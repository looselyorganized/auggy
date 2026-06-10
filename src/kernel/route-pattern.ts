export interface RoutePattern {
  isPattern: boolean;
  shape: string;
  params: readonly string[];
}

const PARAM_SEGMENT_RE = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

export function parseRoutePattern(path: string):
  | { ok: true; pattern: RoutePattern }
  | {
      ok: false;
      error: string;
    } {
  if (!path.startsWith("/")) {
    return { ok: false, error: "path must start with '/'" };
  }

  const params: string[] = [];
  const seenParams = new Set<string>();
  const shapeSegments: string[] = [];
  const segments = path.split("/").slice(1);

  for (const segment of segments) {
    if (segment.includes("*")) {
      return { ok: false, error: "wildcard route segments are not supported" };
    }

    if (!segment.includes(":")) {
      shapeSegments.push(segment);
      continue;
    }

    const match = segment.match(PARAM_SEGMENT_RE);
    if (!match) {
      return {
        ok: false,
        error: `invalid path parameter segment "${segment}" — parameters must be full segments like ":id"`,
      };
    }

    const paramName = match[1]!;
    if (seenParams.has(paramName)) {
      return {
        ok: false,
        error: `duplicate path parameter "${paramName}"`,
      };
    }
    seenParams.add(paramName);
    params.push(paramName);
    shapeSegments.push(":");
  }

  return {
    ok: true,
    pattern: {
      isPattern: params.length > 0,
      shape: `/${shapeSegments.join("/")}`,
      params: Object.freeze(params),
    },
  };
}

export function matchRoutePath(
  patternPath: string,
  pathname: string,
): Record<string, string> | null {
  const parsed = parseRoutePattern(patternPath);
  if (!parsed.ok) return null;

  if (!parsed.pattern.isPattern) {
    return patternPath === pathname ? {} : null;
  }

  const patternSegments = patternPath.split("/").slice(1);
  const pathSegments = pathname.split("/").slice(1);
  if (patternSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i]!;
    const pathSegment = pathSegments[i]!;
    const paramMatch = patternSegment.match(PARAM_SEGMENT_RE);

    if (!paramMatch) {
      if (patternSegment !== pathSegment) return null;
      continue;
    }

    if (pathSegment.length === 0) return null;
    try {
      params[paramMatch[1]!] = decodeURIComponent(pathSegment);
    } catch {
      return null;
    }
  }

  return params;
}

export function routePatternsOverlap(a: string, b: string): boolean {
  const parsedA = parseRoutePattern(a);
  const parsedB = parseRoutePattern(b);
  if (!parsedA.ok || !parsedB.ok) return false;
  if (!parsedA.pattern.isPattern || !parsedB.pattern.isPattern) return false;

  const aSegments = a.split("/").slice(1);
  const bSegments = b.split("/").slice(1);
  if (aSegments.length !== bSegments.length) return false;

  for (let i = 0; i < aSegments.length; i++) {
    const aSegment = aSegments[i]!;
    const bSegment = bSegments[i]!;
    const aIsParam = PARAM_SEGMENT_RE.test(aSegment);
    const bIsParam = PARAM_SEGMENT_RE.test(bSegment);

    if (!aIsParam && !bIsParam && aSegment !== bSegment) {
      return false;
    }
  }

  return true;
}

export function joinRoutePaths(prefix: string, path: string): string {
  if (!prefix.startsWith("/")) {
    throw new Error(`route group prefix "${prefix}" must start with '/'`);
  }
  if (!path.startsWith("/")) {
    throw new Error(`route path "${path}" must start with '/'`);
  }

  if (prefix === "/") return path;
  if (path === "/") return prefix.replace(/\/+$/, "") || "/";
  return `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
