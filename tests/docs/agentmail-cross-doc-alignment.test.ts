import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const surfaces = [
  "README.md",
  "docs/07-built-in-augments.md",
  "docs/18-deploy.md",
  "docs/19-visitor-auth.md",
] as const;

describe("AgentMail cross-document contract", () => {
  test("documents only exact-key connection and environment reuse", () => {
    for (const path of surfaces) {
      const source = read(path);
      expect(source).not.toContain("--mode signup");
      expect(source).not.toContain("--mode existing");
      expect(source).not.toContain("--mode manual");
      expect(source).not.toContain("--replace-key");
      expect(source).not.toContain("AGENTMAIL_ACCOUNT_API_KEY");
    }

    expect(read("README.md")).toContain("auggy agentmail setup agentMail --mode connect");
    expect(read("docs/19-visitor-auth.md")).toContain(
      "auggy agentmail setup visitorAuth --mode connect",
    );
  });

  test("keeps visitorAuth independent from mailbox inbound processing", () => {
    const visitorAuth = read("docs/19-visitor-auth.md");
    expect(visitorAuth).toContain("does not require the `agentMail` augment, inbound mail");
    expect(visitorAuth).toContain("auggy agentmail setup visitorAuth --mode env");
    expect(visitorAuth).toContain("visitor's click returns directly to Auggy's public");
  });

  test("documents durable mailbox state and the one-consumer deployment boundary", () => {
    const deploy = read("docs/18-deploy.md");
    expect(deploy).toContain("/app/data/agent-mail/<augment-name>/orchestration.db");
    expect(deploy).not.toContain("/app/data/agent-mail/<augment-name>/agent-mail.db");
    expect(deploy).toContain("one live Auggy replica per logical AgentMail inbox");
    expect(deploy).toContain("paginated provider catch-up");
  });
});
