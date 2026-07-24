import { isIP } from "node:net";

export interface CredentialTransportPolicy {
  provider: string;
  baseURL: string;
  credential?: unknown;
  allowInsecureHttpWithCredentials?: boolean;
  nodeEnv?: string;
  warn?: (message: string) => void;
}

interface CredentialUrlProtocols {
  secure: "https:" | "wss:";
  insecure: "http:" | "ws:";
  label: "baseURL" | "websocketBaseURL";
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isIpv4Loopback(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const octets = hostname.split(".");
  const first = Number(octets[0]);
  return Number.isInteger(first) && first === 127;
}

function isMappedIpv4Loopback(hostname: string): boolean {
  if (!hostname.startsWith("::ffff:")) return false;
  const mapped = hostname.slice("::ffff:".length);
  if (isIpv4Loopback(mapped)) return true;

  const words = mapped.split(":");
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) {
    return false;
  }
  const highWord = Number.parseInt(words[0]!, 16);
  return highWord >> 8 === 127;
}

export function isLoopbackProviderHostname(rawHostname: string): boolean {
  const hostname = stripIpv6Brackets(rawHostname).toLowerCase().replace(/\.$/, "");
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    isIpv4Loopback(hostname) ||
    isMappedIpv4Loopback(hostname)
  );
}

/**
 * Prevent credentials from crossing a plaintext network boundary.
 *
 * Errors intentionally identify only the provider and policy failure. They
 * never include the raw URL, whose userinfo, query, or path can contain
 * credentials.
 */
function assertSecureCredentialUrl(
  policy: CredentialTransportPolicy,
  protocols: CredentialUrlProtocols,
): void {
  const protocolLabel = protocols.secure === "https:" ? "HTTP(S)" : "WebSocket (WS/WSS)";
  let url: URL;
  try {
    url = new URL(policy.baseURL);
  } catch {
    throw new Error(
      `${policy.provider} ${protocols.label} must be a valid absolute ${protocolLabel} URL.`,
    );
  }

  if (url.protocol !== protocols.secure && url.protocol !== protocols.insecure) {
    throw new Error(
      `${policy.provider} ${protocols.label} must be a valid absolute ${protocolLabel} URL.`,
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${policy.provider} ${protocols.label} must not contain embedded credentials.`);
  }

  if (policy.credential !== undefined && typeof policy.credential !== "string") {
    throw new Error(`${policy.provider} credential must be a string.`);
  }
  const credentialAttached = policy.credential !== undefined && policy.credential.length > 0;
  if (
    url.protocol !== protocols.insecure ||
    !credentialAttached ||
    isLoopbackProviderHostname(url.hostname)
  ) {
    return;
  }

  const nodeEnv = policy.nodeEnv ?? process.env.NODE_ENV;
  if (policy.allowInsecureHttpWithCredentials === true && nodeEnv === "development") {
    (policy.warn ?? console.warn)(
      `[security] ${policy.provider} is using credentialed plaintext HTTP under an explicit development-only override.`,
    );
    return;
  }

  throw new Error(
    `${policy.provider} refuses to send credentials over non-loopback plaintext ${protocols.insecure.slice(0, -1).toUpperCase()}. Use ${protocols.secure.slice(0, -1).toUpperCase()} or a loopback tunnel.`,
  );
}

export function assertSecureCredentialTransport(policy: CredentialTransportPolicy): void {
  assertSecureCredentialUrl(policy, {
    secure: "https:",
    insecure: "http:",
    label: "baseURL",
  });
}

export function assertSecureWebSocketCredentialTransport(policy: CredentialTransportPolicy): void {
  assertSecureCredentialUrl(policy, {
    secure: "wss:",
    insecure: "ws:",
    label: "websocketBaseURL",
  });
}
