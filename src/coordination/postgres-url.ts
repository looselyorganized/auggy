import { SQL } from "bun";

const REDACTED_URL_ERROR = "PostgreSQL coordination URL is invalid";
const CONNECTION_OVERRIDE_PARAMETERS = new Set([
  "host",
  "hostname",
  "port",
  "service",
  "servicefile",
  "socket",
  "unix_socket",
]);

function invalidUrl(): Error {
  return new Error(REDACTED_URL_ERROR);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function isLiteralLoopback(hostname: string): boolean {
  if (hostname === "::1") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

function isLocalhostOrLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || isLiteralLoopback(normalized);
}

/**
 * Validate a secret-bearing PostgreSQL URL without ever including it in an
 * error. Remote coordination databases must use verified TLS; Bun's default
 * `sslmode=prefer` can otherwise downgrade to plaintext.
 */
export function assertSecurePostgresCoordinationUrl(value: string): void {
  if (value !== value.trim() || hasControlCharacter(value)) throw invalidUrl();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidUrl();
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw invalidUrl();
  if (url.hostname.length === 0) throw invalidUrl();
  if (url.hash.length > 0) throw invalidUrl();

  let sslMode: string | undefined;
  for (const [key, parameterValue] of url.searchParams) {
    const normalizedKey = key.toLowerCase();
    if (CONNECTION_OVERRIDE_PARAMETERS.has(normalizedKey)) throw invalidUrl();
    if (normalizedKey === "sslmode") {
      // A case-varied key can conceal a duplicate from URL parsers with
      // different normalization rules. The one canonical spelling is policy.
      if (key !== "sslmode" || sslMode !== undefined) throw invalidUrl();
      sslMode = parameterValue;
      continue;
    }
    // Do not accept competing TLS controls such as ssl, tls, sslrootcert, or
    // case variants. `sslmode` is the single policy-bearing input.
    if (normalizedKey.startsWith("ssl") || normalizedKey.startsWith("tls")) {
      throw invalidUrl();
    }
  }

  if (!isLocalhostOrLoopback(url.hostname) && sslMode !== "verify-full") {
    throw invalidUrl();
  }
}

/** Construct a client only after the URL has crossed the TLS policy boundary. */
export function createSecurePostgresCoordinationClient(url: string): SQL {
  assertSecurePostgresCoordinationUrl(url);
  try {
    return new SQL(url);
  } catch {
    throw invalidUrl();
  }
}
