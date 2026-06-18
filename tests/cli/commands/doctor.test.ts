import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  doctorCommand,
  formatDoctorChecks,
  hasDoctorFailures,
  isPortAvailable,
  runDoctor,
  type DoctorCheck,
} from "../../../src/cli/commands/doctor";

let auggyDir: string;
let originalWebToken: string | undefined;
let originalVisitorSigningKey: string | undefined;

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "doctor-test-auggy-"));
  originalWebToken = process.env.AUGGY_WEB_TOKEN;
  originalVisitorSigningKey = process.env.VISITOR_SIGNING_KEY;
  delete process.env.AUGGY_WEB_TOKEN;
  delete process.env.VISITOR_SIGNING_KEY;
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
  if (originalWebToken === undefined) delete process.env.AUGGY_WEB_TOKEN;
  else process.env.AUGGY_WEB_TOKEN = originalWebToken;
  if (originalVisitorSigningKey === undefined) delete process.env.VISITOR_SIGNING_KEY;
  else process.env.VISITOR_SIGNING_KEY = originalVisitorSigningKey;
});

function agentDirFor(name: string): string {
  return join(auggyDir, "agents", name);
}

function writeAgent(
  name: string,
  opts: {
    provider?: "anthropic" | "openai";
    port?: number;
    token?: string;
    includePackageJson?: boolean;
    installDeps?: boolean;
    installSkill?: boolean;
    providerKey?: string;
    includeVisitorAuth?: boolean;
    includeMcp?: boolean;
    customRoutes?: "valid" | "reserved" | "duplicate";
  } = {},
): string {
  const provider = opts.provider ?? "anthropic";
  const dir = agentDirFor(name);
  mkdirSync(dir, { recursive: true });

  const envToken = opts.token ?? "tok-test";
  const providerKey = opts.providerKey ?? "sk-test";
  const providerEnvVar =
    provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : "OPENROUTER_API_KEY";
  writeFileSync(
    join(dir, ".env"),
    `AUGGY_WEB_TOKEN=${envToken}\n${providerEnvVar}=${providerKey}\nVISITOR_SIGNING_KEY=visitor-secret\n`,
  );

  const config = {
    id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
    name,
    engine: {
      provider,
      model: provider === "openai" ? "gpt-5" : "claude-sonnet-4-6",
    },
    augments: [
      "webTransport",
      "webFetch",
      ...(opts.includeVisitorAuth ? ["visitorAuth"] : []),
      ...(opts.includeMcp ? ["mcp"] : []),
      ...(opts.customRoutes ? ["concierge-services"] : []),
    ],
  };
  writeFileSync(join(dir, "agent.yaml"), stringify(config));
  writeAugmentMetadata(dir, "webTransport", {
    type: "webTransport",
    config: {
      port: opts.port ?? 8080,
      auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
    },
  });
  writeAugmentMetadata(dir, "webFetch", {
    type: "webFetch",
    config: { timeoutMs: 15000 },
  });
  if (opts.includeVisitorAuth) {
    writeAugmentMetadata(dir, "visitorAuth", {
      type: "visitorAuth",
      config: { signingKey: "${VISITOR_SIGNING_KEY}" },
    });
  }
  if (opts.includeMcp) {
    writeAugmentMetadata(dir, "mcp", { type: "mcp", config: {} });
  }

  if (opts.customRoutes) {
    mkdirSync(join(dir, "augments", "concierge-services"), { recursive: true });
    writeFileSync(
      join(dir, "augments", "concierge-services", "augment.yaml"),
      stringify({ type: "custom", source: "./index.ts", config: {} }),
    );
    writeFileSync(
      join(dir, "augments", "concierge-services", "index.ts"),
      customRouteModule(opts.customRoutes),
    );
  }

  if (opts.includePackageJson !== false) {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: `auggy-agent-${name}`,
          private: true,
          type: "module",
          dependencies: {
            auggy: "^0.0.0",
            [provider === "openai" ? "@auggy/openai" : "@auggy/anthropic"]: "^0.0.0",
          },
        },
        null,
        2,
      ),
    );
  }

  if (opts.installDeps) {
    mkdirSync(join(dir, "node_modules", "auggy", "src"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "@auggy", provider), { recursive: true });
  }

  if (opts.installSkill) {
    mkdirSync(join(dir, "skills", "webFetch"), { recursive: true });
    writeFileSync(join(dir, "skills", "webFetch", "SKILL.md"), "---\nname: webFetch\n---\n");
    if (opts.includeVisitorAuth) {
      mkdirSync(join(dir, "skills", "visitorAuth"), { recursive: true });
      writeFileSync(
        join(dir, "skills", "visitorAuth", "SKILL.md"),
        "---\nname: visitorAuth\n---\n",
      );
    }
    if (opts.includeMcp) {
      mkdirSync(join(dir, "skills", "mcp"), { recursive: true });
      writeFileSync(join(dir, "skills", "mcp", "SKILL.md"), "---\nname: mcp\n---\n");
    }
  }

  return dir;
}

function writeAugmentMetadata(dir: string, id: string, metadata: Record<string, unknown>): void {
  mkdirSync(join(dir, "augments", id), { recursive: true });
  writeFileSync(join(dir, "augments", id, "augment.yaml"), stringify(metadata));
}

function customRouteModule(kind: "valid" | "reserved" | "duplicate"): string {
  if (kind === "reserved") {
    return `
      export default function conciergeServices() {
        return {
          name: "concierge-services",
          httpRoutes: [
            {
              method: "GET",
              path: "/console",
              auth: "none",
              handler: async () => new Response(JSON.stringify({ ok: true })),
            },
          ],
        };
      }
    `;
  }

  if (kind === "duplicate") {
    return `
      export default function conciergeServices() {
        return {
          name: "concierge-services",
          httpRoutes: [
            {
              method: "GET",
              path: "/services",
              auth: "none",
              handler: async () => new Response(JSON.stringify({ ok: true })),
            },
            {
              method: "GET",
              path: "/services",
              auth: "bearer",
              handler: async () => new Response(JSON.stringify({ ok: true })),
            },
          ],
        };
      }
    `;
  }

  return `
        export default function conciergeServices() {
          return {
            name: "concierge-services",
            httpRoutes: [
              {
                method: "GET",
                path: "/services",
                auth: "none",
                handler: async () => new Response(JSON.stringify({ ok: true })),
              },
              {
                method: "POST",
                path: "/leads/create",
                auth: "bearer",
                handler: async () => new Response(JSON.stringify({ ok: true })),
              },
            ],
          };
        }
      `;
}

describe("runDoctor", () => {
  test("passes a ready local scaffold", async () => {
    writeAgent("zip", { installDeps: true, installSkill: true });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    expect(hasDoctorFailures(checks)).toBe(false);
    expect(checks.some((c) => c.name === "agent.yaml" && c.status === "pass")).toBe(true);
    expect(checks.some((c) => c.name === "dependency auggy" && c.status === "pass")).toBe(true);
    expect(checks.some((c) => c.name === "port 8080" && c.status === "pass")).toBe(true);
  });

  test("passes a ready project-local scaffold without an agent name", async () => {
    const dir = writeAgent("zip", { installDeps: true, installSkill: true });

    const checks = await runDoctor(undefined, {
      auggyDir,
      cwd: dir,
      isPortAvailable: async () => true,
    });

    expect(hasDoctorFailures(checks)).toBe(false);
    expect(checks.find((c) => c.name === "config path")?.message).toBe(join(dir, "agent.yaml"));
  });

  test("fails when the agent cannot be resolved", async () => {
    const checks = await runDoctor("ghost", { auggyDir });

    expect(hasDoctorFailures(checks)).toBe(true);
    expect(checks[0]?.name).toBe("config path");
    expect(checks[0]?.status).toBe("fail");
    expect(checks[0]?.fix).toContain("auggy create ghost");
  });

  test("surfaces missing env placeholders as an agent.yaml failure", async () => {
    const dir = writeAgent("zip", { installDeps: true });
    writeFileSync(join(dir, ".env"), "AUGGY_WEB_TOKEN=\n");

    const checks = await runDoctor("zip", { auggyDir });

    expect(hasDoctorFailures(checks)).toBe(true);
    const config = checks.find((c) => c.name === "agent.yaml");
    expect(config?.status).toBe("fail");
    expect(config?.message).toContain("AUGGY_WEB_TOKEN");
    expect(config?.message).toContain("augments/webTransport/augment.yaml");
    expect(config?.message).toContain(".env");
  });

  test("fails when provider api key is blank in .env", async () => {
    writeAgent("zip", { installDeps: true, installSkill: true, providerKey: "" });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const providerEnv = checks.find((c) => c.name === "env ANTHROPIC_API_KEY");
    expect(providerEnv?.status).toBe("fail");
    expect(providerEnv?.message).toContain(".env");
    expect(providerEnv?.fix).toContain("ANTHROPIC_API_KEY");
  });

  test("passes provider api key check when set", async () => {
    writeAgent("zip", { installDeps: true, installSkill: true, providerKey: "sk-ant-test" });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const providerEnv = checks.find((c) => c.name === "env ANTHROPIC_API_KEY");
    expect(providerEnv?.status).toBe("pass");
    expect(hasDoctorFailures(checks)).toBe(false);
  });

  test("passes when model snapshot matches agent.yaml", async () => {
    const dir = writeAgent("zip", { installDeps: true, installSkill: true });
    mkdirSync(join(dir, ".auggy"), { recursive: true });
    writeFileSync(
      join(dir, ".auggy", "models.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-06-10T00:00:00.000Z",
        selected: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          source: "static",
          pricingKnown: true,
          pricing: { inputUsdPerMtok: 3, outputUsdPerMtok: 15 },
        },
        registry: { provider: "anthropic", refreshRequested: false, warnings: [] },
      }),
    );

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const snapshot = checks.find((c) => c.name === "model snapshot");
    expect(snapshot?.status).toBe("pass");
    expect(snapshot?.message).toContain("static");
    expect(formatDoctorChecks(checks)).toContain("PASS model snapshot: static, priced");
  });

  test("warns when model snapshot drifts from agent.yaml", async () => {
    const dir = writeAgent("zip", { installDeps: true, installSkill: true });
    mkdirSync(join(dir, ".auggy"), { recursive: true });
    writeFileSync(
      join(dir, ".auggy", "models.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-06-10T00:00:00.000Z",
        selected: {
          provider: "anthropic",
          model: "claude-old",
          source: "static",
          pricingKnown: false,
        },
        registry: { provider: "anthropic", refreshRequested: false, warnings: [] },
      }),
    );

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const snapshot = checks.find((c) => c.name === "model snapshot");
    expect(snapshot?.status).toBe("warn");
    expect(snapshot?.message).toContain("does not match agent.yaml");
    expect(snapshot?.fix).toContain(".auggy/models.lock.json");
    expect(hasDoctorFailures(checks)).toBe(false);
  });

  test("passes env checks for agent.yaml placeholders such as visitorAuth signing key", async () => {
    writeAgent("zip", { installDeps: true, installSkill: true, includeVisitorAuth: true });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    expect(checks.find((c) => c.name === "env AUGGY_WEB_TOKEN")?.status).toBe("pass");
    expect(checks.find((c) => c.name === "env VISITOR_SIGNING_KEY")?.status).toBe("pass");
    expect(formatDoctorChecks(checks)).toContain("PASS env: VISITOR_SIGNING_KEY");
    expect(hasDoctorFailures(checks)).toBe(false);
  });

  test("lists custom augment routes and warns for public routes", async () => {
    writeAgent("zip", {
      installDeps: true,
      installSkill: true,
      customRoutes: "valid",
    });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const publicRoute = checks.find((c) => c.name === "route GET /services");
    const bearerRoute = checks.find((c) => c.name === "route POST /leads/create");
    const posture = checks.find((c) => c.name === "augment route posture");

    expect(posture?.status).toBe("warn");
    expect(posture?.message).toBe("2 route(s): 1 public, 1 private");
    expect(posture?.fix).toContain("Review public routes");
    expect(publicRoute?.status).toBe("warn");
    expect(publicRoute?.message).toBe("concierge-services PUBLIC auth=none params=-");
    expect(publicRoute?.fix).toContain("intentionally public");
    expect(bearerRoute?.status).toBe("pass");
    expect(bearerRoute?.message).toBe("concierge-services PRIVATE auth=bearer params=-");
    expect(formatDoctorChecks(checks)).toContain(
      "WARN route posture: 2 route(s): 1 public, 1 private",
    );
    expect(formatDoctorChecks(checks)).toContain(
      "WARN route: GET /services concierge-services PUBLIC auth=none params=-",
    );
  });

  test("fails when a custom augment route uses a reserved path", async () => {
    writeAgent("zip", {
      installDeps: true,
      installSkill: true,
      customRoutes: "reserved",
    });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const routeFailure = checks.find((c) => c.name === "augment routes");
    expect(routeFailure?.status).toBe("fail");
    expect(routeFailure?.message).toContain('GET "/console"');
    expect(routeFailure?.message).toContain("reserved by webTransport");
    expect(routeFailure?.fix).toContain("Fix the route path");
    expect(hasDoctorFailures(checks)).toBe(true);
  });

  test("fails when custom augment routes collide", async () => {
    writeAgent("zip", {
      installDeps: true,
      installSkill: true,
      customRoutes: "duplicate",
    });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const routeFailure = checks.find((c) => c.name === "augment routes");
    expect(routeFailure?.status).toBe("fail");
    expect(routeFailure?.message).toContain('GET "/services"');
    expect(routeFailure?.message).toContain("Path collisions are not allowed");
    expect(hasDoctorFailures(checks)).toBe(true);
  });

  test("fails when package.json is missing", async () => {
    writeAgent("zip", { includePackageJson: false });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const pkg = checks.find((c) => c.name === "package.json");
    expect(pkg?.status).toBe("fail");
    expect(pkg?.fix).toContain("package.json");
  });

  test("fails when agent-local dependencies are missing", async () => {
    writeAgent("zip", { installDeps: false });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const dep = checks.find((c) => c.name === "dependency @auggy/anthropic");
    expect(dep?.status).toBe("fail");
    expect(dep?.fix).toContain("bun install");
  });

  test("fails when the webTransport port is unavailable", async () => {
    writeAgent("zip", { installDeps: true, installSkill: true, port: 19090 });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async (port) => port !== 19090,
    });

    const port = checks.find((c) => c.name === "port 19090");
    expect(port?.status).toBe("fail");
    expect(port?.fix).toContain("19090");
    expect(port?.fix).toContain("augments/webTransport/augment.yaml");
  });

  test("detects wildcard listeners when checking port availability", async () => {
    const reservedPort = await reservePort();
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", resolve);
      server.listen(reservedPort);
    });

    try {
      await expect(isPortAvailable(reservedPort)).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("warns when a bundled skill is missing", async () => {
    writeAgent("zip", { installDeps: true, installSkill: false });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const skill = checks.find((c) => c.name === "skill webFetch");
    expect(skill?.status).toBe("warn");
    expect(skill?.fix).toContain("skill add webFetch");
    expect(hasDoctorFailures(checks)).toBe(false);
  });

  test("checks mcp config and cloud-hostile stdio during deploy preflight", async () => {
    const dir = writeAgent("zip", { installDeps: true, installSkill: true, includeMcp: true });
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            local: { type: "stdio", command: "npx", args: ["-y", "server"] },
          },
        },
        null,
        2,
      ),
    );

    const localChecks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });
    expect(localChecks.find((check) => check.name === "mcp local")?.status).toBe("pass");

    const cloudChecks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
      cloud: true,
    });
    expect(cloudChecks.find((check) => check.name === "mcp local cloud")?.status).toBe("fail");
  });
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
    server.listen(0);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof port !== "number") throw new Error("could not reserve test port");
  return port;
}

describe("doctor formatting and command", () => {
  test("formatDoctorChecks prints semantic default output", () => {
    const text = formatDoctorChecks([
      { name: "config path", status: "pass", message: "/tmp/auggy-agent/agent.yaml" },
      { name: "agent.yaml", status: "pass", message: "parsed zip" },
      { name: "package.json", status: "pass", message: "/tmp/auggy-agent/package.json" },
      { name: "env ANTHROPIC_API_KEY", status: "pass", message: "/tmp/auggy-agent/.env" },
      {
        name: "dependency @auggy/anthropic",
        status: "pass",
        message: "/tmp/auggy-agent/node_modules/@auggy/anthropic",
      },
      { name: "port 8080", status: "pass", message: "available" },
      {
        name: "skill webFetch",
        status: "pass",
        message: "/tmp/auggy-agent/skills/webFetch/SKILL.md",
      },
      { name: "dep", status: "fail", message: "missing", fix: "run bun install" },
    ]);

    expect(text).toContain("PASS config: agent.yaml");
    expect(text).toContain("PASS agent: zip");
    expect(text).toContain("PASS package manifest: package.json");
    expect(text).toContain("PASS env: ANTHROPIC_API_KEY");
    expect(text).toContain("PASS dependency: @auggy/anthropic");
    expect(text).toContain("PASS port: 8080 available");
    expect(text).toContain("PASS skill: webFetch");
    expect(text).toContain("FAIL dep: missing");
    expect(text).toContain("fix: run bun install");
  });

  test("formatDoctorChecks verbose can compact paths relative to the agent dir", () => {
    const root = "/tmp/auggy-agent";
    const text = formatDoctorChecks(
      [
        { name: "config path", status: "pass", message: `${root}/agent.yaml` },
        { name: "package.json", status: "pass", message: `${root}/package.json` },
        {
          name: "dependency auggy",
          status: "fail",
          message: `missing ${root}/node_modules/auggy`,
          fix: `Run \`cd ${root} && bun install\`.`,
        },
      ],
      { relativeTo: root, verbose: true },
    );

    expect(text).toContain("PASS config path: agent.yaml");
    expect(text).toContain("PASS package.json: package.json");
    expect(text).toContain("missing node_modules/auggy");
    expect(text).toContain("cd . && bun install");
  });

  test("doctor command uses semantic output by default", async () => {
    const run = mock(
      async (): Promise<DoctorCheck[]> => [
        {
          name: "config path",
          status: "pass",
          message: "/tmp/auggy-agent/agent.yaml",
        },
        {
          name: "dependency auggy",
          status: "pass",
          message: "/tmp/auggy-agent/node_modules/auggy",
        },
        {
          name: "runtime auggy",
          status: "pass",
          message: "/tmp/auggy-agent/node_modules/auggy/src",
        },
      ],
    );
    const exit = mock((_code: number) => {});
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      const cmd = doctorCommand({ runDoctor: run, exit });
      await cmd.parseAsync([], { from: "user" });
    } finally {
      console.log = origLog;
    }

    expect(logs.join("\n")).toContain("PASS config: agent.yaml");
    expect(logs.join("\n")).toContain("PASS dependency: auggy");
    expect(logs.join("\n")).not.toContain("runtime auggy");
    expect(logs.join("\n")).not.toContain("node_modules/auggy");
    expect(logs.join("\n")).not.toContain("/tmp/auggy-agent/node_modules/auggy");
  });

  test("doctor command shows runtime source in verbose output", async () => {
    const run = mock(
      async (): Promise<DoctorCheck[]> => [
        {
          name: "config path",
          status: "pass",
          message: "/tmp/auggy-agent/agent.yaml",
        },
        {
          name: "runtime auggy",
          status: "pass",
          message: "/tmp/auggy-agent/node_modules/auggy/src",
        },
      ],
    );
    const exit = mock((_code: number) => {});
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      const cmd = doctorCommand({ runDoctor: run, exit });
      await cmd.parseAsync(["--verbose"], { from: "user" });
    } finally {
      console.log = origLog;
    }

    expect(logs.join("\n")).toContain(
      "PASS runtime auggy: /tmp/auggy-agent/node_modules/auggy/src",
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("doctor command exits 1 when checks fail", async () => {
    const run = mock(
      async (): Promise<DoctorCheck[]> => [{ name: "dep", status: "fail", message: "missing" }],
    );
    const exit = mock((_code: number) => {});
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      const cmd = doctorCommand({ runDoctor: run, exit });
      await cmd.parseAsync(["zip"], { from: "user" });
    } finally {
      console.log = origLog;
    }

    expect(run).toHaveBeenCalledWith("zip", { config: undefined, cloud: undefined });
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.join("\n")).toContain("FAIL dep");
  });

  test("doctor command passes --cloud through to runDoctor", async () => {
    const run = mock(async (): Promise<DoctorCheck[]> => []);
    const exit = mock((_code: number) => {});

    const cmd = doctorCommand({ runDoctor: run, exit });
    await cmd.parseAsync(["zip", "--cloud"], { from: "user" });

    expect(run).toHaveBeenCalledWith("zip", { config: undefined, cloud: true });
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("doctor command can omit name for project-local agent dirs", async () => {
    const run = mock(
      async (): Promise<DoctorCheck[]> => [
        { name: "agent.yaml", status: "pass", message: "parsed zip" },
      ],
    );
    const exit = mock((_code: number) => {});

    const cmd = doctorCommand({ runDoctor: run, exit });
    await cmd.parseAsync([], { from: "user" });

    expect(run).toHaveBeenCalledWith(undefined, { config: undefined, cloud: undefined });
    expect(exit).toHaveBeenCalledWith(0);
  });
});
