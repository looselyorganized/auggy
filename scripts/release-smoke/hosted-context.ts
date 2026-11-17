/** Bounded processes and readable private evidence shared by the hosted scenarios. */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { startApplicationChild } from "./application-child";
import { readBoundedRegularFile } from "./bounded-file";
import { redactEvidence } from "./evidence-redaction";
import { loadSecretsPlan } from "../../src/cli/deploy/secrets";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const hostedInputSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().uuid(),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    region: z.literal("us-west2").default("us-west2"),
    baselineConsumer: z.string().min(1),
    editedConsumer: z.string().min(1),
    maintenanceConsumer: z.string().min(1).optional(),
    environmentFile: z.string().min(1),
    knownHostsFile: z.string().min(1),
    packages: z
      .array(
        z
          .object({
            name: z.enum(["auggy", "@auggy/anthropic"]),
            path: z.string().min(1),
            sha256: sha,
          })
          .strict(),
      )
      .length(2),
    maxSeconds: z.number().int().min(120).max(3600).default(1200),
  })
  .strict();
export type HostedInput = z.infer<typeof hostedInputSchema>;
export const hostedHash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function hostedCheck(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
export function readHostedInput(path: string): HostedInput {
  const input = hostedInputSchema.parse(
    JSON.parse(readBoundedRegularFile(path, 65536).bytes.toString()),
  );
  hostedCheck(
    new Set(input.packages.map((p) => p.name)).size === 2,
    "Select exactly core and Anthropic fixture packages",
  );
  return input;
}
export type HostedCommandOptions = {
  cwd?: string;
  env?: Record<string, string>;
  input?: Uint8Array;
  timeoutMs?: number;
  deployment?: boolean;
  allowFailure?: boolean;
  cleanup?: boolean;
};

export function createHostedContext(input: HostedInput, output: string) {
  const root = resolve(output);
  hostedCheck(!existsSync(root), "Use a new output directory; consumed runs cannot be replayed");
  mkdirSync(root, { mode: 0o700 });
  hostedCheck(realpathSync(root) === root, "Output directory must use its physical absolute path");
  for (const name of ["evidence", "home", "tmp", "auth", "work"])
    mkdirSync(join(root, name), { mode: 0o700 });
  const startedAt = Date.now(),
    deadline = performance.now() + input.maxSeconds * 1000;
  let cleanupDeadline: number | undefined;
  const secrets = loadSecretsPlan(input.environmentFile)
    .variables.map((v) => v.value)
    .filter(Boolean);
  const variables = Object.fromEntries(
    loadSecretsPlan(input.environmentFile).variables.map((v) => [v.key, v.value]),
  );
  let sequence = 0;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  const env = {
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    CI: "true",
  };
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (/^\s*[[{]/.test(value)) {
        try {
          return JSON.stringify(clean(JSON.parse(value)));
        } catch {
          /* Ordinary diagnostic text. */
        }
      }
      return redactEvidence(value, secrets);
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [redactEvidence(k, secrets), clean(v)]),
      );
    return value;
  };
  const save = (name: string, value: unknown) => {
    hostedCheck(/^[a-z0-9-]+\.json$/.test(name), "Invalid evidence filename");
    const bytes = `${JSON.stringify(clean(value), null, 2)}\n`;
    hostedCheck(Buffer.byteLength(bytes) <= 2 * 1024 * 1024, "Evidence exceeds 2MiB bound");
    writeFileSync(join(root, "evidence", name), bytes, { mode: 0o600, flag: "wx" });
  };
  const remaining = (cleanup = false) => {
    if (cleanup) cleanupDeadline ??= performance.now() + 600000;
    hostedCheck(cleanup || !interrupted, "Hosted scenario interrupted; cleanup required");
    return Math.max(0, (cleanup ? cleanupDeadline! : deadline) - performance.now());
  };
  const command = async (
    label: string,
    args: readonly string[],
    options: HostedCommandOptions = {},
  ) => {
    hostedCheck(/^[a-z0-9-]+$/.test(label), "Invalid command label");
    const available = remaining(options.cleanup) - 5000;
    hostedCheck(available > 0, `Deadline exhausted before ${label}`);
    const result = await startApplicationChild({
      command: args,
      cwd: options.cwd ?? root,
      env: { ...env, ...options.env },
      secrets,
      input: options.input,
      timeoutMs: Math.floor(Math.min(options.timeoutMs ?? 15000, available)),
      maxOutputBytes: 2 * 1024 * 1024,
      ...(options.deployment ? { lifetimeProfile: "hosted-deployment" as const } : {}),
    }).finish();
    save(`${String(++sequence).padStart(4, "0")}-${label}.json`, { ...result, command: label });
    hostedCheck(
      result.signal === null &&
        !result.spawnFailed &&
        !result.timedOut &&
        !result.exceededOutput &&
        !result.orphanedGroup &&
        result.cleanupConfirmed &&
        (options.input === undefined ||
          (result.inputComplete === true && result.inputFailed === false)),
      `${label}: process did not complete cleanly; inspect command evidence`,
    );
    hostedCheck(
      options.allowFailure || result.exitCode === 0,
      `${label} failed with exit ${result.exitCode}; inspect command evidence`,
    );
    return result;
  };
  return {
    root,
    input,
    startedAt,
    variables,
    secrets,
    env,
    save,
    remaining,
    command,
    event(phase: string, status: string, error?: unknown) {
      const value = {
        phase,
        status,
        ...(error === undefined
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      };
      save(`${String(++sequence).padStart(4, "0")}-phase.json`, value);
      console.log(JSON.stringify(clean(value)));
    },
    nativeIdentity() {
      const config = JSON.parse(
        readBoundedRegularFile(
          join(homedir(), ".railway/config.json"),
          256 * 1024,
        ).bytes.toString(),
      );
      hostedCheck(config.user?.id, "Railway login is required");
      for (const key of ["token", "accessToken", "refreshToken"])
        if (typeof config.user[key] === "string") secrets.push(config.user[key]);
      config.projects = {};
      mkdirSync(join(env.HOME, ".railway"), { mode: 0o700 });
      writeFileSync(join(env.HOME, ".railway/config.json"), JSON.stringify(config), {
        mode: 0o600,
        flag: "wx",
      });
      copyFileSync(input.knownHostsFile, join(root, "auth/known_hosts"));
      chmodSync(join(root, "auth/known_hosts"), 0o600);
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", interrupt);
    },
    close() {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    },
    runId: randomUUID(),
  };
}
export type HostedContext = ReturnType<typeof createHostedContext>;
