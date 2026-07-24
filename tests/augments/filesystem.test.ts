import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  access,
  writeFile,
  mkdir,
  symlink,
  readFile,
  link,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { filesystem, isWithinMount } from "@/augments/filesystem";
import type { ContextBlock, PeerIdentity, ToolExecuteContext, TurnState } from "@/types";
import { createTempDir } from "@tests/fixtures/temp-dir";
import { asStringTool } from "@tests/fixtures/tool-helpers";

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

  const creatorPeer: PeerIdentity = {
    id: "creator",
    kind: "human",
    trustLevel: "creator",
    sourceAugment: "webTransport",
  };

  const publicPeer: PeerIdentity = {
    id: "visitor-1",
    kind: "human",
    trustLevel: "public",
    publicSubstate: "anonymous",
    sourceAugment: "webTransport",
  };

  const creatorCtx: ToolExecuteContext = {
    turnId: "turn-1",
    threadId: "thread-1",
    peer: creatorPeer,
  };

  const publicCtx: ToolExecuteContext = {
    turnId: "turn-1",
    threadId: "thread-1",
    peer: publicPeer,
  };

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
    context?: ToolExecuteContext,
  ): Promise<string> {
    await aug.onBoot!();
    const tool = aug.tools!.find((t) => t.name === toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);
    return asStringTool(tool).execute(input, context);
  }

  async function writeSkill(folder: string, content: string): Promise<void> {
    const dir = join(tmp.path, "skills", folder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), content, "utf-8");
  }

  function messageTurn(peer: PeerIdentity | null, text: string): TurnState {
    return {
      peer,
      trigger: {
        type: "message",
        payload: { parts: [{ kind: "text", text }] },
      },
    } as unknown as TurnState;
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

  it("creates and canonicalizes a missing writable mount root at boot", async () => {
    const root = join(tmp.path, "not-created", "work");
    const aug = filesystem({
      mounts: [{ name: "work", path: root, writable: true }],
    });

    expect(await execTool(aug, "fs_write", { path: "work/new.txt", content: "safe" })).toContain(
      "Written",
    );
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("safe");
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

    it("rejects readable hard links to files outside the mount", async () => {
      const outside = join(tmp.path, "outside-read-hardlink.txt");
      const inside = join(tmp.path, "readable", "hardlink.txt");
      await writeFile(outside, "outside secret", "utf8");
      await link(outside, inside);

      const aug = createTestFs();
      expect(await execTool(aug, "fs_read", { path: "read/hardlink.txt" })).toContain(
        "multiple filesystem links",
      );
    });

    it("rejects a write through an escaping symlink parent when the leaf does not exist", async () => {
      const outside = join(tmp.path, "outside-write");
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(tmp.path, "writable", "escape-parent"), "dir");

      const aug = createTestFs();
      await expect(
        execTool(aug, "fs_write", {
          path: "work/escape-parent/new.txt",
          content: "must stay inside the mount",
        }),
      ).rejects.toThrow(/outside mount.*boundary/);
      await expect(access(join(outside, "new.txt"))).rejects.toThrow();
    });

    it("rejects mkdir through an escaping symlink parent when the target does not exist", async () => {
      const outside = join(tmp.path, "outside-mkdir");
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(tmp.path, "writable", "escape-parent"), "dir");

      const aug = createTestFs();
      await expect(
        execTool(aug, "fs_mkdir", { path: "work/escape-parent/new-directory" }),
      ).rejects.toThrow(/outside mount.*boundary/);
      await expect(access(join(outside, "new-directory"))).rejects.toThrow();
    });

    it("rejects writes through any symlinked parent, including links that currently stay inside", async () => {
      await mkdir(join(tmp.path, "writable", "real-parent"), { recursive: true });
      await symlink(
        join(tmp.path, "writable", "real-parent"),
        join(tmp.path, "writable", "linked-parent"),
        "dir",
      );

      const aug = createTestFs();
      await expect(
        execTool(aug, "fs_write", {
          path: "work/linked-parent/new.txt",
          content: "do not follow mutation aliases",
        }),
      ).rejects.toThrow(/symlink/);
      await expect(access(join(tmp.path, "writable", "real-parent", "new.txt"))).rejects.toThrow();
    });

    it("rejects search patterns that traverse outside the mount", async () => {
      await writeFile(join(tmp.path, "outside-search-secret.txt"), "secret", "utf8");
      const aug = createTestFs();

      await expect(
        execTool(aug, "fs_search", {
          path: "read",
          pattern: "../outside-search-secret.txt",
        }),
      ).rejects.toThrow(/may not leave the mount boundary/);
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
    it("does not begin a mutation when the turn is already canceled", async () => {
      const aug = createTestFs();
      const controller = new AbortController();
      controller.abort(new DOMException("caller left", "AbortError"));

      await expect(
        execTool(
          aug,
          "fs_write",
          { path: "work/canceled.txt", content: "must not be written" },
          { ...creatorCtx, signal: controller.signal },
        ),
      ).rejects.toThrow("caller left");
      await expect(access(join(tmp.path, "writable", "canceled.txt"))).rejects.toThrow();
    });

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

    it("enforces maxWriteSize in UTF-8 bytes", async () => {
      const aug = filesystem({
        mounts: [
          {
            name: "work",
            path: join(tmp.path, "writable"),
            writable: true,
            maxWriteSize: 4,
          },
        ],
      });
      const result = await execTool(aug, "fs_write", {
        path: "work/unicode.txt",
        content: "ééé",
      });
      expect(result).toContain("exceeds max write size");
      await expect(access(join(tmp.path, "writable", "unicode.txt"))).rejects.toThrow();
    });

    it("rejects oversized content before creating parent directories", async () => {
      const aug = filesystem({
        mounts: [
          {
            name: "work",
            path: join(tmp.path, "writable"),
            writable: true,
            maxWriteSize: 2,
          },
        ],
      });
      const result = await execTool(aug, "fs_write", {
        path: "work/must-not-exist/nested/file.txt",
        content: "too large",
      });
      expect(result).toContain("exceeds max write size");
      await expect(access(join(tmp.path, "writable", "must-not-exist"))).rejects.toThrow();
    });

    it("rejects writing through a hard-linked leaf", async () => {
      const outside = join(tmp.path, "outside-hardlink.txt");
      const inside = join(tmp.path, "writable", "hardlink.txt");
      await writeFile(outside, "outside content", "utf8");
      await link(outside, inside);

      const aug = createTestFs();
      await expect(
        execTool(aug, "fs_write", {
          path: "work/hardlink.txt",
          content: "must not mutate the outside alias",
        }),
      ).rejects.toThrow(/multiple filesystem links/);
      expect(await readFile(outside, "utf8")).toBe("outside content");
    });

    it("keeps the mount pinned when an ancestor is replaced after boot", async () => {
      const configuredParent = join(tmp.path, "configured-parent");
      const originalParent = join(tmp.path, "original-parent");
      const outsideParent = join(tmp.path, "outside-parent");
      const configuredRoot = join(configuredParent, "mount");
      const outsideRoot = join(outsideParent, "mount");
      await mkdir(configuredRoot, { recursive: true });
      await mkdir(outsideRoot, { recursive: true });
      const aug = filesystem({
        mounts: [{ name: "work", path: configuredRoot, writable: true }],
      });
      await aug.onBoot!();

      await rename(configuredParent, originalParent);
      await symlink(outsideParent, configuredParent, "dir");

      const tool = aug.tools!.find((candidate) => candidate.name === "fs_write");
      if (!tool) throw new Error("fs_write not found");
      expect(
        await asStringTool(tool).execute({
          path: "work/anchored.txt",
          content: "pinned",
        }),
      ).toContain("Written");
      expect(await readFile(join(originalParent, "mount", "anchored.txt"), "utf8")).toBe("pinned");
      await expect(access(join(outsideRoot, "anchored.txt"))).rejects.toThrow();
    });

    it("rejects an ordinary-directory replacement during root acquisition", async () => {
      const configuredParent = join(tmp.path, "acquire-configured");
      const originalParent = join(tmp.path, "acquire-original");
      const configuredRoot = join(configuredParent, "mount");
      await mkdir(configuredRoot, { recursive: true });
      await writeFile(join(configuredRoot, "original.txt"), "original", "utf8");
      let replaced = false;
      const aug = filesystem({
        mounts: [{ name: "work", path: configuredRoot, writable: true }],
        __testHooks: {
          async afterMountCanonicalized() {
            if (replaced) return;
            replaced = true;
            await rename(configuredParent, originalParent);
            await mkdir(configuredRoot, { recursive: true });
            await writeFile(join(configuredRoot, "replacement.txt"), "replacement", "utf8");
          },
        },
      });

      await expect(aug.onBoot!()).rejects.toThrow(/changed during acquisition/);
    });

    it("does not reacquire a mount after shutdown cancels a suspended acquisition", async () => {
      let markCanonicalized: (() => void) | undefined;
      const canonicalized = new Promise<void>((resolve) => {
        markCanonicalized = resolve;
      });
      let resumeAcquisition: (() => void) | undefined;
      const suspended = new Promise<void>((resolve) => {
        resumeAcquisition = resolve;
      });
      const aug = filesystem({
        mounts: [{ name: "work", path: join(tmp.path, "readable"), writable: false }],
        __testHooks: {
          async afterMountCanonicalized() {
            markCanonicalized?.();
            await suspended;
          },
        },
      });

      const boot = aug.onBoot!();
      await canonicalized;
      await aug.onShutdown!();
      resumeAcquisition?.();

      await expect(boot).rejects.toThrow(/acquisition was cancelled/);
      const readTool = aug.tools!.find((candidate) => candidate.name === "fs_read");
      if (!readTool) throw new Error("fs_read not found");
      let shutdownError: unknown;
      try {
        await asStringTool(readTool).execute({
          path: "work/hello.txt",
        });
      } catch (error) {
        shutdownError = error;
      }
      expect(String(shutdownError)).toMatch(/shutting down|Unknown mount/);
    });

    it("pins a missing writable root beneath an operator-configured symlink", async () => {
      const outside = join(tmp.path, "missing-root-outside");
      const replacement = join(tmp.path, "missing-root-replacement");
      const configuredParent = join(tmp.path, "missing-root-parent");
      await mkdir(outside, { recursive: true });
      await mkdir(replacement, { recursive: true });
      await symlink(outside, configuredParent, "dir");
      const aug = filesystem({
        mounts: [
          {
            name: "work",
            path: join(configuredParent, "new-root"),
            writable: true,
          },
        ],
      });

      await aug.onBoot!();
      await unlink(configuredParent);
      await symlink(replacement, configuredParent, "dir");
      expect(
        await execTool(aug, "fs_write", {
          path: "work/pinned.txt",
          content: "pinned",
        }),
      ).toContain("Written");
      expect(await readFile(join(outside, "new-root", "pinned.txt"), "utf8")).toBe("pinned");
      await expect(access(join(replacement, "new-root", "pinned.txt"))).rejects.toThrow();
    });

    it("rejects FIFO write targets without blocking for a reader", async () => {
      if (process.platform === "win32") return;
      const fifo = join(tmp.path, "writable", "blocked.fifo");
      const created = Bun.spawnSync(["mkfifo", fifo]);
      expect(created.exitCode).toBe(0);
      const reader = Bun.spawn([
        process.execPath,
        "-e",
        [
          'import { openSync, closeSync, constants } from "node:fs";',
          "await Bun.sleep(1000);",
          "const path = process.argv.at(-1);",
          "if (path) { const fd = openSync(path, constants.O_RDONLY); closeSync(fd); }",
        ].join(" "),
        fifo,
      ]);
      const startedAt = performance.now();
      try {
        await expect(
          execTool(createTestFs(), "fs_write", {
            path: "work/blocked.fifo",
            content: "must not block",
          }),
        ).rejects.toThrow();
        expect(performance.now() - startedAt).toBeLessThan(500);
      } finally {
        reader.kill();
        await reader.exited;
      }
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

    it("does not follow escaping symlinks when listing metadata", async () => {
      const outside = join(tmp.path, "outside-list-secret.txt");
      await writeFile(outside, "sensitive-size", "utf8");
      await symlink(outside, join(tmp.path, "readable", "outside-link.txt"));

      const aug = createTestFs();
      const result = await execTool(aug, "fs_list", { path: "read" });
      const parsed = JSON.parse(result) as {
        entries: Array<{ name: string; type: string; size?: number; modified?: string }>;
      };
      const linkEntry = parsed.entries.find((entry) => entry.name === "outside-link.txt");
      expect(linkEntry).toEqual({ name: "outside-link.txt", type: "symlink" });
    });

    it("keeps a directory listing pinned when its path is replaced after opening", async () => {
      const target = join(tmp.path, "writable", "target");
      const pinnedTarget = join(tmp.path, "writable", "pinned-target");
      const outside = join(tmp.path, "outside-list");
      await mkdir(target);
      await writeFile(join(target, "inside.txt"), "inside", "utf8");
      await mkdir(outside);
      await writeFile(join(outside, "OUTSIDE_SENTINEL"), "secret", "utf8");

      let replaced = false;
      const aug = filesystem({
        mounts: [{ name: "work", path: join(tmp.path, "writable"), writable: true }],
        __testHooks: {
          async afterListTargetOpened() {
            if (replaced) return;
            replaced = true;
            await rename(target, pinnedTarget);
            await symlink(outside, target);
          },
        },
      });

      const result = JSON.parse(await execTool(aug, "fs_list", { path: "work/target" })) as {
        entries: Array<{ name: string }>;
      };
      expect(result.entries.map(({ name }) => name)).toEqual(["inside.txt"]);
      expect(result.entries.map(({ name }) => name)).not.toContain("OUTSIDE_SENTINEL");
    });

    it("returns complete repeatable root listings sequentially and concurrently", async () => {
      const aug = createTestFs();
      await aug.onBoot!();
      const tool = aug.tools!.find((candidate) => candidate.name === "fs_list");
      if (!tool) throw new Error("fs_list not found");
      const list = () =>
        asStringTool(tool).execute({
          path: "read",
        });

      const first = await list();
      const second = await list();
      expect(second).toBe(first);

      const [third, fourth] = await Promise.all([list(), list()]);
      expect(third).toBe(first);
      expect(fourth).toBe(first);
    });

    it("bounds directory listing output before materializing every entry", async () => {
      for (let index = 0; index < 1005; index++) {
        await writeFile(join(tmp.path, "writable", `entry-${index}.txt`), "x", "utf8");
      }
      const result = JSON.parse(await execTool(createTestFs(), "fs_list", { path: "work" })) as {
        entries: Array<{ name: string }>;
        truncated: boolean;
      };
      expect(result.entries).toHaveLength(1000);
      expect(result.truncated).toBe(true);
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

    it("rejects removal of an empty mount root", async () => {
      const emptyRoot = join(tmp.path, "empty-deletable");
      await mkdir(emptyRoot, { recursive: true });
      const aug = filesystem({
        mounts: [{ name: "empty", path: emptyRoot, writable: true, deletable: true }],
      });

      const result = await execTool(aug, "fs_remove", { path: "empty" });

      expect(result).toContain('Cannot delete mount root "empty"');
      await expect(access(emptyRoot)).resolves.toBeNull();
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

    it("applies custom glob exclusions to nested search results", async () => {
      const workspace = join(tmp.path, "search-excludes");
      await mkdir(join(workspace, "generated"), { recursive: true });
      await mkdir(join(workspace, "notes"), { recursive: true });
      await writeFile(join(workspace, "generated", "client.ts"), "generated", "utf-8");
      await writeFile(join(workspace, "notes", "draft.tmp"), "temporary", "utf-8");
      await writeFile(join(workspace, "notes", "keep.md"), "keep", "utf-8");
      const aug = filesystem({
        mounts: [
          {
            name: "workspace",
            path: workspace,
            searchExcludes: ["generated/**", "*.tmp"],
          },
        ],
        workspaceAwareness: { enabled: false },
      });

      const result = JSON.parse(
        await execTool(aug, "fs_search", { path: "workspace", pattern: "**/*" }),
      ) as { results: string[] };

      expect(result.results).toEqual(["workspace/notes/keep.md"]);
    });

    it("searches the pinned mount after its pathname is replaced", async () => {
      const configured = join(tmp.path, "search-configured");
      const pinned = join(tmp.path, "search-pinned");
      await mkdir(configured, { recursive: true });
      await writeFile(join(configured, "original.md"), "original", "utf8");
      const aug = filesystem({
        mounts: [{ name: "workspace", path: configured }],
        workspaceAwareness: { enabled: false },
      });
      await aug.onBoot!();

      await rename(configured, pinned);
      await mkdir(configured, { recursive: true });
      await writeFile(join(configured, "OUTSIDE_SENTINEL.md"), "replacement", "utf8");

      const tool = aug.tools!.find((candidate) => candidate.name === "fs_search");
      if (!tool) throw new Error("fs_search not found");
      const result = JSON.parse(
        await asStringTool(tool).execute({
          path: "workspace",
          pattern: "**/*.md",
        }),
      ) as { results: string[] };
      expect(result.results).toEqual(["workspace/original.md"]);
      expect(JSON.stringify(result)).not.toContain("OUTSIDE_SENTINEL");
    });
  });

  // === Creator-only skill visibility ===

  describe("creator-only skill visibility", () => {
    it("allows creators to read creator-only skills and denies public reads", async () => {
      await writeSkill(
        "auggy",
        [
          "---",
          "name: auggy",
          "description: Build out this agent.",
          "allowedTrustLevels:",
          "  - creator",
          "---",
          "# Auggy",
        ].join("\n"),
      );

      const aug = filesystem({ mounts: [{ name: "skills", path: join(tmp.path, "skills") }] });

      await expect(
        execTool(aug, "fs_read", { path: "skills/auggy/SKILL.md" }, creatorCtx),
      ).resolves.toContain("# Auggy");

      const denied = await execTool(aug, "fs_read", { path: "skills/auggy/SKILL.md" }, publicCtx);
      expect(denied).toContain('Skill "auggy"');
      expect(denied).toContain("Current peer trust: public");
    });

    it("authorizes reads using the canonical skill path", async () => {
      await writeSkill(
        "auggy",
        [
          "---",
          "name: auggy",
          "description: Build out this agent.",
          "allowedTrustLevels: creator",
          "---",
          "# Auggy",
        ].join("\n"),
      );
      await writeSkill("public", "---\nname: public\ndescription: Public guide.\n---\n# Public");
      await symlink(join(tmp.path, "skills", "auggy"), join(tmp.path, "skills", "alias"));

      const aug = filesystem({ mounts: [{ name: "skills", path: join(tmp.path, "skills") }] });

      await expect(
        execTool(aug, "fs_read", { path: "skills/./auggy/SKILL.md" }, creatorCtx),
      ).resolves.toContain("# Auggy");
      await expect(
        execTool(aug, "fs_read", { path: "skills/./public/SKILL.md" }, publicCtx),
      ).resolves.toContain("# Public");

      for (const path of [
        "skills/./auggy/SKILL.md",
        "skills/public/../auggy/SKILL.md",
        "skills/alias/SKILL.md",
      ]) {
        const denied = await execTool(aug, "fs_read", { path }, publicCtx);
        expect(denied).toContain('Skill "auggy"');
        expect(denied).toContain("Current peer trust: public");
      }
    });

    it("hides creator-only skill folders from public list and search results", async () => {
      await writeSkill(
        "auggy",
        [
          "---",
          "name: auggy",
          "description: Build out this agent.",
          "allowedTrustLevels: creator",
          "---",
          "# Auggy",
        ].join("\n"),
      );
      await writeSkill("public", "---\nname: public\ndescription: Public guide.\n---\n# Public");
      await symlink(join(tmp.path, "skills", "auggy"), join(tmp.path, "skills", "alias"));

      const aug = filesystem({ mounts: [{ name: "skills", path: join(tmp.path, "skills") }] });

      const listed = JSON.parse(await execTool(aug, "fs_list", { path: "skills" }, publicCtx)) as {
        entries: Array<{ name: string }>;
      };
      expect(listed.entries.map((entry) => entry.name)).toEqual(["public"]);

      const directList = await execTool(aug, "fs_list", { path: "skills/auggy" }, publicCtx);
      expect(directList).toContain('Skill "auggy"');

      for (const path of ["skills/./auggy", "skills/public/../auggy", "skills/alias"]) {
        const denied = await execTool(aug, "fs_list", { path }, publicCtx);
        expect(denied).toContain('Skill "auggy"');
      }

      const searched = JSON.parse(
        await execTool(aug, "fs_search", { path: "skills", pattern: "**/SKILL.md" }, publicCtx),
      ) as { results: string[] };
      expect(searched.results).toEqual(["skills/public/SKILL.md"]);

      const aliasSearch = JSON.parse(
        await execTool(aug, "fs_search", { path: "skills/.", pattern: "**/SKILL.md" }, publicCtx),
      ) as { results: string[] };
      expect(aliasSearch.results).toEqual(["skills/./public/SKILL.md"]);

      for (const path of ["skills/./auggy", "skills/public/../auggy", "skills/alias"]) {
        const denied = await execTool(aug, "fs_search", { path, pattern: "**/*.md" }, publicCtx);
        expect(denied).toContain('Skill "auggy"');
      }
    });

    it("keeps skill authorization and reads bound to the same folder descriptor", async () => {
      await writeSkill("public", "---\nname: public\ndescription: Public.\n---\n# Public");
      await writeSkill(
        "secret",
        "---\nname: secret\ndescription: Secret.\nallowedTrustLevels: creator\n---\n# Secret",
      );
      let swapped = false;
      const aug = filesystem({
        mounts: [{ name: "skills", path: join(tmp.path, "skills") }],
        __testHooks: {
          async afterSkillPolicyEvaluated() {
            if (swapped) return;
            swapped = true;
            await rename(
              join(tmp.path, "skills", "public"),
              join(tmp.path, "skills", "was-public"),
            );
            await rename(join(tmp.path, "skills", "secret"), join(tmp.path, "skills", "public"));
          },
        },
      });

      const result = await execTool(aug, "fs_read", { path: "skills/public/SKILL.md" }, publicCtx);
      expect(result).toContain("# Public");
      expect(result).not.toContain("# Secret");
    });

    it("fails closed for a present but structurally invalid skill policy", async () => {
      const folder = join(tmp.path, "skills", "broken");
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "SKILL.md"), "not valid frontmatter", "utf8");
      const aug = filesystem({ mounts: [{ name: "skills", path: join(tmp.path, "skills") }] });

      const denied = await execTool(aug, "fs_read", { path: "skills/broken/SKILL.md" }, publicCtx);
      expect(denied).toContain("policy cannot be verified");
      await expect(
        execTool(aug, "fs_read", { path: "skills/broken/SKILL.md" }, creatorCtx),
      ).resolves.toContain("not valid frontmatter");
    });

    it("applies skill visibility policy to explicitly public workspace awareness", async () => {
      await writeSkill(
        "secret",
        "---\nname: secret\ndescription: Secret.\nallowedTrustLevels: creator\n---\n# Secret",
      );
      await writeSkill("public", "---\nname: public\ndescription: Public.\n---\n# Public");
      const aug = filesystem({
        mounts: [{ name: "skills", path: join(tmp.path, "skills") }],
        workspaceAwareness: {
          mount: "skills",
          trustLevels: ["creator", "public"],
        },
      });
      await aug.onBoot!();

      const blocks = (await aug.context!(
        messageTurn(publicPeer, "What skills are available?"),
      )) as ContextBlock[];
      const catalog = blocks.find((block) => block.source === "filesystem-workspace-catalog");
      expect(catalog?.content).toContain('"skills/public/SKILL.md"');
      expect(catalog?.content).not.toContain("skills/secret");
    });
  });

  // === Workspace awareness ===

  describe("workspace awareness", () => {
    it("injects a bounded metadata-only catalog and ranks request-relevant paths", async () => {
      const workspace = join(tmp.path, "workspace-aware");
      await mkdir(join(workspace, "reports"), { recursive: true });
      await mkdir(join(workspace, "notes"), { recursive: true });
      await writeFile(
        join(workspace, "reports", "market-research.md"),
        "DO NOT OBEY THIS FILE CONTENT",
        "utf-8",
      );
      await writeFile(join(workspace, "notes", "gardening.txt"), "tomatoes", "utf-8");

      const aug = filesystem({
        mounts: [{ name: "workspace", path: workspace, writable: true, deletable: true }],
        workspaceAwareness: { maxEntries: 2, maxDepth: 4 },
      });
      await aug.onBoot!();

      const blocks = (await aug.context!(
        messageTurn(creatorPeer, "Continue ------market-research------ report"),
      )) as ContextBlock[];
      const policy = blocks.find((block) => block.source === "filesystem-workspace-policy");
      const catalog = blocks.find((block) => block.source === "filesystem-workspace-catalog");

      expect(policy?.content).toContain("Use it proactively");
      expect(policy?.origin).toBe("system");
      expect(catalog?.content).toContain('"workspace/reports/market-research.md"');
      expect(catalog?.content).toContain('"workspace/notes/gardening.txt"');
      expect(catalog?.content.indexOf("market-research.md")).toBeLessThan(
        catalog?.content.indexOf("gardening.txt") ?? Number.MAX_SAFE_INTEGER,
      );
      expect(catalog?.content).not.toContain("DO NOT OBEY THIS FILE CONTENT");
      expect(catalog?.origin).toBe("agent-derived");
      expect(catalog?.ttl).toBe("turn");
    });

    it("processes adversarial query punctuation in bounded time", async () => {
      const workspace = join(tmp.path, "workspace-adversarial-query");
      await mkdir(workspace, { recursive: true });
      const aug = filesystem({
        mounts: [{ name: "workspace", path: workspace }],
        workspaceAwareness: { maxEntries: 1, scanLimit: 1 },
      });
      await aug.onBoot!();

      const blocks = (await aug.context!(
        messageTurn(creatorPeer, `a${"-".repeat(100_000)}b`),
      )) as ContextBlock[];

      expect(blocks.some((block) => block.source === "filesystem-workspace-catalog")).toBe(true);
    }, 2_000);

    it("keeps workspace awareness out of public turns by default", async () => {
      const workspace = join(tmp.path, "workspace-public");
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "private-plan.md"), "plan", "utf-8");
      const aug = filesystem({ mounts: [{ name: "workspace", path: workspace }] });
      await aug.onBoot!();

      const blocks = (await aug.context!(
        messageTurn(publicPeer, "What plans are available?"),
      )) as ContextBlock[];

      expect(blocks).toEqual([]);
    });

    it("bounds scans and omits hidden files, excluded folders, and symlinks", async () => {
      const workspace = join(tmp.path, "workspace-bounded");
      await mkdir(join(workspace, ".hidden"), { recursive: true });
      await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
      await mkdir(join(workspace, "visible"), { recursive: true });
      await writeFile(join(workspace, ".secret"), "secret", "utf-8");
      await writeFile(join(workspace, ".hidden", "secret.md"), "secret", "utf-8");
      await writeFile(join(workspace, "node_modules", "pkg", "index.js"), "code", "utf-8");
      await writeFile(join(workspace, "visible", "one.md"), "one", "utf-8");
      await writeFile(join(workspace, "visible", "two.md"), "two", "utf-8");
      await symlink(join(workspace, "visible", "one.md"), join(workspace, "alias.md"));

      const aug = filesystem({
        mounts: [{ name: "workspace", path: workspace }],
        workspaceAwareness: { maxEntries: 1, scanLimit: 20, maxDepth: 4 },
      });
      await aug.onBoot!();
      const blocks = (await aug.context!(
        messageTurn(creatorPeer, "Review documents"),
      )) as ContextBlock[];
      const catalog = blocks.find((block) => block.source === "filesystem-workspace-catalog");

      expect(catalog?.content).toContain("2 visible file(s) found");
      expect(catalog?.content).not.toContain(".secret");
      expect(catalog?.content).not.toContain("node_modules");
      expect(catalog?.content).not.toContain("alias.md");
      const listedPaths = catalog?.content.match(/^- /gm) ?? [];
      expect(listedPaths).toHaveLength(1);
    });

    it("applies custom glob exclusions while scanning workspace metadata", async () => {
      const workspace = join(tmp.path, "workspace-glob-excludes");
      await mkdir(join(workspace, "generated"), { recursive: true });
      await mkdir(join(workspace, "notes"), { recursive: true });
      await writeFile(join(workspace, "generated", "client.ts"), "generated", "utf-8");
      await writeFile(join(workspace, "notes", "draft.tmp"), "temporary", "utf-8");
      await writeFile(join(workspace, "notes", "keep.md"), "keep", "utf-8");
      const aug = filesystem({
        mounts: [
          {
            name: "workspace",
            path: workspace,
            searchExcludes: ["generated/**", "*.tmp"],
          },
        ],
      });
      await aug.onBoot!();

      const blocks = (await aug.context!(
        messageTurn(creatorPeer, "Review workspace files"),
      )) as ContextBlock[];
      const catalog = blocks.find((block) => block.source === "filesystem-workspace-catalog");

      expect(catalog?.content).toContain('"workspace/notes/keep.md"');
      expect(catalog?.content).not.toContain("client.ts");
      expect(catalog?.content).not.toContain("draft.tmp");
    });

    it("catalogs the pinned workspace after its pathname is replaced", async () => {
      const workspace = join(tmp.path, "workspace-replaced");
      const pinned = join(tmp.path, "workspace-pinned");
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "original.md"), "original", "utf8");
      const aug = filesystem({ mounts: [{ name: "workspace", path: workspace }] });
      await aug.onBoot!();

      await rename(workspace, pinned);
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "OUTSIDE_SENTINEL.md"), "replacement", "utf8");

      const blocks = (await aug.context!(
        messageTurn(creatorPeer, "Review workspace"),
      )) as ContextBlock[];
      const catalog = blocks.find((block) => block.source === "filesystem-workspace-catalog");
      expect(catalog?.content).toContain('"workspace/original.md"');
      expect(catalog?.content).not.toContain("OUTSIDE_SENTINEL");
    });

    it("does not claim a truncated scan proves the workspace is empty", async () => {
      const workspace = join(tmp.path, "workspace-truncated-empty");
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, ".first"), "hidden", "utf-8");
      await writeFile(join(workspace, "later.md"), "visible", "utf-8");

      const aug = filesystem({
        mounts: [{ name: "workspace", path: workspace }],
        workspaceAwareness: { maxEntries: 1, scanLimit: 1 },
      });
      await aug.onBoot!();
      const blocks = (await aug.context!(
        messageTurn(creatorPeer, "Find existing work"),
      )) as ContextBlock[];
      const catalog = blocks.find((block) => block.source === "filesystem-workspace-catalog");

      expect(catalog?.content).toContain("within a bounded scan");
      expect(catalog?.content).toMatch(/[Oo]mitted path(?:s)? may still exist/);
      expect(catalog?.content).not.toContain("currently has no visible files");
    });

    it("can be disabled and rejects an explicitly missing awareness mount", () => {
      const disabled = filesystem({
        mounts: [{ name: "workspace", path: join(tmp.path, "writable") }],
        workspaceAwareness: { enabled: false },
      });
      expect(disabled.context).toBeUndefined();

      expect(() =>
        filesystem({
          mounts: [{ name: "work", path: join(tmp.path, "writable") }],
          workspaceAwareness: { enabled: true, mount: "workspace" },
        }),
      ).toThrow('workspace awareness mount "workspace" is not configured');
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
      const blocks = (await aug.context!({} as unknown as TurnState, undefined)) as Array<{
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
