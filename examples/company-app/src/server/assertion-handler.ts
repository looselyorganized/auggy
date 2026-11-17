import { createExternalAuthAssertion } from "auggy/auth";
import {
  REFERENCE_ASSERTION_TTL_SECONDS,
  type AuggyAuthorizationPolicy,
  type VerifiedSessionAdapter,
} from "./contracts";
import { methodNotAllowed, privateJson, requireSameOriginPost } from "./assertion-response";

export interface AssertionConfiguration {
  appOrigin?: string;
  audience?: string;
  keyId?: string;
  secret?: string;
}

export function createAssertionHandler(options: {
  configuration: () => AssertionConfiguration;
  adapter: VerifiedSessionAdapter | null;
  policy: AuggyAuthorizationPolicy;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") return methodNotAllowed();
    try {
      const config = options.configuration();
      const denied = requireSameOriginPost(request, config.appOrigin);
      if (denied) return denied;
      if (!options.adapter) return privateJson({ error: "session_verifier_unconfigured" }, 503);
      if (!config.secret || !config.audience || !config.keyId) {
        return privateJson({ error: "assertion_configuration_unavailable" }, 503);
      }
      const session = await options.adapter.verify(request);
      if (!session) return privateJson({ error: "unauthorized" }, 401);
      const authorization = await options.policy.derive(session);
      const assertion = createExternalAuthAssertion({
        secret: config.secret,
        keyId: config.keyId,
        audience: config.audience,
        ttlSeconds: REFERENCE_ASSERTION_TTL_SECONDS,
        provider: session.provider,
        subject: session.userId,
        email: session.email,
        emailVerified: session.emailVerified,
        orgId: session.orgId,
        roles: session.roles,
        scopes: authorization.scopes,
        grants: authorization.grants,
        authzVersion: authorization.authzVersion,
        jti: crypto.randomUUID(),
      });
      return privateJson({ assertion });
    } catch {
      // Verifier, policy and signer failures contain no request/credential diagnostics.
      return privateJson({ error: "assertion_unavailable" }, 503);
    }
  };
}
