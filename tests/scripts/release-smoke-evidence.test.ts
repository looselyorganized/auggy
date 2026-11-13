import { describe, expect, test } from "bun:test";
import { redactEvidence } from "../../scripts/release-smoke/export-evidence";

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
