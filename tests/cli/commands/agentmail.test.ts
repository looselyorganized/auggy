import { describe, expect, mock, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
        getInbox: mock(async () => {
          throw new Error("not used");
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
      expect(result.inboxEmail).toBeUndefined();
      expect(readEnv(paths.envPath)).toMatchObject({
        AGENTMAIL_API_KEY: "am_runtime",
        AGENTMAIL_INBOX_ID: "inb_1",
      });
      expect(readEnv(paths.envPath).AGENTMAIL_INBOX_EMAIL).toBeUndefined();
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

  test("agentMail signup verifies identity before minting the one-time runtime key", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-signup-identity-"));
    try {
      const paths = writeAgentMailAgent(root);
      setAgentMailInbound(paths.augmentPath, {
        mode: "websocket",
        allowedSenders: ["*@example.com"],
        classifications: {
          received: "process",
          spam: "discard",
          blocked: "discard",
          unauthenticated: "discard",
        },
      });
      addWebTransport(paths.configPath);
      const order: string[] = [];
      const provisioner: AgentMailProvisioningClient = {
        signUp: mock(async () => ({
          organizationId: "org_1",
          inboxId: "inb_1",
          apiKey: "am_parent",
        })),
        verify: mock(async () => ({ verified: true })),
        createInbox: mock(async () => {
          throw new Error("not used");
        }),
        getInbox: mock(async (apiKey, inboxId) => {
          order.push("identity");
          expect(apiKey).toBe("am_parent");
          return { inboxId, email: "Agent@Custom.Example" };
        }),
        createInboxApiKey: mock(async (input) => {
          order.push("runtime-key");
          expect(input.apiKey).toBe("am_parent");
          expect(input.permissions).toEqual({
            inbox_read: true,
            message_send: true,
            message_read: true,
          });
          return { apiKeyId: "key_1", apiKey: "am_runtime" };
        }),
      };

      const result = await runAgentMailSetup(
        "agentMail",
        {
          config: paths.configPath,
          mode: "signup",
          humanEmail: "human@example.com",
          username: "agent",
          otp: "123456",
        },
        { provisioner, promptConfirm: (async () => true) as never },
      );

      expect(order).toEqual(["identity", "runtime-key"]);
      expect(result.inboxEmail).toBe("agent@custom.example");
      expect(result.requiredPermissions).toEqual(["inbox_read", "message_send", "message_read"]);
      expect(readEnv(paths.envPath).AGENTMAIL_INBOX_EMAIL).toBe("agent@custom.example");
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
        getInbox: mock(async () => {
          throw new Error("not used");
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
      expect(readEnv(paths.envPath).AGENTMAIL_INBOX_EMAIL).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("existing mode configures the agentMail augment itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-augment-"));
    try {
      const paths = writeAgentMailAgent(root);
      const disabledInbound = {
        mode: "none",
        classifications: { spam: "process", blocked: "process" },
      };
      setAgentMailInbound(paths.augmentPath, disabledInbound);
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
        getInbox: mock(async () => {
          throw new Error("not used");
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
        AGENTMAIL_INBOX_EMAIL: "outbound@agentmail.to",
      });
      expect(readAgentMailConfig(paths.augmentPath)).toMatchObject({
        apiKey: "${AGENTMAIL_API_KEY}",
        inboxId: "${AGENTMAIL_INBOX_ID}",
        emailAddress: "${AGENTMAIL_INBOX_EMAIL}",
        addressVisibility: "public",
        inbound: disabledInbound,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("existing mode mints only the label permissions explicitly processed by inbound policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-inbound-permissions-"));
    try {
      const paths = writeAgentMailAgent(root);
      const inbound = {
        mode: "polling",
        allowedSenders: ["*@example.com"],
        classifications: {
          received: "process",
          spam: "process",
          blocked: "process",
          unauthenticated: "discard",
        },
      };
      setAgentMailInbound(paths.augmentPath, inbound);
      addWebTransport(paths.configPath);
      const createInboxApiKey = mock(
        async (input: Parameters<AgentMailProvisioningClient["createInboxApiKey"]>[0]) => {
          expect(input.permissions).toEqual({
            inbox_read: true,
            message_send: true,
            message_read: true,
            label_spam_read: true,
            label_blocked_read: true,
          });
          return { apiKeyId: "key_inbound", apiKey: "am_runtime_inbound" };
        },
      );
      const provisioner = unusedProvisioner({
        createInbox: mock(async () => ({
          inboxId: "inb_inbound",
          email: "inbound@example.com",
        })),
        createInboxApiKey,
      });

      const result = await runAgentMailSetup(
        "agentMail",
        {
          config: paths.configPath,
          mode: "existing",
          apiKey: "am_parent",
          username: "inbound",
          displayName: "Inbound",
        },
        { provisioner },
      );

      expect(createInboxApiKey).toHaveBeenCalledTimes(1);
      expect(result.requiredPermissions).toEqual([
        "inbox_read",
        "message_send",
        "message_read",
        "label_spam_read",
        "label_blocked_read",
      ]);
      expect(readAgentMailConfig(paths.augmentPath).inbound).toEqual(inbound);
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
        getInbox: mock(async () => {
          throw new Error("not used");
        }),
      };

      const result = await runAgentMailSetup(
        "visitorAuth",
        { config: paths.configPath, mode: "env" },
        { provisioner },
      );

      expect(result.mode).toBe("env");
      expect(result.inboxEmail).toBeUndefined();
      expect(readEnv(paths.envPath)).toMatchObject({
        AGENTMAIL_API_KEY: "am_env",
        AGENTMAIL_INBOX_ID: "inb_env",
      });
      expect(readEnv(paths.envPath).AGENTMAIL_INBOX_EMAIL).toBeUndefined();
      expect(readVisitorAuthAgentMail(paths.augmentPath)).toMatchObject({
        transport: "agentmail",
        apiKey: "${AGENTMAIL_API_KEY}",
        inboxId: "${AGENTMAIL_INBOX_ID}",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agentMail env mode re-verifies and replaces a stored inbox email", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-env-email-"));
    try {
      const paths = writeAgentMailAgent(root);
      writeFileSync(
        paths.envPath,
        [
          "ANTHROPIC_API_KEY=sk-test",
          "AGENTMAIL_API_KEY=am_env",
          "AGENTMAIL_INBOX_ID=inb_env",
          "AGENTMAIL_INBOX_EMAIL=  team@custom.example  ",
          "",
        ].join("\n"),
      );
      const getInbox = mock(async (apiKey: string, inboxId: string) => {
        expect(apiKey).toBe("am_env");
        expect(inboxId).toBe("inb_env");
        return { inboxId, email: "Canonical@Custom.Example" };
      });
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
        getInbox,
      };

      const result = await runAgentMailSetup(
        "agentMail",
        { config: paths.configPath, mode: "env" },
        { provisioner },
      );

      expect(result.inboxEmail).toBe("canonical@custom.example");
      expect(getInbox).toHaveBeenCalledTimes(1);
      expect(readEnv(paths.envPath).AGENTMAIL_INBOX_EMAIL).toBe("canonical@custom.example");
      expect(readAgentMailConfig(paths.augmentPath)).toMatchObject({
        emailAddress: "${AGENTMAIL_INBOX_EMAIL}",
        addressVisibility: "public",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("manual mode resolves an existing inbox with its runtime key", async () => {
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
        getInbox: mock(async () => {
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
      expect(readEnv(paths.envPath).AGENTMAIL_INBOX_EMAIL).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agentMail manual mode always verifies and canonicalizes the provider address", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-manual-email-"));
    try {
      const paths = writeAgentMailAgent(root);
      const getInbox = mock(async (apiKey: string, inboxId: string) => {
        expect(apiKey).toBe("am_existing");
        expect(inboxId).toBe("inb_existing");
        return { inboxId, email: "Help@Custom.Example" };
      });
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
        getInbox,
      };

      const result = await runAgentMailSetup(
        "agentMail",
        {
          config: paths.configPath,
          mode: "manual",
          apiKey: "am_existing",
          inboxId: "inb_existing",
        },
        { provisioner },
      );

      expect(result.inboxEmail).toBe("help@custom.example");
      expect(getInbox).toHaveBeenCalledTimes(1);
      expect(readEnv(paths.envPath).AGENTMAIL_INBOX_EMAIL).toBe("help@custom.example");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not write credentials or config when canonical email lookup fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-email-failure-"));
    try {
      const paths = writeAgentMailAgent(root);
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const originalAugment = readFileSync(paths.augmentPath, "utf-8");
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
        getInbox: mock(async () => {
          throw new Error("provider rejected am_super_secret");
        }),
      };

      let error: Error | undefined;
      try {
        await runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "manual",
            apiKey: "am_super_secret",
            inboxId: "inb_missing",
          },
          { provisioner },
        );
      } catch (caught) {
        error = caught as Error;
      }

      expect(error?.message).toContain("Could not resolve the canonical email");
      expect(error?.message).toContain("retry setup");
      expect(error?.message).not.toContain("am_super_secret");
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preflights the augment YAML before provisioning or local mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-preflight-"));
    try {
      const paths = writeAgentMailAgent(root);
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      writeFileSync(paths.augmentPath, "type: [invalid\n");
      const getInbox = mock(async () => ({ inboxId: "inb_x", email: "agent@example.com" }));
      const provisioner = unusedProvisioner({ getInbox });

      await expect(
        runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "manual",
            apiKey: "am_runtime",
            inboxId: "inb_x",
          },
          { provisioner },
        ),
      ).rejects.toThrow();

      expect(getInbox).not.toHaveBeenCalled();
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid inbound permission policy before provider side effects", async () => {
    const cases: Array<{
      inbound: Record<string, unknown>;
      outbound?: Record<string, unknown>;
      expected: RegExp;
    }> = [
      { inbound: { mode: "smtp" }, expected: /inbound\.mode/ },
      { inbound: { mode: "websocket" }, expected: /allowedSenders/ },
      {
        inbound: { mode: "websocket", allowedSenders: ["*"] },
        expected: /allowAnySender/,
      },
      {
        inbound: {
          mode: "websocket",
          allowedSenders: ["sender@example.com"],
          autoReply: "am_secret_ignored_setting",
        },
        expected: /unsupported inbound field "autoReply"/,
      },
      {
        inbound: {
          mode: "polling",
          allowedSenders: ["sender@example.com"],
          pollIntervalMs: 999,
        },
        expected: /pollIntervalMs/,
      },
      {
        inbound: {
          mode: "websocket",
          allowedSenders: ["sender@example.com"],
          classifications: {
            received: "discard",
            spam: "discard",
            blocked: "discard",
            unauthenticated: "discard",
          },
        },
        expected: /at least one message classification/,
      },
      {
        inbound: {
          mode: "websocket",
          allowedSenders: ["sender@example.com"],
          websocketBaseUrl: "https://ws.example.com",
        },
        expected: /websocketBaseUrl/,
      },
      {
        inbound: {
          mode: "webhook",
          allowedSenders: ["sender@example.com"],
        },
        expected: /inbound\.webhook/,
      },
      {
        inbound: {
          mode: "webhook",
          allowedSenders: ["sender@example.com"],
          webhook: {},
        },
        expected: /requires a webTransport/,
      },
      {
        inbound: {
          mode: "websocket",
          allowedSenders: ["sender@example.com"],
          classifications: { spam: "am_secret_classification" },
        },
        expected: /inbound\.classifications\.spam/,
      },
      {
        inbound: {
          mode: "websocket",
          allowedSenders: ["sender@example.com"],
          classifications: { received: "process", typo: "discard" },
        },
        expected: /unsupported.*typo/,
      },
      {
        inbound: {
          mode: "websocket",
          allowedSenders: ["sender@example.com"],
          replies: { mode: "automatic" },
        },
        outbound: { rateLimit: { enabled: false } },
        expected: /automatic inbound replies require outbound\.rateLimit\.enabled/,
      },
      {
        inbound: {
          mode: "websocket",
          allowedSenders: ["sender@example.com"],
          replies: { mode: "automatic" },
        },
        outbound: { rateLimit: [] },
        expected: /automatic inbound replies require outbound\.rateLimit to be an object/,
      },
      {
        inbound: {
          mode: "websocket",
          allowedSenders: ["sender@example.com"],
          replies: { mode: "automatic" },
        },
        outbound: { rateLimit: { globalMaxPerHour: 101 } },
        expected: /automatic inbound replies require outbound\.rateLimit\.globalMaxPerHour/,
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const root = mkdtempSync(join(tmpdir(), `agentmail-setup-policy-preflight-${index}-`));
      try {
        const paths = writeAgentMailAgent(root);
        setAgentMailInbound(paths.augmentPath, testCase.inbound);
        if (testCase.outbound) setAgentMailOutbound(paths.augmentPath, testCase.outbound);
        const originalEnv = readFileSync(paths.envPath, "utf-8");
        const originalAugment = readFileSync(paths.augmentPath, "utf-8");
        const signUp = mock(async () => {
          throw new Error("must not provision");
        });

        let error: Error | undefined;
        try {
          await runAgentMailSetup(
            "agentMail",
            {
              config: paths.configPath,
              mode: "signup",
              humanEmail: "human@example.com",
              username: "agent",
              otp: "123456",
            },
            { provisioner: unusedProvisioner({ signUp }) },
          );
        } catch (caught) {
          error = caught as Error;
        }

        expect(error?.message).toMatch(testCase.expected);
        expect(error?.message).not.toContain("am_secret_classification");
        expect(error?.message).not.toContain("am_secret_ignored_setting");
        expect(signUp).not.toHaveBeenCalled();
        expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
        expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("requires creator review routes before provisioning reviewed inbound replies", async () => {
    const cases = [
      { replies: undefined },
      { replies: { mode: "review" } },
      { replies: { mode: "automatic" } },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      for (const adminRoute of ["missing", "disabled"] as const) {
        const root = mkdtempSync(
          join(tmpdir(), `agentmail-setup-review-route-${index}-${adminRoute}-`),
        );
        try {
          const paths = writeAgentMailAgent(root);
          setAgentMailInbound(paths.augmentPath, {
            mode: "websocket",
            allowedSenders: ["sender@example.com"],
            ...(testCase.replies ? { replies: testCase.replies } : {}),
          });
          if (testCase.replies?.mode === "automatic") {
            setAgentMailOutbound(paths.augmentPath, {
              rateLimit: { enabled: true, globalMaxPerHour: 10 },
            });
          }
          if (adminRoute === "disabled") addWebTransport(paths.configPath, false);
          const originalEnv = readFileSync(paths.envPath, "utf-8");
          const originalAugment = readFileSync(paths.augmentPath, "utf-8");
          const signUp = mock(async () => {
            throw new Error("must not provision");
          });

          await expect(
            runAgentMailSetup(
              "agentMail",
              {
                config: paths.configPath,
                mode: "signup",
                humanEmail: "human@example.com",
                username: "agent",
                otp: "123456",
              },
              { provisioner: unusedProvisioner({ signUp }) },
            ),
          ).rejects.toThrow(
            /inbound\.replies\.mode (review|automatic) requires.*adminRoute.*before AgentMail setup/,
          );

          expect(signUp).not.toHaveBeenCalled();
          expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
          expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });

  test("preflights creator digest Notify policy before provider or local side effects", async () => {
    const cases: Array<{
      name: string;
      configure: (configPath: string) => void;
      expected: RegExp;
    }> = [
      {
        name: "missing",
        configure: () => {},
        expected: /does not match any notify destination/,
      },
      {
        name: "inline-authority",
        configure: (configPath) =>
          addNotify(configPath, "notify-inline", {
            destinations: [
              {
                name: "creator",
                transport: "log-to-file",
                path: "./notifications.jsonl",
                allowedTrustLevels: ["agent"],
              },
            ],
          }),
        expected: /must allow creator trust/,
      },
      {
        name: "referenced-rate-policy",
        configure: (configPath) =>
          addNotify(
            configPath,
            "notify-ref",
            {
              destinations: [
                {
                  name: "creator",
                  transport: "log-to-file",
                  path: "./notifications.jsonl",
                },
              ],
              rateLimit: { enabled: false },
            },
            true,
          ),
        expected: /rateLimit\.enabled to remain true/,
      },
      {
        name: "ambiguous",
        configure: (configPath) => {
          addNotify(configPath, "notify-inline", {
            destinations: [
              {
                name: "creator",
                transport: "log-to-file",
                path: "./inline.jsonl",
              },
            ],
          });
          addNotify(
            configPath,
            "notify-ref",
            {
              destinations: [
                {
                  name: "creator",
                  transport: "log-to-file",
                  path: "./referenced.jsonl",
                },
              ],
            },
            true,
          );
        },
        expected: /destination names must be unique across the agent/,
      },
    ];

    for (const testCase of cases) {
      const root = mkdtempSync(join(tmpdir(), `agentmail-digest-preflight-${testCase.name}-`));
      try {
        const paths = writeAgentMailAgent(root);
        setAgentMailInbound(paths.augmentPath, {
          mode: "polling",
          allowedSenders: ["sender@example.com"],
          replies: { mode: "disabled" },
          creatorDigest: { enabled: true, destination: "creator" },
        });
        testCase.configure(paths.configPath);
        const originalEnv = readFileSync(paths.envPath, "utf-8");
        const originalAugment = readFileSync(paths.augmentPath, "utf-8");
        const getInbox = mock(async () => {
          throw new Error("must not contact provider");
        });

        await expect(
          runAgentMailSetup(
            "agentMail",
            {
              config: paths.configPath,
              mode: "manual",
              apiKey: "am_secret_runtime",
              inboxId: "inb_x",
            },
            { provisioner: unusedProvisioner({ getInbox }) },
          ),
        ).rejects.toThrow(testCase.expected);

        expect(getInbox).not.toHaveBeenCalled();
        expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
        expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("accepts a referenced creator-authorized Notify destination during setup", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-digest-preflight-valid-"));
    try {
      const paths = writeAgentMailAgent(root);
      setAgentMailInbound(paths.augmentPath, {
        mode: "polling",
        allowedSenders: ["sender@example.com"],
        replies: { mode: "disabled" },
        creatorDigest: { enabled: true, destination: "creator" },
      });
      addNotify(
        paths.configPath,
        "notify",
        {
          destinations: [
            {
              name: "creator",
              transport: "log-to-file",
              path: "./notifications.jsonl",
            },
          ],
        },
        true,
      );
      const getInbox = mock(async () => ({
        inboxId: "inb_x",
        email: "agent@example.com",
      }));

      await expect(
        runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "manual",
            apiKey: "am_runtime",
            inboxId: "inb_x",
          },
          { provisioner: unusedProvisioner({ getInbox }) },
        ),
      ).resolves.toMatchObject({ inboxEmail: "agent@example.com" });
      expect(getInbox).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unsafe or malformed augment references without leaking source lines", async () => {
    for (const malformed of ["unsafe-id", "invalid-metadata"] as const) {
      const root = mkdtempSync(join(tmpdir(), `agentmail-topology-safety-${malformed}-`));
      try {
        const paths = writeAgentMailAgent(root);
        setAgentMailInbound(paths.augmentPath, {
          mode: "polling",
          allowedSenders: ["sender@example.com"],
          replies: { mode: "disabled" },
          creatorDigest: { enabled: true, destination: "creator" },
        });
        const agentConfig = parseYaml(readFileSync(paths.configPath, "utf-8")) as {
          augments?: unknown[];
        };
        if (malformed === "unsafe-id") {
          agentConfig.augments = [...(agentConfig.augments ?? []), "../outside"];
        } else {
          const notifyDir = join(root, "augments", "notify");
          mkdirSync(notifyDir, { recursive: true });
          agentConfig.augments = [...(agentConfig.augments ?? []), "notify"];
          writeFileSync(
            join(notifyDir, "augment.yaml"),
            "type: notify\nconfig:\n  destinations: [\n  apiKey: am_super_secret\n",
          );
        }
        writeFileSync(paths.configPath, stringifyYaml(agentConfig));
        const getInbox = mock(async () => {
          throw new Error("must not contact provider");
        });

        let error: Error | undefined;
        try {
          await runAgentMailSetup(
            "agentMail",
            {
              config: paths.configPath,
              mode: "manual",
              apiKey: "am_runtime",
              inboxId: "inb_x",
            },
            { provisioner: unusedProvisioner({ getInbox }) },
          );
        } catch (caught) {
          error = caught as Error;
        }

        expect(error?.message).toMatch(
          malformed === "unsafe-id" ? /safe augment id/ : /invalid augment metadata/,
        );
        expect(error?.message).not.toContain("am_super_secret");
        expect(getInbox).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("restores .env when the augment YAML commit fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-rollback-"));
    let augmentDir: string | undefined;
    try {
      const paths = writeAgentMailAgent(root);
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const originalAugment = readFileSync(paths.augmentPath, "utf-8");
      augmentDir = join(root, "augments", "agentMail");
      chmodSync(augmentDir, 0o500);

      await expect(
        runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "manual",
            apiKey: "am_runtime",
            inboxId: "inb_x",
          },
          {
            provisioner: unusedProvisioner({
              getInbox: mock(async () => ({
                inboxId: "inb_x",
                email: "agent@example.com",
              })),
            }),
          },
        ),
      ).rejects.toThrow();

      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
    } finally {
      if (augmentDir) chmodSync(augmentDir, 0o700);
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
        getInbox: mock(async () => {
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
      target: "agentMail",
      mode: "existing",
      inboxId: "inb_1",
      inboxEmail: "dx-agent@agentmail.to",
      envPath: "/tmp/agent/.env",
      augmentPath: "/tmp/agent/augments/visitorAuth/augment.yaml",
      envKeys: ["AGENTMAIL_API_KEY", "AGENTMAIL_INBOX_ID", "AGENTMAIL_INBOX_EMAIL"],
      requiredPermissions: ["inbox_read", "message_send"],
    });

    expect(text).toContain("AgentMail inbox ready: dx-agent@agentmail.to (inb_1)");
    expect(text).toContain(
      "Wrote .env: AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID, AGENTMAIL_INBOX_EMAIL",
    );
    expect(text).toContain("agentMail will now send outbound email with AgentMail");
    expect(text).toContain("Runtime key permissions: inbox_read, message_send");
    expect(text).not.toContain("am_");
  });

  test("warns when setup cannot change permissions on an existing runtime key", () => {
    const text = formatAgentMailSetupResult({
      agentName: "dx-agent",
      target: "agentMail",
      mode: "manual",
      inboxId: "inb_1",
      inboxEmail: "dx-agent@agentmail.to",
      envPath: "/tmp/agent/.env",
      augmentPath: "/tmp/agent/augments/agentMail/augment.yaml",
      envKeys: ["AGENTMAIL_API_KEY", "AGENTMAIL_INBOX_ID", "AGENTMAIL_INBOX_EMAIL"],
      requiredPermissions: ["inbox_read", "message_send", "message_read", "label_spam_read"],
    });

    expect(text).toContain("Warning: Setup did not change the existing runtime key");
    expect(text).toContain("inbox_read, message_send, message_read, label_spam_read");
    expect(text).not.toContain("am_super_secret");
  });
});

function unusedProvisioner(
  overrides: Partial<AgentMailProvisioningClient> = {},
): AgentMailProvisioningClient {
  return {
    signUp: async () => {
      throw new Error("not used");
    },
    verify: async () => {
      throw new Error("not used");
    },
    createInbox: async () => {
      throw new Error("not used");
    },
    getInbox: async () => {
      throw new Error("not used");
    },
    createInboxApiKey: async () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

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

function setAgentMailInbound(augmentPath: string, inbound: Record<string, unknown>): void {
  const parsed = parseYaml(readFileSync(augmentPath, "utf-8")) as {
    config?: Record<string, unknown>;
  };
  parsed.config = { ...(parsed.config ?? {}), inbound };
  writeFileSync(augmentPath, stringifyYaml(parsed));
}

function setAgentMailOutbound(augmentPath: string, outbound: Record<string, unknown>): void {
  const parsed = parseYaml(readFileSync(augmentPath, "utf-8")) as {
    config?: Record<string, unknown>;
  };
  parsed.config = { ...(parsed.config ?? {}), outbound };
  writeFileSync(augmentPath, stringifyYaml(parsed));
}

function addWebTransport(configPath: string, adminRoute = true): void {
  const agentDir = dirname(configPath);
  const augmentDir = join(agentDir, "augments", "webTransport");
  mkdirSync(augmentDir, { recursive: true });
  const parsed = parseYaml(readFileSync(configPath, "utf-8")) as {
    augments?: unknown[];
  };
  parsed.augments = [...(parsed.augments ?? []), "webTransport"];
  writeFileSync(configPath, stringifyYaml(parsed));
  writeFileSync(
    join(augmentDir, "augment.yaml"),
    stringifyYaml({
      type: "webTransport",
      config: { port: 8080, ...(adminRoute ? {} : { adminRoute: false }) },
    }),
  );
}

function addNotify(
  configPath: string,
  name: string,
  options: Record<string, unknown>,
  referenced = false,
): void {
  const parsed = parseYaml(readFileSync(configPath, "utf-8")) as {
    augments?: unknown[];
  };
  if (!referenced) {
    parsed.augments = [
      ...(parsed.augments ?? []),
      {
        name,
        type: "notify",
        options,
      },
    ];
    writeFileSync(configPath, stringifyYaml(parsed));
    return;
  }

  const augmentDir = join(dirname(configPath), "augments", name);
  mkdirSync(augmentDir, { recursive: true });
  parsed.augments = [...(parsed.augments ?? []), name];
  writeFileSync(configPath, stringifyYaml(parsed));
  writeFileSync(
    join(augmentDir, "augment.yaml"),
    stringifyYaml({
      type: "notify",
      config: options,
    }),
  );
}
