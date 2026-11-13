import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { parse, stringify } from "yaml";
import { redactEvidence } from "./export-evidence";
import {
  createProviderFixture,
  PROVIDER_FIXTURE_API_KEY,
  PROVIDER_FIXTURE_FINAL_TEXT,
} from "./provider-fixture";

const READY_MS = 60_000;
const SHUTDOWN_MS = 15_000;
const MAX_BYTES = 1024 * 1024;
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function capture(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (bytes < MAX_BYTES) chunks.push(chunk.value.slice(0, MAX_BYTES - bytes));
    bytes += chunk.value.length;
  }
  return Buffer.concat(chunks).toString("utf8") + (bytes > MAX_BYTES ? "\n[truncated]" : "");
}
async function responseJson(response: Response): Promise<unknown> {
  check(response.body, "Link response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      check(bytes <= MAX_BYTES, "Link response exceeded evidence limit");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    void reader.cancel().catch(() => {});
  }
}
export function linkRequest(
  id: string,
  parts: unknown = [{ kind: "text", text: "read acceptance file" }],
) {
  return { jsonrpc: "2.0", id, method: "message/send", params: { to: "receiver", parts } };
}
export function assertLinkMessage(
  value: unknown,
): asserts value is { message_id: string; role: "agent"; parts: { kind: string; text: string }[] } {
  const result = value as {
    message_id?: string;
    role?: string;
    parts?: { kind?: string; text?: string }[];
    kind?: unknown;
  } | null;
  check(
    result &&
      typeof result.message_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.message_id),
    "Link result lacks a message id",
  );
  check(
    result.kind === undefined && result.role === "agent",
    "Link must return a bare agent Message",
  );
  check(
    Array.isArray(result.parts) &&
      result.parts.length === 1 &&
      result.parts[0]?.kind === "text" &&
      result.parts[0]?.text === PROVIDER_FIXTURE_FINAL_TEXT,
    "Link final message did not match the verified provider response",
  );
}

interface Trace {
  turnId: string;
  threadId: string;
  trustLevel: string;
  success: boolean;
  tools: { name: string; sentinelMatched: boolean }[];
}
export async function runPackedLink(options: {
  cli: string;
  agentDir: string;
  home: string;
  evidenceDir: string;
  repoRoot: string;
}): Promise<void> {
  const agentDir = realpathSync(options.agentDir),
    repoRoot = realpathSync(options.repoRoot);
  const cli = realpathSync(options.cli),
    home = realpathSync(options.home);
  check(!inside(agentDir, repoRoot), "Packed Link consumer must live outside the source checkout");
  check(!inside(home, repoRoot), "Packed Link HOME must live outside the source checkout");
  check(
    inside(cli, join(agentDir, "node_modules")) && !inside(cli, repoRoot),
    "Packed Link requires the consumer's project-local CLI",
  );
  const coreRoot = realpathSync(join(agentDir, "node_modules/auggy"));
  const linkRoot = realpathSync(join(agentDir, "node_modules/@auggy/link"));
  for (const root of [coreRoot, linkRoot])
    check(
      inside(root, join(agentDir, "node_modules")) && !inside(root, repoRoot),
      "Packed dependency escaped the installed consumer",
    );
  const linkManifestPath = realpathSync(join(linkRoot, "package.json"));
  check(inside(linkManifestPath, linkRoot), "Link package metadata escaped its package");
  const linkManifest = JSON.parse(readFileSync(linkManifestPath, "utf8"));
  check(
    linkManifest.name === "@auggy/link" && Bun.semver.satisfies(linkManifest.version, ">=0.2.0"),
    "Refusing to execute historical or unverified Link runtime",
  );
  check(
    cli === realpathSync(join(coreRoot, "src/cli/index.ts")),
    "CLI does not belong to the consumer core",
  );
  const originalConfig = parse(readFileSync(join(agentDir, "agent.yaml"), "utf8"));
  const immutableId = originalConfig?.id;
  check(
    typeof immutableId === "string" &&
      /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(immutableId),
    "Link consumer requires a valid immutable agent identity",
  );
  const agentId = immutableId.slice("aug1_".length);
  const owned = join(agentDir, ".packed-link-acceptance"),
    evidenceDir = resolve(options.evidenceDir);
  check(!existsSync(owned), "Packed Link fixture directory already exists");
  await mkdir(owned, { mode: 0o700 });
  await mkdir(join(owned, "workspace"), { mode: 0o700 });
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const bearer = randomBytes(32).toString("hex"),
    sentinel = `link-sentinel-${randomUUID()}`;
  const peerId = randomUUID();
  const secrets = [bearer, PROVIDER_FIXTURE_API_KEY];
  const redact = (value: string) => redactEvidence(value, secrets);
  const json = async (name: string, value: unknown) =>
    writeFile(join(evidenceDir, name), `${redact(JSON.stringify(value, null, 2))}\n`, {
      mode: 0o600,
    });
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: owned,
    LANG: "C.UTF-8",
    TZ: "UTC",
    CI: "1",
    TERM: "dumb",
    NODE_ENV: "development",
    LINK_ALLOW_PLAINTEXT: "1",
    ANTHROPIC_API_KEY: PROVIDER_FIXTURE_API_KEY,
    PACKED_LINK_BEARER: bearer,
    PACKED_LINK_PEER_ID: peerId,
    PACKED_LINK_AGENT_ID: agentId,
  };
  const saved = new Map<string, Buffer | null>();
  const outcomes: Record<string, unknown> = {};
  const lifecycle: Record<string, unknown>[] = [];
  const started = Date.now();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output: Promise<string[]> | undefined;
  let generation = 0;
  let failure: unknown;
  let provider: ReturnType<typeof createProviderFixture> | undefined;
  const cancellation = new AbortController();
  let scenarioSignal: AbortSignal | undefined;
  const signal = (ms: number) =>
    AbortSignal.any([
      cancellation.signal,
      AbortSignal.timeout(ms),
      ...(scenarioSignal ? [scenarioSignal] : []),
    ]);
  const interrupted = () => {
    cancellation.abort(new Error("Link acceptance interrupted"));
    child?.kill("SIGTERM");
  };
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  const traces = async (): Promise<Trace[]> =>
    existsSync(join(owned, "traces.jsonl"))
      ? (await readFile(join(owned, "traces.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const snapshot = () => json("scenarios.json", { scenarios: outcomes, lifecycle });
  const stop = async () => {
    if (!child) return;
    const target = child;
    const running = target.exitCode === null;
    let forced = false;
    if (running) target.kill("SIGTERM");
    try {
      await bounded(target.exited, SHUTDOWN_MS, "Link graceful shutdown");
    } catch {
      forced = true;
      target.kill("SIGKILL");
      await bounded(target.exited, 5_000, "Link forced shutdown");
    } finally {
      if (target.exitCode !== null) child = undefined;
      lifecycle.push({
        generation,
        exitCode: target.exitCode,
        signalCode: target.signalCode,
        forced,
      });
      if (output)
        await writeFile(
          join(evidenceDir, `cli-${generation}.log`),
          redact((await bounded(output, 5_000, "Link logs")).join("\n[stderr]\n")),
          { mode: 0o600 },
        );
      await snapshot();
    }
    check(
      running && !forced && target.exitCode === 0 && target.signalCode === null,
      "Link CLI did not stop gracefully",
    );
  };
  const scenario = async (name: string, action: () => Promise<unknown>) => {
    const deadline = new AbortController();
    scenarioSignal = deadline.signal;
    const timer = setTimeout(() => deadline.abort(new Error("Link scenario deadline")), 120_000);
    outcomes[name] = { status: "running" };
    await snapshot();
    try {
      outcomes[name] = { status: "passed", evidence: await action() };
    } catch (error) {
      outcomes[name] = { status: "failed", message: redact(String(error)) };
      throw error;
    } finally {
      clearTimeout(timer);
      scenarioSignal = undefined;
      await snapshot();
    }
  };
  try {
    provider = createProviderFixture({ toolResultSentinel: sentinel });
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reserved"),
    });
    const port = reservation.port;
    await reservation.stop(true);
    const baseURL = `http://127.0.0.1:${port}`;
    await writeFile(join(owned, "workspace/acceptance.txt"), sentinel);
    await writeFile(
      join(owned, "observer.ts"),
      `import { appendFile } from "node:fs/promises";
import { defineAugment } from "auggy";
export default () => defineAugment({name:"packedLinkObserver",onTurnEnd:async turn=>{
const record={turnId:turn.turnId,threadId:turn.trace.threadId,trustLevel:turn.trace.trigger.trustLevel,success:turn.success,
tools:turn.toolCalls.map(t=>({name:t.name,sentinelMatched:t.output.includes(${JSON.stringify(sentinel)})}))};
await appendFile(${JSON.stringify(join(owned, "traces.jsonl"))},JSON.stringify(record)+"\\n",{mode:0o600});}});
`,
    );
    const probe = join(owned, "client.ts");
    await writeFile(
      probe,
      `import {PeerClient,EnvAddressBook} from "@auggy/link";
import {realpathSync} from "node:fs";
import {createAuthenticatedLinkParts} from ${JSON.stringify(join(coreRoot, "src/augments/link/provenance.ts"))};
const action=process.argv[2];
if(action==="provenance") console.log(JSON.stringify(Object.fromEntries(["auggy","@auggy/link","@auggy/anthropic"].map(p=>[p,realpathSync(new URL(import.meta.resolve(p)))]))));
else {
const bearer=process.env.PACKED_LINK_BEARER;
const client=new PeerClient({addressBook:new EnvAddressBook({PEERS:"receiver",PEER_RECEIVER_URL:${JSON.stringify(baseURL)},PEER_RECEIVER_BEARER:action==="invalid-auth"?"invalid-fixture-bearer":bearer}),config:{retry:{maxAttempts:1,baseDelayMs:1,maxDelayMs:1},timeoutMs:10000}});
const key=crypto.randomUUID();
let parts=[{kind:"text",text:"read acceptance file"}];
if(action!=="unsigned") parts=createAuthenticatedLinkParts({parts,peer:{id:"fixture-creator",kind:"human",trustLevel:"creator",sourceAugment:"fixture"},issuer:process.env.PACKED_LINK_PEER_ID,audience:process.env.PACKED_LINK_AGENT_ID,bearer,idempotencyKey:key});
if(action==="tampered") parts[0].text="tampered";
const result=await client.send({to:"receiver",parts,idempotencyKey:key});
console.log(JSON.stringify(result.ok?{ok:true,outcome:result.value.outcome}:{ok:false,code:result.error.code}));
}
`,
    );
    const clientProbe = async (action: string) => {
      cancellation.signal.throwIfAborted();
      scenarioSignal?.throwIfAborted();
      const probeChild = Bun.spawn([process.execPath, probe, action], {
        cwd: agentDir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const captured = Promise.all([capture(probeChild.stdout), capture(probeChild.stderr)]);
      try {
        check(
          (await bounded(probeChild.exited, 20_000, "Link installed client")) === 0,
          "Installed Link client failed",
        );
        const [stdout, stderr] = await bounded(captured, 5_000, "Link client capture");
        check(!stderr, "Installed Link client produced unexpected stderr");
        return JSON.parse(stdout!);
      } finally {
        if (probeChild.exitCode === null) {
          probeChild.kill("SIGKILL");
          await bounded(probeChild.exited, 5_000, "Link client cleanup");
        }
        await bounded(captured, 5_000, "Link client final capture");
      }
    };
    const paths = await clientProbe("provenance");
    for (const path of Object.values(paths))
      check(
        typeof path === "string" &&
          inside(path, join(agentDir, "node_modules")) &&
          !inside(path, repoRoot),
        "Link runtime import escaped packed consumer",
      );
    await json("provenance.json", {
      cli,
      agentDir,
      paths,
      linkVersion: linkManifest.version,
      linkManifestSHA256: hash(readFileSync(linkManifestPath)),
      sdkEntrySHA256: hash(readFileSync(paths["@auggy/link"])),
      sdkImplementationSHA256: Object.fromEntries(
        [
          "dist/client/peer.js",
          "dist/client/response-body.js",
          "dist/protocol/types.js",
          "dist/protocol/validation-budget.js",
        ].map((file) => {
          const path = realpathSync(join(linkRoot, file));
          check(inside(path, linkRoot), "Link implementation escaped its package");
          return [file, hash(readFileSync(path))];
        }),
      ),
      coreCliSHA256: hash(readFileSync(cli)),
      coreImplementationSHA256: Object.fromEntries(
        [
          "src/kernel/turn-loop.ts",
          "src/cli/augment-resolver.ts",
          "src/cli/agent-isolation.ts",
        ].map((file) => [file, hash(readFileSync(join(coreRoot, file)))]),
      ),
      listener:
        "Existing Link bind behavior; requests use127.0.0.1, provider fixture binds loopback",
      synchronousReplay:
        "Not claimed; Auggy returns synchronous Message outcomes, not durable Link tasks",
    });
    for (const name of ["agent.yaml", ".env"]) {
      const file = join(agentDir, name);
      saved.set(file, existsSync(file) ? await readFile(file) : null);
    }
    const config = parse(saved.get(join(agentDir, "agent.yaml"))?.toString() ?? "{}");
    Object.assign(config, {
      id: config.id ?? `aug1_${randomUUID()}`,
      name: config.name ?? "packed-link",
      engine: {
        provider: "anthropic",
        model: "claude-packed-link",
        baseURL: provider.baseURL,
        maxContextTokens: 32_000,
        maxTokens: 256,
        requestTimeoutMs: 5_000,
        costOverride: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
      },
      augments: [
        {
          name: "filesystem",
          type: "filesystem",
          options: {
            mounts: [
              {
                name: "workspace",
                path: join(owned, "workspace"),
                writable: false,
                deletable: false,
              },
            ],
            workspaceAwareness: { enabled: false },
          },
        },
        {
          name: "link",
          type: "link",
          options: {
            port,
            dbPath: join(owned, "link.db"),
            agentCard: {
              id: agentId,
              name: "packed-link",
              description: "Packed Link acceptance",
              endpointUrl: baseURL,
            },
            peers: {
              fixture: {
                url: baseURL,
                bearer,
                participantId: peerId,
                inboundBearer: bearer,
                inboundBearerId: "fixture-key",
              },
            },
          },
        },
        {
          name: "packedLinkObserver",
          type: "custom",
          source: "./.packed-link-acceptance/observer.ts",
          options: {},
        },
      ],
    });
    await writeFile(join(agentDir, "agent.yaml"), stringify(config));
    await writeFile(join(agentDir, ".env"), "", { mode: 0o600 });
    const start = async () => {
      cancellation.signal.throwIfAborted();
      scenarioSignal?.throwIfAborted();
      generation++;
      const spawned = Bun.spawn([cli, "run", "--no-open"], {
        cwd: agentDir,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      child = spawned;
      output = Promise.all([capture(spawned.stdout), capture(spawned.stderr)]);
      const deadline = Date.now() + READY_MS;
      while (Date.now() < deadline) {
        cancellation.signal.throwIfAborted();
        scenarioSignal?.throwIfAborted();
        check(child.exitCode === null, "Link CLI exited before readiness");
        try {
          const response = await fetch(`${baseURL}/health`, { signal: signal(1_000) });
          await response.body?.cancel();
          if (response.ok) return;
        } catch {
          /* bounded readiness retry */
        }
        await Bun.sleep(50);
      }
      throw new Error("Link readiness deadline exceeded");
    };
    const request = async (body: unknown, auth: "valid" | "missing" | "invalid" = "valid") => {
      const response = await fetch(`${baseURL}/a2a/v1`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth === "missing"
            ? {}
            : { authorization: `Bearer ${auth === "valid" ? bearer : "invalid-fixture-bearer"}` }),
        },
        body: JSON.stringify(body),
        signal: signal(20_000),
      });
      if (response.status === 401) {
        await response.body?.cancel();
        return { status: 401, body: null };
      }
      return {
        status: response.status,
        body: (await responseJson(response)) as {
          id?: string;
          result?: unknown;
          error?: { code?: number; message?: string };
        },
      };
    };
    await start();
    const discovery = await fetch(`${baseURL}/.well-known/agent.json`, { signal: signal(5_000) });
    check(discovery.status === 200, "Link discovery failed");
    const card = (await responseJson(discovery)) as { id?: string };
    check(card.id === agentId, "Link wire identity does not match immutable agent UUID");
    await json("identity.json", { immutableAgentId: immutableId, advertisedLinkId: card.id });
    for (const auth of ["missing", "invalid"] as const)
      await scenario(`${auth}-auth`, async () => {
        const response = await request(linkRequest(auth), auth);
        check(
          response.status === 401 &&
            provider!.evidence().calls === 0 &&
            (await traces()).length === 0,
          "Link auth rejection invoked runtime work",
        );
        return { httpStatus: response.status, providerCalls: 0 };
      });
    await scenario("client-invalid-auth", async () => {
      const result = await clientProbe("invalid-auth");
      check(
        !result.ok &&
          result.code === "peer_unauthenticated" &&
          provider!.evidence().calls === 0 &&
          (await traces()).length === 0,
        "Installed PeerClient did not preserve authentication failure",
      );
      return { code: result.code, providerCalls: 0 };
    });
    for (const [name, body, code] of [
      ["invalid-params", linkRequest("invalid-params", [{ kind: "text", text: 17 }]), -32602],
      ["validation-budget", linkRequest("validation-budget", Array(10_001).fill(null)), -32600],
    ] as const)
      await scenario(name, async () => {
        const response = await request(body);
        check(
          response.status === 200 &&
            response.body?.id === body.id &&
            response.body.error?.code === code &&
            provider!.evidence().calls === 0 &&
            (await traces()).length === 0,
          "Link malformed request did not reject before runtime dispatch",
        );
        return { httpStatus: response.status, rpcCode: code, providerCalls: 0 };
      });
    await scenario("tampered-origin", async () => {
      const result = await clientProbe("tampered");
      check(
        !result.ok &&
          result.code === "peer_protocol_error" &&
          provider!.evidence().calls === 0 &&
          (await traces()).length === 0,
        "Link accepted tampered origin provenance",
      );
      return { code: result.code, providerCalls: 0 };
    });
    const successful = async (kind: "unsigned" | "signed") => {
      provider!.setScenario("success");
      const before = (await traces()).length;
      const result = await clientProbe(kind);
      check(result.ok, "Installed PeerClient failed to receive Link response");
      assertLinkMessage(result.outcome);
      const evidence = provider!.evidence(),
        records = await traces(),
        trace = records.at(-1);
      check(
        evidence.calls === 2 &&
          evidence.validatedToolResults === 1 &&
          evidence.rejectedRequests === 0,
        "Link did not run the real provider/tool/provider sequence",
      );
      check(
        records.length === before + 1 &&
          trace?.success &&
          trace.trustLevel === (kind === "unsigned" ? "public" : "agent") &&
          trace.tools.length === 1 &&
          trace.tools[0]?.name === "fs_read" &&
          trace.tools[0]?.sentinelMatched,
        "Link trace/trust/tool proof failed",
      );
      return {
        provider: evidence,
        turnId: trace.turnId,
        threadId: trace.threadId,
        trustLevel: trace.trustLevel,
        responseSHA256: hash(JSON.stringify(result.outcome)),
      };
    };
    await scenario("unsigned-public-downgrade", () => successful("unsigned"));
    await scenario("signed-origin-capped-at-agent", () => successful("signed"));
    await scenario("provider-failure", async () => {
      provider!.setScenario("provider-failure");
      const response = await request(linkRequest("provider-failure"));
      const evidence = provider!.evidence();
      check(
        response.status === 200 &&
          response.body?.id === "provider-failure" &&
          response.body.error?.code === -32603 &&
          response.body.error.message === "link augment: turn dispatch failed",
        "Link provider failure did not return a sanitized correlated error",
      );
      check(
        evidence.calls === 1 &&
          evidence.toolRequests === 0 &&
          evidence.summaries[0]?.outcome === "provider-failure",
        "Unexpected provider work after Link failure",
      );
      return {
        rpcCode: -32603,
        provider: evidence,
        traceCoverage:
          "Existing generic provider exception bypasses onTurnEnd; no fabricated trace",
      };
    });
    await scenario("restart-new-request", async () => {
      await stop();
      provider!.reset();
      await start();
      check(provider!.evidence().calls === 0, "Restart unexpectedly invoked provider");
      return successful("unsigned");
    });
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors: string[] = [];
    const clean = async (label: string, action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(`${label}: ${redact(String(error))}`);
        failure ??= error;
      }
    };
    try {
      cancellation.abort(new Error("Link cleanup"));
      await clean("stop CLI", stop);
      if (provider)
        await clean("stop provider", () =>
          bounded(provider!.stop(), 5_000, "Link provider shutdown"),
        );
      await clean("capture traces", async () => json("traces.json", await traces()));
      const processStillLive = child?.exitCode === null;
      if (!processStillLive) {
        for (const [file, contents] of saved)
          await clean("restore application file", () =>
            contents === null ? rm(file, { force: true }) : writeFile(file, contents),
          );
        await clean("remove fixture files", () => rm(owned, { recursive: true, force: true }));
      }
      await clean("snapshot", snapshot);
      await json("result.json", {
        status: failure ? "failed" : "passed",
        durationMs: Date.now() - started,
        cleanupErrors,
        retainedFixture: processStillLive ? owned : null,
        unreapedPid: processStillLive ? child?.pid : null,
        ...(failure ? { message: redact(String(failure)) } : {}),
      });
    } finally {
      process.off("SIGINT", interrupted);
      process.off("SIGTERM", interrupted);
    }
  }
  if (failure) throw failure;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ["cli", "agent-dir", "home", "evidence-dir", "repo-root"].map((name) => [
        name,
        { type: "string" as const },
      ]),
    ),
    strict: true,
  });
  for (const name of ["cli", "agent-dir", "home", "evidence-dir", "repo-root"])
    check(typeof values[name] === "string", `Missing --${name}`);
  await runPackedLink({
    cli: values.cli as string,
    agentDir: values["agent-dir"] as string,
    home: values.home as string,
    evidenceDir: values["evidence-dir"] as string,
    repoRoot: values["repo-root"] as string,
  });
}
