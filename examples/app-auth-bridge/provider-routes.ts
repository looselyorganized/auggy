import { mintAuggyAssertionForUser, type MintAuggyAssertionOptions } from "./auth-assertions";
import type { VerifiedAppSession } from "./app-policy";

interface SupabaseUser {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  app_metadata: Record<string, unknown>;
}

export interface SupabaseAuthAdapter {
  auth: {
    getUser(accessToken: string): Promise<{
      data: { user: SupabaseUser | null };
      error?: unknown;
    }>;
  };
}

interface ClerkSession {
  isAuthenticated: boolean;
  userId?: string | null;
  orgId?: string | null;
  orgRole?: string | null;
}

interface ClerkUser {
  primaryEmailAddress?: {
    emailAddress: string;
    verification?: { status?: string | null } | null;
  } | null;
}

export interface ClerkAuthAdapter {
  auth(): Promise<ClerkSession> | ClerkSession;
  currentUser(): Promise<ClerkUser | null> | ClerkUser | null;
}

export interface AppAuthBridgeRouteOptions {
  assertion: MintAuggyAssertionOptions;
}

export function createSupabaseAuggyAssertionHandler(
  supabase: SupabaseAuthAdapter,
  opts: AppAuthBridgeRouteOptions,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const accessToken = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!accessToken) return Response.json({ error: "unauthorized" }, { status: 401 });

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(accessToken);
    if (error || !user) return Response.json({ error: "unauthorized" }, { status: 401 });

    const session: VerifiedAppSession = {
      provider: "supabase",
      userId: user.id,
      email: user.email,
      emailVerified: user.email_confirmed_at != null,
      orgId: stringOrUndefined(user.app_metadata.org_id),
      roles: stringArray(user.app_metadata.roles),
    };

    const { assertion } = await mintAuggyAssertionForUser(session, opts.assertion);
    return Response.json({ assertion });
  };
}

export function createClerkAuggyAssertionHandler(
  clerk: ClerkAuthAdapter,
  opts: AppAuthBridgeRouteOptions,
): () => Promise<Response> {
  return async () => {
    const session = await clerk.auth();
    if (!session.isAuthenticated || !session.userId) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const user = await clerk.currentUser();
    const sessionForAuggy: VerifiedAppSession = {
      provider: "clerk",
      userId: session.userId,
      email: user?.primaryEmailAddress?.emailAddress,
      emailVerified: user?.primaryEmailAddress?.verification?.status === "verified",
      orgId: session.orgId ?? undefined,
      roles: session.orgRole ? [session.orgRole] : [],
    };

    const { assertion } = await mintAuggyAssertionForUser(sessionForAuggy, opts.assertion);
    return Response.json({ assertion });
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
