import { z } from "zod";
import { resolve } from "node:path";
import type { Augment } from "../types";
import { defineTool } from "../helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BashScript {
  name: string;
  description: string;
  command: string;
  workingDir?: string;
  timeout?: number;
}

export type BashRiskLevel =
  | "scripts-only"
  | "restricted"
  | "standard"
  | "unrestricted";

export interface BashAugmentOptions {
  /** Risk preset. Bundles mode, env, and allowlist defaults. Default: "restricted". */
  risk?: BashRiskLevel;
  /** Allowed command names (argv[0] in exec mode, first token in shell mode). */
  allowedCommands?: string[];
  /** Additional blocked command patterns (checked as substring). */
  blockedCommands?: string[];
  /** Initial working directory for commands. */
  workingDir?: string;
  /** Inherit the full process environment. Default: false (only PATH/HOME/USER/LANG + declared env). */
  inheritEnv?: boolean;
  /** Explicit environment variables passed to child processes. */
  env?: Record<string, string>;
  /** Per-command timeout in ms. Default: 30000. */
  timeout?: number;
  /** Max bytes per stream (stdout and stderr independently). Default: 262144 (256KB each). */
  maxOutputBytes?: number;
  /** Max tool calls per turn. Default: 10. */
  maxToolCallsPerTurn?: number;
  /** Named scripts the operator pre-authors. Available in all risk levels. */
  scripts?: BashScript[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024; // 256KB
const SIGKILL_GRACE_MS = 2_000;

/**
 * Always blocked regardless of operator config. Checked against a normalized
 * version of the command (quotes stripped, whitespace collapsed) to resist
 * trivial evasion via quoting or flag splitting.
 */
const HARDCODED_BLOCKED = [
  "rm -rf /",
  "rm -rf /*",
  "rm -r -f /",
  "rm -r -f /*",
  "rm --recursive --force /",
  "mkfs.",
  "dd if=/dev/",
  "shutdown",
  "reboot",
  "halt",
  "init 0",
  "init 6",
  ":(){ :|:& };:",
  "> /dev/sda",
];

/** Minimal env inherited when inheritEnv is false. */
function sanitizedEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LANG", "TERM", "SHELL"]) {
    if (process.env[key]) base[key] = process.env[key]!;
  }
  return { ...base, ...extra };
}

// ---------------------------------------------------------------------------
// Preset resolution
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  mode: "exec" | "shell";
  shellExecEnabled: boolean;
  allowedCommands: string[] | null; // null = no check
  blockedCommands: string[];
  workingDir: string;
  inheritEnv: boolean;
  env: Record<string, string>;
  timeout: number;
  maxOutputBytes: number;
  scripts: BashScript[];
}

function resolvePreset(opts: BashAugmentOptions): ResolvedConfig {
  const risk = opts.risk ?? "restricted";

  const presetDefaults: Record<
    BashRiskLevel,
    { mode: "exec" | "shell"; shellExecEnabled: boolean; inheritEnv: boolean; requireAllowlist: boolean }
  > = {
    "scripts-only": { mode: "exec", shellExecEnabled: false, inheritEnv: false, requireAllowlist: false },
    restricted: { mode: "exec", shellExecEnabled: true, inheritEnv: false, requireAllowlist: true },
    standard: { mode: "shell", shellExecEnabled: true, inheritEnv: false, requireAllowlist: false },
    unrestricted: { mode: "shell", shellExecEnabled: true, inheritEnv: true, requireAllowlist: false },
  };

  const preset = presetDefaults[risk];
  if (!preset) {
    throw new Error(
      `bash: unknown risk level "${risk}". Use: scripts-only, restricted, standard, unrestricted`,
    );
  }

  // Resolve allowlist. When an allowlist is active, FORCE exec mode regardless
  // of the preset. Shell mode + allowlist is a false sense of security:
  // command substitution ($(...)) and other shell features bypass first-token
  // checks trivially. If the operator wants shell features, they should NOT
  // use an allowlist — the two are mutually exclusive security models.
  let allowedCommands: string[] | null = opts.allowedCommands ?? null;
  let mode = preset.mode;
  if (preset.requireAllowlist && !allowedCommands) {
    throw new Error(
      `bash: risk level "restricted" requires allowedCommands to be set. ` +
        `Provide a list of allowed command names or use a different risk level.`,
    );
  }
  if (!preset.requireAllowlist && !opts.allowedCommands) {
    allowedCommands = null; // no check
  }
  if (allowedCommands) {
    mode = "exec"; // C1 fix: allowlist only works with exec mode
  }

  return {
    mode,
    shellExecEnabled: preset.shellExecEnabled,
    allowedCommands,
    blockedCommands: [...HARDCODED_BLOCKED, ...(opts.blockedCommands ?? [])],
    workingDir: opts.workingDir ?? process.cwd(),
    inheritEnv: opts.inheritEnv ?? preset.inheritEnv,
    env: opts.env ?? {},
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
    scripts: opts.scripts ?? [],
  };
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

async function executeCommand(opts: {
  command: string;
  args?: string[];
  mode: "exec" | "shell";
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  maxOutputBytes: number;
}): Promise<ExecResult> {
  const started = performance.now();

  const cmd =
    opts.mode === "shell"
      ? ["sh", "-c", opts.command]
      : [opts.command, ...(opts.args ?? [])];

  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore", // No interactive input — prevents cat/read from hanging
    stdout: "pipe",
    stderr: "pipe",
  });

  // Timeout with SIGTERM → SIGKILL escalation
  let killed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may have already exited after SIGTERM
      }
    }, SIGKILL_GRACE_MS);
  }, opts.timeout);

  // Read streams with byte-count truncation
  const [stdout, stderr] = await Promise.all([
    readStream(proc.stdout, opts.maxOutputBytes),
    readStream(proc.stderr, opts.maxOutputBytes),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);

  const truncated = stdout.truncated || stderr.truncated;
  const durationMs = Math.round(performance.now() - started);

  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: killed ? 137 : exitCode, // 137 = SIGKILL convention
    durationMs,
    truncated,
  };
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (totalBytes + value.byteLength > maxBytes) {
      const remaining = maxBytes - totalBytes;
      if (remaining > 0) {
        chunks.push(value.slice(0, remaining));
      }
      totalBytes = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(value);
    totalBytes += value.byteLength;
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  for (let i = 0; i < chunks.length; i++) {
    text += decoder.decode(chunks[i], { stream: i < chunks.length - 1 });
  }

  if (truncated) {
    text += `\n[truncated at ${maxBytes} bytes]`;
  }

  return { text, truncated };
}

// ---------------------------------------------------------------------------
// Security checks
// ---------------------------------------------------------------------------

/**
 * Normalize a command string for blocklist matching: strip single and double
 * quotes, collapse whitespace. This defeats trivial evasion like `rm -rf "/"`
 * or `rm  -rf  /` while keeping the check simple and predictable.
 */
function normalizeForBlockCheck(cmd: string): string {
  return cmd.replace(/['"]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function checkBlocked(command: string, blockedCommands: string[]): string | null {
  const normalized = normalizeForBlockCheck(command);
  for (const pattern of blockedCommands) {
    if (normalized.includes(pattern.toLowerCase())) {
      return `Command blocked: matches "${pattern}"`;
    }
  }
  return null;
}

function checkAllowed(
  command: string,
  args: string[] | undefined,
  mode: "exec" | "shell",
  allowedCommands: string[] | null,
): string | null {
  if (!allowedCommands) return null; // no allowlist = all allowed

  let binary: string;
  if (mode === "exec") {
    binary = command;
  } else {
    // Shell mode: extract first token as best-effort binary name
    const firstToken = command.trim().split(/[\s;|&]/)[0] ?? "";
    binary = firstToken;
  }

  if (!allowedCommands.includes(binary)) {
    return `Command "${binary}" is not in the allowed list: [${allowedCommands.join(", ")}]`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Augment factory
// ---------------------------------------------------------------------------

export function bash(opts: BashAugmentOptions = {}): Augment {
  const config = resolvePreset(opts);

  // I4 fix: validate operator scripts against the blocklist at construction
  // time. Catches catastrophic typos (e.g. `rm -rf /` in a script command)
  // before the agent boots rather than at runtime.
  for (const script of config.scripts) {
    const blocked = checkBlocked(script.command, config.blockedCommands);
    if (blocked) {
      throw new Error(
        `bash: script "${script.name}" contains a blocked command: ${blocked}`,
      );
    }
  }

  const tools = [];
  const toolNames: string[] = [];

  // --- shell_exec tool ---

  if (config.shellExecEnabled) {
    const shellExecTool = defineTool({
      name: "shell_exec",
      description:
        config.mode === "exec"
          ? "Execute a command with arguments. No shell interpretation — pipes, redirects, and chaining are not available. Returns JSON with stdout, stderr, exitCode, and durationMs."
          : "Execute a shell command. Full shell features available (pipes, redirects, chaining). Returns JSON with stdout, stderr, exitCode, and durationMs.",
      category: "meta",
      input: z.object({
        command: z.string().describe("The command to execute"),
        args: z
          .array(z.string())
          .optional()
          .describe("Arguments (used in restricted/exec mode; ignored in shell mode)"),
      }),
      execute: async ({ command, args }) => {
        // Security checks
        const fullCommand =
          config.mode === "exec" && args?.length
            ? `${command} ${args.join(" ")}`
            : command;

        const blockedReason = checkBlocked(fullCommand, config.blockedCommands);
        if (blockedReason) {
          return JSON.stringify({ error: blockedReason, command: fullCommand });
        }

        const allowedReason = checkAllowed(
          command,
          args,
          config.mode,
          config.allowedCommands,
        );
        if (allowedReason) {
          return JSON.stringify({ error: allowedReason, command });
        }

        // Build environment
        const env = config.inheritEnv
          ? { ...process.env, ...config.env }
          : sanitizedEnv(config.env);

        try {
          const result = await executeCommand({
            command,
            args,
            mode: config.mode,
            cwd: config.workingDir,
            env: env as Record<string, string>,
            timeout: config.timeout,
            maxOutputBytes: config.maxOutputBytes,
          });
          return JSON.stringify({ ...result, command: fullCommand });
        } catch (err) {
          return JSON.stringify({
            error: (err as Error).message,
            command: fullCommand,
          });
        }
      },
    });
    tools.push(shellExecTool);
    toolNames.push("shell_exec");
  }

  // --- run_script tool ---

  if (config.scripts.length > 0) {
    const scriptMap = new Map(config.scripts.map((s) => [s.name, s]));
    const scriptList = config.scripts
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");

    const runScriptTool = defineTool({
      name: "run_script",
      description: `Run a named script defined by the operator. Available scripts:\n${scriptList}`,
      category: "meta",
      input: z.object({
        name: z.string().describe("Script name"),
      }),
      execute: async ({ name }) => {
        const script = scriptMap.get(name);
        if (!script) {
          return JSON.stringify({
            error: `Unknown script "${name}". Available: ${[...scriptMap.keys()].join(", ")}`,
          });
        }

        const env = config.inheritEnv
          ? { ...process.env, ...config.env }
          : sanitizedEnv(config.env);

        try {
          const result = await executeCommand({
            command: script.command,
            mode: "shell", // Scripts are operator-authored, shell is safe
            cwd: script.workingDir
              ? resolve(script.workingDir)
              : config.workingDir,
            env: env as Record<string, string>,
            timeout: script.timeout ?? config.timeout,
            maxOutputBytes: config.maxOutputBytes,
          });
          return JSON.stringify({ ...result, script: name });
        } catch (err) {
          return JSON.stringify({
            error: (err as Error).message,
            script: name,
          });
        }
      },
    });
    tools.push(runScriptTool);
    toolNames.push("run_script");
  }

  if (tools.length === 0) {
    throw new Error(
      'bash: no tools available. Set risk to something other than "scripts-only" or configure scripts.',
    );
  }

  return {
    name: "bash",
    capabilities: ["tools"],
    constraints: {
      maxToolCallsPerTurn: opts.maxToolCallsPerTurn ?? 10,
      perTrustLevel: {
        untrusted: { neverExpose: toolNames },
        authenticated: { neverExpose: toolNames },
      },
    },
    tools,
  };
}
