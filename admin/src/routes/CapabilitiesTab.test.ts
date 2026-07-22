import { describe, expect, it } from "bun:test";
import { buildConversationSurfaceRows, formatMemorySurfaceCapabilities } from "./CapabilitiesTab";

describe("buildConversationSurfaceRows", () => {
  it("reports the supported conversation endpoint without promoting legacy metadata routes", () => {
    const rows = buildConversationSurfaceRows({
      web: {
        allowAnonymous: { value: false, source: "default" },
      },
    });

    expect(rows).toEqual([
      {
        title: "/agent/run",
        prefix: "POST",
        detail: "Primary AG-UI conversation endpoint.",
        health: "ready",
        fields: [{ label: "Access", value: "Authentication required" }],
      },
    ]);
    expect(rows.map((row) => row.title)).not.toContain("GET /agent");
    expect(rows.map((row) => row.title)).not.toContain("GET /.well-known/agent-card.json");
  });

  it("describes anonymous access when the runtime allows it", () => {
    const rows = buildConversationSurfaceRows({
      web: {
        allowAnonymous: { value: true, source: "config" },
      },
    });

    expect(rows[0]?.fields).toEqual([{ label: "Access", value: "Public" }]);
  });
});

describe("formatMemorySurfaceCapabilities", () => {
  it("preserves the context and tools memory description", () => {
    expect(
      formatMemorySurfaceCapabilities({ hasContext: true, usesSharedMemoryTools: true }),
    ).toBe("Context contribution · Shared memory tools");
  });

  it("reports each structural memory surface independently", () => {
    expect(
      formatMemorySurfaceCapabilities({ hasContext: true, usesSharedMemoryTools: false }),
    ).toBe("Context contribution");
    expect(
      formatMemorySurfaceCapabilities({ hasContext: false, usesSharedMemoryTools: true }),
    ).toBe("Shared memory tools");
  });

  it("omits the capability description when neither structural surface is present", () => {
    expect(
      formatMemorySurfaceCapabilities({ hasContext: false, usesSharedMemoryTools: false }),
    ).toBeUndefined();
  });
});
