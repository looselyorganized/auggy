import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { runAdd } from "../../src/cli/commands/add";
import {
  augmentCommand,
  createCustomAugment,
  installCustomAugment,
  listAugments,
  removeAugment,
} from "../../src/cli/commands/augment";
import { acquireProjectMutationLease } from "../../src/cli/authoring/publication";
import { acquireAgentEnvMutationLock } from "../../src/cli/env-mutation-lock";
import type { PublicationFaultHook } from "../../src/cli/authoring/contracts";

let root: string;
let config: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "augment-authoring-")));
  config = join(root, "agent.yaml");
  writeFileSync(
    config,
    "# keep this comment\nname: sample\npurpose: '${PURPOSE}'\nsettings: { disabled: false, count: 0, absent: null }\naugments: []\n",
  );
  writeFileSync(join(root, "package.json"), '{"name":"sample","dependencies":{"auggy":"0.5.0"}}\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function boundedAugmentCli(args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--no-env-file", resolve(import.meta.dir, "../../src/cli/index.ts"), "augment", ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 3000,
      killSignal: "SIGKILL",
      maxBuffer: 128 * 1024,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

const contents = (path: string) => readFileSync(join(root, path), "utf-8");
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const add = (augment: string, extra: Partial<Parameters<typeof runAdd>[1]> = {}) =>
  runAdd(undefined, { config, augment, yes: true, skipInstall: true, ...extra });
const declaration = () => parse(contents("agent.yaml")).augments as Record<string, unknown>[];

function failOnce(boundary: Parameters<PublicationFaultHook>[0]["boundary"]): PublicationFaultHook {
  let failed = false;
  return (event) => {
    if (event.boundary === boundary && !failed) {
      failed = true;
      throw new Error("injected failure");
    }
  };
}

describe("central augment authoring preservation", () => {
  test("named mutation selection rejects a config FIFO before reading or creating receipts", async () => {
    rmSync(config);
    expect(Bun.spawnSync(["mkfifo", config]).exitCode).toBe(0);
    for (const args of [
      ["add", "knowledge", "--agent", "sample", "--yes", "--skip-install"],
      ["remove", "knowledge", "--agent", "sample"],
      ["install", "sample", "./missing/index.ts"],
    ]) {
      const result = boundedAugmentCli(args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/regular file/);
    }
    expect(lstatSync(config).isFIFO()).toBe(true);
    expect(existsSync(join(root, ".auggy"))).toBe(false);
    expect(existsSync(join(root, "knowledge"))).toBe(false);
  });

  test("custom creation registers only the explicitly selected nonstandard config", async () => {
    const original = contents("agent.yaml");
    write("service.yaml", "name: secondary\naugments: []\n");
    const command = augmentCommand({
      cwd: root,
      exit: () => {
        throw new Error("command failed");
      },
    });
    await command.parseAsync(["create", "selected", "--config", join(root, "service.yaml")], {
      from: "user",
    });
    expect(contents("agent.yaml")).toBe(original);
    expect(parse(contents("service.yaml")).augments).toEqual([
      { name: "selected", type: "custom", source: "./src/augments/selected/index.ts", options: {} },
    ]);
    expect(existsSync(join(root, "src/augments/selected/index.ts"))).toBe(true);
  });

  test("add preserves raw semantics, edited assets, and exactly one existing root skills mount", async () => {
    write(
      "agent.yaml",
      contents("agent.yaml").replace(
        "augments: []",
        "augments:\n  - name: guide\n    type: skills\n    options: { dir: ./skills, future: false }\n  - name: retained\n    type: custom\n    source: ./owned.ts\n    options: { literal: '${TOKEN}', zero: 0, no: false, empty: null }",
      ),
    );
    write("skills/knowledge/SKILL.md", "user-owned instructions\n");
    write("knowledge/local/mission.md", "edited knowledge\n");
    await add("knowledge");
    expect(contents("skills/knowledge/SKILL.md")).toBe("user-owned instructions\n");
    expect(contents("knowledge/local/mission.md")).toBe("edited knowledge\n");
    expect(contents("agent.yaml")).toContain("# keep this comment");
    expect(parse(contents("agent.yaml")).settings).toEqual({
      disabled: false,
      count: 0,
      absent: null,
    });
    expect(declaration()[1]?.options).toEqual({
      literal: "${TOKEN}",
      zero: 0,
      no: false,
      empty: null,
    });
    expect(declaration().filter((entry) => entry.type === "skills")).toEqual([
      { name: "guide", type: "skills", options: { dir: "./skills", future: false } },
    ]);
    expect(declaration().at(-1)).toEqual({
      name: "knowledge",
      type: "knowledge",
      options: { root: "./knowledge" },
    });
    expect(existsSync(join(root, "augments"))).toBe(false);
  });

  test("an existing skills shorthand keeps its runtime default root without rewriting options", async () => {
    write("agent.yaml", "name: sample\naugments:\n - { name: guides, type: skills }\n");
    await add("knowledge");
    expect(declaration().filter((entry) => entry.type === "skills")).toEqual([
      { name: "guides", type: "skills" },
    ]);
  });

  test("new skill assets get one canonical root mount and do not duplicate it", async () => {
    await add("knowledge");
    await add("notify");
    expect(declaration().filter((entry) => entry.type === "skills")).toEqual([
      { name: "skills", type: "skills", options: { dir: "./skills" } },
    ]);
  });

  test("ambiguous or unrelated skill mounts refuse root asset writes", async () => {
    write(
      "agent.yaml",
      "name: sample\naugments:\n - name: other\n   type: skills\n   options: { dir: ./elsewhere }\n",
    );
    const before = contents("agent.yaml");
    await expect(add("knowledge")).rejects.toThrow(/exactly one mount/);
    expect(contents("agent.yaml")).toBe(before);
    expect(existsSync(join(root, ".auggy"))).toBe(false);
    expect(existsSync(join(root, "skills"))).toBe(false);
  });

  test("remove unregisters one exact instance and retains every owned asset", () => {
    write(
      "agent.yaml",
      "name: sample\naugments:\n - { name: one, type: custom, source: ./src/one.ts }\n - { name: two, type: custom, source: ./src/two.ts }\n",
    );
    for (const path of ["src/one.ts", "skills/one/SKILL.md", ".env", "data/one.db"])
      write(path, `retained ${path}\n`);
    const pkg = contents("package.json");
    expect(() => removeAugment({ config, augment: "custom" })).toThrow(
      /Multiple augment instances/,
    );
    const result = removeAugment({ config, augment: "one", yes: true });
    expect(result.skillRemoved).toBeNull();
    expect(declaration().map((entry) => entry.name)).toEqual(["two"]);
    for (const path of ["src/one.ts", "skills/one/SKILL.md", ".env", "data/one.db"])
      expect(contents(path)).toBe(`retained ${path}\n`);
    expect(contents("package.json")).toBe(pkg);
  });

  test("create source, test, skill and force collisions fail without changing config", () => {
    const before = contents("agent.yaml");
    write("tests/augments/sample.test.ts", "owned test");
    expect(() => createCustomAugment({ cwd: root, slug: "sample" })).toThrow(/already exists/);
    write("skills/other/notes.md", "owned directory");
    expect(() => createCustomAugment({ cwd: root, slug: "other", includeSkill: true })).toThrow(
      /already exists/,
    );
    expect(() => createCustomAugment({ cwd: root, slug: "new", force: true })).toThrow(/--force/);
    expect(contents("agent.yaml")).toBe(before);
    expect(existsSync(join(root, "src"))).toBe(false);
    expect(existsSync(join(root, ".auggy"))).toBe(false);
  });

  test("symlink destinations cannot write outside the project", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "augment-outside-")));
    try {
      symlinkSync(outside, join(root, "skills"), "dir");
      await expect(add("knowledge")).rejects.toThrow(/real project directories/);
      expect(readdirSync(outside)).toEqual([]);
      expect(declaration()).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("external installation references existing source without metadata or copying", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "external-augment-")));
    try {
      writeFileSync(
        join(outside, "index.ts"),
        'throw new Error("must not import while installing");\n',
      );
      const result = installCustomAugment({ agentName: "sample", config, sourcePath: outside });
      expect(result.source.startsWith("../")).toBe(true);
      expect(declaration()[0]).toEqual({
        name: outside.split("/").at(-1),
        type: "custom",
        source: result.source,
        options: {},
      });
      expect(readdirSync(outside)).toEqual(["index.ts"]);
      expect(existsSync(join(root, "augments"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("legacy authoring gate", () => {
  for (const mixed of [false, true])
    test(`all mutators reject ${mixed ? "mixed" : "referenced"} declarations before writes or setup`, async () => {
      write("augments/notify/augment.yaml", "type: notify\nconfig: {}\n");
      write(
        "agent.yaml",
        `name: sample\naugments:\n - notify\n${mixed ? " - { name: web, type: webFetch }\n" : ""}`,
      );
      const before = contents("agent.yaml");
      let externalCalls = 0;
      const guidance =
        /Preview: auggy migrate --config .*\. Apply: auggy migrate --config .* --apply\./;
      await expect(
        add("knowledge", {
          runAgentMailSetup: async () => {
            externalCalls++;
            throw new Error("called");
          },
          bunInstallSpawn: () => {
            externalCalls++;
            throw new Error("called");
          },
        }),
      ).rejects.toThrow(guidance);
      expect(() => createCustomAugment({ cwd: root, slug: "sample" })).toThrow(guidance);
      expect(() =>
        installCustomAugment({ agentName: "sample", config, sourcePath: "/missing/source" }),
      ).toThrow(guidance);
      expect(() => removeAugment({ config, augment: "notify", yes: true })).toThrow(guidance);
      expect(listAugments({ config }).map((entry) => entry.type)).toContain("notify");
      expect(contents("agent.yaml")).toBe(before);
      expect(externalCalls).toBe(0);
      expect(existsSync(join(root, ".auggy"))).toBe(false);
      expect(existsSync(join(root, "skills"))).toBe(false);
    });
});

describe("publication and env boundaries", () => {
  test("invalid UTF-8 env bytes fail before publication and remain byte-identical", async () => {
    const before = Buffer.from([0x4b, 0x3d, 0xff, 0x0a]);
    writeFileSync(join(root, ".env"), before);
    const yaml = contents("agent.yaml");
    await expect(add("visitorAuth")).rejects.toThrow(/UTF-8/);
    expect(readFileSync(join(root, ".env"))).toEqual(before);
    expect(contents("agent.yaml")).toBe(yaml);
    expect(existsSync(join(root, ".auggy"))).toBe(false);
  });

  test("failed multi-file create rolls back source and central activation", () => {
    const before = contents("agent.yaml");
    expect(() =>
      createCustomAugment({
        cwd: root,
        slug: "sample",
        publication: { fault: failOnce("after-file") },
      }),
    ).toThrow(/rolled-back/);
    expect(contents("agent.yaml")).toBe(before);
    expect(existsSync(join(root, "src/augments/sample/index.ts"))).toBe(false);
    expect(existsSync(join(root, "tests/augments/sample.test.ts"))).toBe(false);
  });

  test("failed add publication cannot modify credentials or run setup/install", async () => {
    write(".env", "VISITOR_SIGNING_KEY=owned\n");
    const before = contents("agent.yaml");
    let calls = 0;
    await expect(
      add("visitorAuth", {
        publication: { fault: failOnce("after-activation") },
        writeEnv: () => {
          calls++;
        },
        runAgentMailSetup: async () => {
          calls++;
          throw new Error("setup");
        },
      }),
    ).rejects.toThrow(/rolled-back/);
    expect(contents("agent.yaml")).toBe(before);
    expect(contents(".env")).toBe("VISITOR_SIGNING_KEY=owned\n");
    expect(calls).toBe(0);
  });

  test("env assignments including blanks, duplicate definitions and original bytes are retained", async () => {
    const before =
      "# owned\r\nexport AUGGY_AGENT_ID = 'original'\r\nAUGGY_PUBLIC_URL=\r\nVISITOR_SIGNING_KEY=\r\nVISITOR_SIGNING_KEY=second\r\n";
    write(".env", before);
    await add("visitorAuth");
    expect(contents(".env")).toBe(before);
    expect(declaration().some((entry) => entry.type === "visitorAuth")).toBe(true);
  });

  test("env writer failure reports activated configuration and retains preimage", async () => {
    write(".env", "OWNED=retained\n");
    await expect(
      add("visitorAuth", {
        writeEnv: () => {
          throw new Error("disk failure");
        },
      }),
    ).rejects.toThrow(/configuration was activated.*\.env initialization failed/);
    expect(contents(".env")).toBe("OWNED=retained\n");
    expect(declaration().some((entry) => entry.type === "visitorAuth")).toBe(true);
    const projectLease = acquireProjectMutationLease(root);
    const envLease = acquireAgentEnvMutationLock(root);
    envLease.release();
    projectLease.release();
  });

  test("concurrent env changes trigger config rollback and are never overwritten", async () => {
    write(".env", "OWNED=original\n");
    await expect(
      add("visitorAuth", {
        publication: {
          fault: (event) => {
            if (event.boundary === "before-complete") write(".env", "OWNED=concurrent\n");
          },
        },
      }),
    ).rejects.toThrow(/publication rolled-back.*Configuration is original/);
    expect(contents(".env")).toBe("OWNED=concurrent\n");
    expect(declaration()).toEqual([]);
  });

  test("post-add AgentMail setup starts only after both leases release", async () => {
    let called = false;
    await add("visitorAuth", {
      yes: false,
      interactive: true,
      confirmSetup: async () => true,
      runAgentMailSetup: async () => {
        const projectLease = acquireProjectMutationLease(root);
        const envLease = acquireAgentEnvMutationLock(root);
        envLease.release();
        projectLease.release();
        called = true;
        return {
          target: "visitorAuth",
          mode: "manual",
          agentName: "sample",
          envPath: join(root, ".env"),
          augmentPath: config,
          envKeys: [],
          inboxId: "test",
          inboxEmail: "test@example.com",
        };
      },
    });
    expect(called).toBe(true);
  });
});

describe("bounded add inputs and diagnostics", () => {
  const invalidPackages = [
    {
      label: "invalid UTF-8",
      bytes: Buffer.concat([Buffer.from('{"private":"'), Buffer.from([0xff]), Buffer.from('"}')]),
      diagnostic: /UTF-8/,
    },
    {
      label: "oversized manifest",
      bytes: Buffer.from(JSON.stringify({ private: true, opaque: "x".repeat(1_048_576) })),
      diagnostic: /byte limit/,
    },
    {
      label: "merged manifest exceeding the cap",
      bytes: Buffer.from(JSON.stringify({ opaque: Array(150_000).fill("x") })),
      diagnostic: /updated package.json.*1 MiB/,
    },
    {
      label: "malformed private token",
      bytes: Buffer.from('{"private":PRIVATE_PACKAGE_SENTINEL}'),
      diagnostic: /valid JSON object/,
    },
    { label: "non-object root", bytes: Buffer.from("[]"), diagnostic: /valid JSON object/ },
    {
      label: "non-object dependencies",
      bytes: Buffer.from('{"dependencies":[]}'),
      diagnostic: /valid JSON object/,
    },
    {
      label: "non-string dependency",
      bytes: Buffer.from('{"dependencies":{"private-package":42}}'),
      diagnostic: /valid JSON object/,
    },
  ];
  for (const fixture of invalidPackages)
    test(`${fixture.label} is rejected privately before any publication or install`, async () => {
      writeFileSync(join(root, "package.json"), fixture.bytes);
      const before = contents("agent.yaml");
      let calls = 0;
      let failure: Error | undefined;
      try {
        await add("link", {
          skipInstall: false,
          bunInstallSpawn: () => {
            calls++;
            throw new Error("must not install");
          },
        });
      } catch (error) {
        failure = error as Error;
      }
      expect(failure?.message).toMatch(fixture.diagnostic);
      expect(failure?.message).not.toContain("PRIVATE_PACKAGE_SENTINEL");
      expect(readFileSync(join(root, "package.json"))).toEqual(fixture.bytes);
      expect(contents("agent.yaml")).toBe(before);
      expect(existsSync(join(root, ".auggy"))).toBe(false);
      expect(existsSync(join(root, "skills"))).toBe(false);
      expect(calls).toBe(0);
    });

  test("readiness-only env inspection rejects invalid bytes before activating a no-env augment", async () => {
    write("agent.yaml", "name: sample\naugments:\n - { name: agentMail, type: agentMail }\n");
    const before = contents("agent.yaml");
    const bytes = Buffer.from([0x4b, 0x3d, 0xff]);
    writeFileSync(join(root, ".env"), bytes);
    await expect(add("knowledge")).rejects.toThrow(/UTF-8/);
    expect(contents("agent.yaml")).toBe(before);
    expect(readFileSync(join(root, ".env"))).toEqual(bytes);
    expect(existsSync(join(root, ".auggy"))).toBe(false);
  });

  for (const needsReadiness of [false, true])
    test(`FIFO env ${needsReadiness ? "needed for readiness is rejected before activation" : "is untouched when no credential read is needed"}`, async () => {
      if (needsReadiness)
        write("agent.yaml", "name: sample\naugments:\n - { name: agentMail, type: agentMail }\n");
      const before = contents("agent.yaml");
      expect(Bun.spawnSync(["mkfifo", join(root, ".env")]).exitCode).toBe(0);
      const result = boundedAugmentCli([
        "add",
        "knowledge",
        "--config",
        config,
        "--yes",
        "--skip-install",
      ]);
      if (needsReadiness) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/regular file/);
        expect(contents("agent.yaml")).toBe(before);
        expect(existsSync(join(root, ".auggy"))).toBe(false);
      } else {
        expect({ code: result.status, stderr: result.stderr }).toMatchObject({ code: 0 });
        expect(declaration().some((entry) => entry.type === "knowledge")).toBe(true);
      }
      expect(lstatSync(join(root, ".env")).isFIFO()).toBe(true);
    }, 10_000);
});
