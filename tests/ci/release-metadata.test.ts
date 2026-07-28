import { describe, expect, test } from "bun:test";
import { resolveReleaseMetadata } from "../../scripts/release-metadata";

describe("release tag metadata", () => {
  test("routes stable releases to latest", () => {
    expect(resolveReleaseMetadata("v0.5.0")).toEqual({
      version: "0.5.0",
      npmTag: "latest",
      prerelease: false,
    });
  });

  test("routes exact prereleases to next", () => {
    expect(resolveReleaseMetadata("v0.5.0-rc.1")).toEqual({
      version: "0.5.0-rc.1",
      npmTag: "next",
      prerelease: true,
    });
    expect(resolveReleaseMetadata("v2.0.0-beta.2.sha-abcdef")).toEqual({
      version: "2.0.0-beta.2.sha-abcdef",
      npmTag: "next",
      prerelease: true,
    });
  });

  test("fails closed on malformed or ambiguous tags", () => {
    for (const tag of [
      "0.5.0",
      "v0.5",
      "v0.5.0-",
      "v0.5.0-rc.01",
      "v01.5.0",
      "v0.5.0+build.1",
      "v0.5.0-rc.1\nlatest",
      "release/v0.5.0",
    ]) {
      expect(() => resolveReleaseMetadata(tag), tag).toThrow(/release tag must be exact/);
    }
  });
});
