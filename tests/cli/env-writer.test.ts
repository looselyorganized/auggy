import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertEnvValues } from "../../src/cli/env-writer";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("upsertEnvValues", () => {
  test("collapses duplicate keys at their first position while preserving unrelated lines", () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-env-writer-"));
    roots.push(root);
    const envPath = join(root, ".env");
    writeFileSync(
      envPath,
      [
        "# existing comment",
        "AGENTMAIL_API_KEY=am_stale_first",
        "UNRELATED=preserved",
        "AGENTMAIL_API_KEY=am_stale_last",
        "",
      ].join("\n"),
    );

    upsertEnvValues(envPath, {
      AGENTMAIL_API_KEY: "am_current",
      AGENTMAIL_INBOX_ID: "inb_current",
    });

    const written = readFileSync(envPath, "utf-8");
    expect(written).toBe(
      [
        "# existing comment",
        "AGENTMAIL_API_KEY=am_current",
        "UNRELATED=preserved",
        "AGENTMAIL_INBOX_ID=inb_current",
        "",
      ].join("\n"),
    );
    expect(written.match(/^AGENTMAIL_API_KEY=/gm)).toHaveLength(1);
  });

  test("repairs an existing permissive env file to owner-only mode", () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-env-writer-"));
    roots.push(root);
    const envPath = join(root, ".env");
    writeFileSync(envPath, "EXISTING=value\n", { mode: 0o644 });
    chmodSync(envPath, 0o644);

    upsertEnvValues(envPath, { NEW_SECRET: "sentinel" });

    expect(readFileSync(envPath, "utf-8")).toContain("NEW_SECRET=sentinel");
    if (process.platform !== "win32") {
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    }
  });

  test("replaces an env symlink without modifying its target", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "auggy-env-writer-"));
    roots.push(root);
    const target = join(root, "outside");
    const envPath = join(root, ".env");
    writeFileSync(target, "OUTSIDE=unchanged\n", { mode: 0o600 });
    symlinkSync(target, envPath);

    upsertEnvValues(envPath, { NEW_SECRET: "sentinel" });

    expect(readFileSync(target, "utf-8")).toBe("OUTSIDE=unchanged\n");
    expect(readFileSync(envPath, "utf-8")).toContain("NEW_SECRET=sentinel");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });
});
