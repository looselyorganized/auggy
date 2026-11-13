import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { readBoundedRegularFile } from "../../scripts/release-smoke/bounded-file";
import { preparePackedTurnFixture, runPackedTurn } from "../../scripts/release-smoke/packed-turn";

let root: string;
let options: Parameters<typeof runPackedTurn>[0];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "auggy-packed-isolation-"));
  for (const directory of ["repo", "agent", "home", "installed"]) {
    await mkdir(join(root, directory));
  }
  await writeFile(join(root, "installed/cli.ts"), "// fixture: must never execute\n");
  options = {
    cli: join(root, "installed/cli.ts"),
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    evidenceDir: join(root, "evidence"),
    repoRoot: join(root, "repo"),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("rejects a consumer symlink into the source checkout before writing evidence or fixtures", async () => {
  const alias = join(root, "source-alias");
  await symlink(options.repoRoot, alias);
  await expect(runPackedTurn({ ...options, agentDir: alias })).rejects.toThrow(
    "Packed consumer must live outside the source checkout",
  );
  expect(existsSync(options.evidenceDir)).toBe(false);
  expect(existsSync(join(options.repoRoot, ".packed-acceptance"))).toBe(false);
});

test("rejects a globally linked source CLI before running it", async () => {
  const sourceCli = join(options.repoRoot, "cli.ts");
  await writeFile(sourceCli, "throw new Error('source CLI must not execute');\n");
  const alias = join(root, "linked-auggy");
  await symlink(sourceCli, alias);
  await expect(runPackedTurn({ ...options, cli: alias })).rejects.toThrow(
    "CLI must resolve outside the source checkout",
  );
  expect(existsSync(join(options.agentDir, ".packed-acceptance"))).toBe(false);
});

test("rejects source-checkout HOME before reading package or environment files", async () => {
  await expect(runPackedTurn({ ...options, home: options.repoRoot })).rejects.toThrow(
    "Consumer HOME must be isolated from the source checkout",
  );
  expect(existsSync(options.evidenceDir)).toBe(false);
});

function tree(path: string): unknown[] {
  return readdirSync(path)
    .sort()
    .map((name) => {
      const file = join(path, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) return [name, stat.mode, readlinkSync(file)];
      if (stat.isDirectory()) return [name, stat.mode, tree(file)];
      const snapshot = readBoundedRegularFile(file, 1024 * 1024);
      return [name, snapshot.mode, snapshot.bytes];
    });
}

async function consumer(format: "referenced" | "inline") {
  const agentDir = options.agentDir;
  const parent = format === "referenced" ? "augments" : "src/augments";
  await mkdir(join(agentDir, parent), { recursive: true });
  const augments = ["filesystem", "webTransport"];
  if (format === "referenced") {
    for (const type of augments) {
      await mkdir(join(agentDir, parent, type));
      await writeFile(
        join(agentDir, parent, type, "augment.yaml"),
        `# Owned metadata\ntype: ${type}\nconfig: {owned: false}\n`,
      );
    }
  } else {
    await writeFile(join(agentDir, "src/index.ts"), "// Owned application source\n");
  }
  await writeFile(
    join(agentDir, "agent.yaml"),
    "# Owned configuration\n" +
      stringify({
        id: "aug1_11111111-1111-4111-8111-111111111111",
        name: "retained-consumer",
        engine: { provider: "anthropic", model: "owned-model" },
        ...(format === "inline"
          ? { application: { entrypoint: "./src/index.ts", contractVersion: 1 } }
          : {}),
        augments:
          format === "referenced"
            ? augments
            : augments.map((type) => ({ type, options: { owned: false } })),
      }),
  );
  await writeFile(join(agentDir, ".env"), "# Owned credentials\nEXISTING=private-fixture\n", {
    mode: 0o600,
  });
  await writeFile(join(agentDir, "application-owned.ts"), "// Retained unrelated source\n");
  return {
    agentDir,
    observerSource: "// Harness observer; never evaluate during fixture preparation\n",
    engine: { provider: "anthropic", model: "fixture-model" },
    filesystem: { workspaceAwareness: { enabled: false } },
    webTransport: { port: 12345, allowAnonymous: false },
    env: "FIXTURE=temporary\n",
  };
}

for (const format of ["referenced", "inline"] as const) {
  test(`${format} packed scenario keeps its active format and restores the exact consumer tree`, async () => {
    const input = await consumer(format);
    const before = tree(input.agentDir);
    const fixture = await preparePackedTurnFixture(input);
    expect(fixture.format).toBe(format);
    const configured = parse(readFileSync(join(input.agentDir, "agent.yaml"), "utf8"));
    expect(configured.engine).toEqual(input.engine);
    expect(readFileSync(join(input.agentDir, fixture.observerPath, "index.ts"), "utf8")).toBe(
      input.observerSource,
    );
    if (format === "referenced") {
      expect(configured.augments).toEqual([
        "filesystem",
        "webTransport",
        "packedAcceptanceObserver",
      ]);
      expect(existsSync(join(input.agentDir, "src"))).toBe(false);
      expect(configured.application).toBeUndefined();
      expect(
        parse(readFileSync(join(input.agentDir, "augments/filesystem/augment.yaml"), "utf8")),
      ).toEqual({ type: "filesystem", config: input.filesystem });
      expect(
        parse(readFileSync(join(input.agentDir, "augments/webTransport/augment.yaml"), "utf8")),
      ).toEqual({ type: "webTransport", config: input.webTransport });
      expect(
        parse(readFileSync(join(input.agentDir, fixture.observerPath, "augment.yaml"), "utf8")),
      ).toEqual({ type: "custom", source: "./index.ts" });
    } else {
      expect(configured.augments).toEqual([
        { name: "filesystem", type: "filesystem", options: input.filesystem },
        { name: "webTransport", type: "webTransport", options: input.webTransport },
        {
          name: "packedAcceptanceObserver",
          type: "custom",
          source: "./src/augments/packedAcceptanceObserver/index.ts",
        },
      ]);
      expect(configured.application).toEqual({ entrypoint: "./src/index.ts", contractVersion: 1 });
      expect(existsSync(join(input.agentDir, "augments"))).toBe(false);
    }
    await fixture.restore();
    expect(tree(input.agentDir)).toEqual(before);
  });

  for (const kind of ["parent-symlink", "directory-collision", "dangling-symlink"] as const) {
    test(`${format} packed fixture rejects ${kind} without changing owned files`, async () => {
      const input = await consumer(format);
      const parent = format === "referenced" ? "augments" : "src/augments";
      const observer = join(input.agentDir, parent, "packedAcceptanceObserver");
      if (kind === "parent-symlink") {
        await rename(join(input.agentDir, parent), join(root, "outside"));
        await symlink(join(root, "outside"), join(input.agentDir, parent));
      } else if (kind === "directory-collision") {
        await mkdir(observer);
        await writeFile(join(observer, "owned.ts"), "// Must survive\n");
      } else {
        await symlink(join(root, "missing"), observer);
      }
      const before = tree(root);
      await expect(preparePackedTurnFixture(input)).rejects.toThrow();
      expect(tree(root)).toEqual(before);
    });
  }
}

test("fixture restoration preserves a changed consumer instead of overwriting it", async () => {
  const input = await consumer("referenced");
  const fixture = await preparePackedTurnFixture(input);
  await writeFile(join(input.agentDir, "agent.yaml"), "# New operator content\n");
  const changed = tree(input.agentDir);
  await expect(fixture.restore()).rejects.toThrow("output changed");
  expect(tree(input.agentDir)).toEqual(changed);
});

for (const kind of ["mixed-declarations", "metadata-type", "inline-instance"] as const) {
  test(`rejects ${kind} mismatch before fixture writes`, async () => {
    const input = await consumer(kind === "inline-instance" ? "inline" : "referenced");
    if (kind === "metadata-type") {
      await writeFile(
        join(input.agentDir, "augments/filesystem/augment.yaml"),
        "type: custom\nsource: ./owned.ts\n",
      );
    } else {
      const path = join(input.agentDir, "agent.yaml");
      const value = parse(readFileSync(path, "utf8"));
      if (kind === "mixed-declarations") value.augments[0] = { type: "filesystem" };
      else value.augments[0].name = "owned-files";
      await writeFile(path, stringify(value));
    }
    const before = tree(input.agentDir);
    await expect(preparePackedTurnFixture(input)).rejects.toThrow();
    expect(tree(input.agentDir)).toEqual(before);
  });
}
