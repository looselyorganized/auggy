/**
 * Placeholder for `auggy visitors --revoke <email>`. Implementation lands in Task 16.
 */
export interface VisitorsRevokeOptions {
  auggyDir?: string;
  confirm?: boolean;
}

export async function runVisitorsRevoke(
  _agentName: string,
  _email: string,
  _opts: VisitorsRevokeOptions = {},
): Promise<void> {
  throw new Error("auggy visitors --revoke: not yet implemented (Task 16)");
}
