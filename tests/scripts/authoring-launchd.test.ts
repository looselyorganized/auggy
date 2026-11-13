import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  assertGeneratedServiceAnswer,
  assertFreshGeneratedServiceState,
  inspectGeneratedServiceLogs,
  watchGeneratedServiceLogs,
  runGeneratedApplicationLaunchd,
} from "../../scripts/release-smoke/authoring-launchd";
import {
  PROVIDER_FIXTURE_ANSWER_TEXT,
  type ProviderFixtureEvidence,
} from "../../scripts/release-smoke/provider-fixture";
import type { ApplicationResponse } from "../../scripts/release-smoke/application-http";

// Static import includes the actual runner in strict checking; no service is started here.
void runGeneratedApplicationLaunchd;

const provider: ProviderFixtureEvidence = {
  scenario: "answer-only",
  generation: 1,
  calls: 1,
  toolRequests: 0,
  validatedToolResults: 0,
  finalResponses: 1,
  rejectedRequests: 0,
  summaries: [{ call: 1, streaming: true, outcome: "direct-answer", status: 200 }],
};
function response(): ApplicationResponse {
  const events = [
    { type: "RUN_STARTED", threadId: "service-thread", runId: "service-run" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: PROVIDER_FIXTURE_ANSWER_TEXT },
    {
      type: "RUN_FINISHED",
      threadId: "service-thread",
      runId: "service-run",
      result: { status: "completed" },
    },
  ];
  return {
    status: 200,
    headers: {},
    body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  };
}

describe("generated service evidence controls", () => {
  test("accepts correlated answer evidence and an explicitly observed owned handler", () => {
    expect(assertGeneratedServiceAnswer(response(), "service-thread", provider).runId).toBe(
      "service-run",
    );
    const edited = response();
    edited.headers = { "x-auggy-owned-service": "owned" };
    expect(assertGeneratedServiceAnswer(edited, "service-thread", provider, "owned").threadId).toBe(
      "service-thread",
    );
  });
  test("wrong source marker and request identity fail even with a successful answer", () => {
    expect(() =>
      assertGeneratedServiceAnswer(response(), "service-thread", provider, "wrong"),
    ).toThrow("marker");
    expect(() => assertGeneratedServiceAnswer(response(), "wrong-thread", provider)).toThrow(
      "correlated",
    );
  });
  test("fabricated or repeated provider work cannot certify service execution", () => {
    for (const changed of [
      { calls: 0 },
      { calls: 2 },
      { toolRequests: 1 },
      { finalResponses: 0 },
      { rejectedRequests: 1 },
    ]) {
      expect(() =>
        assertGeneratedServiceAnswer(response(), "service-thread", { ...provider, ...changed }),
      ).toThrow("provider adapter");
    }
  });
  test("terminal errors, missing answer and events after completion are rejected", () => {
    const bad = response();
    bad.body += 'data: {"type":"RUN_ERROR","message":"failed"}\n\n';
    expect(() => assertGeneratedServiceAnswer(bad, "service-thread", provider)).toThrow(
      "correlated",
    );
    const missing = response();
    missing.body = missing.body.replace(PROVIDER_FIXTURE_ANSWER_TEXT, "unrelated");
    expect(() => assertGeneratedServiceAnswer(missing, "service-thread", provider)).toThrow(
      "correlated",
    );
    const extra = response();
    extra.body += 'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"late"}\n\n';
    expect(() => assertGeneratedServiceAnswer(extra, "service-thread", provider)).toThrow(
      "correlated",
    );
  });
});

test("generated service freshness permits its scaffold README and rejects used state and aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "authoring-service-state-"));
  try {
    mkdirSync(join(root, "data/workspace"), { recursive: true });
    writeFileSync(join(root, "data/workspace/README.md"), "# Generated workspace\n");
    expect(assertFreshGeneratedServiceState(root).path).toBe("data/workspace/README.md");
    writeFileSync(join(root, "data/history.sqlite"), "used-state");
    expect(() => assertFreshGeneratedServiceState(root)).toThrow("runtime state");
    rmSync(join(root, "data/history.sqlite"));
    rmSync(join(root, "data/workspace"), { recursive: true });
    mkdirSync(join(root, "alias"));
    symlinkSync(join(root, "alias"), join(root, "data/workspace"));
    expect(() => assertFreshGeneratedServiceState(root)).toThrow("ordinary");
    rmSync(join(root, "data/workspace"));
    mkdirSync(join(root, "data/workspace"));
    expect(Bun.spawnSync(["mkfifo", join(root, "data/workspace/README.md")]).exitCode).toBe(0);
    expect(() => assertFreshGeneratedServiceState(root)).toThrow("regular file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("service log watchdog catches detached output growth and retains the first failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "authoring-service-logs-"));
  const id = "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c";
  let resolveFailure!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => {
    resolveFailure = resolve;
  });
  let notifications = 0;
  const watcher = watchGeneratedServiceLogs({
    home: root,
    agentId: id,
    intervalMs: 10,
    onFailure(error) {
      notifications++;
      resolveFailure(error);
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(inspectGeneratedServiceLogs(root, id)).toEqual({ stdout: null, stderr: null });
    mkdirSync(join(root, ".auggy/logs"), { recursive: true });
    const log = join(root, ".auggy/logs", `${id}.log`);
    writeFileSync(log, Buffer.alloc(2 * 1024 * 1024 + 1));
    const error = await Promise.race([
      failed,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Log watchdog missed growth")), 1000);
      }),
    ]);
    expect(error.message).toContain("output limit");
    rmSync(log);
    expect(Bun.spawnSync(["mkfifo", log]).exitCode).toBe(0);
    expect(() => inspectGeneratedServiceLogs(root, id)).toThrow("ordinary");
    const result = watcher.stop();
    expect(result.maximumObserved.stdout).toBe(2 * 1024 * 1024 + 1);
    expect(result.failure).toBe(error.message);
    expect(notifications).toBe(1);
  } finally {
    clearTimeout(timeout);
    watcher.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("service log inspection refuses aliased parents without reading targets", () => {
  const root = mkdtempSync(join(tmpdir(), "authoring-service-log-alias-"));
  const target = mkdtempSync(join(tmpdir(), "authoring-service-log-target-"));
  try {
    symlinkSync(target, join(root, ".auggy"));
    expect(() =>
      inspectGeneratedServiceLogs(root, "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c"),
    ).toThrow("parent must be ordinary");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
