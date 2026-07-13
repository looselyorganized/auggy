import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { fileMemory } from "@/augments/fileMemory";
import { createTempDir } from "@tests/fixtures/temp-dir";

const { lstat, readFile, readdir, symlink, writeFile } = fsPromises;

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

  it("keeps destination and cache intact when a partial temp write fails", async () => {
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

    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation(
      async (path, data, options) => {
        if (String(data) === "not persisted") {
          await writeFile(path, "partial", options);
          throw new Error("simulated partial temp write failure");
        }
        await writeFile(path, data, options);
      },
    );
    try {
      await expect(aug.memory!.write!("notes", "not persisted")).rejects.toThrow(
        "simulated partial temp write failure",
      );
      expect((await aug.memory!.read!("notes"))?.content).toBe("initial");
      expect(await readFile(filePath, "utf-8")).toBe("initial");
      expect((await readdir(tmp.path)).filter((name) => name.includes(".auggy-"))).toEqual([]);

      await aug.memory!.write!("notes", "recovered");
      expect((await aug.memory!.read!("notes"))?.content).toBe("recovered");
      expect(await readFile(filePath, "utf-8")).toBe("recovered");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("writes through a symlink without replacing the symlink path", async () => {
    const targetPath = join(tmp.path, "learned-target.md");
    const linkPath = join(tmp.path, "learned.md");
    await writeFile(targetPath, "initial", "utf-8");
    await symlink(targetPath, linkPath);

    const aug = fileMemory({
      label: "learned",
      source: linkPath,
      mutable: true,
      origin: "operator",
      priority: "high",
      placement: "preamble",
      eviction: "drop",
    });
    await aug.onBoot!();

    await aug.memory!.write!("learned", "updated safely");

    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(linkPath, "utf-8")).toBe("updated safely");
    expect(await readFile(targetPath, "utf-8")).toBe("updated safely");
  });

  it("serializes concurrent mutable writes and keeps cache consistent with disk", async () => {
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

    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persisted: string[] = [];

    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation(
      async (path, data, options) => {
        const content = String(data);
        persisted.push(content);
        if (content === "first") {
          markFirstStarted();
          await firstMayFinish;
        }
        await writeFile(path, data, options);
      },
    );

    try {
      const firstWrite = aug.memory!.write!("notes", "first");
      await firstStarted;
      const secondWrite = aug.memory!.write!("notes", "second");

      await Promise.resolve();
      expect(persisted).toEqual(["first"]);

      releaseFirst();
      await Promise.all([firstWrite, secondWrite]);

      expect(persisted).toEqual(["first", "second"]);
      expect((await aug.memory!.read!("notes"))?.content).toBe("second");
      expect(await readFile(filePath, "utf-8")).toBe("second");
    } finally {
      releaseFirst();
      writeSpy.mockRestore();
    }
  });

  it("loads from fallback sources when the primary source is missing", async () => {
    const primaryPath = join(tmp.path, "learned-behaviors.md");
    const legacyPath = join(tmp.path, "learned.md");
    await writeFile(legacyPath, "legacy behavior", "utf-8");

    const aug = fileMemory({
      label: "learned",
      source: primaryPath,
      fallbackSources: [legacyPath],
      mutable: true,
      origin: "agent",
      priority: "high",
      placement: "preamble",
      eviction: "drop",
    });

    await aug.onBoot!();
    expect((await aug.memory!.read!("learned"))?.content).toBe("legacy behavior");

    await aug.memory!.write!("learned", "updated legacy behavior");
    expect(await readFile(legacyPath, "utf-8")).toBe("updated legacy behavior");
  });

  it("prefers the primary source over fallback sources", async () => {
    const primaryPath = join(tmp.path, "learned-behaviors.md");
    const legacyPath = join(tmp.path, "learned.md");
    await writeFile(primaryPath, "canonical behavior", "utf-8");
    await writeFile(legacyPath, "legacy behavior", "utf-8");

    const aug = fileMemory({
      label: "learned",
      source: primaryPath,
      fallbackSources: [legacyPath],
      mutable: true,
      origin: "agent",
      priority: "high",
      placement: "preamble",
      eviction: "drop",
    });

    await aug.onBoot!();
    expect((await aug.memory!.read!("learned"))?.content).toBe("canonical behavior");

    await aug.memory!.write!("learned", "updated canonical behavior");
    expect(await readFile(primaryPath, "utf-8")).toBe("updated canonical behavior");
    expect(await readFile(legacyPath, "utf-8")).toBe("legacy behavior");
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
