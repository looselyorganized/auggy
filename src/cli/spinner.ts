const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerStream {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface SpinnerOptions {
  stream?: SpinnerStream;
  intervalMs?: number;
}

export async function withBrailleSpinner<T>(
  message: string,
  run: () => Promise<T>,
  opts: SpinnerOptions = {},
): Promise<T> {
  const stream = opts.stream ?? process.stderr;
  if (!stream.isTTY) {
    return run();
  }

  let frameIndex = 0;
  const interval = setInterval(() => {
    stream.write(`\r${FRAMES[frameIndex % FRAMES.length]} ${message}...`);
    frameIndex++;
  }, opts.intervalMs ?? 80);

  stream.write(`\r${FRAMES[0]} ${message}...`);
  try {
    const result = await run();
    clearInterval(interval);
    stream.write(`\r\x1b[2K`);
    return result;
  } catch (err) {
    clearInterval(interval);
    stream.write(`\r\x1b[2K`);
    throw err;
  }
}
