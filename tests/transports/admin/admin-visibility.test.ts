import { describe, expect, test } from "bun:test";
import { getAugmentPromotion } from "../../../admin/src/lib/visibility";

describe("console augment visibility", () => {
  test("hides the identity fileMemory backing provider", () => {
    expect(getAugmentPromotion({ type: "fileMemory", name: "identity" })).toMatchObject({
      kind: "hidden",
    });
    expect(getAugmentPromotion({ type: "fileMemory", name: "file-memory-self" })).toMatchObject({
      kind: "hidden",
    });
  });

  test("keeps ordinary fileMemory mounts visible in the Augments tab", () => {
    expect(getAugmentPromotion({ type: "fileMemory", name: "fileMemory" })).toEqual({
      kind: "unpromoted",
    });
  });
});
