/** Exclusive local action journal. It records execution; it never grants hosted approval. */
import { createHash } from "node:crypto";
import { closeSync, fstatSync } from "node:fs";
import { z } from "zod";
import {
  createPinnedFile,
  inspectPinnedFile,
  pinDirectory,
  readPinnedFile,
} from "../../src/lib/anchored-files";

const bytes = 2 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const action = z
  .object({
    id: identifier,
    phase: z.enum(["execution", "cleanup"]),
    operation: identifier,
    /** Reviewable symbolic parameters; resolved IDs are bound by the finite executor. */
    inputs: z.record(z.string(), z.unknown()),
  })
  .strict();
const manifestSchema = z
  .object({ version: z.literal(1), actions: z.array(action).min(1).max(256) })
  .strict();
const runSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1).max(128),
    planSHA256: digest,
    manifestSHA256: digest,
    startedAt: z.number().int().positive(),
  })
  .strict();
const claimSchema = z
  .object({
    version: z.literal(1),
    runId: z.string(),
    planSHA256: digest,
    actionId: identifier,
    actionSHA256: digest,
    inputSHA256: digest,
    claimedAt: z.number().int().positive(),
  })
  .strict();
const outcomeSchema = z
  .object({
    version: z.literal(1),
    claimSHA256: digest,
    finishedAt: z.number().int().positive(),
    status: z.enum(["confirmed", "failed", "unknown", "skipped"]),
    /** Hash of a separately persisted sanitized result; no input/output payload is stored here. */
    evidenceSHA256: digest,
  })
  .strict();
export type HostedActionManifest = z.infer<typeof manifestSchema>;
export type HostedActionOutcome = z.infer<typeof outcomeSchema>["status"];
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const serialize = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);

export function openHostedActionJournal(options: {
  directory: string;
  runId: string;
  planSHA256: string;
  manifestBytes: Uint8Array;
  manifestSHA256: string;
  actionCount: number;
}) {
  digest.parse(options.planSHA256);
  digest.parse(options.manifestSHA256);
  if (
    options.manifestBytes.byteLength > bytes ||
    hash(options.manifestBytes) !== options.manifestSHA256
  )
    throw new Error("Hosted action manifest differs from approval");
  const manifest = manifestSchema.parse(
    JSON.parse(Buffer.from(options.manifestBytes).toString("utf8")),
  );
  if (
    manifest.actions.length !== options.actionCount ||
    new Set(manifest.actions.map((item) => item.id)).size !== manifest.actions.length
  )
    throw new Error("Hosted action IDs or count are ambiguous");
  const cleanupIndex = manifest.actions.findIndex((item) => item.phase === "cleanup");
  if (
    cleanupIndex <= 0 ||
    manifest.actions.slice(cleanupIndex).some((item) => item.phase !== "cleanup")
  )
    throw new Error("Hosted manifest must end with a finite cleanup sequence");
  const directory = pinDirectory(options.directory, "Hosted action journal");
  const identity = fstatSync(directory.fd);
  if ((identity.mode & 0o777) !== 0o700) {
    closeSync(directory.fd);
    throw new Error("Hosted journal must be private");
  }
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error("Hosted journal is closed");
  };
  const write = (name: string, value: unknown) => {
    const body = serialize(value);
    if (body.length > bytes) throw new Error("Hosted journal record exceeded bound");
    return createPinnedFile(directory.fd, name, body, "Exclusive hosted action record");
  };
  const read = (name: string) => readPinnedFile(directory.fd, name, "Hosted action record", bytes);
  const optional = (name: string) => {
    const file = inspectPinnedFile(directory.fd, name, "Hosted action record");
    if (!file) return null;
    closeSync(file.fd);
    return read(name);
  };
  const expected = runSchema.parse({
    version: 1,
    runId: options.runId,
    planSHA256: options.planSHA256,
    manifestSHA256: options.manifestSHA256,
    startedAt: Date.now(),
  });
  let original: z.infer<typeof runSchema>;
  try {
    write("run.json", expected);
    original = runSchema.parse(JSON.parse(read("run.json").toString("utf8")));
    if (
      original.runId !== expected.runId ||
      original.planSHA256 !== expected.planSHA256 ||
      original.manifestSHA256 !== expected.manifestSHA256
    )
      throw new Error("Hosted journal belongs to another run or plan");
  } catch (error) {
    closeSync(directory.fd);
    throw error;
  }
  const originalSHA256 = hash(serialize(original));
  function run() {
    ensureOpen();
    const current = runSchema.parse(JSON.parse(read("run.json").toString("utf8")));
    if (hash(serialize(current)) !== originalSHA256)
      throw new Error("Hosted run clock or identity changed");
    return current;
  }
  function entry(id: string) {
    const index = manifest.actions.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("Unapproved hosted action");
    return { index, definition: manifest.actions[index]! };
  }
  function observe(id: string) {
    run();
    const { definition } = entry(id);
    const claimBytes = optional(`${id}.claim.json`);
    const outcomeBytes = optional(`${id}.outcome.json`);
    if (!claimBytes) {
      if (outcomeBytes) throw new Error("Hosted outcome has no claim");
      return { state: "not-attempted" as const };
    }
    const claim = claimSchema.parse(JSON.parse(claimBytes.toString("utf8")));
    if (
      claim.runId !== original.runId ||
      claim.planSHA256 !== original.planSHA256 ||
      claim.actionId !== id ||
      claim.actionSHA256 !== hash(serialize(definition)) ||
      claim.claimedAt < original.startedAt
    )
      throw new Error("Hosted action claim identity differs");
    if (!outcomeBytes) return { state: "unknown" as const, claim, outcome: null };
    const outcome = outcomeSchema.parse(JSON.parse(outcomeBytes.toString("utf8")));
    if (outcome.claimSHA256 !== hash(claimBytes) || outcome.finishedAt < claim.claimedAt)
      throw new Error("Hosted outcome binding differs");
    return { state: outcome.status, claim, outcome };
  }
  return {
    run,
    observe,
    /** Called immediately before a bounded operation; retries of a claimed action always refuse. */
    claim(id: string, operation: string, inputSHA256: string) {
      const current = run();
      digest.parse(inputSHA256);
      const { index, definition } = entry(id);
      if (definition.operation !== operation)
        throw new Error("Hosted operation differs from manifest");
      if (observe(id).state !== "not-attempted")
        throw new Error("Hosted action is already claimed");
      if (definition.phase === "execution") {
        if (
          manifest.actions
            .slice(cleanupIndex)
            .some((item) => observe(item.id).state !== "not-attempted")
        )
          throw new Error("Hosted cleanup already began");
        for (const previous of manifest.actions.slice(0, index))
          if (observe(previous.id).state !== "confirmed")
            throw new Error("Earlier hosted action is not confirmed");
      } else {
        // Cleanup continues past failed/unknown earlier cleanup outcomes, in its fixed order.
        for (const previous of manifest.actions.slice(cleanupIndex, index))
          if (observe(previous.id).state === "not-attempted")
            throw new Error("Earlier cleanup action was not attempted");
      }
      const claim = claimSchema.parse({
        version: 1,
        runId: current.runId,
        planSHA256: current.planSHA256,
        actionId: id,
        actionSHA256: hash(serialize(definition)),
        inputSHA256,
        claimedAt: Date.now(),
      });
      if (claim.claimedAt < current.startedAt || !write(`${id}.claim.json`, claim))
        throw new Error("Hosted action is already claimed or clock moved backward");
      return claim;
    },
    finish(id: string, status: HostedActionOutcome, evidenceSHA256: string) {
      const observed = observe(id);
      if (!observed.claim || observed.outcome)
        throw new Error("Hosted action cannot receive another outcome");
      const { definition } = entry(id);
      if (status === "skipped" && definition.phase !== "cleanup")
        throw new Error("Execution actions cannot be skipped");
      const outcome = outcomeSchema.parse({
        version: 1,
        claimSHA256: hash(read(`${id}.claim.json`)),
        finishedAt: Date.now(),
        status,
        evidenceSHA256,
      });
      if (outcome.finishedAt < observed.claim.claimedAt || !write(`${id}.outcome.json`, outcome))
        throw new Error("Hosted outcome already exists or clock moved backward");
      return outcome;
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(directory.fd);
      }
    },
  };
}
