/**
 * Server-side tests for the Credentials helpers. Two themes:
 *
 *   1. Atomic rename (codex adversarial-review Medium-1 — the previous
 *      delete-then-set flow could drop the operator's secret on partial
 *      failure). `renameCredential` does one read/modify/write.
 *
 *   2. Round-trip parity with the runtime loader (codex High-2 — covered
 *      by tests/cli/env-parse.test.ts; here we just spot-check that setting
 *      a multiline value via setCredential reads back the same value).
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteCredential,
  listCredentials,
  renameCredential,
  revealCredential,
  setCredential,
} from "@/transports/admin/admin-credentials";

describe("admin-credentials — renameCredential atomicity", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cred-rename-"));
    writeFileSync(
      join(dir, ".env"),
      `${["# header", "ALPHA=one", "BETA=two", "# tail"].join("\n")}\n`,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renames in place with one write — comments and ordering survive", () => {
    const r = renameCredential(dir, "ALPHA", "ALPHA2", "one-updated");
    expect(r.ok).toBe(true);
    const body = readFileSync(join(dir, ".env"), "utf-8");
    // Order: header, ALPHA2 (replacing ALPHA's slot), BETA, tail.
    expect(body).toBe(`${["# header", "ALPHA2=one-updated", "BETA=two", "# tail"].join("\n")}\n`);
  });

  it("oldKey === newKey degenerates to a value update", () => {
    const r = renameCredential(dir, "BETA", "BETA", "two-updated");
    expect(r.ok).toBe(true);
    const list = listCredentials(dir);
    if ("error" in list) throw new Error(list.error);
    expect(list.entries.find((e) => e.key === "BETA")?.length).toBe("two-updated".length);
  });

  it("rejects when source key missing — no file mutation", () => {
    const before = readFileSync(join(dir, ".env"), "utf-8");
    const r = renameCredential(dir, "NOT_THERE", "WHATEVER", "x");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not found/i);
    const after = readFileSync(join(dir, ".env"), "utf-8");
    expect(after).toBe(before);
  });

  it("rejects when destination key already exists — no file mutation", () => {
    const before = readFileSync(join(dir, ".env"), "utf-8");
    const r = renameCredential(dir, "ALPHA", "BETA", "x");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/already exists/i);
    const after = readFileSync(join(dir, ".env"), "utf-8");
    expect(after).toBe(before);
  });

  it("rejects invalid newKey — no file mutation, old key still present", () => {
    const before = readFileSync(join(dir, ".env"), "utf-8");
    const r = renameCredential(dir, "ALPHA", "has spaces", "x");
    expect(r.ok).toBe(false);
    const after = readFileSync(join(dir, ".env"), "utf-8");
    expect(after).toBe(before);
    const reveal = revealCredential(dir, "ALPHA");
    expect("value" in reveal && reveal.value).toBe("one");
  });

  it("rejects null-byte value — no file mutation", () => {
    const before = readFileSync(join(dir, ".env"), "utf-8");
    const r = renameCredential(dir, "ALPHA", "ALPHA2", "bad\0value");
    expect(r.ok).toBe(false);
    const after = readFileSync(join(dir, ".env"), "utf-8");
    expect(after).toBe(before);
  });

  it("rejects oversize value — no file mutation", () => {
    const before = readFileSync(join(dir, ".env"), "utf-8");
    const huge = "x".repeat(64 * 1024 + 1);
    const r = renameCredential(dir, "ALPHA", "ALPHA2", huge);
    expect(r.ok).toBe(false);
    const after = readFileSync(join(dir, ".env"), "utf-8");
    expect(after).toBe(before);
  });
});

describe("admin-credentials — setCredential round-trips multiline", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cred-rt-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("PEM-style value reads back identical via revealCredential", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----";
    const set = setCredential(dir, "PEM", pem);
    expect(set.ok).toBe(true);
    const reveal = revealCredential(dir, "PEM");
    if ("error" in reveal) throw new Error(reveal.error);
    expect(reveal.value).toBe(pem);
  });

  it("JSON-blob value with backslash-n literal reads back identical", () => {
    const blob = '{"key": "two\\nthree"}';
    const set = setCredential(dir, "JSON_BLOB", blob);
    expect(set.ok).toBe(true);
    const reveal = revealCredential(dir, "JSON_BLOB");
    if ("error" in reveal) throw new Error(reveal.error);
    expect(reveal.value).toBe(blob);
  });

  it("deleting a key keeps surrounding comments intact", () => {
    writeFileSync(join(dir, ".env"), `${["# head", "DOOMED=value", "# tail"].join("\n")}\n`);
    const r = deleteCredential(dir, "DOOMED");
    expect(r.ok).toBe(true);
    const body = readFileSync(join(dir, ".env"), "utf-8");
    expect(body).toBe(`${["# head", "# tail"].join("\n")}\n`);
  });
});

describe("admin-credentials — managed file isolation", () => {
  it("refuses to read or mutate a symlinked .env", () => {
    const root = mkdtempSync(join(tmpdir(), "cred-symlink-root-"));
    const outside = mkdtempSync(join(tmpdir(), "cred-symlink-outside-"));
    const target = join(outside, "secret.env");
    const sentinel = "SENTINEL_SECRET=outside-only\n";
    writeFileSync(target, sentinel);
    symlinkSync(target, join(root, ".env"));

    try {
      expect(listCredentials(root)).toHaveProperty("error");
      const revealed = revealCredential(root, "SENTINEL_SECRET");
      expect(revealed).toHaveProperty("error");
      expect(JSON.stringify(revealed)).not.toContain("outside-only");
      expect(setCredential(root, "NEW_SECRET", "changed").ok).toBe(false);
      expect(renameCredential(root, "SENTINEL_SECRET", "RENAMED", "changed").ok).toBe(false);
      expect(deleteCredential(root, "SENTINEL_SECRET").ok).toBe(false);
      expect(readFileSync(target, "utf-8")).toBe(sentinel);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
