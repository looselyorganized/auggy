import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [cliPath, packedRoot, consumerDir, smokeHome] = process.argv.slice(2);
if (!cliPath || !packedRoot || !consumerDir || !smokeHome) {
  throw new Error(
    "usage: release-smoke-agentmail-cli.ts <cli> <packed-root> <consumer-dir> <home>",
  );
}

mkdirSync(consumerDir, { recursive: true });
writeFileSync(
  join(consumerDir, "agent.yaml"),
  [
    "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
    "name: packed-agentmail",
    "engine:",
    "  provider: anthropic",
    "  model: claude-sonnet-4-6",
    "augments: []",
    "",
  ].join("\n"),
);
writeFileSync(
  join(consumerDir, "package.json"),
  `${JSON.stringify({ name: "packed-agentmail-consumer", private: true, type: "module" }, null, 2)}\n`,
);
writeFileSync(join(consumerDir, ".env"), "ANTHROPIC_API_KEY=smoke-not-real\n");

const add = await runCli(["augment", "add", "agentmail", "--skip-install", "--yes"]);
if (add.exitCode !== 0) {
  throw new Error(`packed CLI could not add lowercase agentmail:\n${add.output}`);
}
const agentYaml = readFileSync(join(consumerDir, "agent.yaml"), "utf8");
const augmentYaml = join(consumerDir, "augments", "agentMail", "augment.yaml");
if (!agentYaml.includes("  - agentMail") || agentYaml.includes("  - agentmail")) {
  throw new Error("packed CLI did not canonicalize lowercase agentmail in agent.yaml");
}
if (!existsSync(augmentYaml) || !readFileSync(augmentYaml, "utf8").startsWith("type: agentMail")) {
  throw new Error("packed CLI did not create canonical agentMail augment metadata");
}

// A deliberately invalid mode reaches Auggy's setup validation only after the
// optional target has been parsed and inferred from the canonical install. It
// cannot contact AgentMail or write credentials.
const setup = await runCli(["agentmail", "setup", "--mode", "packed-smoke-invalid"]);
if (setup.exitCode === 0 || !setup.output.includes("Invalid AgentMail setup mode")) {
  throw new Error(`packed optional AgentMail setup path did not execute:\n${setup.output}`);
}
if (setup.output.includes("missing required argument")) {
  throw new Error("packed AgentMail setup still requires an explicit target");
}

const provisioningPath = join(packedRoot, "src", "cli", "agentmail-provisioning.ts");
const provisioning = await import(pathToFileURL(provisioningPath).href);
const canonicalClientId = provisioning.buildAgentMailClientId(
  "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
  "agentMail",
);
if (canonicalClientId !== "auggy.v1.inbox.aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c.agentMail") {
  throw new Error(`packed CLI emitted an unexpected AgentMail client_id: ${canonicalClientId}`);
}

let providerCalls = 0;
const provisioningClient = provisioning.createAgentMailProvisioningClient({
  apiBaseUrl: "https://api.agentmail.to/v0",
  http: {
    post: async () => {
      providerCalls += 1;
      throw new Error("invalid client_id reached the provider transport");
    },
    get: async () => {
      providerCalls += 1;
      throw new Error("unexpected provider read");
    },
  },
});
let invalidClientIdRejected = false;
try {
  await provisioningClient.createInbox({
    apiKey: "packed-smoke-not-a-secret",
    username: "packed-agentmail",
    clientId: "auggy:invalid:client-id",
  });
} catch (error) {
  invalidClientIdRejected =
    error instanceof Error && error.message.includes("AgentMail client_id must be");
}
if (!invalidClientIdRejected || providerCalls !== 0) {
  throw new Error("packed CLI did not reject an invalid AgentMail client_id before transport");
}

async function runCli(args: string[]): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn([cliPath, ...args], {
    cwd: consumerDir,
    env: { ...process.env, HOME: smokeHome },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}
