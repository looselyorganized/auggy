import { z } from "zod";
import type {
  Augment,
  AugmentHttpRoute,
  AugmentHttpRouteAuth,
  AugmentHttpRoutePolicy,
  AugmentHttpRouteRequestJsonSchema,
  AugmentHttpRouteResponseJsonSchema,
  AugmentHttpRouteWebhookProvider,
  AugmentHttpRouteWebhookSignaturePolicy,
  HttpMethod,
  RouteAuthContext,
  RouteWebhookContext,
  Tool,
  ToolCategory,
  ToolExecuteContext,
  ToolResult,
} from "./types";
import { joinRoutePaths } from "./kernel/route-pattern";

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

export interface RouteContextBase<TParams = Record<string, string>> {
  request: Request;
  signal: AbortSignal;
  auth: RouteAuthContext;
  webhook?: RouteWebhookContext;
  params: TParams;
  route: {
    method: HttpMethod;
    path: string;
    params: TParams;
  };
}

export type RouteContext<
  TParams = Record<string, string>,
  TQuery = undefined,
  TBody = undefined,
> = RouteContextBase<TParams> & {
  query: TQuery;
  body: TBody;
};

type RouteRateLimit = NonNullable<AugmentHttpRoute["rateLimit"]>;

// biome-ignore lint/suspicious/noExplicitAny: Route schemas intentionally accept any Zod input/output shape.
type AnySchema = z.ZodType<any, any, any>;

type InferSchema<TSchema extends AnySchema | undefined, TFallback> = TSchema extends AnySchema
  ? z.infer<TSchema>
  : TFallback;

interface RouteOptionsBase {
  auth: AugmentHttpRouteAuth;
  timeoutMs?: number;
  maxBodyBytes?: number;
  rateLimit?: RouteRateLimit;
  policy?: AugmentHttpRoutePolicy;
}

export interface DefineGetRouteOptions<
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
  TResponse extends AnySchema | undefined = undefined,
> extends RouteOptionsBase {
  query?: TQuery;
  params?: TParams;
  response?: TResponse;
  handler: (
    ctx: RouteContext<
      InferSchema<TParams, Record<string, string>>,
      InferSchema<TQuery, undefined>,
      undefined
    >,
  ) => Promise<Response> | Response;
}

export interface DefinePostRouteOptions<
  TBody extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
  TQuery extends AnySchema | undefined = undefined,
  TResponse extends AnySchema | undefined = undefined,
> extends RouteOptionsBase {
  body?: TBody;
  params?: TParams;
  query?: TQuery;
  response?: TResponse;
  handler: (
    ctx: RouteContext<
      InferSchema<TParams, Record<string, string>>,
      InferSchema<TQuery, undefined>,
      InferSchema<TBody, undefined>
    >,
  ) => Promise<Response> | Response;
}

export function json(
  data: unknown,
  status = 200,
  headers?: Headers | Record<string, string>,
): Response {
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
  requestJsonSchema?: AugmentHttpRouteRequestJsonSchema,
  responseJsonSchema?: AugmentHttpRouteResponseJsonSchema,
): AugmentHttpRoute {
  return {
    method,
    path,
    auth: opts.auth,
    handler,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(requestJsonSchema ? { requestJsonSchema } : {}),
    ...(responseJsonSchema ? { responseJsonSchema } : {}),
  };
}

export const webhook = {
  signature(
    provider: AugmentHttpRouteWebhookProvider,
    opts: { secretEnv?: string; timestampToleranceSeconds?: number } = {},
  ): AugmentHttpRouteWebhookSignaturePolicy {
    return {
      kind: "webhook.signature",
      provider,
      ...(opts.secretEnv !== undefined ? { secretEnv: opts.secretEnv } : {}),
      ...(opts.timestampToleranceSeconds !== undefined
        ? { timestampToleranceSeconds: opts.timestampToleranceSeconds }
        : {}),
    };
  },
};

function toJsonSchema(schema: AnySchema | undefined): Record<string, unknown> | undefined {
  return schema ? (z.toJSONSchema(schema) as Record<string, unknown>) : undefined;
}

function requestJsonSchema(
  schemas: AugmentHttpRouteRequestJsonSchema,
): AugmentHttpRouteRequestJsonSchema | undefined {
  return Object.keys(schemas).length > 0 ? schemas : undefined;
}

function fallbackRouteAuth(auth: AugmentHttpRouteAuth): RouteAuthContext {
  if (auth === "bearer" || auth === "creator") {
    return {
      mode: auth,
      principal: { kind: "creator", trustLevel: "creator", peerId: "creator" },
    };
  }
  const anonymous = {
    kind: "anonymous" as const,
    trustLevel: "public" as const,
    publicSubstate: "anonymous" as const,
  };
  if (auth === "none") return { mode: "none", principal: anonymous };
  if (auth === "agent.required") {
    return {
      mode: "agent",
      agentId: "agent",
      peerId: "agent:agent",
      principal: {
        kind: "agent",
        trustLevel: "agent",
        agentId: "agent",
        peerId: "agent:agent",
      },
    };
  }
  return { mode: "visitor", state: "anonymous", principal: anonymous };
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
  get<
    TQuery extends AnySchema | undefined = undefined,
    TParams extends AnySchema | undefined = undefined,
    TResponse extends AnySchema | undefined = undefined,
  >(path: string, opts: DefineGetRouteOptions<TQuery, TParams, TResponse>): AugmentHttpRoute {
    return routeBase(
      "GET",
      path,
      opts,
      async (request, { signal, auth, params, routePath, webhook }) => {
        const parsedQuery = opts.query
          ? opts.query.safeParse(queryObject(new URL(request.url).searchParams))
          : { success: true as const, data: undefined };
        if (!parsedQuery.success) return badRequest();

        const rawParams = params ?? {};
        const parsedParams = opts.params
          ? opts.params.safeParse(rawParams)
          : { success: true as const, data: rawParams };
        if (!parsedParams.success) return badRequest();

        return await opts.handler({
          request,
          signal,
          auth: auth ?? fallbackRouteAuth(opts.auth),
          ...(webhook ? { webhook } : {}),
          params: parsedParams.data as TParams extends AnySchema
            ? z.infer<TParams>
            : Record<string, string>,
          route: {
            method: "GET",
            path: routePath ?? path,
            params: parsedParams.data as TParams extends AnySchema
              ? z.infer<TParams>
              : Record<string, string>,
          },
          query: parsedQuery.data as TQuery extends AnySchema ? z.infer<TQuery> : undefined,
          body: undefined,
        });
      },
      requestJsonSchema({
        ...(opts.params ? { params: toJsonSchema(opts.params) } : {}),
        ...(opts.query ? { query: toJsonSchema(opts.query) } : {}),
      }),
      toJsonSchema(opts.response),
    );
  },

  post<
    TBody extends AnySchema | undefined = undefined,
    TParams extends AnySchema | undefined = undefined,
    TQuery extends AnySchema | undefined = undefined,
    TResponse extends AnySchema | undefined = undefined,
  >(
    path: string,
    opts: DefinePostRouteOptions<TBody, TParams, TQuery, TResponse>,
  ): AugmentHttpRoute {
    return routeBase(
      "POST",
      path,
      opts,
      async (request, { signal, auth, params, routePath, webhook }) => {
        let rawBody: unknown;
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

        const parsedQuery = opts.query
          ? opts.query.safeParse(queryObject(new URL(request.url).searchParams))
          : { success: true as const, data: undefined };
        if (!parsedQuery.success) return badRequest();

        const rawParams = params ?? {};
        const parsedParams = opts.params
          ? opts.params.safeParse(rawParams)
          : { success: true as const, data: rawParams };
        if (!parsedParams.success) return badRequest();

        return await opts.handler({
          request,
          signal,
          auth: auth ?? fallbackRouteAuth(opts.auth),
          ...(webhook ? { webhook } : {}),
          params: parsedParams.data as TParams extends AnySchema
            ? z.infer<TParams>
            : Record<string, string>,
          route: {
            method: "POST",
            path: routePath ?? path,
            params: parsedParams.data as TParams extends AnySchema
              ? z.infer<TParams>
              : Record<string, string>,
          },
          query: parsedQuery.data as TQuery extends AnySchema ? z.infer<TQuery> : undefined,
          body: parsedBody.data as TBody extends AnySchema ? z.infer<TBody> : undefined,
        });
      },
      requestJsonSchema({
        ...(opts.params ? { params: toJsonSchema(opts.params) } : {}),
        ...(opts.query ? { query: toJsonSchema(opts.query) } : {}),
        ...(opts.body ? { body: toJsonSchema(opts.body) } : {}),
      }),
      toJsonSchema(opts.response),
    );
  },

  group(prefix: string, routes: readonly AugmentHttpRoute[]): AugmentHttpRoute[] {
    return routes.map((route) => {
      const path = joinRoutePaths(prefix, route.path);
      return {
        ...route,
        path,
        handler: (request, opts) =>
          route.handler(request, {
            ...opts,
            routePath: opts.routePath ?? path,
          }),
      };
    });
  },
};
