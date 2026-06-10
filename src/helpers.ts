import { z } from "zod";
import type {
  Augment,
  AugmentHttpRoute,
  AugmentHttpRouteAuth,
  HttpMethod,
  Tool,
  ToolCategory,
  ToolExecuteContext,
  ToolResult,
} from "./types";

// biome-ignore lint/suspicious/noExplicitAny: Tool schemas intentionally accept any Zod input/output shape.
export function defineTool<T extends z.ZodType<any, any, any>>(opts: {
  name: string;
  description: string;
  category: ToolCategory;
  input: T;
  execute: (input: z.infer<T>, context?: ToolExecuteContext) => Promise<string | ToolResult>;
}): Tool<z.infer<T>> {
  return {
    name: opts.name,
    description: opts.description,
    category: opts.category,
    input: opts.input,
    inputJsonSchema: z.toJSONSchema(opts.input) as Record<string, unknown>,
    execute: opts.execute,
  };
}

export function defineAugment(opts: Augment): Augment {
  return opts;
}

export interface RouteContextBase {
  request: Request;
  signal: AbortSignal;
  route: {
    method: HttpMethod;
    path: string;
  };
}

type RouteRateLimit = NonNullable<AugmentHttpRoute["rateLimit"]>;

// biome-ignore lint/suspicious/noExplicitAny: Route schemas intentionally accept any Zod input/output shape.
type AnySchema = z.ZodType<any, any, any>;

interface RouteOptionsBase {
  auth: AugmentHttpRouteAuth;
  timeoutMs?: number;
  maxBodyBytes?: number;
  rateLimit?: RouteRateLimit;
}

export interface DefineGetRouteOptions<TQuery extends AnySchema | undefined = undefined>
  extends RouteOptionsBase {
  query?: TQuery;
  handler: (
    ctx: RouteContextBase & {
      query: TQuery extends AnySchema ? z.infer<TQuery> : undefined;
    },
  ) => Promise<Response> | Response;
}

export interface DefinePostRouteOptions<TBody extends AnySchema | undefined = undefined>
  extends RouteOptionsBase {
  body?: TBody;
  handler: (
    ctx: RouteContextBase & {
      body: TBody extends AnySchema ? z.infer<TBody> : undefined;
    },
  ) => Promise<Response> | Response;
}

export function json(data: unknown, status = 200, headers?: Headers | Record<string, string>): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

function badRequest(): Response {
  return json({ error: "bad-request", message: "Invalid request" }, 400);
}

function routeBase(
  method: HttpMethod,
  path: string,
  opts: RouteOptionsBase,
  handler: AugmentHttpRoute["handler"],
): AugmentHttpRoute {
  return {
    method,
    path,
    auth: opts.auth,
    handler,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
  };
}

function queryObject(searchParams: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of searchParams.entries()) {
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }
  return out;
}

export const defineRoute = {
  get<TQuery extends AnySchema | undefined = undefined>(
    path: string,
    opts: DefineGetRouteOptions<TQuery>,
  ): AugmentHttpRoute {
    return routeBase("GET", path, opts, async (request, { signal }) => {
      const parsedQuery = opts.query
        ? opts.query.safeParse(queryObject(new URL(request.url).searchParams))
        : { success: true as const, data: undefined };
      if (!parsedQuery.success) return badRequest();

      return await opts.handler({
        request,
        signal,
        route: { method: "GET", path },
        query: parsedQuery.data as TQuery extends AnySchema ? z.infer<TQuery> : undefined,
      });
    });
  },

  post<TBody extends AnySchema | undefined = undefined>(
    path: string,
    opts: DefinePostRouteOptions<TBody>,
  ): AugmentHttpRoute {
    return routeBase("POST", path, opts, async (request, { signal }) => {
      let rawBody: unknown = undefined;
      if (opts.body) {
        try {
          rawBody = await request.json();
        } catch {
          return badRequest();
        }
      }

      const parsedBody = opts.body
        ? opts.body.safeParse(rawBody)
        : { success: true as const, data: undefined };
      if (!parsedBody.success) return badRequest();

      return await opts.handler({
        request,
        signal,
        route: { method: "POST", path },
        body: parsedBody.data as TBody extends AnySchema ? z.infer<TBody> : undefined,
      });
    });
  },
};
