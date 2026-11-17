/** Test-fixture policy only; production authentication and storage remain unchanged. */
import { z } from "zod";
import { hostedCheck as check } from "./hosted-context";

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
