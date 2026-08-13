import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatAgentMailSetupResult, runAgentMailSetup } from "../../../src/cli/commands/agentmail";

const ENV_KEYS = [
  "AGENTMAIL_API_KEY",
  "AGENTMAIL_INBOX_ID",
  "AGENTMAIL_INBOX_EMAIL",
  "AGENTMAIL_ACCOUNT_API_KEY",
] as const;
let priorEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  priorEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof priorEnv;
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (priorEnv[key] === undefined) delete process.env[key];
    else process.env[key] = priorEnv[key];
  }
});

describe("agentMail connect setup", () => {
  test("accepts lowercase setup target while preserving canonical files and result", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-lowercase-"));
    try {
      const paths = writeAgent(root);
      const result = await runAgentMailSetup(
        "agentmail",
        {
          config: paths.configPath,
          mode: "connect",
          apiKey: "am_operator_selected",
          inboxId: "owned@agentmail.to",
        },
        {
          interactive: false,
          verifyRuntimeAccess: async () => ({
            emailAddress: "owned@agentmail.to",
            verifiedPermissions: ["inbox_read", "message_read", "draft_read"],
          }),
        },
      );
      expect(result.target).toBe("agentMail");
      expect(result.augmentPath).toBe(paths.augmentPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists the exact supplied runtime key after read-only inbox checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-connect-"));
    try {
      const paths = writeAgent(root, { inbound: true, review: true });
      const verifyRuntimeAccess = mock(async (input, requirements) => {
        expect(input.apiKey).toBe("am_exact_runtime_key");
        expect(input.inboxId).toBe("inbox@agentmail.to");
        expect(requirements).toEqual({ messageRead: true, draftRead: true });
        return {
          emailAddress: "inbox@agentmail.to",
          verifiedPermissions: ["inbox_read", "message_read", "draft_read"],
        };
      });

      const result = await runAgentMailSetup(
        "agentMail",
        {
          config: paths.configPath,
          mode: "connect",
          apiKey: "am_exact_runtime_key",
          inboxId: "inbox@agentmail.to",
        },
        {
          interactive: false,
          verifyRuntimeAccess,
        },
      );

      const env = readFileSync(paths.envPath, "utf8");
      expect(env).toContain("AGENTMAIL_API_KEY=am_exact_runtime_key");
      expect(env).toContain("AGENTMAIL_INBOX_ID=inbox@agentmail.to");
      expect(env).toContain("AGENTMAIL_INBOX_EMAIL=inbox@agentmail.to");
      expect(result.mode).toBe("connect");
      expect(result.verifiedPermissions).toEqual(["inbox_read", "message_read", "draft_read"]);
      expect(result.requiredPermissions).toEqual([
        "inbox_read",
        "message_read",
        "draft_read",
        "message_send",
        "draft_create",
        "draft_update",
        "draft_send",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exposes only one read-only verifier and no provider mutation dependency", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-no-provision-"));
    try {
      const paths = writeAgent(root);
      const verifyRuntimeAccess = mock(async () => ({
        emailAddress: "owned@agentmail.to",
        verifiedPermissions: ["inbox_read"],
      }));
      await runAgentMailSetup(
        "agentMail",
        {
          config: paths.configPath,
          mode: "connect",
          apiKey: "am_operator_selected",
          inboxId: "owned@agentmail.to",
        },
        {
          interactive: false,
          verifyRuntimeAccess,
        },
      );
      expect(verifyRuntimeAccess).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("env mode reuses exact stored credentials and re-verifies them", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-env-"));
    try {
      const paths = writeAgent(root);
      writeFileSync(
        paths.envPath,
        "AGENTMAIL_API_KEY=am_stored_exact\nAGENTMAIL_INBOX_ID=stored@agentmail.to\nAGENTMAIL_INBOX_EMAIL=stored@agentmail.to\n",
      );
      const result = await runAgentMailSetup(
        "agentMail",
        { config: paths.configPath, mode: "env" },
        {
          interactive: false,
          verifyRuntimeAccess: async (input) => {
            expect(input.apiKey).toBe("am_stored_exact");
            return {
              emailAddress: "stored@agentmail.to",
              verifiedPermissions: ["inbox_read"],
            };
          },
        },
      );

      expect(result.mode).toBe("env");
      expect(readFileSync(paths.envPath, "utf8")).toContain("AGENTMAIL_API_KEY=am_stored_exact");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects removed agentMail provisioning and replacement modes before provider access", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-removed-mode-"));
    try {
      const paths = writeAgent(root);
      const verifyRuntimeAccess = mock(async () => ({
        emailAddress: "must-not-run@agentmail.to",
        verifiedPermissions: ["inbox_read"],
      }));
      for (const mode of ["signup", "existing", "manual"]) {
        await expect(
          runAgentMailSetup(
            "agentMail",
            { config: paths.configPath, mode },
            { interactive: false, verifyRuntimeAccess },
          ),
        ).rejects.toThrow(/does not create accounts, inboxes, or API keys/);
      }
      expect(verifyRuntimeAccess).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects inline and renamed mounts before reading credentials or contacting AgentMail", async () => {
    for (const mounted of [
      ["augments:", "  - type: agentMail", "    name: agentMail"],
      ["augments:", "  - mail"],
    ]) {
      const root = mkdtempSync(join(tmpdir(), "agentmail-noncanonical-"));
      try {
        const paths = writeAgent(root);
        if (mounted[1] === "  - mail") {
          mkdirSync(join(root, "augments", "mail"), { recursive: true });
          writeFileSync(
            join(root, "augments", "mail", "augment.yaml"),
            "type: agentMail\nconfig: {}\n",
          );
        }
        writeFileSync(
          paths.configPath,
          [
            "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
            "name: mail-agent",
            "engine:",
            "  provider: anthropic",
            "  model: claude-sonnet-4-6",
            ...mounted,
            "",
          ].join("\n"),
        );
        const verifyRuntimeAccess = mock(async () => ({
          emailAddress: "must-not-run@agentmail.to",
          verifiedPermissions: ["inbox_read"],
        }));
        await expect(
          runAgentMailSetup(
            "agentMail",
            { config: paths.configPath, mode: "connect" },
            { interactive: false, verifyRuntimeAccess },
          ),
        ).rejects.toThrow(/inline or under a custom name/);
        expect(verifyRuntimeAccess).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("reports the exact-key boundary without claiming write permissions were probed", () => {
    const output = formatAgentMailSetupResult({
      agentName: "mail-agent",
      target: "agentMail",
      mode: "connect",
      inboxId: "inbox@agentmail.to",
      inboxEmail: "inbox@agentmail.to",
      envPath: "/tmp/.env",
      augmentPath: "/tmp/augment.yaml",
      envKeys: ["AGENTMAIL_API_KEY", "AGENTMAIL_INBOX_ID", "AGENTMAIL_INBOX_EMAIL"],
      verifiedPermissions: ["inbox_read", "message_read", "draft_read"],
      requiredPermissions: ["inbox_read", "message_read", "message_send", "draft_create"],
      enabledCapabilities: [
        "receive and triage incoming mail",
        "prepare creator-reviewed reply drafts",
      ],
    });
    expect(output).toContain("exact API key you supplied");
    expect(output).toContain("Verified read capabilities: inbox_read, message_read, draft_read");
    expect(output).toContain("Write operations still require");
    expect(output).not.toContain("verified: message_send");
  });

  test("keeps provider verification failures actionable and redacts the supplied key", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentmail-redaction-"));
    const secret = "am_never_print_this";
    try {
      const paths = writeAgent(root);
      let failure: unknown;
      try {
        await runAgentMailSetup(
          "agentMail",
          {
            config: paths.configPath,
            mode: "connect",
            apiKey: secret,
            inboxId: "denied@agentmail.to",
          },
          {
            interactive: false,
            verifyRuntimeAccess: async () => {
              throw new Error(`provider rejected credential ${secret}`);
            },
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("Could not verify the supplied AgentMail key's read access");
      expect(message).toContain("Grant inbox_read");
      expect(message).not.toContain(secret);
      expect(readFileSync(paths.envPath, "utf8")).not.toContain(secret);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeAgent(
  root: string,
  options: { inbound?: boolean; review?: boolean } = {},
): { configPath: string; envPath: string; augmentPath: string } {
  const configPath = join(root, "agent.yaml");
  const envPath = join(root, ".env");
  const augmentPath = join(root, "augments", "agentMail", "augment.yaml");
  mkdirSync(join(root, "augments", "agentMail"), { recursive: true });
  writeFileSync(
    configPath,
    [
      "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
      "name: mail-agent",
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
      "    allowDirectDelivery: true",
      ...(options.inbound
        ? [
            "  inbound:",
            "    mode: websocket",
            "    allowAnySender: true",
            "    rateLimit:",
            "      globalMaxPerHour: 100",
            "      perSenderMaxPerHour: 5",
          ]
        : []),
      ...(options.review ? ["  replies:", "    mode: review"] : []),
      "",
    ].join("\n"),
  );
  return { configPath, envPath, augmentPath };
}
