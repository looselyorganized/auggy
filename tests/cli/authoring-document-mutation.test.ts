import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTHORING_LIMITS,
  type MutationPlanInput,
  type PlannedFile,
} from "../../src/cli/authoring/contracts";
import { AuthoringError, readFileSnapshot } from "../../src/cli/authoring/document-io";
import { createMutationPlan } from "../../src/cli/authoring/mutation";

const directories: string[] = [];
function fixture(): MutationPlanInput {
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "auggy-plan-")));
  directories.push(projectDir);
  const path = join(projectDir, "agent.yaml");
  writeFileSync(path, "augments: []\n");
  const before = readFileSnapshot(path, 1024);
  return {
    kind: "migrate",
    projectDir,
    configRelativePath: "agent.yaml",
    inputs: [before],
    files: [
      {
        relativePath: "agent.yaml",
        before,
        bytes: Buffer.from("augments: [{ type: budgets }]\n"),
        mode: 0o644,
        role: "activation",
      },
    ],
    summary: [{ path: "agent.yaml", operation: "replace", reason: "Inline augment declarations." }],
  };
}
function support(input: MutationPlanInput, relativePath = "src/example.ts"): PlannedFile {
  return {
    relativePath,
    before: readFileSnapshot(join(input.projectDir, relativePath), 1024, { allowMissing: true }),
    bytes: Buffer.from("export {};\n"),
    mode: 0o644,
    role: "support",
  };
}
function withFile(input: MutationPlanInput, file: PlannedFile): MutationPlanInput {
  return { ...input, inputs: [...input.inputs, file.before], files: [...input.files, file] };
}
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("Expected classified failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AuthoringError);
    expect((error as AuthoringError).code).toBe(code);
  }
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("private mutation planning", () => {
  test("permits only init-owned private model snapshot creation inside .auggy", () => {
    const base = fixture();
    const modelFile = { ...support(base, ".auggy/models.lock.json"), mode: 0o600 };
    const input = withFile({ ...base, kind: "init" }, modelFile);
    expect(createMutationPlan(input).files).toHaveLength(2);
    expectCode(() => createMutationPlan({ ...input, kind: "migrate" }), "reserved-destination");
    expectCode(
      () => createMutationPlan(withFile({ ...base, kind: "init" }, { ...modelFile, mode: 0o644 })),
      "reserved-destination",
    );
    expectCode(
      () =>
        createMutationPlan(
          withFile({ ...base, kind: "init" }, support(base, ".auggy/authoring.lock")),
        ),
      "reserved-destination",
    );
  });

  test("fingerprints sorted inputs and outputs deterministically, including identity, operation, bytes, mode and role", () => {
    const base = fixture();
    const input = withFile(base, support(base));
    const first = createMutationPlan(input);
    const reordered = createMutationPlan({
      ...input,
      inputs: [...input.inputs].reverse(),
      files: [...input.files].reverse(),
    });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered.fingerprint).toBe(first.fingerprint);
    expect(createMutationPlan({ ...input, summary: [] }).fingerprint).toBe(first.fingerprint);
    expect(createMutationPlan({ ...input, kind: "augment-add" }).fingerprint).not.toBe(
      first.fingerprint,
    );
    expect(
      createMutationPlan({
        ...input,
        files: input.files.map((file, index) =>
          index ? { ...file, bytes: Buffer.from("different") } : file,
        ),
      }).fingerprint,
    ).not.toBe(first.fingerprint);
    expect(
      createMutationPlan({
        ...input,
        files: input.files.map((file, index) => (index ? { ...file, mode: 0o600 } : file)),
      }).fingerprint,
    ).not.toBe(first.fingerprint);
    const ignore = { ...support(base, ".gitignore"), role: "ignore" as const };
    expect(createMutationPlan(withFile(base, ignore)).files).toHaveLength(2);
    expect(createMutationPlan(base).files[0]?.before).toEqual(base.inputs[0]);
  });

  test("rejects corrupted bytes, conflicting identities and missing destination preconditions", () => {
    const input = fixture();
    const snapshot = input.inputs[0]!;
    if (!snapshot.exists) throw new Error("Expected file");
    expectCode(
      () => createMutationPlan({ ...input, inputs: [{ ...snapshot, sha256: "0".repeat(64) }] }),
      "invalid-precondition",
    );
    expectCode(
      () =>
        createMutationPlan({
          ...input,
          inputs: [...input.inputs, { ...snapshot, identity: { ...snapshot.identity, ino: "42" } }],
        }),
      "conflicting-precondition",
    );
    expectCode(() => createMutationPlan({ ...input, inputs: [] }), "destination-precondition");
    expectCode(
      () =>
        createMutationPlan({
          ...input,
          files: [
            {
              ...input.files[0]!,
              before: { ...snapshot, identity: { ...snapshot.identity, ino: "42" } },
            },
          ],
        }),
      "destination-precondition",
    );
    snapshot.bytes[0] = 0;
    expectCode(() => createMutationPlan(input), "invalid-precondition");
  });

  test.each([
    "../outside",
    "/absolute",
    "./dot",
    "a//b",
    "a/../b",
    "a\\b",
    "a\nb",
    "https:target",
    `a/${"b".repeat(1024)}`,
  ])("rejects uncontained or unnormalized destination %s", (path) => {
    const input = fixture();
    const file = { ...support(input), relativePath: path };
    expectCode(() => createMutationPlan(withFile(input, file)), "unsafe-destination");
  });

  test("read-only external input never authorizes writes there", () => {
    const input = fixture();
    const external = fixture().inputs[0]!;
    expect(
      createMutationPlan({ ...input, inputs: [...input.inputs, external] }).inputs,
    ).toHaveLength(2);
    expectCode(
      () => createMutationPlan(withFile(input, { ...support(input), before: external })),
      "destination-precondition",
    );
  });

  test("rejects duplicate, case-colliding, ancestor-overlap and reserved paths", () => {
    const base = fixture();
    const file = support(base, "src/Example.ts");
    const input = withFile(base, file);
    for (const path of ["src/Example.ts", "src/example.ts", "src"])
      expectCode(
        () => createMutationPlan(withFile(input, support(base, path))),
        "duplicate-destination",
      );
    for (const path of [".git/config", ".auggy/operations/record", "nested/.git/config"])
      expectCode(
        () => createMutationPlan(withFile(base, support(base, path))),
        "reserved-destination",
      );
  });

  test("symlinked parents and leaf destinations are rejected before publication", () => {
    const input = fixture();
    const outside = fixture().projectDir;
    symlinkSync(outside, join(input.projectDir, "src"));
    expectCode(() => createMutationPlan(withFile(input, support(input))), "unsafe-destination");
    const leaf = {
      ...support(input, "leaf"),
      before: { path: join(input.projectDir, "leaf"), exists: false as const },
    };
    symlinkSync(join(outside, "agent.yaml"), join(input.projectDir, "leaf"));
    expectCode(() => createMutationPlan(withFile(input, leaf)), "unsafe-destination");
  });

  test("requires exactly one activation and dedicated roles for sensitive destinations", () => {
    const input = fixture();
    expectCode(
      () => createMutationPlan({ ...input, files: [], summary: [] }),
      "invalid-activation",
    );
    expectCode(
      () => createMutationPlan(withFile(input, { ...support(input), role: "activation" })),
      "invalid-role",
    );
    expectCode(
      () => createMutationPlan(withFile(input, { ...support(input), role: "ignore" })),
      "invalid-role",
    );
    expectCode(() => createMutationPlan(withFile(input, support(input, ".env"))), "invalid-role");
    const env = { ...support(input, ".env"), role: "new-env" as const, mode: 0o600 };
    expectCode(() => createMutationPlan(withFile(input, env)), "invalid-role");
    expect(createMutationPlan(withFile({ ...input, kind: "init" }, env)).files).toHaveLength(2);
    expectCode(
      () => createMutationPlan(withFile({ ...input, kind: "init" }, { ...env, mode: 0o644 })),
      "invalid-role",
    );
    expectCode(
      () => createMutationPlan({ ...input, files: [{ ...input.files[0]!, mode: 0o4755 }] }),
      "invalid-mode",
    );
  });

  test("enforces output, input, write-count and summary bounds", () => {
    const input = fixture();
    expectCode(
      () =>
        createMutationPlan(
          withFile(input, {
            ...support(input),
            bytes: Buffer.alloc(AUTHORING_LIMITS.outputBytes + 1),
          }),
        ),
      "output-limit",
    );
    const files = Array.from({ length: 256 }, (_, index) => support(input, `src/file${index}.ts`));
    expectCode(
      () =>
        createMutationPlan({
          ...input,
          inputs: [...input.inputs, ...files.map((file) => file.before)],
          files: [...input.files, ...files],
        }),
      "plan-limit",
    );
    const largeFiles = Array.from({ length: 5 }, (_, index) => ({
      ...support(input, `src/large${index}.ts`),
      bytes: Buffer.alloc(AUTHORING_LIMITS.outputBytes),
    }));
    expectCode(
      () =>
        createMutationPlan({
          ...input,
          inputs: [...input.inputs, ...largeFiles.map((file) => file.before)],
          files: [...input.files, ...largeFiles],
        }),
      "output-limit",
    );
    expectCode(
      () =>
        createMutationPlan({
          ...input,
          summary: [{ path: "agent.yaml", operation: "create", reason: "Wrong operation." }],
        }),
      "invalid-summary",
    );
    expectCode(
      () =>
        createMutationPlan({
          ...input,
          summary: [{ path: "agent.yaml", operation: "replace", reason: "x".repeat(1025) }],
        }),
      "invalid-summary",
    );
  });
});

test("central activation cannot exceed its next-read limit and aggregate inputs are bounded", () => {
  const input = fixture();
  expectCode(
    () =>
      createMutationPlan({
        ...input,
        files: [{ ...input.files[0]!, bytes: Buffer.alloc(AUTHORING_LIMITS.documentBytes + 1) }],
      }),
    "output-limit",
  );
  const extra = Array.from({ length: 3 }, (_, index) => {
    const path = join(input.projectDir, `input${index}`);
    writeFileSync(path, Buffer.alloc(3_000_000));
    return readFileSnapshot(path, AUTHORING_LIMITS.outputBytes);
  });
  expectCode(
    () => createMutationPlan({ ...input, inputs: [...input.inputs, ...extra] }),
    "input-limit",
  );
});
