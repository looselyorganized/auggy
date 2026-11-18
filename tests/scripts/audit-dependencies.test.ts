import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuditOptions,
  inspectAuditOutput,
  matchesWorkspaceException,
  runDependencyAudit,
} from "../../scripts/audit-dependencies";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(code: string, options: Partial<AuditOptions> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "auggy-audit-test-"));
  directories.push(cwd);
  writeFileSync(join(cwd, "bun.lock"), "fixture lock\n");
  const evidencePath = join(cwd, "evidence", "audit.json");
  const result = runDependencyAudit({
    cwd,
    evidencePath,
    command: [process.execPath, "-e", code],
    ...options,
  });
  return { result, evidence: readFileSync(evidencePath, "utf8") };
}

describe("strict dependency audit", () => {
  test("accepts only a successful command with an empty advisory object", () => {
    const { result, evidence } = fixture('process.stdout.write("{}\\n")');
    expect(result.status).toBe("passed");
    expect(result.failure).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.advisoryPackages).toBe(0);
    expect(result.lockfileSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.helperSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(evidence)).toEqual(result);
  });

  test.each(["info", "low", "moderate", "high", "critical", "unknown"])(
    "rejects %s findings even if the command exits zero",
    (severity) => {
      const output = JSON.stringify({ package: [{ severity }] });
      const { result } = fixture(`process.stdout.write(${JSON.stringify(output)})`);
      expect(result.status).toBe("failed");
      expect(result.failure).toBe("advisories");
      expect(result.advisoryPackages).toBe(1);
    },
  );

  test.each(["", "not-json", "{}\n{}", "audit banner\n{}"])(
    "rejects malformed output %j",
    (stdout) => {
      expect(inspectAuditOutput(stdout).failure).toBe("malformed-json");
    },
  );

  test.each(["[]", "null", "false", "0", '"clean"'])(
    "rejects unexpected response shape %j",
    (stdout) => {
      expect(inspectAuditOutput(stdout).failure).toBe("unexpected-shape");
    },
  );

  test("rejects nonempty error envelopes and empty package lists", () => {
    expect(inspectAuditOutput('{"error":"registry unavailable"}').failure).toBe("advisories");
    expect(inspectAuditOutput('{"package":[]}').failure).toBe("advisories");
  });

  test("does not turn command or network failures into an empty successful audit", () => {
    const { result } = fixture(
      'process.stdout.write("{}"); process.stderr.write("registry unavailable"); process.exit(1)',
    );
    expect(result.status).toBe("failed");
    expect(result.failure).toBe("command-failed");
    expect(result.exitCode).toBe(1);
  });

  test("rejects malformed or wrong-shaped responses from the real subprocess boundary", () => {
    for (const output of ["registry unavailable", "[]"]) {
      const { result } = fixture(`process.stdout.write(${JSON.stringify(output)})`);
      expect(result.status).toBe("failed");
      expect(result.failure).toBe(output === "[]" ? "unexpected-shape" : "malformed-json");
    }
  });

  test("fails when the audit executable cannot start", () => {
    const { result } = fixture("", { command: ["/nonexistent/auggy-audit-test-binary"] });
    expect(result.status).toBe("failed");
    expect(result.failure).toBe("command-failed");
    expect(result.exitCode).toBeNull();
  });

  test("fails and terminates a timed out command", () => {
    const { result } = fixture("setInterval(() => {}, 1000)", { timeoutMs: 100 });
    expect(result.status).toBe("failed");
    expect(result.failure).toBe("timeout");
    expect(result.signal).toBe("SIGKILL");
  });

  test("bounds subprocess output", () => {
    const { result } = fixture('process.stdout.write("x".repeat(100_000))', {
      maxOutputBytes: 1024,
    });
    expect(result.status).toBe("failed");
    expect(result.failure).toBe("output-limit");
  });

  test("detects lockfile changes during the audit", () => {
    const { result } = fixture(
      'require("node:fs").writeFileSync("bun.lock", "changed"); process.stdout.write("{}")',
    );
    expect(result.status).toBe("failed");
    expect(result.failure).toBe("lockfile-changed");
  });

  test("evidence omits credentials in registry responses and diagnostics", () => {
    const secret = "fixture-private-registry-credential";
    const output = JSON.stringify({
      [secret]: [
        {
          url: "https://github.com/advisories/GHSA-6qxp-vccf-f47h",
          severity: "high",
          title: secret,
        },
        { url: `https://user:${secret}@registry.invalid`, severity: secret },
      ],
    });
    const { result, evidence } = fixture(
      `process.stdout.write(${JSON.stringify(output)}); process.stderr.write(${JSON.stringify(secret)})`,
    );
    expect(result.status).toBe("failed");
    expect(evidence).not.toContain(secret);
    expect(evidence).not.toContain("registry.invalid");
    expect(result.advisories).toEqual([
      { id: "GHSA-6qxp-vccf-f47h", severity: "high" },
      { id: null, severity: "unknown" },
    ]);
  });
});

describe("temporary workspace picomatch exception", () => {
  const finding = {
    url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
    severity: "high",
    vulnerable_versions: "<=4.0.7",
  };
  const report = { picomatch: [finding] };
  const lock = "cd4b421883d2874dba117e9410acae08207f352d99b74fcd6a9872d35afde3f7";
  const before = Date.parse("2026-12-01T23:58:59.999Z");

  test("requires the sole reviewed finding, graph and unexpired decision", () => {
    for (const other of [
      { other: [finding] },
      { ...report, other: [] },
      { picomatch: [finding, null] },
      { picomatch: [{ ...finding, severity: "critical" }] },
      { picomatch: [{ ...finding, vulnerable_versions: "<=4.0.8" }] },
      { picomatch: [{ ...finding, url: "https://github.com/advisories/another" }] },
      { picomatch: [] },
    ]) {
      expect(matchesWorkspaceException(JSON.stringify(other), lock, before)).toBe(false);
    }
    expect(matchesWorkspaceException("{", lock, before)).toBe(false);
    expect(matchesWorkspaceException(JSON.stringify(report), "different graph", before)).toBe(
      false,
    );
    expect(matchesWorkspaceException(JSON.stringify(report), lock, before + 1)).toBe(false);
    expect(matchesWorkspaceException(JSON.stringify(report), lock, before)).toBe(true);
  });

  test("only an opted-in root audit with an ordinary advisory exit accepts the finding", () => {
    setSystemTime(new Date(before));
    try {
      const code = `console.log(${JSON.stringify(JSON.stringify(report))}); console.error("bun audit v1.3.14 (0d9b296a)");`;
      const options = {
        cwd: join(import.meta.dir, "../.."),
        command: [process.execPath, "-e", `${code}process.exit(1)`] as const,
      };
      const accepted = runDependencyAudit({ ...options, workspaceException: true });
      expect(accepted.status).toBe("passed");
      expect(accepted.exitCode).toBe(1);
      expect(accepted.advisories).toHaveLength(1);
      expect(accepted.acceptedException?.id).toBe("GHSA-fc5q-39xc-vjpf");
      expect(runDependencyAudit(options).status).toBe("failed");
      expect(fixture(`${code}process.exit(1)`, { workspaceException: true }).result.status).toBe(
        "failed",
      );
      for (const ending of [
        'console.error("registry error"); process.exit(1)',
        "process.exit(2)",
      ]) {
        expect(
          runDependencyAudit({
            ...options,
            workspaceException: true,
            command: [process.execPath, "-e", `${code}${ending}`],
          }).status,
        ).toBe("failed");
      }
    } finally {
      setSystemTime();
    }
  });
});
