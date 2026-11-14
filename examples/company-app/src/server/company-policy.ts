import type {
  AuggyAuthorizationPolicy,
  DerivedAuggyAuthorization,
  VerifiedAppSession,
} from "./contracts";

/** This lookup belongs to the company's permission service, outside Auggy. */
export interface CompanyPermissionAdapter {
  authorizationFor(session: VerifiedAppSession): Promise<DerivedAuggyAuthorization>;
}

export function createCompanyPolicy(adapter: CompanyPermissionAdapter): AuggyAuthorizationPolicy {
  return { derive: (session) => adapter.authorizationFor(session) };
}
