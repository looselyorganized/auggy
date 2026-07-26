import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogToFileAdapter } from "../../src/augments/notify/adapters/log-to-file";
import type { LogToFileNotifyDestination } from "../../src/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "auggy-notify-log-"));
  roots.push(root);
  const destination: LogToFileNotifyDestination = {
    name: "ops",
    transport: "log-to-file",
    path: join(root, "state", "notifications.jsonl"),
  };
  return { root, destination };
}

describe("log-to-file notify adapter", () => {
  test("creates and appends through an owner-only anchored file", async () => {
    const { destination } = fixture();
    const result = await createLogToFileAdapter().deliver(destination, { summary: "hello" });
    expect(result.status).toBe("sent");
    expect(readFileSync(destination.path, "utf8")).toContain('"summary":"hello"');
    expect(statSync(destination.path).mode & 0o777).toBe(0o600);
  });

  test("rejects a symlink leaf without changing its target", async () => {
    const { root, destination } = fixture();
    mkdirSync(join(root, "state"), { mode: 0o700 });
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, "outside\n", { mode: 0o600 });
    symlinkSync(outside, destination.path);
    const result = await createLogToFileAdapter().deliver(destination, { summary: "escape" });
    expect(result.status).toBe("failed");
    expect(lstatSync(destination.path).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  test("keeps append anchored when its admitted parent path is replaced", async () => {
    const { root, destination } = fixture();
    const state = join(root, "state");
    const admitted = join(root, "admitted");
    const outside = join(root, "outside");
    mkdirSync(state, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    const outsideLog = join(outside, "notifications.jsonl");
    writeFileSync(outsideLog, "outside\n", { mode: 0o600 });
    const adapter = createLogToFileAdapter({
      __testHooks: {
        afterParentPinned: () => {
          renameSync(state, admitted);
          symlinkSync(outside, state, "dir");
        },
      },
    });
    const result = await adapter.deliver(destination, { summary: "anchored" });
    expect(result.status).toBe("sent");
    expect(readFileSync(join(admitted, "notifications.jsonl"), "utf8")).toContain("anchored");
    expect(readFileSync(outsideLog, "utf8")).toBe("outside\n");
  });

  test("repairs an existing permissive destination before appending", async () => {
    const { root, destination } = fixture();
    mkdirSync(join(root, "state"), { mode: 0o700 });
    writeFileSync(destination.path, "", { mode: 0o600 });
    chmodSync(destination.path, 0o644);
    const result = await createLogToFileAdapter().deliver(destination, { summary: "secure" });
    expect(result.status).toBe("sent");
    expect(statSync(destination.path).mode & 0o777).toBe(0o600);
  });
});
