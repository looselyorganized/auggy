import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";
import { parseConfig } from "../config-parser";
import { createTypeScriptClient, type TypeScriptClientTarget } from "../routes-client";
import { createOpenApiDocument } from "../routes-openapi";
import { resolveConfigPath } from "../resolve-config";
import { inspectAugmentRoutes } from "../route-inspector";
import type { RouteManifestEntry, RouteManifestSummary } from "../../kernel/route-manifest";

export interface RoutesOptions {
  config?: string;
  auggyDir?: string;
  cwd?: string;
}

export interface RoutesReport {
  agent: {
    name: string;
    configPath: string;
  };
  summary: RouteManifestSummary;
  routes: readonly RouteManifestEntry[];
}

export interface RoutesCommandDeps {
  runRoutes?: (name: string | undefined, opts: RoutesOptions) => Promise<RoutesReport>;
  exit?: (code: number) => void;
  auggyDir?: string;
  cwd?: string;
}

export async function runRoutes(
  name: string | undefined,
  opts: RoutesOptions = {},
): Promise<RoutesReport> {
  const configPath = resolveConfigPath(name, opts.config, {
    auggyDir: opts.auggyDir,
    cwd: opts.cwd,
  });
  const config = parseConfig(configPath);
  const inspected = await inspectAugmentRoutes(dirname(configPath), config.augments);

  if (inspected.issues.length > 0) {
    throw new Error(
      [
        "Could not inspect routes:",
        ...inspected.issues.map((issue) => `  - ${issue.message}`),
      ].join("\n"),
    );
  }

  return {
    agent: {
      name: config.name,
      configPath,
    },
    summary: inspected.summary,
    routes: inspected.manifest,
  };
}

export function formatRoutesReport(report: RoutesReport): string {
  const lines = [`Routes for ${report.agent.name}`, ""];

  if (report.routes.length === 0) {
    lines.push("No augment routes found.");
    return lines.join("\n");
  }

  lines.push(
    `${report.summary.publicRoutes > 0 ? "WARN" : "PASS"} route posture: ${
      report.summary.totalRoutes
    } route(s): ${report.summary.publicRoutes} public, ${report.summary.privateRoutes} private`,
    "",
  );

  const rows = report.routes.map((route) => ({
    method: route.method,
    path: route.path,
    augment: route.augmentName,
    access: route.public ? "PUBLIC" : "PRIVATE",
    auth: `auth=${route.auth}`,
    params: `params=${route.params.length > 0 ? route.params.join(",") : "-"}`,
  }));
  const methodWidth = Math.max(...rows.map((row) => row.method.length));
  const pathWidth = Math.max(...rows.map((row) => row.path.length));
  const augmentWidth = Math.max(...rows.map((row) => row.augment.length));
  const accessWidth = Math.max(...rows.map((row) => row.access.length));

  lines.push(
    ...rows.map(
      (row) =>
        `${row.method.padEnd(methodWidth)}  ${row.path.padEnd(pathWidth)}  ${row.augment.padEnd(
          augmentWidth,
        )}  ${row.access.padEnd(accessWidth)}  ${row.auth}  ${row.params}`,
    ),
  );

  return lines.join("\n");
}

export function routesCommand(deps: RoutesCommandDeps = {}): Command {
  const run = deps.runRoutes ?? runRoutes;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  return new Command("routes")
    .description("Show HTTP routes registered by an agent")
    .argument("[name]", "agent name")
    .option("--config <path>", "path to agent.yaml")
    .option("--json", "print the route manifest as JSON")
    .option("--openapi", "print an OpenAPI 3.1 document as JSON")
    .option("--client <format>", "print a generated route client (currently: ts)")
    .option("--target <target>", "generated client target: browser or server (default: browser)")
    .option("--out <path>", "write generated client output to a file")
    .action(
      async (
        name: string | undefined,
        opts: {
          config?: string;
          json?: boolean;
          openapi?: boolean;
          client?: string;
          target?: string;
          out?: string;
        },
      ) => {
        try {
          const outputModes = [opts.json, opts.openapi, opts.client !== undefined].filter(Boolean);
          if (outputModes.length > 1) {
            throw new Error("Choose only one of --json, --openapi, or --client.");
          }
          if (opts.client !== undefined && opts.client !== "ts") {
            throw new Error(`Unsupported client format "${opts.client}". Supported formats: ts.`);
          }
          if (opts.target !== undefined && opts.client === undefined) {
            throw new Error("--target currently requires --client ts.");
          }
          if (opts.out !== undefined && opts.client === undefined) {
            throw new Error("--out currently requires --client ts.");
          }
          const clientTarget = resolveClientTarget(opts.target);
          const report = await run(name, {
            config: opts.config,
            auggyDir: deps.auggyDir,
            cwd: deps.cwd,
          });
          const output =
            opts.client === "ts"
              ? createTypeScriptClient(report, { target: clientTarget })
              : opts.openapi
                ? JSON.stringify(createOpenApiDocument(report), null, 2)
                : opts.json
                  ? JSON.stringify(report, null, 2)
                  : formatRoutesReport(report);

          if (opts.out) {
            mkdirSync(dirname(opts.out), { recursive: true });
            writeFileSync(opts.out, output.endsWith("\n") ? output : `${output}\n`);
            console.log(`Wrote TypeScript client to ${opts.out}`);
          } else {
            console.log(output);
          }
          exit(0);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          exit(1);
        }
      },
    );
}

function resolveClientTarget(target: string | undefined): TypeScriptClientTarget {
  if (target === undefined) return "browser";
  if (target === "browser" || target === "server") return target;
  throw new Error(`Unsupported client target "${target}". Supported targets: browser, server.`);
}
