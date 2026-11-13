import { describe, expect, test } from "bun:test";
import {
  assertRetainedAuthoringOwnership,
  ownershipChangedMembers,
  runGeneratedOwnershipUpdate,
  type RetainedAuthoringSnapshot,
} from "../../scripts/release-smoke/authoring-ownership";
import {
  applicationHash,
  type PackedArtifactEvidence,
} from "../../scripts/release-smoke/application-consumer";

// Typecheck the real orchestrator; these controls never claim an installed update.
void runGeneratedOwnershipUpdate;
const snapshot = (): RetainedAuthoringSnapshot => ({
  source: {
    "src/turn.ts": applicationHash("edited turn"),
    "skills/owned/SKILL.md": applicationHash("edited skill"),
  },
  state: { "data/ownership.sqlite": applicationHash("durable bytes") },
  credentialSHA256: applicationHash("private bytes never reported"),
});
function artifact(variant: string): PackedArtifactEvidence {
  return {
    packageName: "auggy",
    version: "0.5.0",
    sha256: applicationHash(variant),
    manifest: {
      name: "auggy",
      version: "0.5.0",
      auggyRuntime: { schemaVersion: 1, launcherProtocol: 1, applicationContracts: [1] },
    },
    fileHashes: {
      "package.json": applicationHash("same manifest"),
      "src/cli/index.ts": applicationHash(variant),
    },
  };
}

describe("generated ownership evidence controls", () => {
  test("identical owned bytes pass without exposing credential values", () => {
    expect(() => assertRetainedAuthoringOwnership(snapshot(), snapshot())).not.toThrow();
  });
  test("source, skill, state and credential changes each invalidate preservation", () => {
    for (const file of ["src/turn.ts", "skills/owned/SKILL.md"]) {
      const changed = snapshot();
      changed.source = { ...changed.source, [file]: applicationHash("rewritten") };
      expect(() => assertRetainedAuthoringOwnership(snapshot(), changed)).toThrow(
        "unexpected files",
      );
    }
    const state = snapshot();
    state.state = { "data/ownership.sqlite": applicationHash("changed state") };
    expect(() => assertRetainedAuthoringOwnership(snapshot(), state)).toThrow("unexpected files");
    const credentials = snapshot();
    credentials.credentialSHA256 = applicationHash("replaced credentials");
    expect(() => assertRetainedAuthoringOwnership(snapshot(), credentials)).toThrow(
      "credential bytes",
    );
  });
  test("missing owned files and empty state cannot manufacture preservation", () => {
    const missing = snapshot();
    missing.source = {};
    expect(() => assertRetainedAuthoringOwnership(snapshot(), missing)).toThrow("unexpected files");
    const empty = snapshot();
    empty.state = {};
    expect(() => assertRetainedAuthoringOwnership(empty, empty)).toThrow(
      "actual source and durable state",
    );
  });
  test("artifact evidence must actually differ in an observed installed member", () => {
    const before = artifact("before"),
      after = artifact("after");
    expect(ownershipChangedMembers(before, after)).toEqual(["src/cli/index.ts"]);
    expect(() => ownershipChangedMembers(before, before)).toThrow("distinct actual artifacts");
    after.fileHashes = before.fileHashes;
    expect(() => ownershipChangedMembers(before, after)).toThrow(
      "observed changed installed member",
    );
    const incapable = artifact("old");
    incapable.manifest.auggyRuntime = undefined;
    expect(() => ownershipChangedMembers(incapable, before)).toThrow("contract-1");
  });
});
