const MAX_NAMESPACE_BYTES = 256;

export interface CanonicalMemoryNamespace {
  /** Canonical operator-facing namespace without the label delimiter. */
  namespace: string;
  /** Existing public label prefix. */
  prefix: string;
  /** Collision-free, collation-independent storage ownership key. */
  key: string;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
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
  if (!isWellFormedUnicode(value)) {
    throw new Error(`${owner}: namespace must contain well-formed Unicode`);
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
