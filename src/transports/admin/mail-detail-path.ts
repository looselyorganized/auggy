const SAFE_RESOURCE_KINDS = new Set(["reviews", "messages"]);

/**
 * Accept only canonical creator-authenticated AgentMail detail routes:
 * `/agentmail/{reviews|messages}/<id>` for the legacy instance, or
 * `/agentmail/<instance>/{reviews|messages}/<id>` for explicit instances.
 *
 * This validator is shared by the Console bundle and its server-side proxy.
 * Keeping the allowlist path-shaped (rather than accepting an arbitrary URL)
 * prevents the proxy from becoming an authenticated SSRF primitive.
 */
export function isSafeMailDetailPath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 1_024 ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\") ||
    hasControlCharacter(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  if (segments[0] !== "" || segments[1] !== "agentmail") return false;
  if (segments.length === 4) {
    return SAFE_RESOURCE_KINDS.has(segments[2] ?? "") && isCanonicalSegment(segments[3], 256);
  }
  if (segments.length === 5) {
    return (
      isCanonicalSegment(segments[2], 128) &&
      SAFE_RESOURCE_KINDS.has(segments[3] ?? "") &&
      isCanonicalSegment(segments[4], 256)
    );
  }
  return false;
}

function isCanonicalSegment(raw: string | undefined, max: number): boolean {
  if (!raw || raw.length > max * 3) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return false;
  }
  return (
    decoded.length > 0 &&
    decoded.length <= max &&
    decoded !== "." &&
    decoded !== ".." &&
    !decoded.includes("%") &&
    !decoded.includes("/") &&
    !decoded.includes("\\") &&
    !hasControlCharacter(decoded) &&
    encodeURIComponent(decoded) === raw
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
