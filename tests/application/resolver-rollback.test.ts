import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAugments } from "../../src/cli/augment-resolver";
import { createApplicationHost } from "../../src/application/host";
import { readPidManifest } from "../../src/cli/pid-registry";
import type { AugmentConfig } from "../../src/cli/types";
import { contractComposer } from "../fixtures/application-contract";
import { createMockModel } from "../fixtures/mock-model";

test("partial resolver failure reports once only after reverse shutdown actually settles", async () => {
  for (const failingCleanup of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "host-resolver-rollback-"));
    const events = join(root, "events");
    for (const name of ["first", "second"])
      writeFileSync(
        join(root, `${name}.ts`),
        `import { appendFileSync } from "node:fs";
      export default () => ({ name: "${name}", onShutdown: async () => {
        await Bun.sleep(5); appendFileSync(${JSON.stringify(events)}, "${name}\\n");
        ${failingCleanup && name === "second" ? 'throw new Error("private cleanup failure");' : ""}
      } });`,
      );
    writeFileSync(
      join(root, "broken.ts"),
      'export default () => { throw new Error("original factory failure"); };',
    );
    let reports = 0;
    let observed: unknown;
    try {
      await expect(
        resolveAugments(
          ["first", "second", "broken"].map((name) => ({
            name,
            type: "custom",
            source: `./${name}.ts`,
          })),
          root,
          {
            onConstructionRollback(report) {
              reports++;
              observed = {
                events: readFileSync(events, "utf8"),
                frozen: Object.isFrozen(report),
                report,
              };
              throw new Error("observer must not replace original error");
            },
          },
        ),
      ).rejects.toThrow("original factory failure");
      expect(reports).toBe(1);
      expect(observed).toEqual({
        events: "second\nfirst\n",
        frozen: true,
        report: {
          resources: "unknown",
          failures: failingCleanup ? ["augment-shutdown-failed"] : [],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test.each([
  { name: "broken", type: "custom" },
  {
    name: "learned",
    type: "fileMemory",
    options: { label: "learned", source: "./learned.md" },
  },
] satisfies AugmentConfig[])(
  "validation before a $type constructor does not retain unknown resources",
  async (invalid) => {
    const root = mkdtempSync(join(tmpdir(), "host-resolver-validation-"));
    const events = join(root, "events");
    writeFileSync(
      join(root, "first.ts"),
      `import { writeFileSync } from "node:fs";
       export default () => ({ name: "first", onShutdown() {
         writeFileSync(${JSON.stringify(events)}, "closed");
       } });`,
    );
    let report: unknown;
    try {
      await expect(
        resolveAugments([{ name: "first", type: "custom", source: "./first.ts" }, invalid], root, {
          onConstructionRollback: (value) => {
            report = value;
          },
        }),
      ).rejects.toThrow();
      expect(readFileSync(events, "utf8")).toBe("closed");
      expect(report).toEqual({ resources: "closed", failures: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function resourceFixture(mode: "factory" | "import" | "invalid-return" | "normalization") {
  const root = mkdtempSync(join(tmpdir(), "host-construction-resource-"));
  const id = `aug1_${crypto.randomUUID()}`;
  const key = `auggy-construction-test-${crypto.randomUUID()}`;
  const registry = {
    auggyDir: join(root, "registry"),
    processIdentityForPid: () => "construction-test-incarnation",
  };
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/index.ts"), "// declaration only\n");
  const allocate = `globalThis[${JSON.stringify(key)}] = Bun.serve({
    hostname: "127.0.0.1", port: 0, fetch: () => new Response("still active")
  });
  writeFileSync(${JSON.stringify(join(root, "port"))}, String(globalThis[${JSON.stringify(key)}].port));`;
  const failure = 'throw new Error("construction resource failure");';
  const body =
    mode === "invalid-return"
      ? "return undefined;"
      : mode === "normalization"
        ? `return { name: "resource", get tools() { ${failure} }, async onShutdown() {
          await globalThis[${JSON.stringify(key)}].stop(true);
          await Bun.write(${JSON.stringify(join(root, "closed"))}, "closed");
        } };`
        : failure;
  writeFileSync(
    join(root, "resource.ts"),
    'import { writeFileSync } from "node:fs";\n' +
      (mode === "import"
        ? `${allocate}\n${failure}\nexport default () => ({ name: "unreachable" });`
        : `export default () => { ${allocate}\n${body} };`),
  );
  writeFileSync(
    join(root, "agent.yaml"),
    `id: ${id}
name: construction-resource-test
application:
  entrypoint: ./src/index.ts
  contractVersion: 1
engine:
  provider: anthropic
  model: fixture
augments:
  - name: resource
    type: custom
    source: ./resource.ts
`,
  );
  const options = {
    configPath: join(root, "agent.yaml"),
    mode: "foreground" as const,
    ...registry,
    compose: contractComposer,
    factories: { resolveEngine: async () => createMockModel() },
  };
  const host = createApplicationHost(options);
  const server = () => Reflect.get(globalThis, key) as Bun.Server<undefined> | undefined;
  return {
    root,
    host,
    options,
    server,
    manifest: () => readPidManifest(id, registry),
    async dispose() {
      await server()?.stop(true);
      Reflect.deleteProperty(globalThis, key);
      await host.stop({ deadlineMs: 100 });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.each(["factory", "import", "invalid-return"] as const)(
  "a %s failure after allocation retains ownership and blocks a competing host",
  async (mode) => {
    const fixture = resourceFixture(mode);
    try {
      await expect(fixture.host.prepare()).rejects.toThrow(
        mode === "invalid-return"
          ? "must return an augment object"
          : "construction resource failure",
      );
      expect(await fixture.host.stop({ deadlineMs: 1000 })).toMatchObject({
        status: "retained",
        ownership: "retained",
        reason: "outcome-unknown",
      });
      expect(fixture.manifest()).not.toBeNull();
      const server = fixture.server();
      expect(server).toBeDefined();
      const response = await fetch(`http://127.0.0.1:${server!.port}/`);
      expect(await response.text()).toBe("still active");
      const competitor = createApplicationHost(fixture.options);
      try {
        await expect(competitor.prepare()).rejects.toThrow(/live or unverifiable runtime/);
      } finally {
        await competitor.stop({ deadlineMs: 100 });
      }
      expect(fixture.manifest()).not.toBeNull();
    } finally {
      await fixture.dispose();
    }
  },
);

test("a returned augment is cleaned up when property normalization throws", async () => {
  const fixture = resourceFixture("normalization");
  try {
    await expect(fixture.host.prepare()).rejects.toThrow("construction resource failure");
    expect(await fixture.host.stop({ deadlineMs: 1000 })).toMatchObject({
      status: "stopped",
      ownership: "released",
      cleanup: "complete",
    });
    expect(readFileSync(join(fixture.root, "closed"), "utf8")).toBe("closed");
    expect(fixture.manifest()).toBeNull();
    const port = readFileSync(join(fixture.root, "port"), "utf8");
    await expect(
      fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
  } finally {
    await fixture.dispose();
  }
});

test("a throwing built-in factory cannot certify resource closure", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-resolver-builtin-"));
  let server: Bun.Server<undefined> | undefined;
  let report: unknown;
  try {
    await expect(
      resolveAugments([{ name: "web", type: "webTransport" }], root, {
        webTransportFactory() {
          server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => new Response("active"),
          });
          throw new Error("built-in construction failure");
        },
        onConstructionRollback(value) {
          report = value;
        },
      }),
    ).rejects.toThrow("built-in construction failure");
    expect(report).toEqual({ resources: "unknown", failures: [] });
    expect(await (await fetch(`http://127.0.0.1:${server!.port}/`)).text()).toBe("active");
  } finally {
    await server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
