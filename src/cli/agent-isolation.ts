const AUGGY_AGENT_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertImmutableAgentId(agentId: string): string {
  if (!AUGGY_AGENT_ID_RE.test(agentId)) {
    throw new Error("[agent-isolation] agentId must be a valid aug1_ UUID");
  }
  return agentId;
}

export function scopedAgentNamespace(
  agentId: string | undefined,
  configuredNamespace: string | undefined,
  fallback: string,
): string {
  const localNamespace = (configuredNamespace ?? fallback).trim();
  if (!localNamespace || localNamespace.includes("\0")) {
    throw new Error("[agent-isolation] state namespace must be a non-empty string");
  }
  if (!agentId) return localNamespace;

  const immutableId = assertImmutableAgentId(agentId);
  if (localNamespace === immutableId || localNamespace.startsWith(`${immutableId}:`)) {
    return localNamespace;
  }
  return `${immutableId}:${localNamespace}`;
}
