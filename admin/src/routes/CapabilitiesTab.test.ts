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
        title: "POST /agent/run",
        detail: "AG-UI chat, creator auth",
        badges: [
          {
            id: "auth:creator",
            kind: "auth",
            label: "creator",
            tone: "neutral",
          },
        ],
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

    expect(rows[0]?.detail).toBe("AG-UI chat, anonymous allowed");
    expect(rows[0]?.badges).toEqual([
      {
        id: "auth:anonymous",
        kind: "auth",
        label: "anonymous",
        tone: "neutral",
      },
    ]);
  });
});

describe("formatMemorySurfaceCapabilities", () => {
  it("preserves the context and tools memory badge", () => {
    expect(
      formatMemorySurfaceCapabilities({ hasContext: true, usesSharedMemoryTools: true }),
    ).toBe("context, tools");
  });

  it("reports each structural memory surface independently", () => {
    expect(
      formatMemorySurfaceCapabilities({ hasContext: true, usesSharedMemoryTools: false }),
    ).toBe("context");
    expect(
      formatMemorySurfaceCapabilities({ hasContext: false, usesSharedMemoryTools: true }),
    ).toBe("tools");
  });

  it("omits the capability badge when neither structural surface is present", () => {
    expect(
      formatMemorySurfaceCapabilities({ hasContext: false, usesSharedMemoryTools: false }),
    ).toBeUndefined();
  });
});
