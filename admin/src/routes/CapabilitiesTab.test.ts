import { describe, expect, it } from "bun:test";
import { formatMemorySurfaceCapabilities } from "./CapabilitiesTab";

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
