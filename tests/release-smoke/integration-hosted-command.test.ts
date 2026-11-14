import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApplicationChild } from "../../scripts/release-smoke/application-child";
import {
  prepareHostedCommandFixture,
  type HostedCommandReceipt,
  type PreparedHostedCommandFixture,
} from "../../scripts/release-smoke/integration-hosted-command-fixture";
import {
  HOSTED_COMMAND_LIMITS,
  hostedCommandHash,
  parseHostedCommandRegistry,
  parseHostedCommandRequest,
} from "../../scripts/release-smoke/integration-fixtures/hosted/remote-command";

// Opt in explicitly: every test then executes the SAME bundled envelope in the
// pinned Linux image. Only uniquely named, network-disabled owned containers run.
const alpine = process.env.AUGGY_TEST_HOSTED_COMMAND_DOCKER === "1";
const image = "oven/bun@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0";
const docker = "/usr/local/bin/docker";
const children = new Set<ChildProcessWithoutNullStreams>();
const containers = new Set<string>();
let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "auggy-hosted-command-"));
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* Already reaped. */
      }
    }
  }
  children.clear();
  for (const name of containers) await dockerAction(["rm", "--force", name]);
  containers.clear();
  rmSync(workspace, { recursive: true, force: true });
});

const ack = `import { createHash } from "node:crypto";
const input = Buffer.from(await Bun.stdin.arrayBuffer());
const request = JSON.parse(input.toString("utf8"));
const inputSHA256 = createHash("sha256").update(input).digest("hex");
const respond = (result) => console.log(JSON.stringify({version:1,requestId:request.requestId,commandId:request.commandId,inputSHA256,result}));`;
function request(requestId = "request-one", payload: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({ version: 1, operation: "execute", requestId, commandId: "approved", payload }),
  );
}
async function fixture(
  script = `${ack}\nrespond({ok:true});`,
  timeoutMs = 2_000,
  envKeys: string[] = [],
) {
  const source = join(workspace, `source-${randomUUID()}.ts`);
  writeFileSync(source, script);
  return prepareHostedCommandFixture({
    destination: join(workspace, `fixture-${randomUUID()}`),
    commands: [{ commandId: "approved", sourcePath: source, timeoutMs, envKeys }],
  });
}
function argv(prepared: PreparedHostedCommandFixture) {
  if (!alpine) return [process.execPath, ...prepared.launchArgs];
  const name = `auggy-command-${randomUUID()}`;
  containers.add(name);
  return [
    docker,
    "run",
    "--rm",
    "--init",
    "-i",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--user",
    String(process.getuid!()),
    "--mount",
    `type=bind,src=${prepared.directory},dst=/fixture`,
    ...[...new Set(prepared.registry.commands.flatMap((entry) => entry.envKeys))].flatMap((key) => [
      "--env",
      key,
    ]),
    image,
    "/usr/local/bin/bun",
    "--no-env-file",
    "--no-install",
    "--config=/dev/null",
    "/fixture/remote-command.js",
    prepared.entrySHA256,
  ];
}
async function execute(
  prepared: PreparedHostedCommandFixture,
  input: Uint8Array,
  env: Record<string, string> = {},
) {
  return startApplicationChild({
    command: argv(prepared),
    cwd: workspace,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      DOCKER_HOST: "unix:///Users/bigviking/.docker/run/docker.sock",
      ...env,
    },
    secrets: [],
    input,
    timeoutMs: 20_000,
  }).finish();
}
function receipt(prepared: PreparedHostedCommandFixture, id = "request-one"): HostedCommandReceipt {
  return JSON.parse(
    readFileSync(join(prepared.directory, "receipts", `${id}.receipt.json`), "utf8"),
  );
}
async function dockerAction(args: string[]) {
  return startApplicationChild({
    command: [docker, ...args],
    cwd: workspace,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      DOCKER_HOST: "unix:///Users/bigviking/.docker/run/docker.sock",
    },
    secrets: [],
    timeoutMs: 10_000,
  }).finish();
}
function raw(prepared: PreparedHostedCommandFixture) {
  const command = argv(prepared);
  const child = spawn(command[0]!, command.slice(1), {
    cwd: workspace,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      DOCKER_HOST: "unix:///Users/bigviking/.docker/run/docker.sock",
    },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  return child;
}
async function closed(child: ChildProcessWithoutNullStreams, timeoutMs = 12_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<number | null>((resolve) => child.once("close", resolve)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Envelope did not exit within test bound")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitFile(file: string) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(file)).toBe(true);
}

test("strict finite registry and request reject arbitrary argv, environment and oversized bounds", () => {
  expect(() =>
    parseHostedCommandRequest(
      Buffer.from(
        JSON.stringify({ ...JSON.parse(request().toString()), argv: ["sh", "-c", "bad"] }),
      ),
    ),
  ).toThrow();
  expect(() => parseHostedCommandRequest(Buffer.alloc(HOSTED_COMMAND_LIMITS.bytes + 1))).toThrow();
  expect(() => parseHostedCommandRequest(request("../escape"))).toThrow();
  const entry = {
    commandId: "approved",
    script: "commands/approved.js",
    sourceSHA256: "a".repeat(64),
    timeoutMs: 60_001,
    envKeys: [],
  };
  expect(() =>
    parseHostedCommandRegistry(Buffer.from(JSON.stringify({ version: 1, commands: [entry] }))),
  ).toThrow();
  expect(() =>
    parseHostedCommandRegistry(
      Buffer.from(
        JSON.stringify({
          version: 1,
          commands: [{ ...entry, timeoutMs: 100, envKeys: ["BUN_OPTIONS"] }],
        }),
      ),
    ),
  ).toThrow();
});

test("acknowledged success persists private receipt before output; explicit read is byte-identical and duplicate never reexecutes", async () => {
  const prepared = await fixture(
    `${ack}\nimport { appendFileSync } from "node:fs"; appendFileSync("effect", "once"); respond({ok:true});`,
  );
  const bytes = request();
  const result = await execute(prepared, bytes);
  expect(result.exitCode).toBe(0);
  expect(result.cleanupConfirmed).toBe(true);
  const saved = receipt(prepared);
  expect(saved.status).toBe("passed");
  expect(saved.inputSHA256).toBe(hostedCommandHash(bytes));
  expect(saved.registrySHA256).toBe(prepared.registrySHA256);
  expect(saved.bundleSHA256).toBe(prepared.entrySHA256);
  expect(saved.sourceSHA256).toBe(prepared.registry.commands[0]!.sourceSHA256);
  expect(saved.child?.cleanupConfirmed).toBe(true);
  expect(saved.child?.inputComplete).toBe(true);
  expect(saved.acknowledged).toBe(true);
  expect(statSync(join(prepared.directory, "receipts")).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(join(prepared.directory, "receipts")))
    expect(statSync(join(prepared.directory, "receipts", name)).mode & 0o777).toBe(0o600);
  expect(result.stdout).toBe(
    readFileSync(join(prepared.directory, "receipts/request-one.receipt.json"), "utf8"),
  );
  const read = await execute(
    prepared,
    Buffer.from(
      JSON.stringify({ version: 1, operation: "read-receipt", requestId: "request-one" }),
    ),
  );
  expect(read.exitCode).toBe(0);
  expect(read.stdout).toBe(result.stdout);
  const duplicate = await execute(prepared, bytes);
  expect(duplicate.exitCode).toBe(1);
  expect(duplicate.stdout).toBe("");
  expect(readFileSync(join(prepared.directory, "effect"), "utf8")).toBe("once");
}, 40_000);

test("concurrent duplicate requests have one durable admission and one effect", async () => {
  const prepared = await fixture(
    `${ack}\nimport { appendFileSync } from "node:fs"; appendFileSync("effect", "once"); await Bun.sleep(100); respond({ok:true});`,
  );
  const results = await Promise.all([execute(prepared, request()), execute(prepared, request())]);
  expect(results.map((value) => value.exitCode).sort()).toEqual([0, 1]);
  expect(readFileSync(join(prepared.directory, "effect"), "utf8")).toBe("once");
  expect(receipt(prepared).status).toBe("passed");
}, 30_000);

test("shell syntax in payload stays inert data and launch ignores adjacent env/config files", async () => {
  const prepared = await fixture(
    `${ack}\nrespond({value:request.payload.value, env:process.env.HOSTED_CANARY ?? null});`,
  );
  writeFileSync(join(prepared.directory, ".env"), "HOSTED_CANARY=loaded\n");
  writeFileSync(join(prepared.directory, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
  writeFileSync(join(prepared.directory, "evil.ts"), 'await Bun.write("unwanted", "ran");');
  const value = "$(touch unwanted); `touch unwanted`; /bin/sh -c nope";
  const result = await execute(prepared, request("request-one", { value }));
  expect(result.exitCode).toBe(0);
  expect(receipt(prepared).result).toEqual({ value, env: null });
  expect(existsSync(join(prepared.directory, "unwanted"))).toBe(false);
});

test("pipe completion and zero exit without application acknowledgement cannot pass", async () => {
  const prepared = await fixture("await Bun.stdin.arrayBuffer(); console.log('{}');");
  const result = await execute(prepared, request());
  expect(result.exitCode).toBe(1);
  expect(receipt(prepared).child?.inputComplete).toBe(true);
  expect(receipt(prepared).acknowledged).toBe(false);
  expect(receipt(prepared).status).toBe("failed");
});

test("reviewed generation evidence remains visible while forwarded control credentials are redacted", async () => {
  const prepared = await fixture(
    `${ack}\nrespond({generation:process.env.AUGGY_FIXTURE_GENERATION_ID, token:process.env.AUGGY_FIXTURE_CONTROL_TOKEN});`,
    2_000,
    ["AUGGY_FIXTURE_GENERATION_ID", "AUGGY_FIXTURE_CONTROL_TOKEN"],
  );
  const secret = "b".repeat(64);
  const result = await execute(prepared, request(), {
    AUGGY_FIXTURE_GENERATION_ID: "generation-visible",
    AUGGY_FIXTURE_CONTROL_TOKEN: secret,
  });
  expect(result.exitCode).toBe(0);
  expect(receipt(prepared).result).toEqual({
    generation: "generation-visible",
    token: "[REDACTED]",
  });
  expect(result.stdout).not.toContain(secret);
  for (const name of readdirSync(join(prepared.directory, "receipts")))
    expect(readFileSync(join(prepared.directory, "receipts", name), "utf8")).not.toContain(secret);
});

test("short or JSON-escaped credential formats fail before executing reviewed code", async () => {
  for (const token of ["canary7", 'synthetic-secret-"quoted"-value']) {
    const prepared = await fixture(
      `${ack}\nawait Bun.write("unwanted", "ran"); respond({token:process.env.AUGGY_FIXTURE_CONTROL_TOKEN});`,
      2_000,
      ["AUGGY_FIXTURE_CONTROL_TOKEN"],
    );
    const result = await execute(prepared, request(), { AUGGY_FIXTURE_CONTROL_TOKEN: token });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(existsSync(join(prepared.directory, "unwanted"))).toBe(false);
    expect(existsSync(join(prepared.directory, "receipts/request-one.receipt.json"))).toBe(false);
    expect(
      (await execute(prepared, request(), { AUGGY_FIXTURE_CONTROL_TOKEN: "b".repeat(64) }))
        .exitCode,
    ).toBe(1);
  }
}, 20_000);

test("escaped output cannot leak a valid token through nested strings or object keys", async () => {
  const prepared = await fixture(
    `${ack}\nconst token=process.env.AUGGY_FIXTURE_CONTROL_TOKEN;
const output=JSON.stringify({version:1,requestId:request.requestId,commandId:request.commandId,inputSHA256,result:{[token]:[token]}});
const escaped=Array.from(token).map(c=>"\\\\u"+c.charCodeAt(0).toString(16).padStart(4,"0")).join("");
console.log(output.split(token).join(escaped));`,
    2_000,
    ["AUGGY_FIXTURE_CONTROL_TOKEN"],
  );
  const token = "b".repeat(64);
  const result = await execute(prepared, request(), { AUGGY_FIXTURE_CONTROL_TOKEN: token });
  expect(result.exitCode).toBe(1);
  expect(receipt(prepared).acknowledged).toBe(false);
  expect(receipt(prepared).result).toBeNull();
  expect(result.stdout).not.toContain(token);
});

test("private token cannot become public request identity and unsupported env names fail preparation", async () => {
  const token = "b".repeat(64);
  const prepared = await fixture(`${ack}\nrespond({ok:true});`, 2_000, [
    "AUGGY_FIXTURE_CONTROL_TOKEN",
  ]);
  const result = await execute(prepared, request(token), { AUGGY_FIXTURE_CONTROL_TOKEN: token });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(existsSync(join(prepared.directory, "receipts", `${token}.claim.json`))).toBe(false);
  await expect(
    fixture(`${ack}\nrespond({ok:true});`, 2_000, ["AUGGY_FIXTURE_UNREVIEWED_SECRET"]),
  ).rejects.toThrow();
});

test("an acknowledgement of another request or other bytes cannot pass", async () => {
  for (const change of [
    'request.requestId = "another-request";',
    'const wrong = "0".repeat(64);',
  ]) {
    const script = change.startsWith("const wrong")
      ? `${ack}\nconsole.log(JSON.stringify({version:1,requestId:request.requestId,commandId:request.commandId,inputSHA256:"0".repeat(64),result:{ok:true}}));`
      : `${ack}\n${change} respond({ok:true});`;
    const prepared = await fixture(script);
    expect((await execute(prepared, request())).exitCode).toBe(1);
    expect(receipt(prepared).acknowledged).toBe(false);
  }
});

test("nonreader input reaches the independent deadline and cannot pass", async () => {
  const prepared = await fixture("setInterval(() => {}, 1000);", 250);
  const result = await execute(
    prepared,
    request("request-one", { padding: "x".repeat(HOSTED_COMMAND_LIMITS.bytes - 256) }),
  );
  expect(result.exitCode).toBe(1);
  const saved = receipt(prepared);
  expect(saved.status).toBe("failed");
  expect(saved.child?.timedOut).toBe(true);
  // Bun can buffer stdin even though this script never consumes it. Pipe
  // completion is deliberately insufficient: no application ack can pass.
  expect(typeof saved.child?.inputComplete).toBe("boolean");
  expect(saved.acknowledged).toBe(false);
  expect(saved.child?.cleanupConfirmed).toBe(true);
}, 25_000);

test("output flood is bounded, kills the command and preserves a failure receipt", async () => {
  const prepared = await fixture(
    "await Bun.stdin.arrayBuffer(); process.stdout.write('x'.repeat(3*1024*1024)); setInterval(() => {}, 1000);",
    2_000,
  );
  const result = await execute(prepared, request());
  expect(result.exitCode).toBe(1);
  expect(receipt(prepared).child?.exceededOutput).toBe(true);
  expect(receipt(prepared).child?.cleanupConfirmed).toBe(true);
  expect(Buffer.byteLength(result.stdout)).toBeLessThan(4096);
});

test("a leader that leaves a descendant never passes and the owned group is stopped", async () => {
  const prepared = await fixture(
    `${ack}\nconst child=Bun.spawn([process.execPath,"--no-env-file","--no-install","--config=/dev/null","-e","setInterval(()=>{},1000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"}); await Bun.write("descendant", String(child.pid)); respond({ok:true}); process.exit(0);`,
    2_000,
  );
  const result = await execute(prepared, request());
  expect(result.exitCode).toBe(1);
  const saved = receipt(prepared);
  expect(saved.status).toBe("failed");
  expect(saved.child?.orphanedGroup).toBe(true);
  expect(saved.child?.cleanupConfirmed).toBe(true);
  if (!alpine)
    expect(() =>
      process.kill(Number(readFileSync(join(prepared.directory, "descendant"), "utf8")), 0),
    ).toThrow();
}, 15_000);

test("incomplete input and EOF cancellation do not execute a command", async () => {
  const prepared = await fixture(`${ack}\nawait Bun.write("unwanted", "ran"); respond({ok:true});`);
  const child = raw(prepared);
  const exit = closed(child);
  child.stdin.write('{"version":');
  child.stdout.resume();
  child.stderr.resume();
  expect(await exit).toBe(1);
  expect(existsSync(join(prepared.directory, "unwanted"))).toBe(false);
  expect(existsSync(join(prepared.directory, "receipts"))).toBe(false);
  const empty = await execute(prepared, Buffer.alloc(0));
  expect(empty.exitCode).toBe(1);
}, 20_000);

test("signal cancellation during incomplete input exits without admission", async () => {
  const prepared = await fixture();
  const child = raw(prepared);
  const exit = closed(child);
  child.stdin.write('{"version":');
  child.stdout.resume();
  child.stderr.resume();
  // Wait for entry startup. No request can be admitted before EOF.
  await Bun.sleep(alpine ? 300 : 100);
  if (alpine)
    expect(
      (await dockerAction(["kill", "--signal", "SIGTERM", [...containers].at(-1)!])).exitCode,
    ).toBe(0);
  else child.kill("SIGTERM");
  expect(await exit).toBe(1);
  expect(existsSync(join(prepared.directory, "receipts"))).toBe(false);
}, 20_000);

test("SIGINT TERM and HUP interrupt admitted work and leave durable failure receipts", async () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const prepared = await fixture(
      `${ack}\nawait Bun.write("started", "yes"); setInterval(()=>{},1000);`,
      5_000,
    );
    const child = raw(prepared);
    const exit = closed(child);
    child.stdin.end(request());
    child.stdout.resume();
    child.stderr.resume();
    await waitFile(join(prepared.directory, "started"));
    if (alpine) {
      const name = [...containers].at(-1)!;
      expect((await dockerAction(["kill", "--signal", signal, name])).exitCode).toBe(0);
    } else child.kill(signal);
    expect(await exit).toBe(1);
    const saved = receipt(prepared);
    expect(saved.status).toBe("failed");
    expect(saved.interrupted).toBe(signal);
    expect(saved.child?.cleanupConfirmed).toBe(true);
  }
}, 45_000);

test("caller output disconnect cannot prevent durable outcome or permit replay", async () => {
  const prepared = await fixture(
    `${ack}\nawait Bun.write("started", "yes"); await Bun.sleep(300); respond({ok:true});`,
  );
  const child = raw(prepared);
  const exit = closed(child);
  child.stdin.end(request());
  child.stderr.resume();
  await waitFile(join(prepared.directory, "started"));
  child.stdout.destroy();
  await exit;
  await waitFile(join(prepared.directory, "receipts/request-one.commit.json"));
  expect(receipt(prepared).status).toBe("passed");
  const read = await execute(
    prepared,
    Buffer.from(
      JSON.stringify({ version: 1, operation: "read-receipt", requestId: "request-one" }),
    ),
  );
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout).status).toBe("passed");
  expect((await execute(prepared, request())).exitCode).toBe(1);
}, 35_000);

test("remote deadline survives a disconnected caller; only its durable receipt establishes outcome", async () => {
  const prepared = await fixture(
    `${ack}\nawait Bun.write("started", "yes"); setInterval(()=>{},1000);`,
    500,
  );
  const child = raw(prepared);
  const exit = closed(child);
  child.stdin.end(request());
  child.stderr.resume();
  await waitFile(join(prepared.directory, "started"));
  if (alpine)
    child.kill("SIGKILL"); // Kills only local Docker caller, not the remote process.
  else child.stdout.destroy();
  await waitFile(join(prepared.directory, "receipts/request-one.commit.json"));
  await exit;
  const saved = receipt(prepared);
  expect(saved.status).toBe("failed");
  expect(saved.child?.timedOut).toBe(true);
  expect(saved.child?.cleanupConfirmed).toBe(true);
  const read = await execute(
    prepared,
    Buffer.from(
      JSON.stringify({ version: 1, operation: "read-receipt", requestId: "request-one" }),
    ),
  );
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout).status).toBe("failed");
}, 30_000);

test("registry, bundle, command source and receipt tampering are rejected", async () => {
  for (const target of ["commands.json", "remote-command.js", "commands/approved.js"]) {
    const prepared = await fixture();
    writeFileSync(
      join(prepared.directory, target),
      `${readFileSync(join(prepared.directory, target), "utf8")}\n `,
    );
    const result = await execute(prepared, request());
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(existsSync(join(prepared.directory, "receipts/request-one.claim.json"))).toBe(false);
  }
  const prepared = await fixture();
  expect((await execute(prepared, request())).exitCode).toBe(0);
  const path = join(prepared.directory, "receipts/request-one.receipt.json");
  writeFileSync(path, readFileSync(path, "utf8").replace('"status":"passed"', '"status":"failed"'));
  const read = await execute(
    prepared,
    Buffer.from(
      JSON.stringify({ version: 1, operation: "read-receipt", requestId: "request-one" }),
    ),
  );
  expect(read.exitCode).toBe(1);
  expect(read.stdout).toBe("");
}, 35_000);

test("a linked source or linked receipt cannot substitute trusted bytes", async () => {
  const prepared = await fixture();
  const source = join(prepared.directory, "commands/approved.js");
  const other = join(prepared.directory, "other.js");
  writeFileSync(other, readFileSync(source));
  rmSync(source);
  symlinkSync("../other.js", source);
  expect((await execute(prepared, request())).exitCode).toBe(1);
  expect(existsSync(join(prepared.directory, "receipts/request-one.claim.json"))).toBe(false);
  const second = await fixture();
  expect((await execute(second, request())).exitCode).toBe(0);
  const saved = join(second.directory, "receipts/request-one.receipt.json");
  writeFileSync(join(second.directory, "substitute.json"), readFileSync(saved));
  rmSync(saved);
  symlinkSync("../substitute.json", saved);
  const read = await execute(
    second,
    Buffer.from(
      JSON.stringify({ version: 1, operation: "read-receipt", requestId: "request-one" }),
    ),
  );
  expect(read.exitCode).toBe(1);
  expect(read.stdout).toBe("");
});

test("an existing orphan claim blocks all automatic retries", async () => {
  const prepared = await fixture(`${ack}\nawait Bun.write("unwanted", "ran"); respond({ok:true});`);
  mkdirSync(join(prepared.directory, "receipts"), { mode: 0o700 });
  writeFileSync(join(prepared.directory, "receipts/request-one.claim.json"), "{}", { mode: 0o600 });
  const result = await execute(prepared, request());
  expect(result.exitCode).toBe(1);
  expect(existsSync(join(prepared.directory, "unwanted"))).toBe(false);
  expect(
    (
      await execute(
        prepared,
        Buffer.from(
          JSON.stringify({ version: 1, operation: "read-receipt", requestId: "request-one" }),
        ),
      )
    ).exitCode,
  ).toBe(1);
});
