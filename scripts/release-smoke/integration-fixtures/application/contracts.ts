import type {
  HashedIntegrationFile,
  IntegrationScenarioEvidence,
} from "../../integration-contracts";

/** Complete, bounded source inventory; never copy .env, .next, dependencies or fixture registries. */
export const COMPANY_APP_SOURCE_FILES = [
  "package.json",
  "bun.lock",
  ".gitignore",
  "next-env.d.ts",
  "next.config.ts",
  "postcss.config.mjs",
  "tsconfig.json",
  "tsconfig.tests.json",
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/app/globals.css",
  "src/app/auggy-theme.css",
  "src/app/api/auggy-auth-assertion/route.ts",
  "src/app/api/auggy-config/route.ts",
  "src/client/agent-run.ts",
  "src/components/support-chat.tsx",
  "src/components/ui/button.tsx",
  "src/components/ui/textarea.tsx",
  "src/lib/utils.ts",
  "src/server/assertion-handler.ts",
  "src/server/assertion-response.ts",
  "src/server/company-policy.ts",
  "src/server/composition.ts",
  "src/server/contracts.ts",
  "src/server/session-adapter.ts",
  "agent-integration/orders/contracts.ts",
  "agent-integration/orders/service-client.ts",
] as const;

export const COMPANY_APP_ADAPTER_PATH = "src/server/session-adapter.ts";
export const COMPANY_APP_FIXTURE_ADAPTER_PATH = "fixtures/session-adapter.ts.fixture";
export const COMPANY_APP_FIXTURE_MARKER = "M5_FIXTURE_AUTH_BUILD_V1";
export type CompanyAppBuildKind = "production-reference" | "fixture-auth";
export interface PreparedCompanyApp {
  directory: string;
  baselineFiles: readonly HashedIntegrationFile[];
  changes: IntegrationScenarioEvidence["changes"];
  installedFiles: readonly HashedIntegrationFile[];
  lockfile: HashedIntegrationFile;
}
export interface ApplicationLayoutObservation {
  innerWidth: number;
  clientWidth: number;
  scrollWidth: number;
  app: { left: number; right: number; width: number };
  conversation: { left: number; right: number; width: number };
}
export interface ApplicationBrowserObservation {
  version: 1;
  firstChunkBeforeTerminal: boolean;
  directAgentRequests: number;
  freshAssertionCount: number;
  stableRetryKey: boolean;
  applicationCookiesSentToAgent: boolean;
  creatorCredentialSentToAgent: boolean;
  interruptedThenCompleted: boolean;
  mobileOverflow: boolean;
  desktopOverflow: boolean;
  layout: {
    desktop: { before: ApplicationLayoutObservation; after: ApplicationLayoutObservation };
    mobile: { before: ApplicationLayoutObservation; after: ApplicationLayoutObservation };
  };
  keyboardFocusVisible: boolean;
  checks: string[];
}
