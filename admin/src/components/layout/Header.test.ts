import { describe, expect, it } from "bun:test";
import { buildRuntimeEndpointRows } from "./Header";

describe("buildRuntimeEndpointRows", () => {
  it("keeps runtime and health details without promoting a legacy agent card", () => {
    const rows = buildRuntimeEndpointRows("https://agent.example");

    expect(rows).toEqual([
      ["Runtime URL", "https://agent.example"],
      ["Health", "https://agent.example/health"],
    ]);
    expect(rows.map(([label]) => label)).not.toContain("Agent card");
  });

  it("uses explicit unknown values when rendered without a browser origin", () => {
    expect(buildRuntimeEndpointRows("")).toEqual([
      ["Runtime URL", "unknown"],
      ["Health", "unknown"],
    ]);
  });
});
