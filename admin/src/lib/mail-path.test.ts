import { describe, expect, it } from "bun:test";
import { isSafeMailDetailPath } from "./mail-path";

describe("isSafeMailDetailPath", () => {
  it("accepts only canonical legacy and instance-scoped Mail detail routes", () => {
    expect(isSafeMailDetailPath("/agentmail/reviews/review_1")).toBeTrue();
    expect(isSafeMailDetailPath("/agentmail/mail-west/messages/message%40one")).toBeTrue();
    expect(isSafeMailDetailPath("/agentmail/mail-west/reviews/review_1")).toBeTrue();
  });

  it("rejects route confusion, traversal, double encoding, and decoded separators", () => {
    for (const path of [
      "/agentmail/reviews/../admin",
      "/agentmail/mail-west/reviews/%2Fconsole",
      "/agentmail/mail-west/reviews/%252Fconsole",
      "/agentmail/mail-west/reviews/review_1/extra",
      "/agentmail//reviews/review_1",
      "/agentmail/./reviews/review_1",
      "/agentmail/mail-west/other/review_1",
      "/agentmail/mail-west/reviews/review_1?next=/console",
      "//agentmail/reviews/review_1",
      "/console/api/dashboard",
    ]) {
      expect(isSafeMailDetailPath(path), path).toBeFalse();
    }
  });
});
