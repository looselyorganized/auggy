/** Test-fixture policy only; production authentication and storage remain unchanged. */
import { z } from "zod";
import { hostedCheck as check } from "./hosted-context";
import { assertSealedHostedHttpSnapshot, parseHostedHttpSnapshot } from "./integration-hosted-http";
import {
  hostedCheckpoint,
  type HostedHttpCheckpoint,
  type HostedHttpControl,
} from "./integration-fixtures/http-container/startup";

export const HOSTED_HTTP_ASSERTION_TTL_SECONDS = 180;
export const HOSTED_HTTP_RESTORE_HOLD_MS = (HOSTED_HTTP_ASSERTION_TTL_SECONDS + 30) * 1000;
export const HOSTED_HTTP_EXPIRY_PROBE_TTL_SECONDS = 20;

export function assertHostedHttpFixture(config: unknown) {
  const value = z
    .object({
      augments: z.array(
        z
          .object({
            type: z.string(),
            options: z.unknown().optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough()
    .parse(config);
  const listeners = value.augments.filter((a) => a.type === "webTransport");
  check(listeners.length === 1, "Expected one HTTP fixture transport");
  z.object({
    externalAuth: z
      .object({
        maxTtlSeconds: z.literal(HOSTED_HTTP_ASSERTION_TTL_SECONDS),
        replayProtection: z
          .object({ enabled: z.literal(true), dbPath: z.string().min(1) })
          .passthrough(),
      })
      .passthrough(),
    idempotency: z.object({ dbPath: z.string().min(1) }).passthrough(),
  })
    .passthrough()
    .parse(listeners[0]!.options);
}

export interface HostedAuthResponse {
  status: number;
  retryAfter: string | null;
  body: unknown;
}
export function assertHostedAuthHold(response: HostedAuthResponse) {
  check(response.status === 503, "Restored authentication must be held");
  z.object({ error: z.literal("external_auth_unavailable") })
    .strict()
    .parse(response.body);
  check(
    response.retryAfter !== null &&
      /^[1-9]\d*$/.test(response.retryAfter) &&
      Number(response.retryAfter) <= HOSTED_HTTP_RESTORE_HOLD_MS / 1000,
    "Restore hold must report a bounded integer Retry-After",
  );
}
export function assertHostedExpiredAssertion(response: HostedAuthResponse) {
  check(response.status === 401, "Expired assertion must be rejected");
  z.object({ error: z.literal("unauthorized") })
    .strict()
    .parse(response.body);
}

/** Provider RUNNING/instance identity alone cannot distinguish a stale process. */
export function isFreshHostedHttpFixture(result: unknown, generationId: string) {
  if (result === null) return false;
  const value = z.object({ generationId: z.string(), snapshot: z.string() }).parse(result);
  check(value.generationId === generationId, "Restart fixture generation changed");
  const snapshot = parseHostedHttpSnapshot(value.snapshot);
  if (snapshot.state === "sealed") return false;
  check(
    snapshot.state === "waiting" &&
      snapshot.initializedFrom === null &&
      snapshot.initialEffects === 0 &&
      snapshot.checkpoint.effects.length === 0 &&
      snapshot.domain.calls === 0 &&
      snapshot.model.totalRequests === 0 &&
      snapshot.model.generation === 0,
    "Restart fixture is not a fresh waiting process",
  );
  return true;
}

/** Every fresh process needs its downstream checkpoint before probing and sealing. */
export async function observeHostedHttpHold(options: {
  control: (input: HostedHttpControl) => Promise<unknown>;
  checkpoint: HostedHttpCheckpoint;
  generationId: string;
  request: () => Promise<HostedAuthResponse>;
}) {
  const control = async (input: HostedHttpControl) => {
    const result = z
      .object({ generationId: z.string(), snapshot: z.string() })
      .parse(await options.control(input));
    check(result.generationId === options.generationId, "HTTP hold fixture generation changed");
    return result.snapshot;
  };
  const expected = hostedCheckpoint(options.checkpoint).sha256;
  const initialized = parseHostedHttpSnapshot(
    await control({
      operation: "initialize",
      checkpoint: options.checkpoint,
    }),
  );
  check(
    initialized.state === "active" &&
      initialized.initializedFrom === expected &&
      initialized.checkpointSHA256 === expected,
    "HTTP hold fixture checkpoint changed",
  );
  const held = await options.request();
  assertHostedAuthHold(held);
  const sealedSnapshot = await control({ operation: "seal" });
  const sealed = assertSealedHostedHttpSnapshot(sealedSnapshot);
  check(
    sealed.checkpointSHA256 === expected &&
      sealed.domain.calls === 0 &&
      sealed.model.totalRequests === 0,
    "Held ingress performed work",
  );
  return { held, sealedSnapshot };
}
