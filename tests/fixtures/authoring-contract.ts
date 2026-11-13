/** Compile-only consumer of the frozen CLI-local boundary; never boots an agent. */
import type {
  ApplicationScaffoldPlan,
  AuthoringDocument,
  DocumentEdit,
  DocumentOperations,
  InspectionReport,
  InstalledSourceIndex,
  PublicationOperations,
  PublicationResult,
} from "../../src/cli/authoring/contracts";

export function authoringContractConsumer(
  document: AuthoringDocument,
  documents: DocumentOperations,
  publication: PublicationOperations,
): PublicationResult {
  documents.assertInlineAuthoring(document);
  const activation = documents.editAuthoringDocument(document, [
    {
      kind: "append-augment",
      entry: {
        name: "orders",
        type: "custom",
        source: "./src/augments/orders/index.ts",
        options: { enabled: false, count: 0, label: null, references: ["${TOKEN}"] },
      },
    },
  ]);
  const plan = documents.createMutationPlan({
    kind: "augment-create",
    projectDir: document.projectDir,
    configRelativePath: "agent.yaml",
    inputs: document.inputs,
    files: [activation],
    summary: [{ path: "agent.yaml", operation: "replace", reason: "Register custom augment" }],
  });
  const lease = publication.acquireProjectMutationLease(document.projectDir);
  try {
    const result = publication.publishMutationPlan(plan, { lease });
    if (result.status === "recovery-required" && result.activation !== "original") {
      // A credential caller must preserve its verified env postimage in this case.
      return result;
    }
    return result;
  } finally {
    lease.release();
  }
}

export function applicationTemplateContract(plan: ApplicationScaffoldPlan): 1 {
  const entrypoint: "./src/index.ts" = plan.application.entrypoint;
  void entrypoint;
  return plan.application.contractVersion;
}

export const sourceIndexContract = {
  schemaVersion: 1,
  runtime: {
    application: "src/application/runner.ts",
    host: "src/application/host.ts",
    turn: "src/kernel/turn-session.ts",
  },
  augments: [{ type: "webTransport", entrypoint: "src/transports/web-transport.ts" }],
} satisfies InstalledSourceIndex;

export const partialInspectionContract = {
  schemaVersion: 1,
  status: "partial",
  inspector: { version: "0.5.0" },
  project: {
    configPath: "/agent/agent.yaml",
    format: "inline",
    name: "support",
    identity: { value: null, environmentNames: ["AUGGY_AGENT_ID"] },
  },
  application: { mode: "legacy", entrypoint: null, contractVersion: null, source: null },
  runtime: {
    status: "unavailable",
    packageRoot: null,
    version: null,
    manifestSHA256: null,
    applicationSupported: null,
  },
  execution: {
    basis: "conventional-project-files",
    startup: null,
    composition: null,
    http: null,
    turn: null,
    runtime: {},
  },
  augments: [],
  runtimeDiscovery: "not-evaluated",
  diagnostics: [{ code: "runtime-unavailable", message: "Install the project dependencies." }],
} satisfies InspectionReport;

// @ts-expect-error Authoring is not an arbitrary file deletion or JSON patch API.
export const forbiddenDelete: DocumentEdit = { kind: "delete", path: ".env" };
