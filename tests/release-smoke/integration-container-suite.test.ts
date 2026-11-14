import { describe, expect, test } from "bun:test";
import {
  assertContainerAdmission,
  containerAcceptedRequestCount,
  readContainerEffectJournal,
  readContainerResponse,
  summarizeContainerEffects,
  selectContainerDurabilityImage,
  serializeContainerDiagnostics,
} from "../../scripts/release-smoke/integration-container-suite";

// Pure negative controls for acceptance oracles. These are not actual-container evidence.
describe("container acceptance oracles", () => {
  test("durability evidence selects its actual image rather than the first admission or worker image", () => {
    const image = (
      role: "admission-http" | "worker" | "durability-http" | "longer-ttl-http",
      identity: string,
    ) => ({
      role,
      imageDigest: `sha256:${identity.repeat(64)}`,
      exportSHA256: identity.repeat(64),
      profile: { kind: "none" as const },
    });
    const admission = image("admission-http", "a"),
      worker = image("worker", "b"),
      durability = image("durability-http", "c"),
      ttl = image("longer-ttl-http", "d");
    expect(selectContainerDurabilityImage([admission, worker, durability, ttl])).toBe(
      durability.imageDigest,
    );
    expect(selectContainerDurabilityImage([ttl, durability, worker, admission])).toBe(
      durability.imageDigest,
    );
    expect(selectContainerDurabilityImage([admission, worker])).toBeNull();
    expect(() =>
      selectContainerDurabilityImage([durability, image("durability-http", "e")]),
    ).toThrow("Ambiguous");
  });

  test("response observations retain only nonnegative safe counts, never reflected JSON or credentials", () => {
    expect(containerAcceptedRequestCount({ acceptedRequests: 0 })).toBe(0);
    expect(containerAcceptedRequestCount({ acceptedRequests: 4 })).toBe(4);
    for (const acceptedRequests of [
      "synthetic-secret",
      { nested: "synthetic-secret" },
      ["synthetic-secret"],
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      undefined,
    ]) {
      expect(containerAcceptedRequestCount({ acceptedRequests })).toBeNull();
    }
    expect(containerAcceptedRequestCount(null)).toBeNull();
    expect(containerAcceptedRequestCount([])).toBeNull();
  });

  test("entire diagnostic JSON is redacted before encoding and hashing, including nested escaped strings", () => {
    const secret = 'synthetic-quoted-"secret"';
    const value = {
      stages: [{ result: { failureDiagnostic: `nested ${secret}` } }],
      observations: {
        lastAdmission: { log: `authorization: Bearer ${secret}` },
        requests: [
          {
            acceptedRequests: containerAcceptedRequestCount({ acceptedRequests: { leak: secret } }),
          },
        ],
      },
    };
    const bytes = serializeContainerDiagnostics(value, [secret]);
    const text = bytes.toString("utf8");
    expect(text).not.toContain("synthetic-quoted");
    const decoded = JSON.parse(text);
    expect(decoded.stages[0].result.failureDiagnostic).toBe("nested [REDACTED]");
    expect(decoded.observations.requests[0].acceptedRequests).toBeNull();
    expect(decoded.observations.lastAdmission.log).toContain("[REDACTED]");
    expect(() =>
      serializeContainerDiagnostics({ oversized: "x".repeat(4 * 1024 * 1024) }, []),
    ).toThrow("exceeded bound");
  });

  test("partial journals expose duplicate authority and unauthorized effects instead of expected constants", () => {
    const requests = [
      { id: "first", authorityGroup: "same-assertion", kind: "authorized" as const, status: 200 },
      {
        id: "concurrent",
        authorityGroup: "same-assertion",
        kind: "authorized" as const,
        status: 200,
      },
      { id: "invalid", authorityGroup: "wrong-secret", kind: "unauthorized" as const, status: 401 },
    ];
    expect(summarizeContainerEffects(requests, ["first"])).toEqual({
      effectCount: 1,
      duplicateEffectCount: 0,
      unauthorizedEffectCount: 0,
    });
    expect(
      summarizeContainerEffects(requests, ["first", "concurrent", "invalid", "unknown"]),
    ).toEqual({ effectCount: 4, duplicateEffectCount: 1, unauthorizedEffectCount: 2 });
    expect(summarizeContainerEffects(requests, [])).toEqual({
      effectCount: 0,
      duplicateEffectCount: 0,
      unauthorizedEffectCount: 0,
    });
  });
  test("requires the intended admission reason before augment construction", () => {
    expect(() =>
      assertContainerAdmission(
        "Error: [runtime-volume] runtime data root: does not exist",
        "missing",
      ),
    ).not.toThrow();
    expect(() =>
      assertContainerAdmission("Error: runtime data root must have mode 0700", "mode"),
    ).not.toThrow();
    expect(() =>
      assertContainerAdmission(
        "Error: Missing environment variables in agent.yaml: AUGGY_DATA_DIR",
        "missing",
      ),
    ).toThrow();
    expect(() =>
      assertContainerAdmission("Error: runtime data root must have mode 0700", "missing"),
    ).toThrow();
    expect(() =>
      assertContainerAdmission(
        "container-proof:factory\nError: runtime data root must have mode 0700",
        "mode",
      ),
    ).toThrow();
  });

  test("reads observed effects without counting boot or auth diagnostics as effects", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(
      readContainerEffectJournal(
        `container-proof:factory\ncontainer-proof:effect:${id}\nHTTP auth refused\ncontainer-proof:effect:${id}`,
      ),
    ).toEqual([id, id]);
    expect(() => readContainerEffectJournal("container-proof:effect:unexpected-secret")).toThrow();
    expect(readContainerEffectJournal("container-worker:ready")).toEqual([]);
  });

  test("bounds streamed responses while preserving status and retry-after", async () => {
    expect(
      await readContainerResponse(new Response('{"acceptedRequests":1}', { status: 200 })),
    ).toEqual({ status: 200, retryAfter: null, body: { acceptedRequests: 1 } });
    expect(
      await readContainerResponse(
        new Response('{"error":"held"}', { status: 503, headers: { "retry-after": "10" } }),
      ),
    ).toEqual({ status: 503, retryAfter: "10", body: { error: "held" } });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(2048));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readContainerResponse(new Response(body))).rejects.toThrow("exceeded bound");
    expect(cancelled).toBe(true);
  });

  test("cancellation ends a stalled response body and malformed JSON cannot pass", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const result = readContainerResponse(new Response(body), controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(cancelled).toBe(true);
    await expect(readContainerResponse(new Response("not json"))).rejects.toThrow();
  });
});
