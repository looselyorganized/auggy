import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileMemory } from "@/augments/fileMemory";
import { createTempDir } from "@tests/fixtures/temp-dir";

describe("fileMemory", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await createTempDir();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it("loads file contents at boot and returns them via read()", async () => {
    const filePath = join(tmp.path, "soul.md");
    await writeFile(filePath, "I am the test agent.", "utf-8");

    const aug = fileMemory({
      label: "self",
      source: filePath,
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    });

    await aug.onBoot!();
    const entry = await aug.memory!.read!("self");
    expect(entry?.content).toBe("I am the test agent.");
  });

  it("declares static ownership of its label", () => {
    const aug = fileMemory({
      label: "self",
      source: join(tmp.path, "soul.md"),
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    });
    expect(aug.memory!.owns).toEqual({ kind: "static", labels: ["self"] });
  });

  it("sets defaults from configuration", () => {
    const aug = fileMemory({
      label: "self",
      source: join(tmp.path, "soul.md"),
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    });
    expect(aug.memory!.defaults).toEqual({
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
      ttl: "persistent",
    });
  });

  it("returns null for labels it doesn't own", async () => {
    const filePath = join(tmp.path, "soul.md");
    await writeFile(filePath, "hi", "utf-8");

    const aug = fileMemory({
      label: "self",
      source: filePath,
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    });
    await aug.onBoot!();
    const entry = await aug.memory!.read!("other");
    expect(entry).toBeNull();
  });

  it("supports mutable writes when mutable: true", async () => {
    const filePath = join(tmp.path, "notes.md");
    await writeFile(filePath, "initial", "utf-8");

    const aug = fileMemory({
      label: "notes",
      source: filePath,
      mutable: true,
      origin: "system",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });
    await aug.onBoot!();
    await aug.memory!.write!("notes", "updated content");

    const entry = await aug.memory!.read!("notes");
    expect(entry?.content).toBe("updated content");

    const onDisk = await readFile(filePath, "utf-8");
    expect(onDisk).toBe("updated content");
  });

  it("omits write method when mutable: false", () => {
    const aug = fileMemory({
      label: "self",
      source: join(tmp.path, "soul.md"),
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    });
    expect(aug.memory!.write).toBeUndefined();
  });

  it("fails onBoot if the file does not exist", async () => {
    const aug = fileMemory({
      label: "self",
      source: join(tmp.path, "nonexistent.md"),
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    });
    await expect(aug.onBoot!()).rejects.toThrow();
  });
});
