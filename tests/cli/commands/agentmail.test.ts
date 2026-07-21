import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentMailProvisioningClient } from "../../../src/cli/agentmail-provisioning";
import { formatAgentMailSetupResult, runAgentMailSetup } from "../../../src/cli/commands/agentmail";
import { parseEnvFile } from "../../../src/cli/env-parse";

describe("agentmail setup command", () => {
  test("signup mode verifies owner email, creates a scoped runtime key, and patches visitorAuth", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-signup-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const provisioner: AgentMailProvisioningClient = {
        signUp: mock(async (input) => {
          expect(input).toEqual({
            humanEmail: "human@example.com",
            username: "dx-agent",
            source: "auggy-cli",
            referrer: "auggy visitorAuth setup",
          });
          return { organizationId: "org_1", inboxId: "inb_1", apiKey: "am_parent" };
        }),
        verify: mock(async (apiKey, otp) => {
          expect(apiKey).toBe("am_parent");
          expect(otp).toBe("123456");
          return { verified: true };
        }),
        createInbox: mock(async () => {
          throw new Error("not used");
        }),
        createInboxApiKey: mock(async (input) => {
          expect(input).toEqual({
            apiKey: "am_parent",
            inboxId: "inb_1",
            name: "dx-agent visitorAuth",
            permissions: { inbox_read: true, message_send: true },
          });
          return { apiKeyId: "key_1", apiKey: "am_runtime" };
        }),
      };

      const result = await runAgentMailSetup(
        "visitorAuth",
        {
          config: paths.configPath,
          mode: "signup",
          humanEmail: "human@example.com",
          username: "dx-agent",
          otp: "123456",
        },
        {
          provisioner,
          promptConfirm: (async () => true) as never,
        },
      );

      expect(result.inboxId).toBe("inb_1");
      expect(readEnv(paths.envPath)).toMatchObject({
        AGENTMAIL_API_KEY: "am_runtime",
        AGENTMAIL_INBOX_ID: "inb_1",
      });
      expect(readVisitorAuthAgentMail(paths.augmentPath)).toEqual({
        transport: "agentmail",
        subjectPrefix: "[Verify] ",
        apiKey: "${AGENTMAIL_API_KEY}",
        inboxId: "${AGENTMAIL_INBOX_ID}",
      });
      expect(readVisitorAuthConfig(paths.augmentPath).rateLimit).toEqual({
        perHour: 1,
        perDay: 3,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("existing mode creates a new inbox in an existing account and writes only the scoped key", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-existing-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const provisioner: AgentMailProvisioningClient = {
        signUp: mock(async () => {
          throw new Error("not used");
        }),
        verify: mock(async () => {
          throw new Error("not used");
        }),
        createInbox: mock(async (input) => {
          expect(input).toEqual({
            apiKey: "am_parent",
            username: "support",
            displayName: "Support Agent",
            clientId: "auggy:aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c:visitorAuth",
            metadata: { source: "auggy-cli", agent: "dx-agent", augment: "visitorAuth" },
          });
          return { inboxId: "inb_support", email: "support@agentmail.to" };
        }),
        createInboxApiKey: mock(async (input) => {
          expect(input.apiKey).toBe("am_parent");
          expect(input.inboxId).toBe("inb_support");
          expect(input.permissions).toEqual({ inbox_read: true, message_send: true });
          return { apiKeyId: "key_support", apiKey: "am_runtime_support" };
        }),
      };

      const result = await runAgentMailSetup(
        "visitorAuth",
        {
          config: paths.configPath,
          mode: "existing",
          apiKey: "am_parent",
          username: "support",
          displayName: "Support Agent",
        },
        { provisioner },
      );

      expect(result.inboxEmail).toBe("support@agentmail.to");
      expect(readEnv(paths.envPath)).toMatchObject({
        AGENTMAIL_API_KEY: "am_runtime_support",
        AGENTMAIL_INBOX_ID: "inb_support",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("existing mode configures the agentMail augment itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-augment-"));
    try {
      const paths = writeAgentMailAgent(root);
      const provisioner: AgentMailProvisioningClient = {
        signUp: mock(async () => {
          throw new Error("not used");
        }),
        verify: mock(async () => {
          throw new Error("not used");
        }),
        createInbox: mock(async (input) => {
          expect(input).toEqual({
            apiKey: "am_parent",
            username: "outbound",
            displayName: "Outbound Mail",
            clientId: "auggy:aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c:agentMail",
            metadata: { source: "auggy-cli", agent: "dx-agent", augment: "agentMail" },
          });
          return { inboxId: "inb_outbound", email: "outbound@agentmail.to" };
        }),
        createInboxApiKey: mock(async (input) => {
          expect(input.apiKey).toBe("am_parent");
          expect(input.inboxId).toBe("inb_outbound");
          expect(input.name).toBe("dx-agent agentMail");
          expect(input.permissions).toEqual({ inbox_read: true, message_send: true });
          return { apiKeyId: "key_outbound", apiKey: "am_runtime_outbound" };
        }),
      };

      const result = await runAgentMailSetup(
        "agentMail",
        {
          config: paths.configPath,
          mode: "existing",
          apiKey: "am_parent",
          username: "outbound",
          displayName: "Outbound Mail",
        },
        { provisioner },
      );

      expect(result.target).toBe("agentMail");
      expect(readEnv(paths.envPath)).toMatchObject({
        AGENTMAIL_API_KEY: "am_runtime_outbound",
        AGENTMAIL_INBOX_ID: "inb_outbound",
      });
      expect(readAgentMailConfig(paths.augmentPath)).toMatchObject({
        apiKey: "${AGENTMAIL_API_KEY}",
        inboxId: "${AGENTMAIL_INBOX_ID}",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("env mode reuses existing .env credentials and patches visitorAuth", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-env-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      writeFileSync(
        paths.envPath,
        "ANTHROPIC_API_KEY=sk-test\nAGENTMAIL_API_KEY=am_env\nAGENTMAIL_INBOX_ID=inb_env\n",
      );
      const provisioner: AgentMailProvisioningClient = {
        signUp: mock(async () => {
          throw new Error("not used");
        }),
        verify: mock(async () => {
          throw new Error("not used");
        }),
        createInbox: mock(async () => {
          throw new Error("not used");
        }),
        createInboxApiKey: mock(async () => {
          throw new Error("not used");
        }),
      };

      const result = await runAgentMailSetup(
        "visitorAuth",
        { config: paths.configPath, mode: "env" },
        { provisioner },
      );

      expect(result.mode).toBe("env");
      expect(readEnv(paths.envPath)).toMatchObject({
        AGENTMAIL_API_KEY: "am_env",
        AGENTMAIL_INBOX_ID: "inb_env",
      });
      expect(readVisitorAuthAgentMail(paths.augmentPath)).toMatchObject({
        transport: "agentmail",
        apiKey: "${AGENTMAIL_API_KEY}",
        inboxId: "${AGENTMAIL_INBOX_ID}",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("manual mode configures an existing inbox without provisioning network calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-manual-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const provisioner: AgentMailProvisioningClient = {
        signUp: mock(async () => {
          throw new Error("not used");
        }),
        verify: mock(async () => {
          throw new Error("not used");
        }),
        createInbox: mock(async () => {
          throw new Error("not used");
        }),
        createInboxApiKey: mock(async () => {
          throw new Error("not used");
        }),
      };

      await runAgentMailSetup(
        "visitorAuth",
        {
          config: paths.configPath,
          mode: "manual",
          apiKey: "am_existing",
          inboxId: "inb_existing",
        },
        { provisioner },
      );

      expect(readEnv(paths.envPath)).toMatchObject({
        AGENTMAIL_API_KEY: "am_existing",
        AGENTMAIL_INBOX_ID: "inb_existing",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves custom visitorAuth limits when switching console delivery to AgentMail", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-custom-rate-limit-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const customRateLimit = {
        minIntervalSeconds: 15,
        perHour: 100,
        perDay: 500,
        operatorExtension: 2,
      };
      const doc = parseYaml(readFileSync(paths.augmentPath, "utf-8")) as {
        config: Record<string, unknown>;
      };
      doc.config.rateLimit = customRateLimit;
      writeFileSync(paths.augmentPath, stringifyYaml(doc));

      const provisioner: AgentMailProvisioningClient = {
        signUp: mock(async () => {
          throw new Error("not used");
        }),
        verify: mock(async () => {
          throw new Error("not used");
        }),
        createInbox: mock(async () => {
          throw new Error("not used");
        }),
        createInboxApiKey: mock(async () => {
          throw new Error("not used");
        }),
      };

      await runAgentMailSetup(
        "visitorAuth",
        {
          config: paths.configPath,
          mode: "manual",
          apiKey: "am_existing",
          inboxId: "inb_existing",
        },
        { provisioner },
      );

      expect(readVisitorAuthConfig(paths.augmentPath).rateLimit).toEqual(customRateLimit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires visitorAuth to be installed before setup", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-missing-"));
    try {
      mkdirSync(root, { recursive: true });
      const configPath = join(root, "agent.yaml");
      writeFileSync(
        configPath,
        [
          "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
          "name: dx-agent",
          "engine:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-6",
          "augments: []",
          "",
        ].join("\n"),
      );

      await expect(
        runAgentMailSetup("visitorAuth", { config: configPath, mode: "manual" }, {}),
      ).rejects.toThrow(/auggy augment add visitorAuth/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("formats result without leaking API keys", () => {
    const text = formatAgentMailSetupResult({
      agentName: "dx-agent",
      target: "visitorAuth",
      mode: "existing",
      inboxId: "inb_1",
      inboxEmail: "dx-agent@agentmail.to",
      envPath: "/tmp/agent/.env",
      augmentPath: "/tmp/agent/augments/visitorAuth/augment.yaml",
      envKeys: ["AGENTMAIL_API_KEY", "AGENTMAIL_INBOX_ID"],
    });

    expect(text).toContain("AgentMail inbox ready: dx-agent@agentmail.to (inb_1)");
    expect(text).toContain("Wrote .env: AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID");
    expect(text).toContain("visitorAuth will now send magic links with AgentMail");
    expect(text).not.toContain("am_");
  });
});

function writeVisitorAuthAgent(root: string): {
  configPath: string;
  envPath: string;
  augmentPath: string;
} {
  const configPath = join(root, "agent.yaml");
  const envPath = join(root, ".env");
  const augmentPath = join(root, "augments", "visitorAuth", "augment.yaml");
  mkdirSync(join(root, "augments", "visitorAuth"), { recursive: true });
  writeFileSync(
    configPath,
    [
      "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
      "name: dx-agent",
      "engine:",
      "  provider: anthropic",
      "  model: claude-sonnet-4-6",
      "augments:",
      "  - visitorAuth",
      "",
    ].join("\n"),
  );
  writeFileSync(envPath, "ANTHROPIC_API_KEY=sk-test\n");
  writeFileSync(
    augmentPath,
    [
      "type: visitorAuth",
      "config:",
      "  publicUrl: ${AUGGY_PUBLIC_URL}",
      "  agentMail:",
      '    transport: "console"',
      '    subjectPrefix: "[Verify] "',
      "  signingKey: ${VISITOR_SIGNING_KEY}",
      "  rateLimit:",
      "    minIntervalSeconds: 10",
      "    perHour: 360",
      "    perDay: 8640",
      "",
    ].join("\n"),
  );
  expect(existsSync(augmentPath)).toBe(true);
  return { configPath, envPath, augmentPath };
}

function writeAgentMailAgent(root: string): {
  configPath: string;
  envPath: string;
  augmentPath: string;
} {
  const configPath = join(root, "agent.yaml");
  const envPath = join(root, ".env");
  const augmentPath = join(root, "augments", "agentMail", "augment.yaml");
  mkdirSync(join(root, "augments", "agentMail"), { recursive: true });
  writeFileSync(
    configPath,
    [
      "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
      "name: dx-agent",
      "engine:",
      "  provider: anthropic",
      "  model: claude-sonnet-4-6",
      "augments:",
      "  - agentMail",
      "",
    ].join("\n"),
  );
  writeFileSync(envPath, "ANTHROPIC_API_KEY=sk-test\n");
  writeFileSync(
    augmentPath,
    [
      "type: agentMail",
      "config:",
      "  apiKey: ${AGENTMAIL_API_KEY}",
      "  inboxId: ${AGENTMAIL_INBOX_ID}",
      "  outbound:",
      "    allowedTrustLevels: [creator]",
      "",
    ].join("\n"),
  );
  expect(existsSync(augmentPath)).toBe(true);
  return { configPath, envPath, augmentPath };
}

function readEnv(envPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of parseEnvFile(readFileSync(envPath, "utf-8"))) {
    if (line.kind === "kv") out[line.key] = line.value;
  }
  return out;
}

function readVisitorAuthAgentMail(augmentPath: string): Record<string, unknown> {
  return (readVisitorAuthConfig(augmentPath).agentMail as Record<string, unknown>) ?? {};
}

function readVisitorAuthConfig(augmentPath: string): Record<string, unknown> {
  const parsed = parseYaml(readFileSync(augmentPath, "utf-8")) as {
    config?: Record<string, unknown>;
  };
  return parsed.config ?? {};
}

function readAgentMailConfig(augmentPath: string): Record<string, unknown> {
  const parsed = parseYaml(readFileSync(augmentPath, "utf-8")) as {
    config?: Record<string, unknown>;
  };
  return parsed.config ?? {};
}
