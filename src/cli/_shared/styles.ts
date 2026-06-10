export interface CliStyleOptions {
  color?: boolean;
}

function shouldColor(opts: CliStyleOptions): boolean {
  return opts.color ?? Boolean(process.stdout.isTTY);
}

function ansi(code: number, value: string, opts: CliStyleOptions): string {
  return shouldColor(opts) ? `\x1b[${code}m${value}\x1b[0m` : value;
}

export function successMark(opts: CliStyleOptions = {}): string {
  return ansi(32, "✔", opts);
}

export function failureMark(opts: CliStyleOptions = {}): string {
  return ansi(31, "✖", opts);
}

export function warningLabel(opts: CliStyleOptions = {}): string {
  return ansi(33, "WARN", opts);
}
