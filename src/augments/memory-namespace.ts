const MAX_NAMESPACE_BYTES = 256;

export interface CanonicalMemoryNamespace {
  /** Canonical operator-facing namespace without the label delimiter. */
  namespace: string;
  /** Existing public label prefix. */
  prefix: string;
  /** Collision-free, collation-independent storage ownership key. */
  key: string;
}

/**
 * Canonicalize a memory namespace once for both public labels and storage
 * authorization. A single trailing colon remains an accepted alias for the
 * historical prefix-shaped configuration form.
 */
export function canonicalMemoryNamespace(
  value: string,
  owner = "memory",
): CanonicalMemoryNamespace {
  if (typeof value !== "string") {
    throw new Error(`${owner}: namespace must be a string`);
  }
  const trimmed = value.trim().normalize("NFC");
  const namespace = trimmed.endsWith(":") ? trimmed.slice(0, -1) : trimmed;
  const bytes = Buffer.byteLength(namespace, "utf8");
  if (!namespace || namespace.includes("\0") || bytes > MAX_NAMESPACE_BYTES) {
    throw new Error(`${owner}: namespace must contain 1 to ${MAX_NAMESPACE_BYTES} UTF-8 bytes`);
  }
  return {
    namespace,
    prefix: `${namespace}:`,
    key: `v1.${Buffer.from(namespace, "utf8").toString("base64url")}`,
  };
}
