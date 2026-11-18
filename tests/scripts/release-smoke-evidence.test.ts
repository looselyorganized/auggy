import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { redactEvidence } from "../../scripts/release-smoke/export-evidence";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function exportFixture() {
  const root = mkdtempSync(join(tmpdir(), "release-evidence-export-"));
  directories.push(root);
  const smoke = join(root, "smoke");
  const evidence = join(root, "evidence");
  mkdirSync(smoke);
  mkdirSync(evidence);
  return {
    evidence,
    write(path: string, content: string) {
      const target = join(evidence, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    },
    run() {
      return Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          resolve(import.meta.dir, "../../scripts/release-smoke/export-evidence.ts"),
          smoke,
          evidence,
          "0",
          "fixture-revision",
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 5_000 },
      );
    },
  };
}

describe("release evidence inventory", () => {
  test("records application evidence in the release manifest", () => {
    const fixture = exportFixture();
    fixture.write("authoring/application/application.json", '{"state":"passed"}\n');
    const result = fixture.run();
    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(readFileSync(join(fixture.evidence, "release.json"), "utf8"));
    expect(manifest.exitCode).toBe(0);
    expect(Object.keys(manifest.records).sort()).toEqual([
      "authoring/application/application.json",
    ]);
  });

  test("rejects excessive evidence nesting", () => {
    const fixture = exportFixture();
    fixture.write("authoring/unexpected/a/b/c/record.json", "{}\n");
    const result = fixture.run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Evidence directory nesting exceeded");
  });
});

describe("release evidence redaction", () => {
  test("removes generated secrets and authorization values from diagnostics", () => {
    const result = redactEvidence(
      "failed Bearer unexpected-token; key=sk-ant-example secret=generated-secret generated-secret",
      ["generated-secret"],
    );
    expect(result).not.toContain("generated-secret");
    expect(result).not.toContain("unexpected-token");
    expect(result).not.toContain("sk-ant-example");
    expect(result).toContain("failed");
  });

  test("removes CLI login capabilities and cookie headers", () => {
    const token = "a".repeat(43);
    const output = redactEvidence(
      `/console/cli-login/${token}\nSet-Cookie: session=private-value\nCookie: session=other-value`,
      [],
    );
    expect(output).not.toContain(token);
    expect(output).not.toContain("private-value");
    expect(output).not.toContain("other-value");
  });

  test("retains useful non-secret failure evidence", () => {
    const message = "scenario=restart status=failed exitCode=1 tool=fs_read";
    expect(redactEvidence(message, [])).toBe(message);
  });
});
