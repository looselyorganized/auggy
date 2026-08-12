import { describe, expect, test } from "bun:test";
import { agentMail } from "../../../src/augments/agentMail";

describe("agentMail replacement boundary", () => {
  test("remains resolvable without exposing removed mailbox operations", async () => {
    const augment = agentMail({
      apiKey: "am_test",
      inboxId: "support@agentmail.to",
      inbound: { mode: "none" },
    });

    expect(augment.type).toBe("agentMail");
    expect(augment.tools).toBeUndefined();
    expect(augment.transport).toBeUndefined();
    expect((await augment.adminInfo?.())?.sections).toEqual([
      {
        kind: "status",
        level: "warn",
        message: "Replacement runtime not active",
      },
    ]);
  });

  test("rejects deleted workflow fields instead of silently reviving legacy behavior", () => {
    expect(() =>
      agentMail({
        apiKey: "am_test",
        inboxId: "support@agentmail.to",
        inbound: { mode: "none" },
        creatorDigest: { enabled: true, destination: "creator" },
      } as never),
    ).toThrow('unsupported config field "creatorDigest"');
  });

  test("fails with actionable required-credential errors", () => {
    expect(() => agentMail({ apiKey: "", inboxId: "support@agentmail.to" })).toThrow(
      "set AGENTMAIL_API_KEY in .env",
    );
    expect(() => agentMail({ apiKey: "am_test", inboxId: "" })).toThrow(
      "set AGENTMAIL_INBOX_ID in .env",
    );
  });
});
