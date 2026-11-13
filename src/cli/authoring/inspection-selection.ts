/** Existing config/name precedence, using only bounded raw-document snapshots. */
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { VALID_NAME_RE } from "../agent-name";
import type { AuthoringDocument } from "./contracts";
import { readAuthoringDocument } from "./document";
import { AuthoringError } from "./document-io";
import { safeNavigation } from "./inspection-safety";

function boundedPath(path: string): string {
  if (safeNavigation(path, "") !== path) {
    throw new AuthoringError(
      "invalid-config-path",
      "Select a bounded filesystem configuration path without control characters.",
    );
  }
  return path;
}

export function selectInspectionDocument(
  name: string | undefined,
  configFlag?: string,
  options: { readonly cwd?: string } = {},
): AuthoringDocument {
  // An explicit config wins, including when the positional name is unrelated.
  if (configFlag) return readAuthoringDocument(boundedPath(resolve(configFlag)));
  if (name !== undefined && (!VALID_NAME_RE.test(name) || safeNavigation(name, "") !== name)) {
    throw new AuthoringError(
      "invalid-agent-name",
      "Use letters, digits, hyphens and underscores for the agent name.",
    );
  }
  const cwd = options.cwd ?? process.cwd();
  const local = boundedPath(resolve(cwd, "agent.yaml"));
  let localExists = false;
  try {
    lstatSync(local);
    localExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AuthoringError(
        "unreadable-config",
        "Cannot inspect the local configuration; review its permissions.",
      );
    }
  }
  if (localExists) {
    const document = readAuthoringDocument(local);
    if (name && (typeof document.value.name !== "string" || document.value.name.trim() !== name)) {
      throw new AuthoringError(
        "agent-name-mismatch",
        "The local configuration names a different agent; select the requested directory or pass --config explicitly.",
        { path: local, field: "/name" },
      );
    }
    return document;
  }
  if (!name) {
    throw new AuthoringError(
      "missing-config",
      "Run inside an agent project, pass an agent name, or select --config explicitly.",
      { path: local },
    );
  }
  return readAuthoringDocument(boundedPath(resolve(cwd, name, "agent.yaml")));
}
