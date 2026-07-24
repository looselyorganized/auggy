import { spawn, type ChildProcess } from "node:child_process";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

export interface BoundedStdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env: Record<string, string>;
  maxMessageBytes: number;
}

export class BoundedStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private child: ChildProcess | null = null;
  private pending: Buffer;
  private pendingLength = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly onStdoutData = (chunk: Buffer): void => this.acceptChunk(chunk);
  private readonly onStdoutError = (error: Error): void => this.fail(error);
  private readonly onStdinError = (error: Error): void => this.fail(error);

  constructor(private readonly options: BoundedStdioTransportOptions) {
    if (!Number.isSafeInteger(options.maxMessageBytes) || options.maxMessageBytes < 1) {
      throw new TypeError("MCP stdio maxMessageBytes must be a positive safe integer.");
    }
    this.pending = Buffer.allocUnsafe(Math.min(4096, options.maxMessageBytes));
  }

  async start(): Promise<void> {
    if (this.child || this.closed) throw new Error("Bounded stdio transport is already started.");
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    child.stdout?.on("data", this.onStdoutData);
    child.stdout?.on("error", this.onStdoutError);
    child.stdin?.on("error", this.onStdinError);
    child.on("close", () => {
      this.closed = true;
      this.child = null;
      this.pendingLength = 0;
      this.onclose?.();
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  private acceptChunk(chunk: Buffer): void {
    if (this.closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) {
        if (!this.appendPending(chunk.subarray(offset))) return;
        return;
      }

      const segment = chunk.subarray(offset, newline);
      if (!this.appendPending(segment)) return;
      const line = this.pending.subarray(0, this.pendingLength).toString("utf8");
      this.pendingLength = 0;
      offset = newline + 1;
      if (!line.trim()) continue;
      try {
        this.onmessage?.(deserializeMessage(line));
      } catch {
        this.fail(new Error("MCP stdio server emitted an invalid JSON-RPC message."));
        return;
      }
    }
  }

  private appendPending(segment: Buffer): boolean {
    const required = this.pendingLength + segment.length;
    if (required > this.options.maxMessageBytes) {
      this.fail(new Error("MCP stdio message exceeded the configured byte limit."));
      return false;
    }
    if (required > this.pending.length) {
      const capacity = Math.min(
        this.options.maxMessageBytes,
        Math.max(required, this.pending.length * 2),
      );
      const grown = Buffer.allocUnsafe(capacity);
      this.pending.copy(grown, 0, 0, this.pendingLength);
      this.pending = grown;
    }
    segment.copy(this.pending, this.pendingLength);
    this.pendingLength = required;
    return true;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.onerror?.(error);
    void this.beginClose();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed) throw new Error("MCP stdio transport is closed.");
    const child = this.child;
    if (!child?.stdin) throw new Error("MCP stdio transport is not connected.");
    const serialized = serializeMessage(message);
    if (Buffer.byteLength(serialized, "utf8") > this.options.maxMessageBytes) {
      throw new Error("MCP stdio request exceeded the configured byte limit.");
    }
    if (child.stdin.write(serialized)) return;
    await new Promise<void>((resolve, reject) => {
      child.stdin!.once("drain", resolve);
      child.stdin!.once("error", reject);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.beginClose();
  }

  private beginClose(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const child = this.child;
    this.child = null;
    this.pendingLength = 0;
    if (!child) return Promise.resolve();
    child.stdout?.off("data", this.onStdoutData);
    child.stdout?.off("error", this.onStdoutError);
    child.stdin?.off("error", this.onStdinError);
    this.closePromise = terminateChild(child).finally(() => {
      this.closePromise = null;
    });
    return this.closePromise;
  }
}

async function terminateChild(child: ChildProcess): Promise<void> {
  child.stdin?.end();
  if (await waitForChildExit(child, 100)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 500)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child, 500);
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
  });
}
