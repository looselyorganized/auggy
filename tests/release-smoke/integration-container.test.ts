import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { applicationHash } from "../../scripts/release-smoke/application-consumer";
import {
  probeIntegrationDocker,
  withIntegrationDocker,
} from "../../scripts/release-smoke/integration-container";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

// Command-supervision fixture only. This is deliberately not Docker/container acceptance.
const fixture = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const args = process.argv.slice(2);
const file = process.env.M5_COMMAND_STATE;
appendFileSync(file + ".commands", JSON.stringify(args) + "\\n");
if (process.env.M5_DAEMON_UNAVAILABLE) process.exit(1);
if (args[0] === "info") { console.log(JSON.stringify("28.0.0")); process.exit(0); }
const directory = file + ".resources";
mkdirSync(directory, { recursive: true });
const all = () => readdirSync(directory).map((name) => ({ file: join(directory, name), value: JSON.parse(readFileSync(join(directory, name), "utf8")) }));
const find = (kind, id) => all().find((entry) => entry.value.kind === kind && (entry.value.id === id || entry.value.name === id));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const save = (kind, name) => {
 const id = kind === "volume" ? name : (kind === "image" ? "sha256:" : "") + hash(name);
 const label = args[args.indexOf("--label") + 1].split("=")[1];
 const value = { kind, name, id, labels: { "org.auggy.integration.run": process.env.M5_WRONG_OWNER || label } };
 writeFileSync(join(directory, hash(kind + name)), JSON.stringify(value));
 appendFileSync(file + ".started", JSON.stringify({ pid: process.pid, kind, name }) + "\\n");
 return value;
};
if ((args[0] === "volume" && args[1] === "create") || args[0] === "build" || args[0] === "create") {
 const kind = args[0] === "volume" ? "volume" : args[0] === "build" ? "image" : "container";
 const name = kind === "volume" ? args.at(-1) : args[args.indexOf(kind === "image" ? "--tag" : "--name") + 1];
 const resource = save(kind, name);
 await Bun.sleep(Number(process.env["M5_" + kind.toUpperCase() + "_CREATE_DELAY_MS"] || "0"));
 if (kind === "image") writeFileSync(args[args.indexOf("--iidfile") + 1], resource.id);
 console.log(resource.id); process.exit(0);
}
if (["volume", "image", "container"].includes(args[0]) && args[1] === "inspect") {
 const resource = find(args[0], args.at(-1));
 if (!resource) process.exit(1);
 console.log(JSON.stringify(resource.value.labels)); process.exit(0);
}
if (["volume", "image", "container"].includes(args[0]) && args[1] === "rm") {
 if (process.env.M5_ASSERT_CREATE_REAPED) {
   const started = readFileSync(file + ".started", "utf8").trim().split("\\n").map((line) => JSON.parse(line));
   const live = started.some(({pid}) => { try { process.kill(pid, 0); return true; } catch { return false; } });
   appendFileSync(file + ".cleanup-checks", JSON.stringify({ live }) + "\\n");
   if (live) process.exit(2);
 }
 const resource = find(args[0], args.at(-1));
 if (!resource) process.exit(1);
 rmSync(resource.file);
 writeFileSync(file, JSON.stringify(Object.fromEntries(all().map((entry) => [entry.value.id, entry.value.labels]))));
 process.exit(0);
}
if (["start", "stop", "exec"].includes(args[0])) {
 const id = args[0] === "stop" ? args.at(-1) : args[1];
 if (!find("container", id)) process.exit(1);
 console.log(args[0] === "exec" ? "fixture-command-complete" : id); process.exit(0);
}
process.exit(1);
`;

function options(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "auggy-m5-container-controls-"));
  paths.push(root);
  const binary = join(root, "docker-fixture");
  writeFileSync(binary, fixture);
  chmodSync(binary, 0o700);
  const state = join(root, "state.json");
  return {
    cwd: root,
    binary,
    runId: randomUUID(),
    secrets: [],
    timeoutMs: 1000,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: root,
      M5_COMMAND_STATE: state,
      ...extra,
    },
  };
}

function commands(input: ReturnType<typeof options>): string[][] {
  return readFileSync(`${input.env.M5_COMMAND_STATE}.commands`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

function context(input: ReturnType<typeof options>) {
  const path = join(input.cwd, "export-context");
  mkdirSync(path);
  const manifest = '{"fixture":"command mechanics only"}\n';
  writeFileSync(join(path, "auggy-deployment.json"), manifest);
  return { context: path, exportSHA256: applicationHash(manifest) };
}

describe("Docker supervision controls; no real Docker claim", () => {
  test("an early observer failure kills and reaps an active create before ownership cleanup", async () => {
    const input = options({ M5_VOLUME_CREATE_DELAY_MS: "30000", M5_ASSERT_CREATE_REAPED: "1" });
    let creation: Promise<unknown> | undefined;
    const started = performance.now();
    const result = await withIntegrationDocker({ ...input, timeoutMs: 30_000 }, async (scope) => {
      creation = scope.createVolume().catch(() => undefined);
      const deadline = performance.now() + 2000;
      while (!existsSync(`${input.env.M5_COMMAND_STATE}.started`)) {
        if (performance.now() >= deadline) throw new Error("Fixture create did not start");
        await Bun.sleep(5);
      }
      throw new Error("Observation failed while create was still running");
    });
    await creation;
    expect(result.status).toBe("failed");
    expect(result.cleanup.status).toBe("complete");
    expect(performance.now() - started).toBeLessThan(4000);
    const records = readFileSync(`${input.env.M5_COMMAND_STATE}.started`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { pid: number });
    expect(records).toHaveLength(1);
    expect(() => process.kill(records[0]!.pid, 0)).toThrow();
    expect(readFileSync(`${input.env.M5_COMMAND_STATE}.cleanup-checks`, "utf8")).toBe(
      '{"live":false}\n',
    );
    expect(readdirSync(`${input.env.M5_COMMAND_STATE}.resources`)).toHaveLength(0);
  }, 10_000);

  test("five concurrent volume requests reserve only four creates before any await", async () => {
    const input = options({ M5_VOLUME_CREATE_DELAY_MS: "150" });
    const result = await withIntegrationDocker({ ...input, timeoutMs: 5000 }, async (scope) => {
      const created = await Promise.allSettled(
        Array.from({ length: 5 }, () => scope.createVolume()),
      );
      expect(created.filter((value) => value.status === "fulfilled")).toHaveLength(4);
      expect(created.filter((value) => value.status === "rejected")).toHaveLength(1);
      const denied = created.find((value) => value.status === "rejected");
      expect(
        denied?.status === "rejected" && String(denied.reason).includes("volume count exceeded"),
      ).toBe(true);
    });
    expect(result.status).toBe("passed");
    expect(result.cleanup.status).toBe("complete");
    expect(
      commands(input).filter((command) => command[0] === "volume" && command[1] === "create"),
    ).toHaveLength(4);
  }, 10_000);

  test("failed ownership validation keeps uncertain volume reservations counted", async () => {
    const input = options({ M5_WRONG_OWNER: "unrelated-run" });
    const result = await withIntegrationDocker({ ...input, timeoutMs: 5000 }, async (scope) => {
      const created = await Promise.allSettled(
        Array.from({ length: 4 }, () => scope.createVolume()),
      );
      expect(created.every((value) => value.status === "rejected")).toBe(true);
      await expect(scope.createVolume()).rejects.toThrow("volume count exceeded");
    });
    expect(result.status).toBe("failed");
    expect(result.cleanup.status).toBe("failed");
    expect(result.cleanup.remainingOwnedIds).toHaveLength(4);
    expect(
      commands(input).filter((command) => command[0] === "volume" && command[1] === "create"),
    ).toHaveLength(4);
    expect(commands(input).some((command) => command[1] === "rm")).toBe(false);
  }, 10_000);

  test("five concurrent builds reserve only four image candidates", async () => {
    const input = options({ M5_IMAGE_CREATE_DELAY_MS: "150" });
    const source = context(input);
    const result = await withIntegrationDocker({ ...input, timeoutMs: 5000 }, async (scope) => {
      const built = await Promise.allSettled(Array.from({ length: 5 }, () => scope.build(source)));
      expect(built.filter((value) => value.status === "fulfilled")).toHaveLength(4);
      const denied = built.find((value) => value.status === "rejected");
      expect(
        denied?.status === "rejected" && String(denied.reason).includes("image count exceeded"),
      ).toBe(true);
    });
    expect(result.status).toBe("passed");
    expect(commands(input).filter((command) => command[0] === "build")).toHaveLength(4);
    expect(result.cleanup.status).toBe("complete");
  }, 10_000);

  test("nine concurrent container requests reserve only eight before the CLI returns", async () => {
    const input = options({ M5_CONTAINER_CREATE_DELAY_MS: "150" });
    const source = context(input);
    const result = await withIntegrationDocker({ ...input, timeoutMs: 10_000 }, async (scope) => {
      const volume = await scope.createVolume();
      const { imageId } = await scope.build(source);
      const containers = await Promise.allSettled(
        Array.from({ length: 9 }, () =>
          scope.start({
            volume,
            imageId,
            profile: { kind: "none" },
            env: {},
          }),
        ),
      );
      expect(containers.filter((value) => value.status === "fulfilled")).toHaveLength(8);
      const denied = containers.find((value) => value.status === "rejected");
      expect(
        denied?.status === "rejected" && String(denied.reason).includes("container count exceeded"),
      ).toBe(true);
    });
    expect(result.status).toBe("passed");
    expect(commands(input).filter((command) => command[0] === "create")).toHaveLength(8);
    expect(result.cleanup.status).toBe("complete");
  }, 15_000);

  test("exhausting work commands leaves an independent allowance for all owned cleanup", async () => {
    const input = options();
    const source = context(input);
    let exhausted = false;
    const result = await withIntegrationDocker({ ...input, timeoutMs: 20_000 }, async (scope) => {
      const volume = await scope.createVolume();
      const { imageId } = await scope.build(source);
      const { containerId } = await scope.start({
        volume,
        imageId,
        profile: { kind: "none" },
        env: {},
      });
      try {
        for (let index = 0; index < 128; index++) await scope.exec(containerId, ["fixture-only"]);
      } catch (error) {
        exhausted = String(error).includes("command count exceeded");
        throw error;
      }
    });
    expect(exhausted).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.cleanup.status).toBe("complete");
    expect(result.cleanup.remainingOwnedIds).toHaveLength(0);
    expect(commands(input).filter((command) => command[1] === "rm")).toHaveLength(3);
    expect(readdirSync(`${input.env.M5_COMMAND_STATE}.resources`)).toHaveLength(0);
  }, 30_000);

  test("daemon unavailability reports unavailable and creates no resources", async () => {
    const input = options({ M5_DAEMON_UNAVAILABLE: "1" });
    expect((await probeIntegrationDocker(input)).status).toBe("unavailable");
    let observed = false;
    const result = await withIntegrationDocker(input, async () => {
      observed = true;
    });
    expect(result.status).toBe("unavailable");
    expect(observed).toBe(false);
    const commands = readFileSync(`${input.env.M5_COMMAND_STATE}.commands`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(commands.every((command) => command[0] === "info")).toBe(true);
  });

  test("assertion failure still removes only the exact labelled owned volume", async () => {
    const input = options();
    const result = await withIntegrationDocker(input, async (scope) => {
      await scope.createVolume();
      throw new Error("synthetic scenario assertion failure");
    });
    expect(result.status).toBe("failed");
    expect(result.cleanup.status).toBe("complete");
    expect(JSON.parse(readFileSync(input.env.M5_COMMAND_STATE, "utf8"))).toEqual({});
    const commands = readFileSync(`${input.env.M5_COMMAND_STATE}.commands`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(commands.some((command) => command[0] === "volume" && command[1] === "rm")).toBe(true);
    expect(commands.some((command) => command.includes("prune"))).toBe(false);
  });

  test("wrong owner refuses deletion and records the unresolved exact resource", async () => {
    const input = options({ M5_WRONG_OWNER: "unrelated-run" });
    const result = await withIntegrationDocker(input, async (scope) => {
      await scope.createVolume();
    });
    expect(result.status).toBe("failed");
    expect(result.cleanup.status).toBe("failed");
    expect(result.cleanup.remainingOwnedIds).toHaveLength(1);
    const commands = readFileSync(`${input.env.M5_COMMAND_STATE}.commands`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(commands.some((command) => command[1] === "rm")).toBe(false);
  });

  test("hung scenario expires; a late continuation cannot create resources after cleanup", async () => {
    const input = options();
    let continueLate!: () => void;
    let late: Promise<unknown> | undefined;
    const result = await withIntegrationDocker({ ...input, timeoutMs: 100 }, async (scope) => {
      await new Promise<void>((resolve) => {
        continueLate = resolve;
      });
      late = scope.createVolume();
      await late;
    });
    expect(result.status).toBe("failed");
    continueLate();
    await Bun.sleep(10);
    expect(late).toBeDefined();
    await expect(late!).rejects.toThrow("phase has ended");
    const commands = readFileSync(`${input.env.M5_COMMAND_STATE}.commands`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(commands.some((command) => command[0] === "volume")).toBe(false);
  });
});
