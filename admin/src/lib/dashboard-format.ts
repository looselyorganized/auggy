import type { DashboardData } from "@/lib/types";

export function formatModelLabel(dashboard: DashboardData | null): string | null {
  const provider = dashboard?.agentMeta?.engine?.provider;
  const model = dashboard?.agentMeta?.engine?.model;
  if (provider && model) return `${provider} / ${model}`;
  if (provider) return provider;
  if (model) return model;
  return null;
}
