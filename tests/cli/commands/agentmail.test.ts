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
import {
  AgentMailProvisioningApiError,
  type AgentMailProvisioningClient,
  AgentMailProvisioningResponseError,
} from "../../../src/cli/agentmail-provisioning";
import {
  agentMailCommand,
  formatAgentMailSetupResult,
  runAgentMailSetup,
} from "../../../src/cli/commands/agentmail";
import { loadEnvFile } from "../../../src/cli/config-parser";
import { acquireAgentEnvMutationLock } from "../../../src/cli/env-mutation-lock";
import { parseEnvFile } from "../../../src/cli/env-parse";

describe("agentmail setup command", () => {
  test("infers the only installed canonical AgentMail setup target", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-infer-"));
    try {
      const paths = writeVisitorAuthAgent(root);

      const result = await runAgentMailSetup(
        undefined,
        {
          config: paths.configPath,
          mode: "manual",
          apiKey: "am_runtime",
          inboxId: "inb_existing",
        },
        { provisioner: unusedProvisioner() },
      );

      expect(result.target).toBe("visitorAuth");
      expect(result.mode).toBe("manual");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Commander accepts an omitted setup target and maps non-secret flags", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-command-"));
    const originalLog = console.log;
    try {
      const paths = writeVisitorAuthAgent(root);
      const logs: string[] = [];
      console.log = (...args: unknown[]) => logs.push(args.join(" "));
      const command = agentMailCommand({
        provisioner: unusedProvisioner(),
        interactive: false,
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      });

      await command.parseAsync([
        "node",
        "auggy-agentmail",
        "setup",
        "--config",
        paths.configPath,
        "--mode",
        "manual",
        "--api-key",
        "am_runtime",
        "--inbox-id",
        "inb_existing",
      ]);

      expect(logs.join("\n")).toContain("AgentMail inbox ready: inb_existing");
      expect(logs.join("\n")).not.toContain("am_runtime");
    } finally {
      console.log = originalLog;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when an omitted target would choose between shared credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-target-choice-"));
    try {
      const paths = writeAgentMailAgent(root);
      addVisitorAuth(paths.configPath);
      await expect(
        runAgentMailSetup(
          undefined,
          {
            config: paths.configPath,
            mode: "manual",
            apiKey: "am_runtime",
            inboxId: "inb_existing",
          },
          { provisioner: unusedProvisioner(), interactive: true },
        ),
      ).rejects.toThrow(/Configure agentMail first[\s\S]*visitorAuth --mode env/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires an explicit mode when non-interactive input would otherwise prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-noninteractive-"));
    try {
      const paths = writeAgentMailAgent(root);
      await expect(
        runAgentMailSetup("agentMail", { config: paths.configPath }, { interactive: false }),
      ).rejects.toThrow(/needs a mode in non-interactive use/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preflights every non-interactive mode before prompts or provider calls", async () => {
    for (const mode of ["signup", "existing", "manual"] as const) {
      const root = mkdtempSync(join(tmpdir(), `agentmail-setup-${mode}-preflight-`));
      try {
        const paths = writeVisitorAuthAgent(root);
        const originalEnv = readFileSync(paths.envPath, "utf-8");
        const signUp = mock(async () => {
          throw new Error("must not contact AgentMail");
        });

        await expect(
          runAgentMailSetup(
            "visitorAuth",
            { config: paths.configPath, mode },
            {
              interactive: false,
              provisioner: unusedProvisioner({ signUp }),
              promptInput: (async () => {
                throw new Error("must not prompt");
              }) as never,
              promptPassword: (async () => {
                throw new Error("must not prompt");
              }) as never,
              promptConfirm: (async () => {
                throw new Error("must not prompt");
              }) as never,
            },
          ),
        ).rejects.toThrow(
          mode === "signup"
            ? /--mode signup is interactive-only/
            : new RegExp(`--mode ${mode} needs`),
        );
        expect(signUp).not.toHaveBeenCalled();
        expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("rejects setup flags that the selected mode would ignore", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-unused-flags-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      await expect(
        runAgentMailSetup(
          "visitorAuth",
          { config: paths.configPath, mode: "env", apiKey: "am_should_not_be_ignored" },
          { interactive: false, provisioner: unusedProvisioner() },
        ),
      ).rejects.toThrow(/--mode env does not use --api-key/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the secure account-key environment variable with argv precedence", async () => {
    const previous = process.env.AGENTMAIL_ACCOUNT_API_KEY;
    process.env.AGENTMAIL_ACCOUNT_API_KEY = "am_account_from_env";
    try {
      for (const [explicit, expected] of [
        [undefined, "am_account_from_env"],
        ["am_account_from_argv", "am_account_from_argv"],
      ] as const) {
        const root = mkdtempSync(join(tmpdir(), "agentmail-setup-account-env-"));
        try {
          const paths = writeVisitorAuthAgent(root);
          const createInbox = mock(
            async (input: Parameters<AgentMailProvisioningClient["createInbox"]>[0]) => {
              expect(input.apiKey).toBe(expected);
              return { inboxId: "inb_env", email: "env@agentmail.to" };
            },
          );
          await runAgentMailSetup(
            "visitorAuth",
            {
              config: paths.configPath,
              mode: "existing",
              username: "env-agent",
              ...(explicit ? { apiKey: explicit } : {}),
            },
            {
              interactive: false,
              provisioner: unusedProvisioner({
                createInbox,
                createInboxApiKey: async () => ({ apiKeyId: "key_1", apiKey: "am_runtime" }),
              }),
            },
          );
          expect(createInbox).toHaveBeenCalledTimes(1);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
      process.env.AGENTMAIL_ACCOUNT_API_KEY = "   ";
      const root = mkdtempSync(join(tmpdir(), "agentmail-setup-account-blank-"));
      try {
        const paths = writeVisitorAuthAgent(root);
        await expect(
          runAgentMailSetup(
            "visitorAuth",
            { config: paths.configPath, mode: "existing", username: "env-agent" },
            { interactive: false, provisioner: unusedProvisioner() },
          ),
        ).rejects.toThrow(/AGENTMAIL_ACCOUNT_API_KEY/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      restoreProcessEnv("AGENTMAIL_ACCOUNT_API_KEY", previous);
    }
  });

  test("rejects a provisioning account key auto-loaded from project dotenv files", async () => {
    const previous = process.env.AGENTMAIL_ACCOUNT_API_KEY;
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-account-dotenv-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      writeFileSync(join(root, ".env.local"), "AGENTMAIL_ACCOUNT_API_KEY=am_project_secret\n");
      process.env.AGENTMAIL_ACCOUNT_API_KEY = "am_project_secret";
      const createInbox = mock(async () => {
        throw new Error("must not contact AgentMail");
      });

      let error: Error | undefined;
      try {
        await runAgentMailSetup(
          "visitorAuth",
          { config: paths.configPath, mode: "existing", username: "env-agent" },
          {
            cwd: root,
            interactive: false,
            provisioner: unusedProvisioner({ createInbox }),
          },
        );
      } catch (caught) {
        error = caught as Error;
      }

      expect(error?.message).toContain("provisioning-only account credential");
      expect(error?.message).toContain(".env.local");
      expect(error?.message).not.toContain("am_project_secret");
      expect(createInbox).not.toHaveBeenCalled();
      expect(readFileSync(paths.envPath, "utf-8")).not.toContain("AGENTMAIL_ACCOUNT_API_KEY");
    } finally {
      restoreProcessEnv("AGENTMAIL_ACCOUNT_API_KEY", previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows a process-scoped account key when the project dotenv placeholder is blank", async () => {
    const previous = process.env.AGENTMAIL_ACCOUNT_API_KEY;
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-account-process-env-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      writeFileSync(join(root, ".env.local"), "AGENTMAIL_ACCOUNT_API_KEY=\n");
      process.env.AGENTMAIL_ACCOUNT_API_KEY = "am_process_secret";
      const createInbox = mock(async () => ({
        inboxId: "inb_process",
        email: "process@agentmail.to",
      }));

      const result = await runAgentMailSetup(
        "visitorAuth",
        { config: paths.configPath, mode: "existing", username: "process" },
        {
          cwd: root,
          interactive: false,
          provisioner: unusedProvisioner({
            createInbox,
            createInboxApiKey: async () => ({ apiKeyId: "key_1", apiKey: "am_runtime" }),
          }),
        },
      );

      expect(result.inboxId).toBe("inb_process");
      expect(createInbox).toHaveBeenCalledTimes(1);
    } finally {
      restoreProcessEnv("AGENTMAIL_ACCOUNT_API_KEY", previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires visitorAuth to reuse agentMail credentials when both are installed", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-shared-credentials-"));
    try {
      const paths = writeAgentMailAgent(root);
      addVisitorAuth(paths.configPath);
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const createInbox = mock(async () => {
        throw new Error("must not replace the shared inbox");
      });

      await expect(
        runAgentMailSetup(
          "visitorAuth",
          {
            config: paths.configPath,
            mode: "existing",
            apiKey: "am_parent",
            username: "visitor-auth",
          },
          { provisioner: unusedProvisioner({ createInbox }) },
        ),
      ).rejects.toThrow(/share one AgentMail inbox[\s\S]*visitorAuth --mode env/);
      expect(createInbox).not.toHaveBeenCalled();
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows visitorAuth to attach to the shared credentials through env mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-shared-env-"));
    try {
      const paths = writeAgentMailAgent(root);
      addVisitorAuth(paths.configPath);
      writeFileSync(
        paths.envPath,
        [
          "ANTHROPIC_API_KEY=sk-test",
          "AGENTMAIL_API_KEY=am_runtime_shared",
          "AGENTMAIL_INBOX_ID=inb_shared",
          "AGENTMAIL_INBOX_EMAIL=agent@agentmail.to",
          "",
        ].join("\n"),
      );

      const result = await runAgentMailSetup(
        "visitorAuth",
        { config: paths.configPath, mode: "env" },
        { interactive: false, provisioner: unusedProvisioner() },
      );

      expect(result.mode).toBe("env");
      expect(result.inboxId).toBe("inb_shared");
      const visitorPath = join(root, "augments", "visitorAuth", "augment.yaml");
      expect(readVisitorAuthAgentMail(visitorPath)).toMatchObject({
        transport: "agentmail",
        apiKey: "${AGENTMAIL_API_KEY}",
        inboxId: "${AGENTMAIL_INBOX_ID}",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires agentMail to reuse credentials when visitorAuth already uses AgentMail", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-shared-reverse-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      addAgentMail(paths.configPath);
      setVisitorAuthTransport(paths.augmentPath, "agentmail");
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const createInbox = mock(async () => {
        throw new Error("must not replace the shared inbox");
      });

      await expect(
        runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "existing",
            apiKey: "am_parent",
            username: "outbound",
          },
          { provisioner: unusedProvisioner({ createInbox }) },
        ),
      ).rejects.toThrow(/visitorAuth already uses the shared AgentMail inbox[\s\S]*--mode env/);
      expect(createInbox).not.toHaveBeenCalled();
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats omitted visitorAuth transport as AgentMail-backed shared credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-shared-default-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      addAgentMail(paths.configPath);
      removeVisitorAuthTransport(paths.augmentPath);
      const createInbox = mock(async () => {
        throw new Error("must not replace default shared credentials");
      });

      await expect(
        runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "existing",
            apiKey: "am_parent",
            username: "outbound",
          },
          { provisioner: unusedProvisioner({ createInbox }) },
        ),
      ).rejects.toThrow(/visitorAuth already uses the shared AgentMail inbox[\s\S]*--mode env/);
      expect(createInbox).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows agentMail provisioning while visitorAuth still uses console delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-shared-console-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      addAgentMail(paths.configPath);
      const agentMailPath = join(root, "augments", "agentMail", "augment.yaml");
      const createInbox = mock(async () => ({
        inboxId: "inb_outbound",
        email: "outbound@agentmail.to",
      }));

      const result = await runAgentMailSetup(
        "agentMail",
        {
          config: paths.configPath,
          mode: "existing",
          apiKey: "am_parent",
          username: "outbound",
        },
        {
          provisioner: unusedProvisioner({
            createInbox,
            createInboxApiKey: async () => ({ apiKeyId: "key_outbound", apiKey: "am_runtime" }),
          }),
        },
      );

      expect(result.inboxId).toBe("inb_outbound");
      expect(createInbox).toHaveBeenCalledTimes(1);
      expect(readAgentMailConfig(agentMailPath).emailAddress).toBe("${AGENTMAIL_INBOX_EMAIL}");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("visitorAuth refuses shared credentials when other AgentMail consumers are noncanonical", async () => {
    for (const topology of ["custom-only", "canonical-plus-secondary"] as const) {
      const root = mkdtempSync(join(tmpdir(), `agentmail-setup-shared-${topology}-`));
      try {
        const paths = writeVisitorAuthAgent(root);
        if (topology === "canonical-plus-secondary") {
          addAgentMail(paths.configPath);
        }
        const current = parseYaml(readFileSync(paths.configPath, "utf-8")) as {
          augments?: unknown[];
        };
        current.augments = [
          ...(current.augments ?? []),
          { name: "secondaryMail", type: "agentMail", options: {} },
        ];
        writeFileSync(paths.configPath, stringifyYaml(current));

        await expect(
          runAgentMailSetup(
            "visitorAuth",
            { config: paths.configPath, mode: "env" },
            { interactive: false, provisioner: unusedProvisioner() },
          ),
        ).rejects.toThrow(/cannot safely change shared AGENTMAIL_\*/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("explains how to install a target when neither canonical target is mounted", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-no-target-"));
    try {
      const paths = writeAgentMailAgent(root);
      const config = parseYaml(readFileSync(paths.configPath, "utf-8")) as {
        augments?: unknown[];
      };
      config.augments = [];
      writeFileSync(paths.configPath, stringifyYaml(config));

      await expect(
        runAgentMailSetup(undefined, { config: paths.configPath, mode: "manual" }, {}),
      ).rejects.toThrow(/auggy augment add agentMail[\s\S]*auggy augment add visitorAuth/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed for an inline mount even when a stale canonical file exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-inline-target-"));
    try {
      const paths = writeAgentMailAgent(root);
      const config = parseYaml(readFileSync(paths.configPath, "utf-8")) as {
        augments?: unknown[];
      };
      config.augments = [
        {
          name: "agentMail",
          type: "agentMail",
          options: { apiKey: "${INLINE_API_KEY}", inboxId: "${INLINE_INBOX_ID}" },
        },
      ];
      writeFileSync(paths.configPath, stringifyYaml(config));
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const staleAugment = readFileSync(paths.augmentPath, "utf-8");

      await expect(
        runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "manual",
            apiKey: "am_runtime",
            inboxId: "inb_existing",
          },
          { provisioner: unusedProvisioner() },
        ),
      ).rejects.toThrow(/mounted inline[\s\S]*canonical referenced/);
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      expect(readFileSync(paths.augmentPath, "utf-8")).toBe(staleAugment);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when global credentials would affect an additional same-type instance", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-multiple-consumers-"));
    try {
      const paths = writeAgentMailAgent(root);
      const config = parseYaml(readFileSync(paths.configPath, "utf-8")) as {
        augments?: unknown[];
      };
      config.augments = [
        ...(config.augments ?? []),
        { name: "secondaryMail", type: "agentMail", options: {} },
      ];
      writeFileSync(paths.configPath, stringifyYaml(config));

      await expect(
        runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "manual",
            apiKey: "am_runtime",
            inboxId: "inb_existing",
          },
          { provisioner: unusedProvisioner() },
        ),
      ).rejects.toThrow(/multiple agentMail instances[\s\S]*configure every instance manually/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts case-insensitive direct target names and reports the canonical target", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-target-case-"));
    try {
      const paths = writeAgentMailAgent(root);
      const result = await runAgentMailSetup(
        "AGENTMAIL",
        {
          config: paths.configPath,
          mode: "manual",
          apiKey: "am_runtime",
          inboxId: "inb_existing",
        },
        {
          provisioner: unusedProvisioner({
            getInbox: async () => ({
              inboxId: "inb_existing",
              email: "agent@agentmail.to",
            }),
          }),
        },
      );

      expect(result.target).toBe("agentMail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("labels interactive setup modes by account and inbox ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-mode-copy-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      let choiceNames: string[] = [];

      const result = await runAgentMailSetup(
        "visitorAuth",
        {
          config: paths.configPath,
          apiKey: "am_runtime",
          inboxId: "inb_existing",
        },
        {
          provisioner: unusedProvisioner(),
          promptSelect: (async (prompt: { choices?: Array<{ name?: string }> }) => {
            choiceNames = (prompt.choices ?? []).flatMap((choice) =>
              choice.name ? [choice.name] : [],
            );
            return "manual";
          }) as never,
        },
      );

      expect(result.mode).toBe("manual");
      expect(choiceNames).toEqual([
        "New to AgentMail — create an account and first inbox",
        "Existing AgentMail account — create an inbox with an account API key",
        "Existing AgentMail inbox — connect its ID and scoped runtime key",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("interactive signup can switch safely to existing-account inbox creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-existing-recovery-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const originalConfig = readFileSync(paths.configPath, "utf-8");
      const signUp = mock(async () => {
        throw new AgentMailProvisioningApiError({
          operation: "/agent/sign-up",
          status: 403,
          providerName: "AlreadyExistsError",
          providerCode: "already_exists",
          providerMessage: "User already exists",
        });
      });
      const createInbox = mock(async () => ({
        inboxId: "inb_existing_account",
        email: "support@agentmail.to",
      }));
      const createInboxApiKey = mock(async () => ({
        apiKeyId: "key_runtime",
        apiKey: "am_runtime_scoped",
      }));
      const confirmations: string[] = [];

      const result = await runAgentMailSetup(
        "visitorAuth",
        {
          config: paths.configPath,
          humanEmail: "owner@example.com",
          username: "support",
        },
        {
          provisioner: unusedProvisioner({ signUp, createInbox, createInboxApiKey }),
          promptSelect: (async () => "signup") as never,
          promptConfirm: (async (prompt: { message?: string }) => {
            confirmations.push(prompt.message ?? "");
            return true;
          }) as never,
          promptPassword: (async () => "am_parent_account") as never,
          promptInput: (async () => "Support") as never,
        },
      );

      expect(result.mode).toBe("existing");
      expect(result.inboxId).toBe("inb_existing_account");
      expect(signUp).toHaveBeenCalledTimes(1);
      expect(createInbox).toHaveBeenCalledTimes(1);
      expect(createInboxApiKey).toHaveBeenCalledTimes(1);
      expect(
        confirmations.some((message) => message.includes("already has an AgentMail account")),
      ).toBe(true);
      expect(readEnv(paths.envPath)).toMatchObject({
        AGENTMAIL_API_KEY: "am_runtime_scoped",
        AGENTMAIL_INBOX_ID: "inb_existing_account",
      });
      expect(readFileSync(paths.configPath, "utf-8")).toBe(originalConfig);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit signup fails closed with an actionable existing-account command", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-existing-explicit-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const originalAugment = readFileSync(paths.augmentPath, "utf-8");
      const createInbox = mock(async () => {
        throw new Error("must not adopt or create an inbox");
      });

      await expect(
        runAgentMailSetup(
          "visitorAuth",
          {
            config: paths.configPath,
            mode: "signup",
            humanEmail: "owner@example.com",
            username: "support",
          },
          {
            provisioner: unusedProvisioner({
              signUp: async () => {
                throw new AgentMailProvisioningApiError({
                  operation: "/agent/sign-up",
                  status: 403,
                  providerName: "AlreadyExistsError",
                  providerCode: "already_exists",
                });
              },
              createInbox,
            }),
            promptConfirm: (async () => true) as never,
          },
        ),
      ).rejects.toThrow(/auggy agentmail setup visitorAuth --mode existing/);
      expect(createInbox).not.toHaveBeenCalled();
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not misclassify an AlreadyExists failure after signup as an account collision", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-key-collision-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      let confirmations = 0;

      const error = await runAgentMailSetup(
        "visitorAuth",
        {
          config: paths.configPath,
          humanEmail: "owner@example.com",
          username: "support",
        },
        {
          provisioner: unusedProvisioner({
            signUp: async () => ({
              organizationId: "org_1",
              inboxId: "inb_1",
              apiKey: "am_parent",
            }),
            verify: async () => ({ verified: true }),
            createInboxApiKey: async () => {
              throw new AgentMailProvisioningApiError({
                operation: "/inboxes/inb_1/api-keys",
                status: 409,
                providerCode: "already_exists",
              });
            },
          }),
          promptSelect: (async () => "signup") as never,
          promptInput: (async () => "123456") as never,
          promptConfirm: (async () => {
            confirmations += 1;
            return true;
          }) as never,
        },
      ).catch((caught) => caught);

      expect(error).toBeInstanceOf(AgentMailProvisioningApiError);
      expect((error as AgentMailProvisioningApiError).operation).toBe("/inboxes/inb_1/api-keys");
      expect(confirmations).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
        },
        {
          provisioner,
          promptInput: (async () => "123456") as never,
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

  test("signup retries only definitively invalid verification codes within a fixed bound", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-signup-otp-retry-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const codes = ["bad-one", "bad-two", "good-code"];
      const prompts: string[] = [];
      const verify = mock(async (_apiKey: string, otp: string) => {
        if (otp === "bad-one") return { verified: false };
        if (otp === "bad-two") {
          throw new AgentMailProvisioningApiError({
            operation: "/agent/verify",
            status: 422,
            providerCode: "validation_error",
            issues: [{ path: ["otp_code"], code: "invalid_format", message: "Invalid code" }],
          });
        }
        return { verified: true };
      });

      const result = await runAgentMailSetup(
        "visitorAuth",
        {
          config: paths.configPath,
          mode: "signup",
          humanEmail: "owner@example.com",
          username: "support",
        },
        {
          provisioner: unusedProvisioner({
            signUp: async () => ({
              organizationId: "org_1",
              inboxId: "inb_1",
              apiKey: "am_parent",
            }),
            verify,
            createInboxApiKey: async () => ({ apiKeyId: "key_1", apiKey: "am_runtime" }),
          }),
          promptConfirm: (async () => true) as never,
          promptInput: (async (prompt: { message?: string }) => {
            prompts.push(prompt.message ?? "");
            return codes.shift() ?? "unexpected";
          }) as never,
        },
      );

      expect(result.inboxId).toBe("inb_1");
      expect(verify).toHaveBeenCalledTimes(3);
      expect(prompts).toEqual([
        "AgentMail verification code:",
        "AgentMail verification code (attempt 2 of 3):",
        "AgentMail verification code (attempt 3 of 3):",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("signup never retries an ambiguous verification failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-signup-otp-ambiguous-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const originalAugment = readFileSync(paths.augmentPath, "utf-8");
      const verify = mock(async () => {
        throw new AgentMailProvisioningApiError({
          operation: "/agent/verify",
          status: 503,
          providerCode: "unavailable",
          outcomeUnknown: true,
        });
      });
      const promptInput = mock(async () => "123456");

      const error = (await runAgentMailSetup(
        "visitorAuth",
        {
          config: paths.configPath,
          mode: "signup",
          humanEmail: "owner@example.com",
          username: "support",
        },
        {
          provisioner: unusedProvisioner({
            signUp: async () => ({
              organizationId: "org_1",
              inboxId: "inb_1",
              apiKey: "am_parent",
            }),
            verify,
          }),
          promptConfirm: (async () => true) as never,
          promptInput: promptInput as never,
        },
      ).catch((caught) => caught as Error)) as Error;

      expect(error).toBeInstanceOf(AgentMailProvisioningApiError);
      expect(error.message).toContain("outcome is unknown");
      expect(error.message).not.toContain("am_parent");
      expect(verify).toHaveBeenCalledTimes(1);
      expect(promptInput).toHaveBeenCalledTimes(1);
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("signup stops after three rejected codes with actionable recovery and no local mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-signup-otp-exhausted-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const originalAugment = readFileSync(paths.augmentPath, "utf-8");
      const verify = mock(async () => ({ verified: false }));
      const promptInput = mock(async () => "wrong-code");

      await expect(
        runAgentMailSetup(
          "visitorAuth",
          {
            config: paths.configPath,
            mode: "signup",
            humanEmail: "owner@example.com",
            username: "support",
          },
          {
            provisioner: unusedProvisioner({
              signUp: async () => ({
                organizationId: "org_1",
                inboxId: "inb_1",
                apiKey: "am_parent",
              }),
              verify,
            }),
            promptConfirm: (async () => true) as never,
            promptInput: promptInput as never,
          },
        ),
      ).rejects.toThrow(/No local credentials were changed[\s\S]*--mode existing/);
      expect(verify).toHaveBeenCalledTimes(3);
      expect(promptInput).toHaveBeenCalledTimes(3);
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("signup cancellation returns the same safe existing-account recovery path", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-signup-otp-cancel-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const verify = mock(async () => ({ verified: true }));
      const cancellation = new Error("prompt cancelled");
      cancellation.name = "ExitPromptError";

      await expect(
        runAgentMailSetup(
          "visitorAuth",
          {
            config: paths.configPath,
            mode: "signup",
            humanEmail: "owner@example.com",
            username: "support",
          },
          {
            provisioner: unusedProvisioner({
              signUp: async () => ({
                organizationId: "org_1",
                inboxId: "inb_1",
                apiKey: "am_parent",
              }),
              verify,
            }),
            promptConfirm: (async () => true) as never,
            promptInput: (async () => {
              throw cancellation;
            }) as never,
          },
        ),
      ).rejects.toThrow(/No local credentials were changed[\s\S]*--mode existing/);
      expect(verify).not.toHaveBeenCalled();
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
        },
        {
          provisioner,
          promptInput: (async () => "123456") as never,
          promptConfirm: (async () => true) as never,
        },
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
            clientId: "auggy.v1.inbox.aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c.visitorAuth",
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

  test("existing mode requires an immutable agent id before provider side effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-id-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      writeFileSync(
        paths.configPath,
        readFileSync(paths.configPath, "utf-8").replace(/^id:.*\n/m, ""),
      );
      let dispatched = false;
      const provisioner = unusedProvisioner({
        createInbox: async () => {
          dispatched = true;
          return { inboxId: "inb_unexpected", email: "unexpected@example.com" };
        },
      });

      await expect(
        runAgentMailSetup(
          "visitorAuth",
          { config: paths.configPath, mode: "existing", apiKey: "am_parent", username: "support" },
          { provisioner },
        ),
      ).rejects.toThrow(/must contain a valid immutable aug1_ UUID/);
      expect(dispatched).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("existing mode leaves local state unchanged across provider inbox failures", async () => {
    for (const status of [400, 401, 403, 409, 429]) {
      const root = mkdtempSync(join(tmpdir(), `agentmail-setup-inbox-failure-${status}-`));
      try {
        const paths = writeVisitorAuthAgent(root);
        const originalConfig = readFileSync(paths.configPath, "utf-8");
        const originalEnv = readFileSync(paths.envPath, "utf-8");
        const originalAugment = readFileSync(paths.augmentPath, "utf-8");
        const parentApiKey = `am_parent_secret_${status}`;
        const createInbox = mock(async () => {
          throw new AgentMailProvisioningApiError({
            operation: "/inboxes",
            status,
            providerCode: "request_failed",
            providerMessage: "The inbox could not be created.",
          });
        });
        const createInboxApiKey = mock(async () => {
          throw new Error("must not create a scoped key");
        });

        let error: Error | undefined;
        try {
          await runAgentMailSetup(
            "visitorAuth",
            {
              config: paths.configPath,
              mode: "existing",
              apiKey: parentApiKey,
              username: "support",
              displayName: "Support",
            },
            {
              provisioner: unusedProvisioner({ createInbox, createInboxApiKey }),
            },
          );
        } catch (caught) {
          error = caught as Error;
        }

        expect(error?.message).toContain(String(status));
        expect(error?.message).not.toContain(parentApiKey);
        expect(createInbox).toHaveBeenCalledTimes(1);
        expect(createInboxApiKey).not.toHaveBeenCalled();
        expect(readFileSync(paths.configPath, "utf-8")).toBe(originalConfig);
        expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
        expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("existing mode explicitly reuses a compatible account-owned inbox after resource_taken", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-owned-collision-"));
    try {
      const paths = writeAgentMailAgent(root);
      const passwordPrompt = mock(async () => "am_parent_account");
      const confirmPrompt = mock(async () => true);
      const createInbox = mock(async () => {
        throw new AgentMailProvisioningApiError({
          operation: "/inboxes",
          status: 403,
          providerName: "ResourceTakenError",
          providerCode: "resource_taken",
          providerMessage: "Inbox is taken",
        });
      });
      const listInboxes = mock(async () => [
        {
          inboxId: "inb_existing",
          email: "support@agentmail.to",
          clientId: "auggy.v1.inbox.aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c.visitorAuth",
        },
      ]);
      const createInboxApiKey = mock(async () => ({
        apiKeyId: "key_runtime",
        apiKey: "am_runtime_scoped",
      }));

      const result = await runAgentMailSetup(
        "agentMail",
        {
          config: paths.configPath,
          mode: "existing",
          username: "support",
          displayName: "Support",
        },
        {
          provisioner: unusedProvisioner({ createInbox, listInboxes, createInboxApiKey }),
          promptPassword: passwordPrompt as never,
          promptConfirm: confirmPrompt as never,
          interactive: true,
        },
      );

      expect(result.inboxId).toBe("inb_existing");
      expect(result.inboxEmail).toBe("support@agentmail.to");
      expect(passwordPrompt).toHaveBeenCalledTimes(1);
      expect(createInbox).toHaveBeenCalledTimes(1);
      expect(listInboxes).toHaveBeenCalledTimes(1);
      expect(confirmPrompt).toHaveBeenCalledTimes(1);
      expect(createInboxApiKey).toHaveBeenCalledTimes(1);
      expect(readEnv(paths.envPath)).toMatchObject({
        AGENTMAIL_API_KEY: "am_runtime_scoped",
        AGENTMAIL_INBOX_ID: "inb_existing",
        AGENTMAIL_INBOX_EMAIL: "support@agentmail.to",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resource_taken retries a bounded username without asking for the account key again", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-username-retry-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const passwordPrompt = mock(async () => "am_parent_account");
      const usernamePrompt = mock(async () => "support-2");
      const createInbox = mock(
        async (input: Parameters<AgentMailProvisioningClient["createInbox"]>[0]) => {
          if (input.username === "support") {
            throw new AgentMailProvisioningApiError({
              operation: "/inboxes",
              status: 403,
              providerCode: "resource_taken",
            });
          }
          return { inboxId: "inb_support_2", email: "support-2@agentmail.to" };
        },
      );
      const createInboxApiKey = mock(async () => ({
        apiKeyId: "key_runtime",
        apiKey: "am_runtime_scoped",
      }));
      const listInboxes = mock(async () => [
        {
          inboxId: "inb_unrelated",
          email: "support@agentmail.to",
          clientId: "some.other.integration",
        },
      ]);

      const result = await runAgentMailSetup(
        "visitorAuth",
        {
          config: paths.configPath,
          mode: "existing",
          username: "support",
          displayName: "Support",
        },
        {
          provisioner: unusedProvisioner({ createInbox, listInboxes, createInboxApiKey }),
          promptPassword: passwordPrompt as never,
          promptInput: usernamePrompt as never,
          promptConfirm: (async () => {
            throw new Error("must not offer unrelated inbox reuse");
          }) as never,
          interactive: true,
        },
      );

      expect(result.inboxId).toBe("inb_support_2");
      expect(passwordPrompt).toHaveBeenCalledTimes(1);
      expect(usernamePrompt).toHaveBeenCalledTimes(1);
      expect(createInbox).toHaveBeenCalledTimes(2);
      expect(createInbox.mock.calls.map(([call]) => call.apiKey)).toEqual([
        "am_parent_account",
        "am_parent_account",
      ]);
      expect(createInboxApiKey).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resource_taken cancellation creates no scoped key and leaves local state unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-collision-cancel-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const originalConfig = readFileSync(paths.configPath, "utf-8");
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const originalAugment = readFileSync(paths.augmentPath, "utf-8");
      const createInboxApiKey = mock(async () => {
        throw new Error("must not create a scoped key");
      });
      const promptCancellation = new Error("cancelled");
      promptCancellation.name = "ExitPromptError";

      await expect(
        runAgentMailSetup(
          "visitorAuth",
          {
            config: paths.configPath,
            mode: "existing",
            apiKey: "am_parent_account",
            username: "support",
            displayName: "Support",
          },
          {
            provisioner: unusedProvisioner({
              createInbox: async () => {
                throw new AgentMailProvisioningApiError({
                  operation: "/inboxes",
                  status: 403,
                  providerCode: "resource_taken",
                });
              },
              listInboxes: async () => [],
              createInboxApiKey,
            }),
            promptInput: (async () => {
              throw promptCancellation;
            }) as never,
            interactive: true,
          },
        ),
      ).rejects.toThrow(/selection was cancelled[\s\S]*no runtime key[\s\S]*no local credentials/);
      expect(createInboxApiKey).not.toHaveBeenCalled();
      expect(readFileSync(paths.configPath, "utf-8")).toBe(originalConfig);
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resource_taken stops after three username attempts without creating a scoped key", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-collision-bound-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const createInbox = mock(async () => {
        throw new AgentMailProvisioningApiError({
          operation: "/inboxes",
          status: 403,
          providerCode: "resource_taken",
        });
      });
      const createInboxApiKey = mock(async () => {
        throw new Error("must not create a scoped key");
      });
      let retry = 1;

      await expect(
        runAgentMailSetup(
          "visitorAuth",
          {
            config: paths.configPath,
            mode: "existing",
            apiKey: "am_parent_account",
            username: "support",
            displayName: "Support",
          },
          {
            provisioner: unusedProvisioner({
              createInbox,
              listInboxes: async () => [],
              createInboxApiKey,
            }),
            promptInput: (async () => `support-${++retry}`) as never,
            interactive: true,
          },
        ),
      ).rejects.toThrow(/support-3@agentmail\.to is already taken[\s\S]*no runtime key/);
      expect(createInbox).toHaveBeenCalledTimes(3);
      expect(createInboxApiKey).not.toHaveBeenCalled();
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("existing mode reuses the same deterministic client id after an explicit retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-idempotent-retry-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const originalConfig = readFileSync(paths.configPath, "utf-8");
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const originalAugment = readFileSync(paths.augmentPath, "utf-8");
      const clientIds: Array<string | undefined> = [];
      const createInbox = mock(
        async (input: Parameters<AgentMailProvisioningClient["createInbox"]>[0]) => {
          clientIds.push(input.clientId);
          throw new Error("AgentMail /inboxes failed (503): retry later");
        },
      );
      const options = {
        config: paths.configPath,
        mode: "existing" as const,
        apiKey: "am_parent",
        username: "support",
        displayName: "Support",
      };

      await expect(
        runAgentMailSetup("visitorAuth", options, {
          provisioner: unusedProvisioner({ createInbox }),
        }),
      ).rejects.toThrow(/503/);
      await expect(
        runAgentMailSetup("visitorAuth", options, {
          provisioner: unusedProvisioner({ createInbox }),
        }),
      ).rejects.toThrow(/503/);

      expect(clientIds).toEqual([
        "auggy.v1.inbox.aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c.visitorAuth",
        "auggy.v1.inbox.aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c.visitorAuth",
      ]);
      expect(readFileSync(paths.configPath, "utf-8")).toBe(originalConfig);
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("existing mode leaves local state unchanged when scoped-key creation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-scoped-key-failure-"));
    try {
      const paths = writeAgentMailAgent(root);
      const originalConfig = readFileSync(paths.configPath, "utf-8");
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const originalAugment = readFileSync(paths.augmentPath, "utf-8");
      const parentApiKey = "am_parent_secret_scoped_key";
      const createInbox = mock(async () => ({
        inboxId: "inb_created",
        email: "support@agentmail.to",
      }));
      const createInboxApiKey = mock(async () => {
        throw new AgentMailProvisioningApiError({
          operation: "/inboxes/inb_created/api-keys",
          status: 429,
          providerCode: "rate_limited",
          providerMessage: "Try again later.",
        });
      });

      let error: Error | undefined;
      try {
        await runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "existing",
            apiKey: parentApiKey,
            username: "support",
            displayName: "Support",
          },
          {
            provisioner: unusedProvisioner({ createInbox, createInboxApiKey }),
          },
        );
      } catch (caught) {
        error = caught as Error;
      }

      expect(error?.message).toContain("429");
      expect(error?.message).not.toContain(parentApiKey);
      expect(createInbox).toHaveBeenCalledTimes(1);
      expect(createInboxApiKey).toHaveBeenCalledTimes(1);
      expect(readFileSync(paths.configPath, "utf-8")).toBe(originalConfig);
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("outcome-unknown scoped-key creation names the possible orphan without leaking secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-scoped-key-unknown-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const parentApiKey = "am_parent_secret_unknown";
      const createInboxApiKey = mock(async () => {
        throw new AgentMailProvisioningApiError({
          operation: "/inboxes/inb_created/api-keys",
          status: 503,
          providerCode: "unavailable",
          outcomeUnknown: true,
        });
      });

      const error = (await runAgentMailSetup(
        "visitorAuth",
        {
          config: paths.configPath,
          mode: "existing",
          apiKey: parentApiKey,
          username: "support",
        },
        {
          provisioner: unusedProvisioner({
            createInbox: async () => ({
              inboxId: "inb_created",
              email: "support@agentmail.to",
            }),
            createInboxApiKey,
          }),
        },
      ).catch((caught) => caught as Error)) as Error;

      expect(error.message).toContain('scoped key named "dx-agent visitorAuth"');
      expect(error.message).toContain("revoke any orphan before retrying");
      expect(error.message).not.toContain(parentApiKey);
      expect(createInboxApiKey).toHaveBeenCalledTimes(1);
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("existing mode leaves local state unchanged for a malformed provider response", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-malformed-response-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const originalConfig = readFileSync(paths.configPath, "utf-8");
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const originalAugment = readFileSync(paths.augmentPath, "utf-8");
      const parentApiKey = "am_parent_secret_malformed";
      const createInbox = mock(async () => {
        throw new AgentMailProvisioningResponseError("/inboxes", "inbox_id or email was missing");
      });

      let error: Error | undefined;
      try {
        await runAgentMailSetup(
          "visitorAuth",
          {
            config: paths.configPath,
            mode: "existing",
            apiKey: parentApiKey,
            username: "support",
            displayName: "Support",
          },
          { provisioner: unusedProvisioner({ createInbox }) },
        );
      } catch (caught) {
        error = caught as Error;
      }

      expect(error).toBeInstanceOf(AgentMailProvisioningResponseError);
      expect(error?.message).toContain("invalid response");
      expect(error?.message).not.toContain(parentApiKey);
      expect(readFileSync(paths.configPath, "utf-8")).toBe(originalConfig);
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
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
            clientId: "auggy.v1.inbox.aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c.agentMail",
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

  test("env mode uses the first nonempty duplicate and collapses disk definitions to runtime parity", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-env-duplicates-"));
    const previous = snapshotAgentMailRuntimeEnv();
    try {
      clearAgentMailRuntimeEnv();
      const paths = writeVisitorAuthAgent(root);
      writeFileSync(
        paths.envPath,
        [
          "ANTHROPIC_API_KEY=sk-test",
          "AGENTMAIL_API_KEY=",
          "AGENTMAIL_API_KEY=am_first",
          "AGENTMAIL_API_KEY=am_last",
          "AGENTMAIL_INBOX_ID=",
          "AGENTMAIL_INBOX_ID=inb_first",
          "AGENTMAIL_INBOX_ID=inb_last",
          "",
        ].join("\n"),
      );

      const result = await runAgentMailSetup(
        "visitorAuth",
        { config: paths.configPath, mode: "env" },
        { interactive: false, provisioner: unusedProvisioner() },
      );

      expect(result.inboxId).toBe("inb_first");
      const written = readFileSync(paths.envPath, "utf-8");
      expect(written.match(/^AGENTMAIL_API_KEY=/gm)).toHaveLength(1);
      expect(written.match(/^AGENTMAIL_INBOX_ID=/gm)).toHaveLength(1);
      clearAgentMailRuntimeEnv();
      loadEnvFile(root);
      expect(process.env.AGENTMAIL_API_KEY).toBe("am_first");
      expect(process.env.AGENTMAIL_INBOX_ID).toBe("inb_first");
    } finally {
      restoreAgentMailRuntimeEnv(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never provisions over runtime credentials already stored on disk", async () => {
    for (const mode of ["signup", "existing"] as const) {
      const root = mkdtempSync(join(tmpdir(), `agentmail-setup-no-rotation-disk-${mode}-`));
      try {
        const paths = writeVisitorAuthAgent(root);
        writeFileSync(
          paths.envPath,
          "ANTHROPIC_API_KEY=sk-test\nAGENTMAIL_API_KEY=am_existing\nAGENTMAIL_INBOX_ID=inb_existing\n",
        );
        const originalEnv = readFileSync(paths.envPath, "utf-8");
        const signUp = mock(async () => {
          throw new Error("must not contact AgentMail");
        });
        const createInbox = mock(async () => {
          throw new Error("must not contact AgentMail");
        });

        await expect(
          runAgentMailSetup(
            "visitorAuth",
            {
              config: paths.configPath,
              mode,
              ...(mode === "signup"
                ? { humanEmail: "owner@example.com", username: "support" }
                : { apiKey: "am_parent", username: "support" }),
            },
            {
              interactive: true,
              provisioner: unusedProvisioner({ signUp, createInbox }),
            },
          ),
        ).rejects.toThrow(
          /will not be rotated automatically[\s\S]*--mode env[\s\S]*revoke[\s\S]*remove[\s\S]*unset/,
        );
        expect(signUp).not.toHaveBeenCalled();
        expect(createInbox).not.toHaveBeenCalled();
        expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("never provisions over exported runtime credentials without disk values", async () => {
    const previous = snapshotAgentMailRuntimeEnv();
    try {
      for (const mode of ["signup", "existing"] as const) {
        clearAgentMailRuntimeEnv();
        process.env.AGENTMAIL_API_KEY = "am_exported";
        const root = mkdtempSync(join(tmpdir(), `agentmail-setup-no-rotation-ambient-${mode}-`));
        try {
          const paths = writeVisitorAuthAgent(root);
          const signUp = mock(async () => {
            throw new Error("must not contact AgentMail");
          });
          const createInbox = mock(async () => {
            throw new Error("must not contact AgentMail");
          });

          await expect(
            runAgentMailSetup(
              "visitorAuth",
              {
                config: paths.configPath,
                mode,
                ...(mode === "signup"
                  ? { humanEmail: "owner@example.com", username: "support" }
                  : { apiKey: "am_parent", username: "support" }),
              },
              {
                interactive: true,
                provisioner: unusedProvisioner({ signUp, createInbox }),
              },
            ),
          ).rejects.toThrow(/will not be rotated automatically[\s\S]*unset exported/);
          expect(signUp).not.toHaveBeenCalled();
          expect(createInbox).not.toHaveBeenCalled();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    } finally {
      restoreAgentMailRuntimeEnv(previous);
    }
  });

  test("rejects an exported manual runtime credential conflict before provider or mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-env-conflict-"));
    const previous = snapshotAgentMailRuntimeEnv();
    try {
      clearAgentMailRuntimeEnv();
      process.env.AGENTMAIL_API_KEY = "am_exported";
      const paths = writeAgentMailAgent(root);
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const originalAugment = readFileSync(paths.augmentPath, "utf-8");
      const getInbox = mock(async () => {
        throw new Error("must not contact AgentMail");
      });

      await expect(
        runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "manual",
            apiKey: "am_selected",
            inboxId: "inb_selected",
          },
          { interactive: false, provisioner: unusedProvisioner({ getInbox }) },
        ),
      ).rejects.toThrow(
        /AGENTMAIL_API_KEY[\s\S]*--mode env[\s\S]*revoke[\s\S]*remove[\s\S]*unset exported/,
      );
      expect(getInbox).not.toHaveBeenCalled();
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
    } finally {
      restoreAgentMailRuntimeEnv(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("manual mode reuses matching disk and Bun-auto-loaded credentials without rotation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-manual-reuse-"));
    const previous = snapshotAgentMailRuntimeEnv();
    try {
      clearAgentMailRuntimeEnv();
      const paths = writeAgentMailAgent(root);
      writeFileSync(
        paths.envPath,
        [
          "ANTHROPIC_API_KEY=sk-test",
          "AGENTMAIL_API_KEY=am_existing",
          "AGENTMAIL_INBOX_ID=inb_existing",
          "AGENTMAIL_INBOX_EMAIL=Support@AgentMail.To",
          "",
        ].join("\n"),
      );
      process.env.AGENTMAIL_API_KEY = "am_existing";
      process.env.AGENTMAIL_INBOX_ID = "inb_existing";
      process.env.AGENTMAIL_INBOX_EMAIL = "Support@AgentMail.To";
      const getInbox = mock(async () => ({
        inboxId: "inb_existing",
        email: "support@agentmail.to",
      }));

      const result = await runAgentMailSetup(
        "agentMail",
        {
          config: paths.configPath,
          mode: "manual",
          apiKey: "am_existing",
          inboxId: "inb_existing",
        },
        { interactive: false, provisioner: unusedProvisioner({ getInbox }) },
      );

      expect(result.mode).toBe("manual");
      expect(getInbox).toHaveBeenCalledTimes(1);
      expect(readEnv(paths.envPath)).toMatchObject({
        AGENTMAIL_API_KEY: "am_existing",
        AGENTMAIL_INBOX_ID: "inb_existing",
        AGENTMAIL_INBOX_EMAIL: "support@agentmail.to",
      });
    } finally {
      restoreAgentMailRuntimeEnv(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("manual mode refuses to replace a stored runtime key before provider access", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-manual-disk-conflict-"));
    try {
      const paths = writeAgentMailAgent(root);
      writeFileSync(
        paths.envPath,
        "ANTHROPIC_API_KEY=sk-test\nAGENTMAIL_API_KEY=am_existing\nAGENTMAIL_INBOX_ID=inb_existing\n",
      );
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const getInbox = mock(async () => {
        throw new Error("must not contact AgentMail");
      });

      await expect(
        runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "manual",
            apiKey: "am_replacement",
            inboxId: "inb_existing",
          },
          { interactive: false, provisioner: unusedProvisioner({ getInbox }) },
        ),
      ).rejects.toThrow(/cannot replace[\s\S]*AGENTMAIL_API_KEY[\s\S]*revoke/);
      expect(getInbox).not.toHaveBeenCalled();
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts Bun-auto-loaded values that exactly match the agent .env", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-env-autoload-"));
    const previous = snapshotAgentMailRuntimeEnv();
    try {
      clearAgentMailRuntimeEnv();
      const paths = writeVisitorAuthAgent(root);
      writeFileSync(
        paths.envPath,
        "ANTHROPIC_API_KEY=sk-test\nAGENTMAIL_API_KEY=am_env\nAGENTMAIL_INBOX_ID=inb_env\n",
      );
      process.env.AGENTMAIL_API_KEY = "am_env";
      process.env.AGENTMAIL_INBOX_ID = "inb_env";

      const result = await runAgentMailSetup(
        "visitorAuth",
        { config: paths.configPath, mode: "env" },
        { interactive: false, provisioner: unusedProvisioner() },
      );

      expect(result.inboxId).toBe("inb_env");
    } finally {
      restoreAgentMailRuntimeEnv(previous);
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
      const originalConfig = readFileSync(paths.configPath, "utf-8");
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
      expect(readFileSync(paths.configPath, "utf-8")).toBe(originalConfig);
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
        const originalConfig = readFileSync(paths.configPath, "utf-8");
        const originalEnv = readFileSync(paths.envPath, "utf-8");
        const originalAugment = readFileSync(paths.augmentPath, "utf-8");
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
        expect(readFileSync(paths.configPath, "utf-8")).toBe(originalConfig);
        expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
        expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
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
      const lease = acquireAgentEnvMutationLock(root);
      lease.release();
    } finally {
      if (augmentDir) chmodSync(augmentDir, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails before provider access when Console holds the agent credential mutation lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-lock-contention-"));
    try {
      const paths = writeVisitorAuthAgent(root);
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const signUp = mock(async () => {
        throw new Error("must not contact AgentMail");
      });
      const lease = acquireAgentEnvMutationLock(root);
      try {
        await expect(
          runAgentMailSetup(
            "visitorAuth",
            {
              config: paths.configPath,
              mode: "signup",
              humanEmail: "owner@example.com",
              username: "support",
            },
            {
              interactive: true,
              provisioner: unusedProvisioner({ signUp }),
            },
          ),
        ).rejects.toThrow(/being updated by another Auggy operation[\s\S]*no files were changed/);
      } finally {
        lease.release();
      }

      expect(signUp).not.toHaveBeenCalled();
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      await expect(
        runAgentMailSetup(
          "visitorAuth",
          {
            config: paths.configPath,
            mode: "manual",
            apiKey: "am_runtime",
            inboxId: "inb_existing",
          },
          { interactive: false, provisioner: unusedProvisioner() },
        ),
      ).resolves.toMatchObject({ inboxId: "inb_existing" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports scoped-key evidence and rolls back local files when commit fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-scoped-key-rollback-"));
    let augmentDir: string | undefined;
    try {
      const paths = writeAgentMailAgent(root);
      const originalEnv = readFileSync(paths.envPath, "utf-8");
      const originalAugment = readFileSync(paths.augmentPath, "utf-8");
      augmentDir = join(root, "augments", "agentMail");
      chmodSync(augmentDir, 0o500);

      const error = (await runAgentMailSetup(
        "agentMail",
        {
          config: paths.configPath,
          mode: "existing",
          apiKey: "am_parent",
          username: "outbound",
        },
        {
          provisioner: unusedProvisioner({
            createInbox: async () => ({
              inboxId: "inb_outbound",
              email: "outbound@agentmail.to",
            }),
            createInboxApiKey: async () => ({
              apiKeyId: "key_runtime_123",
              apiKey: "am_runtime",
            }),
          }),
        },
      ).catch((caught) => caught as Error)) as Error;

      expect(error.message).toContain('scoped runtime key "dx-agent agentMail"');
      expect(error.message).toContain("key_runtime_123");
      expect(error.message).toContain("Review and revoke that orphaned key");
      expect(error.message).not.toContain("am_runtime");
      expect(readFileSync(paths.envPath, "utf-8")).toBe(originalEnv);
      expect(readFileSync(paths.augmentPath, "utf-8")).toBe(originalAugment);
    } finally {
      if (augmentDir) chmodSync(augmentDir, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const changedFile of ["agent.yaml", "augment.yaml", ".env"] as const) {
    test(`does not overwrite a concurrent ${changedFile} edit after provider mutation`, async () => {
      const root = mkdtempSync(join(tmpdir(), `agentmail-setup-config-cas-${changedFile}-`));
      try {
        const paths = writeAgentMailAgent(root);
        const originalEnv = readFileSync(paths.envPath, "utf-8");
        const changedPath =
          changedFile === "agent.yaml"
            ? paths.configPath
            : changedFile === "augment.yaml"
              ? paths.augmentPath
              : paths.envPath;
        const concurrentEdit = `${readFileSync(changedPath, "utf-8")}# concurrent operator edit\n`;

        const error = (await runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "existing",
            apiKey: "am_parent",
            username: "outbound",
          },
          {
            provisioner: unusedProvisioner({
              createInbox: async () => ({
                inboxId: "inb_outbound",
                email: "outbound@agentmail.to",
              }),
              createInboxApiKey: async () => {
                writeFileSync(changedPath, concurrentEdit);
                return { apiKeyId: "key_concurrent", apiKey: "am_runtime" };
              },
            }),
          },
        ).catch((caught) => caught as Error)) as Error;

        expect(error.message).toContain("did not commit");
        expect(error.message).toContain("changed while AgentMail setup was running");
        expect(error.message).toContain("key_concurrent");
        expect(error.message).not.toContain("am_runtime");
        expect(readFileSync(changedPath, "utf-8")).toBe(concurrentEdit);
        expect(readFileSync(paths.envPath, "utf-8")).toBe(
          changedFile === ".env" ? concurrentEdit : originalEnv,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("defers termination until a created scoped key is committed or reconciled", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-setup-deferred-signal-"));
    const initialSigintListeners = process.listenerCount("SIGINT");
    const initialSigtermListeners = process.listenerCount("SIGTERM");
    try {
      const paths = writeAgentMailAgent(root);
      const error = (await runAgentMailSetup(
        "agentMail",
        {
          config: paths.configPath,
          mode: "existing",
          apiKey: "am_parent",
          username: "outbound",
        },
        {
          provisioner: unusedProvisioner({
            createInbox: async () => ({
              inboxId: "inb_outbound",
              email: "outbound@agentmail.to",
            }),
            createInboxApiKey: async () => {
              process.emit("SIGINT", "SIGINT");
              return { apiKeyId: "key_signal", apiKey: "am_runtime" };
            },
          }),
        },
      ).catch((caught) => caught as Error)) as Error;

      expect(error.message).toContain("received SIGINT");
      expect(error.message).toContain("local credential commit completed safely");
      expect(readEnv(paths.envPath)).toMatchObject({
        AGENTMAIL_API_KEY: "am_runtime",
        AGENTMAIL_INBOX_ID: "inb_outbound",
        AGENTMAIL_INBOX_EMAIL: "outbound@agentmail.to",
      });
      expect(readAgentMailConfig(paths.augmentPath)).toMatchObject({
        apiKey: "${AGENTMAIL_API_KEY}",
        inboxId: "${AGENTMAIL_INBOX_ID}",
      });
    } finally {
      expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);
      expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
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

function restoreProcessEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

type AgentMailRuntimeEnvSnapshot = Record<
  "AGENTMAIL_API_KEY" | "AGENTMAIL_INBOX_ID" | "AGENTMAIL_INBOX_EMAIL",
  string | undefined
>;

function snapshotAgentMailRuntimeEnv(): AgentMailRuntimeEnvSnapshot {
  return {
    AGENTMAIL_API_KEY: process.env.AGENTMAIL_API_KEY,
    AGENTMAIL_INBOX_ID: process.env.AGENTMAIL_INBOX_ID,
    AGENTMAIL_INBOX_EMAIL: process.env.AGENTMAIL_INBOX_EMAIL,
  };
}

function clearAgentMailRuntimeEnv(): void {
  delete process.env.AGENTMAIL_API_KEY;
  delete process.env.AGENTMAIL_INBOX_ID;
  delete process.env.AGENTMAIL_INBOX_EMAIL;
}

function restoreAgentMailRuntimeEnv(snapshot: AgentMailRuntimeEnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) restoreProcessEnv(key, value);
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

function setVisitorAuthTransport(augmentPath: string, transport: "console" | "agentmail"): void {
  const parsed = parseYaml(readFileSync(augmentPath, "utf-8")) as {
    config?: Record<string, unknown>;
  };
  const config = parsed.config ?? {};
  const agentMail =
    typeof config.agentMail === "object" && config.agentMail !== null
      ? (config.agentMail as Record<string, unknown>)
      : {};
  parsed.config = { ...config, agentMail: { ...agentMail, transport } };
  writeFileSync(augmentPath, stringifyYaml(parsed));
}

function removeVisitorAuthTransport(augmentPath: string): void {
  const parsed = parseYaml(readFileSync(augmentPath, "utf-8")) as {
    config?: Record<string, unknown>;
  };
  const config = parsed.config ?? {};
  const agentMail =
    typeof config.agentMail === "object" && config.agentMail !== null
      ? { ...(config.agentMail as Record<string, unknown>) }
      : {};
  delete agentMail.transport;
  parsed.config = { ...config, agentMail };
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

function addVisitorAuth(configPath: string): void {
  const agentDir = dirname(configPath);
  const augmentDir = join(agentDir, "augments", "visitorAuth");
  mkdirSync(augmentDir, { recursive: true });
  const parsed = parseYaml(readFileSync(configPath, "utf-8")) as {
    augments?: unknown[];
  };
  parsed.augments = [...(parsed.augments ?? []), "visitorAuth"];
  writeFileSync(configPath, stringifyYaml(parsed));
  writeFileSync(
    join(augmentDir, "augment.yaml"),
    stringifyYaml({
      type: "visitorAuth",
      config: {
        publicUrl: "${AUGGY_PUBLIC_URL}",
        agentMail: { transport: "console", subjectPrefix: "[Verify] " },
        signingKey: "${VISITOR_SIGNING_KEY}",
        rateLimit: { minIntervalSeconds: 10, perHour: 360, perDay: 8640 },
      },
    }),
  );
}

function addAgentMail(configPath: string): void {
  const agentDir = dirname(configPath);
  const augmentDir = join(agentDir, "augments", "agentMail");
  mkdirSync(augmentDir, { recursive: true });
  const parsed = parseYaml(readFileSync(configPath, "utf-8")) as {
    augments?: unknown[];
  };
  parsed.augments = [...(parsed.augments ?? []), "agentMail"];
  writeFileSync(configPath, stringifyYaml(parsed));
  writeFileSync(
    join(augmentDir, "augment.yaml"),
    stringifyYaml({
      type: "agentMail",
      config: {
        apiKey: "${AGENTMAIL_API_KEY}",
        inboxId: "${AGENTMAIL_INBOX_ID}",
        outbound: { allowedTrustLevels: ["creator"] },
      },
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
