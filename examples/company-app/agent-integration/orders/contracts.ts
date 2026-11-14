import type { AuthorizationGrant, AuthorizationScope } from "auggy/auth";

export interface CompanySubject {
  provider: string;
  userId: string;
  orgId?: string;
  roles: readonly string[];
}

export interface CompanyAuthorization {
  scopes: readonly AuthorizationScope[];
  grants: readonly AuthorizationGrant[];
  authzVersion: string;
}

export interface OrderPrincipal {
  provider: string;
  subject: string;
  orgId?: string;
  grants: readonly AuthorizationGrant[];
  authzVersion: string;
}

export interface OrderRecord {
  id: string;
  status: "processing" | "shipped";
  item: string;
  totalCents: number;
  privateNote: string;
}

export interface RefundSimulation {
  simulationId: string;
  orderId: string;
  amountCents: number;
  simulated: true;
}

/** Replace this adapter with your existing business service, retaining authorization. */
export interface OrdersService {
  authorizationFor(subject: CompanySubject): Promise<CompanyAuthorization>;
  read(principal: OrderPrincipal, orderId: string, signal?: AbortSignal): Promise<OrderRecord>;
  simulateRefund(
    principal: OrderPrincipal,
    input: {
      orderId: string;
      amountCents: number;
      reason: string;
      operationId: string;
    },
    signal?: AbortSignal,
  ): Promise<RefundSimulation>;
}
