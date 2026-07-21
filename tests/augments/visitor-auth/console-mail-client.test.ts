import { describe, expect, it, spyOn } from "bun:test";
import { createConsoleMailClient } from "@/augments/visitorAuth/console-mail-client";

describe("createConsoleMailClient", () => {
  it("send writes a header line containing recipient + subject to the sink", async () => {
    const lines: string[] = [];
    const client = createConsoleMailClient({ sink: (l) => lines.push(l) });
    const result = await client.send({
      inboxId: "console",
      to: ["dave@example.com"],
      subject: "[Verify] Confirm your email",
      text: "Click to verify: http://localhost:8080/visitor-auth/verify?token=abc123",
    });
    expect(result.status).toBe("sent");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("INFO visitorAuth local verification link");
    expect(lines[0]).toContain("  To: dave@example.com");
    expect(lines[0]).toContain("  Subject: [Verify] Confirm your email");
    expect(lines[0]).not.toContain("would-send");
  });

  it("send embeds the verbatim message text (with verify URL) so operators can copy from terminal", async () => {
    const lines: string[] = [];
    const client = createConsoleMailClient({ sink: (l) => lines.push(l) });
    const verifyUrl =
      "http://localhost:8080/visitor-auth/verify?token=550e8400-e29b-41d4-a716-446655440000";
    await client.send({
      inboxId: "console",
      to: ["alice@example.com"],
      subject: "Verify",
      text: `Hello! Verify your email here: ${verifyUrl}\nExpires in 15 minutes.`,
    });
    expect(lines[0]).toContain(verifyUrl);
    expect(lines[0]).toContain("Expires in 15 minutes.");
    expect(lines[0]?.split(verifyUrl)).toHaveLength(2);
  });

  it("send returns synthetic messageId / threadId with the 'console-' prefix", async () => {
    const client = createConsoleMailClient({ sink: () => {} });
    const result = await client.send({
      inboxId: "console",
      to: ["x@example.com"],
      subject: "s",
      text: "t",
    });
    expect(result.status).toBe("sent");
    if (result.status !== "sent") return; // type guard
    expect(result.messageId).toMatch(/^console-/);
    expect(result.threadId).toMatch(/^console-thread-/);
  });

  it("multiple sends each reach the sink in order", async () => {
    const lines: string[] = [];
    const client = createConsoleMailClient({ sink: (l) => lines.push(l) });
    await client.send({ inboxId: "console", to: ["a@x"], subject: "s1", text: "t1" });
    await client.send({ inboxId: "console", to: ["b@x"], subject: "s2", text: "t2" });
    await client.send({ inboxId: "console", to: ["c@x"], subject: "s3", text: "t3" });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("a@x");
    expect(lines[1]).toContain("b@x");
    expect(lines[2]).toContain("c@x");
  });

  it("getInbox returns synthetic OK without touching the network", async () => {
    const client = createConsoleMailClient({ sink: () => {} });
    const result = await client.getInbox("anything");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.inboxId).toBe("anything");
    }
  });

  it("default sink is console.log (uncaptured smoke test)", async () => {
    const client = createConsoleMailClient();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await client.send({
        inboxId: "console",
        to: ["smoke@example.com"],
        subject: "smoke",
        text: "smoke test",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = String(spy.mock.calls[0]![0]);
      expect(arg).toContain("smoke@example.com");
    } finally {
      spy.mockRestore();
    }
  });

  it("multiple recipients are joined with comma-space in the header", async () => {
    const lines: string[] = [];
    const client = createConsoleMailClient({ sink: (l) => lines.push(l) });
    await client.send({
      inboxId: "console",
      to: ["a@x.com", "b@x.com"],
      subject: "multi",
      text: "body",
    });
    expect(lines[0]).toContain("a@x.com, b@x.com");
  });
});
