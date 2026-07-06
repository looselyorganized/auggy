import type { AuthorizationGrant, AuthorizationScope } from "auggy";

export type AppAuthProvider = "supabase" | "clerk";

export interface VerifiedAppSession {
  provider: AppAuthProvider;
  userId: string;
  email?: string;
  emailVerified?: boolean;
  orgId?: string;
  roles: readonly string[];
}

export interface DerivedAuggyAuthorization {
  scopes: readonly AuthorizationScope[];
  grants: readonly AuthorizationGrant[];
}

const readableOrdersByUser = new Map<string, readonly string[]>([
  ["user_123", ["order_123"]],
  ["support_123", ["order_123"]],
]);

const refundableOrdersByUser = new Map<string, readonly string[]>([
  ["support_123", ["order_123"]],
]);

export async function deriveAuggyAuthorization(
  session: VerifiedAppSession,
): Promise<DerivedAuggyAuthorization> {
  const readableOrderIds = readableOrdersByUser.get(session.userId) ?? [];
  const refundableOrderIds = refundableOrdersByUser.get(session.userId) ?? [];
  const isSupport = session.roles.includes("support");

  return {
    scopes: readableOrderIds.length > 0 ? ["orders.read"] : [],
    grants: [
      ...readableOrderIds.map((orderId) => ({
        action: "orders.read",
        resource: orderId,
      })),
      ...refundableOrderIds.map((orderId) => ({
        action: "refund.issue",
        resource: orderId,
        constraints: isSupport ? { maxAmountCents: 5000 } : undefined,
      })),
    ].map((grant) =>
      grant.constraints === undefined
        ? { action: grant.action, resource: grant.resource }
        : grant,
    ),
  };
}
