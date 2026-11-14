import "server-only";
import { privateJson, requireHttpOrigin } from "@/server/assertion-response";

export const dynamic = "force-dynamic";

/** Only the public destination leaves the server; it can change without a rebuild. */
export function GET(): Response {
  try {
    return privateJson({ agentOrigin: requireHttpOrigin(process.env.AUGGY_AGENT_URL) });
  } catch {
    return privateJson({ error: "agent_configuration_unavailable" }, 503);
  }
}
