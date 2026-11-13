import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ApplicationScaffoldPlan } from "./authoring/contracts";

const TEMPLATE_ROOT = resolve(import.meta.dir, "../scaffold-templates/application");
const TEMPLATE_FILES = [
  "src/index.ts",
  "src/agent.ts",
  "src/http.ts",
  "src/turn.ts",
  "src/augments/README.md",
  "tests/application.test.ts",
  "tsconfig.json",
  "README.md",
] as const;

function validateConfigFileName(name: string): void {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*\.ya?ml$/.test(name) ||
    Buffer.byteLength(name) > 255
  ) {
    throw new Error(
      "Application configuration must use a bounded YAML basename without paths or shell characters.",
    );
  }
}

export function applicationPackageFields(
  configFileName = "agent.yaml",
): ApplicationScaffoldPlan["packageFields"] {
  validateConfigFileName(configFileName);
  // The accepted basename grammar excludes quotes and shell metacharacters.
  const configArgument = /^[A-Za-z0-9._-]+$/.test(configFileName)
    ? configFileName
    : `'${configFileName}'`;
  return Object.freeze({
    type: "module",
    scripts: Object.freeze({
      start: "bun src/index.ts",
      dev: "bun src/index.ts",
      cli: `auggy dev --config ${configArgument}`,
      typecheck: "tsc --project tsconfig.json --noEmit",
      test: "bun test tests",
    }),
    devDependencies: Object.freeze({ "@types/bun": "1.3.14", typescript: "5.9.3" }),
  });
}

/** Plan owned source from packaged templates. No project writes, imports or installation. */
export function planApplicationScaffold(input: {
  readonly configFileName: string;
}): ApplicationScaffoldPlan {
  const name = input.configFileName;
  const packageFields = applicationPackageFields(name);
  const configUrl = JSON.stringify(`../${encodeURIComponent(name)}`);
  return Object.freeze({
    application: Object.freeze({ entrypoint: "./src/index.ts", contractVersion: 1 }),
    files: Object.freeze(
      TEMPLATE_FILES.map((relativePath) =>
        Object.freeze({
          relativePath,
          bytes: Buffer.from(
            readFileSync(resolve(TEMPLATE_ROOT, `${relativePath}.template`), "utf8")
              .replaceAll("{{CONFIG_URL}}", configUrl)
              .replaceAll("{{CONFIG_FILE}}", name),
          ),
          mode: 0o644,
        }),
      ),
    ),
    packageFields,
  });
}
