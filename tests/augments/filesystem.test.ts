import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { filesystem, isWithinMount } from "@/augments/filesystem";
import { createTempDir } from "@tests/fixtures/temp-dir";

describe("filesystem augment", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await createTempDir();
    // Set up a test directory structure:
    // tmp/
    //   readable/
    //     hello.txt ("hello world")
    //     sub/
    //       nested.md ("nested content")
    //     big.txt (500KB of 'x')
    //     logo.png (fake binary — empty but has binary extension)
    //   writable/
    //     (empty — for write tests)
    //   deletable/
    //     trash.txt ("delete me")
    //     nonempty/
    //       keep.txt ("keep")
    await mkdir(join(tmp.path, "readable", "sub"), { recursive: true });
    await mkdir(join(tmp.path, "writable"), { recursive: true });
    await mkdir(join(tmp.path, "deletable", "nonempty"), {
      recursive: true,
    });

    await writeFile(join(tmp.path, "readable", "hello.txt"), "hello world", "utf-8");
    await writeFile(join(tmp.path, "readable", "sub", "nested.md"), "nested content", "utf-8");
    await writeFile(join(tmp.path, "readable", "big.txt"), "x".repeat(500 * 1024), "utf-8");
    await writeFile(join(tmp.path, "readable", "logo.png"), "", "utf-8");
    await writeFile(join(tmp.path, "deletable", "trash.txt"), "delete me", "utf-8");
    await writeFile(join(tmp.path, "deletable", "nonempty", "keep.txt"), "keep", "utf-8");
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  function createTestFs(overrides?: { mounts?: Parameters<typeof filesystem>[0]["mounts"] }) {
    const mounts = overrides?.mounts ?? [
      { name: "read", path: join(tmp.path, "readable"), writable: false },
      {
        name: "work",
        path: join(tmp.path, "writable"),
        writable: true,
      },
      {
        name: "del",
        path: join(tmp.path, "deletable"),
        writable: true,
        deletable: true,
      },
    ];
    return filesystem({ mounts });
  }

  async function execTool(
    aug: ReturnType<typeof filesystem>,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    await aug.onBoot!();
    const tool = aug.tools!.find((t) => t.name === toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);
    return tool.execute(input);
  }

  // === Structure ===

  describe("structure", () => {
    it("returns an augment with 6 tools", () => {
      const aug = createTestFs();
      expect(aug.name).toBe("filesystem");
      expect(aug.tools).toHaveLength(6);
      const names = aug.tools!.map((t) => t.name);
      expect(names).toContain("fs_read");
      expect(names).toContain("fs_write");
      expect(names).toContain("fs_list");
      expect(names).toContain("fs_mkdir");
      expect(names).toContain("fs_remove");
      expect(names).toContain("fs_search");
    });

    it("sets maxToolCallsPerTurn to 15", () => {
      const aug = createTestFs();
      expect(aug.constraints?.maxToolCallsPerTurn).toBe(15);
    });

    it("sets perTrustLevel structural defaults for public + agent", () => {
      const aug = createTestFs();
      expect(aug.constraints?.perTrustLevel?.public?.neverExpose).toEqual([
        "fs_write",
        "fs_mkdir",
        "fs_remove",
      ]);
      expect(aug.constraints?.perTrustLevel?.agent?.neverExpose).toEqual(["fs_remove"]);
      expect(aug.constraints?.perTrustLevel?.creator).toBeUndefined();
    });

    it("throws on duplicate mount names", () => {
      expect(() =>
        filesystem({
          mounts: [
            { name: "a", path: "/tmp/a" },
            { name: "a", path: "/tmp/b" },
          ],
        }),
      ).toThrow(/duplicate mount name/);
    });

    it("throws on mount names with path separators", () => {
      expect(() => filesystem({ mounts: [{ name: "a/b", path: "/tmp/ab" }] })).toThrow(
        /must not contain path separators/,
      );
    });

    it("throws if deletable but not writable", () => {
      expect(() =>
        filesystem({
          mounts: [
            {
              name: "bad",
              path: "/tmp/bad",
              writable: false,
              deletable: true,
            },
          ],
        }),
      ).toThrow(/deletable requires writable/);
    });
  });

  // === fs_read ===

  describe("fs_read", () => {
    it("reads a file from a mounted directory", async () => {
      const aug = createTestFs();
      const result = await execTool(aug, "fs_read", {
        path: "read/hello.txt",
      });
      expect(result).toBe("hello world");
    });

    it("reads nested files", async () => {
      const aug = createTestFs();
      const result = await execTool(aug, "fs_read", {
        path: "read/sub/nested.md",
      });
      expect(result).toBe("nested content");
    });

    it("truncates files over maxReadSize", async () => {
      const aug = filesystem({
        mounts: [
          {
            name: "read",
            path: join(tmp.path, "readable"),
            maxReadSize: 1024,
          },
        ],
      });
      const result = await execTool(aug, "fs_read", {
        path: "read/big.txt",
      });
      expect(result).toContain("[truncated at");
      expect(result).toContain("total size:");
      expect(result.length).toBeLessThan(2000);
    });

    it("rejects binary files with a useful error", async () => {
      const aug = createTestFs();
      const result = await execTool(aug, "fs_read", {
        path: "read/logo.png",
      });
      expect(result).toContain("Error: Binary file");
      expect(result).toContain(".png");
    });

    it("returns an error for directories", async () => {
      const aug = createTestFs();
      const result = await execTool(aug, "fs_read", {
        path: "read/sub",
      });
      expect(result).toContain("is a directory");
    });

    it("rejects unknown mount names", async () => {
      const aug = createTestFs();
      await expect(execTool(aug, "fs_read", { path: "nonexistent/file.txt" })).rejects.toThrow(
        /Unknown mount/,
      );
    });
  });

  // === Path traversal security ===

  describe("security", () => {
    it("rejects path traversal via ../", async () => {
      const aug = createTestFs();
      await expect(execTool(aug, "fs_read", { path: "read/../../etc/passwd" })).rejects.toThrow(
        /outside mount.*boundary/,
      );
    });

    it("rejects path traversal via encoded ../", async () => {
      const aug = createTestFs();
      await expect(
        execTool(aug, "fs_read", { path: "read/sub/../../../etc/passwd" }),
      ).rejects.toThrow(/outside mount.*boundary/);
    });

    it("rejects write-path traversal via ../", async () => {
      const aug = createTestFs();
      await expect(
        execTool(aug, "fs_write", {
          path: "work/../../etc/evil.txt",
          content: "escaped",
        }),
      ).rejects.toThrow(/outside mount.*boundary/);
    });

    it("rejects mkdir-path traversal via ../", async () => {
      const aug = createTestFs();
      await expect(execTool(aug, "fs_mkdir", { path: "work/../../escape" })).rejects.toThrow(
        /outside mount.*boundary/,
      );
    });

    it("rejects remove-path traversal via ../", async () => {
      const aug = createTestFs();
      await expect(execTool(aug, "fs_remove", { path: "del/../../etc/passwd" })).rejects.toThrow(
        /outside mount.*boundary/,
      );
    });

    it("rejects symlinks that escape the mount boundary", async () => {
      // Create a symlink inside readable/ that points outside
      const linkPath = join(tmp.path, "readable", "escape-link.txt");
      await symlink("/etc/hosts", linkPath);

      const aug = createTestFs();
      // resolveAndValidate catches the symlink escape via realpath and throws.
      // In production, the turn loop's try/catch converts this to an error
      // string. Here we verify the security check fires.
      await expect(execTool(aug, "fs_read", { path: "read/escape-link.txt" })).rejects.toThrow(
        /outside mount.*boundary/,
      );
    });

    // Codex review P2: separator-suffix check broke mounts rooted at
    // filesystem roots ("/" on POSIX). These pure-unit tests verify the
    // new `path.relative`-based boundary check handles root mounts,
    // prefix-collision siblings, and cross-drive cases uniformly.
    it("isWithinMount allows children of a root-level mount (POSIX `/`)", () => {
      expect(isWithinMount("/etc/hosts", "/")).toBe(true);
      expect(isWithinMount("/", "/")).toBe(true);
      expect(isWithinMount("/usr/local/bin/foo", "/")).toBe(true);
    });

    it("isWithinMount still rejects prefix-collision siblings", () => {
      // mountRoot /var/data/work — target /var/data/workspace/file starts
      // with the same string prefix but is outside the mount.
      expect(isWithinMount("/var/data/workspace/file", "/var/data/work")).toBe(false);
      expect(isWithinMount("/tmp/abc/file", "/tmp/a")).toBe(false);
    });

    it("isWithinMount rejects parent traversal", () => {
      expect(isWithinMount("/tmp", "/tmp/a")).toBe(false);
      expect(isWithinMount("/", "/tmp/a")).toBe(false);
    });

    it("isWithinMount accepts direct descendants and the mount itself", () => {
      expect(isWithinMount("/tmp/a", "/tmp/a")).toBe(true);
      expect(isWithinMount("/tmp/a/b", "/tmp/a")).toBe(true);
      expect(isWithinMount("/tmp/a/b/c/d", "/tmp/a")).toBe(true);
    });

    it("rejects symlinks that escape via prefix-collision sibling (Codex Finding 2)", async () => {
      // Create mount root `readable/` and a sibling `readable-evil/` whose
      // path starts with the mountRoot as a string prefix. A symlink inside
      // readable/ points into readable-evil/. Before the separator-aware
      // boundary check, `startsWith(mountRoot)` returned true and the
      // symlink was accepted.
      await mkdir(join(tmp.path, "readable-evil"), { recursive: true });
      await writeFile(
        join(tmp.path, "readable-evil", "secret.txt"),
        "should not be readable",
        "utf-8",
      );
      const linkPath = join(tmp.path, "readable", "collision-link.txt");
      await symlink(join(tmp.path, "readable-evil", "secret.txt"), linkPath);

      const aug = createTestFs();
      await expect(execTool(aug, "fs_read", { path: "read/collision-link.txt" })).rejects.toThrow(
        /outside mount.*boundary/,
      );
    });
  });

  // === fs_write ===

  describe("fs_write", () => {
    it("writes a file to a writable mount", async () => {
      const aug = createTestFs();
      const result = await execTool(aug, "fs_write", {
        path: "work/test.txt",
        content: "written by agent",
      });
      expect(result).toContain("Written");

      // Verify on disk
      const onDisk = await readFile(join(tmp.path, "writable", "test.txt"), "utf-8");
      expect(onDisk).toBe("written by agent");
    });

    it("creates parent directories automatically", async () => {
      const aug = createTestFs();
      await execTool(aug, "fs_write", {
        path: "work/deep/nested/dir/file.md",
        content: "deep write",
      });

      const onDisk = await readFile(
        join(tmp.path, "writable", "deep", "nested", "dir", "file.md"),
        "utf-8",
      );
      expect(onDisk).toBe("deep write");
    });

    it("rejects writes to read-only mounts", async () => {
      const aug = createTestFs();
      await expect(
        execTool(aug, "fs_write", {
          path: "read/hacked.txt",
          content: "nope",
        }),
      ).rejects.toThrow(/read-only/);
    });

    it("rejects writes exceeding maxWriteSize", async () => {
      const aug = filesystem({
        mounts: [
          {
            name: "work",
            path: join(tmp.path, "writable"),
            writable: true,
            maxWriteSize: 100,
          },
        ],
      });
      const result = await execTool(aug, "fs_write", {
        path: "work/big.txt",
        content: "x".repeat(200),
      });
      expect(result).toContain("exceeds max write size");
    });
  });

  // === fs_list ===

  describe("fs_list", () => {
    it("lists directory contents with types and sizes", async () => {
      const aug = createTestFs();
      const result = await execTool(aug, "fs_list", { path: "read" });
      const parsed = JSON.parse(result) as {
        entries: Array<{ name: string; type: string; size?: number }>;
      };

      expect(parsed.entries.length).toBeGreaterThan(0);
      const names = parsed.entries.map((e) => e.name);
      expect(names).toContain("hello.txt");
      expect(names).toContain("sub");

      // Directories first, then files
      const subEntry = parsed.entries.find((e) => e.name === "sub");
      expect(subEntry?.type).toBe("dir");
    });

    it("returns stat info for a single file", async () => {
      const aug = createTestFs();
      const result = await execTool(aug, "fs_list", {
        path: "read/hello.txt",
      });
      const parsed = JSON.parse(result) as {
        type: string;
        size: number;
      };
      expect(parsed.type).toBe("file");
      expect(parsed.size).toBe(11); // "hello world"
    });
  });

  // === fs_mkdir ===

  describe("fs_mkdir", () => {
    it("creates a directory in a writable mount", async () => {
      const aug = createTestFs();
      const result = await execTool(aug, "fs_mkdir", {
        path: "work/new-dir",
      });
      expect(result).toContain("Created directory");
    });

    it("rejects mkdir on read-only mounts", async () => {
      const aug = createTestFs();
      await expect(execTool(aug, "fs_mkdir", { path: "read/new-dir" })).rejects.toThrow(
        /read-only/,
      );
    });
  });

  // === fs_remove ===

  describe("fs_remove", () => {
    it("removes a file from a deletable mount", async () => {
      const aug = createTestFs();
      const result = await execTool(aug, "fs_remove", {
        path: "del/trash.txt",
      });
      expect(result).toContain("Removed file");
    });

    it("rejects removal from non-deletable writable mounts", async () => {
      // "work" is writable but not deletable
      await writeFile(join(tmp.path, "writable", "temp.txt"), "temp", "utf-8");
      const aug = createTestFs();
      await expect(execTool(aug, "fs_remove", { path: "work/temp.txt" })).rejects.toThrow(
        /does not allow deletion/,
      );
    });

    it("rejects removal of non-empty directories", async () => {
      const aug = createTestFs();
      const result = await execTool(aug, "fs_remove", {
        path: "del/nonempty",
      });
      expect(result).toContain("not empty");
    });
  });

  // === fs_search ===

  describe("fs_search", () => {
    it("finds files matching a glob pattern", async () => {
      const aug = createTestFs();
      const result = await execTool(aug, "fs_search", {
        path: "read",
        pattern: "**/*.md",
      });
      const parsed = JSON.parse(result) as {
        results: string[];
        count: number;
      };
      expect(parsed.count).toBeGreaterThan(0);
      expect(parsed.results.some((r) => r.includes("nested.md"))).toBe(true);
    });

    it("returns a message when no files match", async () => {
      const aug = createTestFs();
      const result = await execTool(aug, "fs_search", {
        path: "read",
        pattern: "*.xyz",
      });
      expect(result).toContain("No files matching");
    });

    it("respects maxResults cap", async () => {
      // Create many files
      for (let i = 0; i < 10; i++) {
        await writeFile(join(tmp.path, "writable", `file-${i}.txt`), `content ${i}`, "utf-8");
      }
      const aug = createTestFs();
      const result = await execTool(aug, "fs_search", {
        path: "work",
        pattern: "*.txt",
        maxResults: 3,
      });
      const parsed = JSON.parse(result) as {
        results: string[];
        truncated: boolean;
      };
      expect(parsed.results.length).toBe(3);
      expect(parsed.truncated).toBe(true);
    });
  });

  // === SKILL.md loading ===

  describe("skill loading", () => {
    it("boot-loads a SKILL.md and returns it as an evictable context block", async () => {
      const skillPath = join(tmp.path, "SKILL.md");
      await writeFile(skillPath, "# Filesystem Guide\nUse fs_read to read files.", "utf-8");

      const aug = filesystem({
        mounts: [{ name: "read", path: join(tmp.path, "readable") }],
        skillFile: skillPath,
      });
      await aug.onBoot!();

      expect(aug.context).toBeDefined();
      const blocks = (await aug.context!({} as any, undefined)) as Array<{
        content: string;
        priority: string;
      }>;

      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.content).toContain("Filesystem Guide");
      expect(blocks[0]!.priority).toBe("evictable");
    });

    it("handles missing SKILL.md gracefully (no boot failure)", async () => {
      const aug = filesystem({
        mounts: [{ name: "read", path: join(tmp.path, "readable") }],
        skillFile: join(tmp.path, "nonexistent-skill.md"),
      });
      // Should not throw
      await aug.onBoot!();
    });
  });
});
