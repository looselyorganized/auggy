import type { ChatThreadSummary } from "./chat-workspace";

/**
 * Reconcile a server list response with local mutations that landed while the
 * request was in flight. Changed identities keep their current presence and
 * value; unchanged identities accept the server snapshot.
 */
export function reconcileChatSummarySnapshot(
  serverSummaries: readonly ChatThreadSummary[],
  currentSummaries: readonly ChatThreadSummary[],
  revisionsBefore: ReadonlyMap<string, number>,
  revisionsNow: ReadonlyMap<string, number>,
): ChatThreadSummary[] {
  assertUniqueSummaryIds(serverSummaries, "serverSummaries");
  assertUniqueSummaryIds(currentSummaries, "currentSummaries");

  const currentById = new Map(currentSummaries.map((summary) => [summary.id, summary]));
  const serverIds = new Set(serverSummaries.map((summary) => summary.id));
  const reconciled: ChatThreadSummary[] = [];

  for (const serverSummary of serverSummaries) {
    if (!revisionChanged(serverSummary.id, revisionsBefore, revisionsNow)) {
      reconciled.push(serverSummary);
      continue;
    }
    const current = currentById.get(serverSummary.id);
    if (current) reconciled.push(current);
  }

  for (const current of currentSummaries) {
    if (
      !serverIds.has(current.id) &&
      revisionChanged(current.id, revisionsBefore, revisionsNow)
    ) {
      reconciled.push(current);
    }
  }

  return reconciled;
}

function revisionChanged(
  threadId: string,
  revisionsBefore: ReadonlyMap<string, number>,
  revisionsNow: ReadonlyMap<string, number>,
): boolean {
  return (revisionsBefore.get(threadId) ?? 0) !== (revisionsNow.get(threadId) ?? 0);
}

function assertUniqueSummaryIds(
  summaries: readonly Pick<ChatThreadSummary, "id">[],
  label: string,
): void {
  const ids = new Set<string>();
  for (const summary of summaries) {
    if (ids.has(summary.id)) {
      throw new Error(`Duplicate chat thread summary ID in ${label}: ${summary.id}`);
    }
    ids.add(summary.id);
  }
}
