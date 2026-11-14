import "server-only";
import type { VerifiedSessionAdapter } from "./contracts";

/**
 * Replace this composition with your application's trusted server-side session
 * verifier. Return canonical identity/roles from that verifier, never request JSON
 * or an unsigned identity cookie. null deliberately disables assertion issuance.
 */
export const sessionAdapter: VerifiedSessionAdapter | null = null;
