import { createExternalAuthAssertion, type AuthorizationGrant, type AuthorizationScope } from "auggy";
import { deriveAuggyAuthorization, type VerifiedAppSession } from "./app-policy";

export interface MintAuggyAssertionOptions {
  secret: string;
  keyId?: string;
  audience: string;
  ttlSeconds?: number;
  authzVersion: string;
  now?: number;
  jti?: string;
}

export interface MintedAuggyAuthorization {
  scopes: readonly AuthorizationScope[];
  grants: readonly AuthorizationGrant[];
}

export async function mintAuggyAssertionForUser(
  session: VerifiedAppSession,
  opts: MintAuggyAssertionOptions,
): Promise<{ assertion: string; authorization: MintedAuggyAuthorization }> {
  const authorization = await deriveAuggyAuthorization(session);

  return {
    assertion: createExternalAuthAssertion({
      secret: opts.secret,
      keyId: opts.keyId,
      audience: opts.audience,
      provider: session.provider,
      subject: session.userId,
      ttlSeconds: opts.ttlSeconds ?? 60,
      now: opts.now,
      email: session.email,
      emailVerified: session.emailVerified,
      orgId: session.orgId,
      roles: session.roles,
      scopes: authorization.scopes,
      grants: authorization.grants,
      authzVersion: opts.authzVersion,
      jti: opts.jti ?? crypto.randomUUID(),
    }),
    authorization,
  };
}
