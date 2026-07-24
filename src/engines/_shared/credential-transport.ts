export interface CredentialTransportPolicy {
  provider: string;
  baseURL: string;
  credential?: string;
  allowInsecureHttpWithCredentials?: boolean;
  nodeEnv?: string;
  warn?: (message: string) => void;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isIpv4Loopback(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
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
export function assertSecureCredentialTransport(policy: CredentialTransportPolicy): void {
  let url: URL;
  try {
    url = new URL(policy.baseURL);
  } catch {
    throw new Error(`${policy.provider} baseURL must be a valid absolute HTTP(S) URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${policy.provider} baseURL must be a valid absolute HTTP(S) URL.`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${policy.provider} baseURL must not contain embedded credentials.`);
  }

  const credentialAttached = policy.credential !== undefined && policy.credential.length > 0;
  if (url.protocol !== "http:" || !credentialAttached || isLoopbackProviderHostname(url.hostname)) {
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
    `${policy.provider} refuses to send credentials over non-loopback plaintext HTTP. Use HTTPS or a loopback tunnel.`,
  );
}
