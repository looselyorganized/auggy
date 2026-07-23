import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIdentity, writeIdentity } from "@/transports/admin/admin-identity";

const roots: string[] = [];

afterEach(() => {
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
});
