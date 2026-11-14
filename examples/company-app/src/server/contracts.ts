import type { AuthorizationGrant, AuthorizationScope } from "auggy";

/** Application-owned identity returned only by its trusted server-side verifier. */
export interface VerifiedAppSession {
  provider: string;
  userId: string;
  email?: string;
  emailVerified?: boolean;
  orgId?: string;
  roles: readonly string[];
}

export interface VerifiedSessionAdapter {
  verify(request: Request): Promise<VerifiedAppSession | null>;
}

/** Business authority is derived separately from authentication. */
export interface DerivedAuggyAuthorization {
  scopes: readonly AuthorizationScope[];
  grants: readonly AuthorizationGrant[];
  authzVersion: string;
}

export interface AuggyAuthorizationPolicy {
  derive(session: VerifiedAppSession): Promise<DerivedAuggyAuthorization>;
}

export const REFERENCE_ASSERTION_TTL_SECONDS = 60;
