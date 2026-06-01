import { describe, test, expect } from "bun:test";
import { shouldExtract } from "@/augments/layeredMemory/extractor/frequency";

describe("shouldExtract", () => {
  const config = {
    creator: "every-turn" as const,
    agent: "every-N-turns" as const,
    public: { recognized: "every-turn" as const, anonymous: "session-end-only" as const },
  };
  const everyN = 3;

  test("creator + every-turn → extract", () => {
    expect(shouldExtract({ trustLevel: "creator" }, 0, config, everyN)).toBe("extract");
    expect(shouldExtract({ trustLevel: "creator" }, 5, config, everyN)).toBe("extract");
  });

  test("agent + every-N-turns(3) → extract on 0, 3, 6...", () => {
    expect(shouldExtract({ trustLevel: "agent" }, 0, config, everyN)).toBe("extract");
    expect(shouldExtract({ trustLevel: "agent" }, 1, config, everyN)).toBe("skip");
    expect(shouldExtract({ trustLevel: "agent" }, 2, config, everyN)).toBe("skip");
    expect(shouldExtract({ trustLevel: "agent" }, 3, config, everyN)).toBe("extract");
  });

  test("public.recognized + every-turn → extract", () => {
    expect(
      shouldExtract({ trustLevel: "public", publicSubstate: "recognized" }, 0, config, everyN),
    ).toBe("extract");
  });

  test("public.anonymous + session-end-only → buffer", () => {
    expect(
      shouldExtract({ trustLevel: "public", publicSubstate: "anonymous" }, 0, config, everyN),
    ).toBe("buffer");
    expect(
      shouldExtract({ trustLevel: "public", publicSubstate: "anonymous" }, 5, config, everyN),
    ).toBe("buffer");
  });

  test("'never' → skip", () => {
    const c = { ...config, agent: "never" as const };
    expect(shouldExtract({ trustLevel: "agent" }, 0, c, everyN)).toBe("skip");
  });

  test("missing publicSubstate when trustLevel=public → fallback to anonymous", () => {
    expect(shouldExtract({ trustLevel: "public" }, 0, config, everyN)).toBe("buffer");
  });

  test("unknown trust level → skip", () => {
    expect(shouldExtract({ trustLevel: "unknown" as never }, 0, config, everyN)).toBe("skip");
  });
});
