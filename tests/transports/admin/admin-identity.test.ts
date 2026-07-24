import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIdentity, writeIdentity } from "@/transports/admin/admin-identity";
import { __setManagedRootAcquisitionHookForTest } from "@/transports/admin/admin-managed-files";

const roots: string[] = [];

afterEach(() => {
  __setManagedRootAcquisitionHookForTest(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("admin-identity — managed file isolation", () => {
  it("reads and writes a regular file below the agent root", () => {
    const root = temp("identity-regular-");
    writeFileSync(join(root, "identity.md"), "before");
    expect(readIdentity(root, "./identity.md")).toMatchObject({ content: "before" });
    expect(writeIdentity(root, "./identity.md", "after").ok).toBe(true);
    expect(readFileSync(join(root, "identity.md"), "utf-8")).toBe("after");
  });

  it("refuses leaf and parent symlinks without disclosing or mutating outside data", () => {
    const root = temp("identity-root-");
    const outside = temp("identity-outside-");
    const target = join(outside, "secret.md");
    const sentinel = "SENTINEL_IDENTITY_OUTSIDE";
    writeFileSync(target, sentinel);
    symlinkSync(target, join(root, "identity.md"));

    const readLeaf = readIdentity(root, "./identity.md");
    expect(readLeaf).toHaveProperty("error");
    expect(JSON.stringify(readLeaf)).not.toContain(sentinel);
    expect(writeIdentity(root, "./identity.md", "changed").ok).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe(sentinel);

    mkdirSync(join(outside, "nested"));
    writeFileSync(join(outside, "nested", "identity.md"), sentinel);
    symlinkSync(join(outside, "nested"), join(root, "nested"));
    expect(readIdentity(root, "./nested/identity.md")).toHaveProperty("error");
    expect(writeIdentity(root, "./nested/new.md", "changed").ok).toBe(false);
    expect(readFileSync(join(outside, "nested", "identity.md"), "utf-8")).toBe(sentinel);
    expect(() => readFileSync(join(outside, "nested", "new.md"), "utf-8")).toThrow();
  });

  it("keeps the agent root pinned when an ancestor is replaced after first use", () => {
    const container = temp("identity-container-");
    const configuredParent = join(container, "configured");
    const originalParent = join(container, "original");
    const outsideParent = join(container, "outside");
    const root = join(configuredParent, "agent");
    const outsideRoot = join(outsideParent, "agent");
    mkdirSync(root, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(join(root, "identity.md"), "before");
    writeFileSync(join(outsideRoot, "identity.md"), "outside");
    expect(readIdentity(root, "./identity.md")).toMatchObject({ content: "before" });

    renameSync(configuredParent, originalParent);
    symlinkSync(outsideParent, configuredParent, "dir");

    expect(writeIdentity(root, "./identity.md", "after").ok).toBe(true);
    expect(readFileSync(join(originalParent, "agent", "identity.md"), "utf-8")).toBe("after");
    expect(readFileSync(join(outsideRoot, "identity.md"), "utf-8")).toBe("outside");
  });

  it("rejects an ordinary-directory replacement during root acquisition", () => {
    const container = temp("identity-acquire-");
    const configuredParent = join(container, "configured");
    const originalParent = join(container, "original");
    const root = join(configuredParent, "agent");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "identity.md"), "original");
    let replaced = false;
    __setManagedRootAcquisitionHookForTest(() => {
      if (replaced) return;
      replaced = true;
      renameSync(configuredParent, originalParent);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "identity.md"), "replacement");
    });

    expect(readIdentity(root, "./identity.md")).toHaveProperty("error");
    expect(readFileSync(join(originalParent, "agent", "identity.md"), "utf8")).toBe("original");
    expect(readFileSync(join(root, "identity.md"), "utf8")).toBe("replacement");
  });
});
