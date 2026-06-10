import { describe, expect, test } from "bun:test";
import { withBrailleSpinner, type SpinnerStream } from "../../src/cli/spinner";

describe("withBrailleSpinner", () => {
  test("renders braille frames on TTY streams and clears the line", async () => {
    const writes: string[] = [];
    const stream: SpinnerStream = {
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk);
      },
    };

    const result = await withBrailleSpinner("Starting Railway build", async () => "ok", {
      stream,
      intervalMs: 1_000,
    });

    expect(result).toBe("ok");
    expect(writes[0]).toContain("⠋ Starting Railway build...");
    expect(writes.at(-1)).toBe("\r\x1b[2K");
  });

  test("does not write control characters for non-TTY streams", async () => {
    const writes: string[] = [];
    const stream: SpinnerStream = {
      isTTY: false,
      write(chunk: string) {
        writes.push(chunk);
      },
    };

    await withBrailleSpinner("Pushing env vars", async () => undefined, { stream });

    expect(writes).toEqual([]);
  });

  test("can print success text after clearing a TTY spinner", async () => {
    const writes: string[] = [];
    const stream: SpinnerStream = {
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk);
      },
    };

    await withBrailleSpinner("Starting Railway build", async () => undefined, {
      stream,
      intervalMs: 1_000,
      successText: "✔ Build started",
    });

    expect(writes.at(-2)).toBe("\r\x1b[2K");
    expect(writes.at(-1)).toBe("✔ Build started\n");
  });

  test("can print failure text after clearing a TTY spinner", async () => {
    const writes: string[] = [];
    const stream: SpinnerStream = {
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk);
      },
    };

    await expect(
      withBrailleSpinner(
        "Starting Railway build",
        async () => {
          throw new Error("boom");
        },
        {
          stream,
          intervalMs: 1_000,
          failureText: "✖ Starting Railway build",
        },
      ),
    ).rejects.toThrow("boom");

    expect(writes.at(-2)).toBe("\r\x1b[2K");
    expect(writes.at(-1)).toBe("✖ Starting Railway build\n");
  });
});
