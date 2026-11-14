import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  EXTERNAL_AUTH_REPLAY_GUARD_FILE,
  EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE,
} from "./external-auth-replay-contracts";

const reserved = [
  EXTERNAL_AUTH_REPLAY_GUARD_FILE,
  EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE,
  ".auggy-state-identity.json",
  ".auggy-restore-fence.json",
  ".auggy-runtime-singleton.lock",
];
const collator = new Intl.Collator("und", { usage: "search", sensitivity: "base" });

/** Inspect the original spelling before a resolver can turn a URI into a filename. */
export function isManagedReplayFilePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    value !== ":memory:" &&
    !/^(?:file|sqlite):/i.test(value)
  );
}

/** Pure preflight: never create parents beneath an agent control file. */
export function assertManagedReplayPathWithinRoot(path: string, root: string): void {
  const fromRoot = relative(resolve(root), resolve(path));
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("[external-auth-replay] dbPath must stay within its runtime data root");
  }
  const first = fromRoot.split(sep)[0]!;
  if (reserved.some((leaf) => collator.compare(first, leaf) === 0)) {
    throw new Error("[external-auth-replay] dbPath conflicts with a reserved runtime control path");
  }
}
