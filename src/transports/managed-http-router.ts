import type {
  ConfiguredWebHttp,
  ManagedHttpHandler,
  ManagedHttpListener,
  ManagedHttpRequest,
} from "../types";

/** Connection information is captured by the listener, never accepted from an app. */
export interface HttpConnection {
  requestIP?: (request: Request) => { address?: string } | null;
}

interface Invocation {
  request: Request;
  connection: HttpConnection;
  active: boolean;
  consumed: boolean;
}

/** One guarded delegate implementation serves the legacy and application mounts. */
export function createManagedHttpRouter(options: {
  name: string;
  external: boolean;
  canServe(): boolean;
  prelude(request: Request): Response | null;
  agentRun(request: Request, connection: HttpConnection): Promise<Response>;
  fallback(request: Request, connection: HttpConnection): Promise<Response>;
}) {
  const invocations = new WeakMap<ManagedHttpRequest, Invocation>();
  const descriptors = new WeakMap<ManagedHttpListener, ManagedHttpHandler>();
  let selected: ManagedHttpHandler | undefined;
  let created = false;
  let sealed = false;
  let draining = false;
  const pending = new Set<Promise<unknown>>();

  function track<T>(operation: Promise<T>): Promise<T> {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  }

  const delegate =
    (run: boolean): ManagedHttpHandler =>
    (receipt) => {
      const invocation = invocations.get(receipt);
      if (!invocation?.active || invocation.consumed) {
        throw new Error("[application-http] invalid or consumed request receipt");
      }
      invocation.consumed = true;
      const { request, connection } = invocation;
      if (run) {
        if (request.method !== "POST" || new URL(request.url).pathname !== "/agent/run") {
          throw new Error("[application-http] agent-run receipt has the wrong route");
        }
        // Application code may discard this promise or throw after delegation.
        // The guarded ingress remains owned until it has actually settled.
        return track(Promise.resolve().then(() => options.agentRun(request, connection)));
      }
      if (request.method === "POST" && new URL(request.url).pathname === "/agent/run") {
        return new Response("Not Found", { status: 404 });
      }
      return track(Promise.resolve().then(() => options.fallback(request, connection)));
    };
  const agentRun = delegate(true);
  const fallback = delegate(false);
  const http: ConfiguredWebHttp = Object.freeze({
    name: options.name,
    agentRun,
    fallback,
    createListener(input: Parameters<ConfiguredWebHttp["createListener"]>[0]) {
      if (!options.external || created || sealed || draining) {
        throw new Error("[application-http] listener already owned or closed");
      }
      if (
        input.fallback !== fallback ||
        !Array.isArray(input.routes) ||
        input.routes.length !== 1 ||
        input.routes[0]?.method !== "POST" ||
        input.routes[0]?.path !== "/agent/run" ||
        typeof input.routes[0]?.handle !== "function"
      ) {
        throw new Error("[application-http] invalid canonical route or fallback");
      }
      const listener = Object.freeze({}) as ManagedHttpListener;
      descriptors.set(listener, input.routes[0].handle);
      created = true;
      return listener;
    },
  });

  if (!options.external) selected = agentRun;

  return {
    http,
    owns(listener: ManagedHttpListener): boolean {
      return descriptors.has(listener);
    },
    prepare(): void {
      if (options.external) {
        if (draining) throw new Error("[application-http] listener is closed");
        return;
      }
      if (pending.size) throw new Error("[application-http] previous requests are unsettled");
      sealed = false;
      draining = false;
    },
    select(listener: ManagedHttpListener): void {
      const handler = descriptors.get(listener);
      if (!options.external || sealed || selected || draining || !handler) {
        throw new Error("[application-http] listener ownership conflict");
      }
      selected = handler;
    },
    seal(): void {
      if (!selected || draining) throw new Error("[application-http] missing listener binding");
      sealed = true;
    },
    closeAdmission(): void {
      draining = true;
    },
    pendingRequests(): number {
      return pending.size;
    },
    async waitForQuiescence(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    dispatch(request: Request, connection: HttpConnection): Promise<Response> {
      if (!sealed || draining || !options.canServe()) {
        return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
      }
      const operation = Promise.resolve().then(async () => {
        const prelude = options.prelude(request);
        if (prelude) return prelude;
        const headers = new Headers(request.headers);
        const receipt = Object.freeze({
          method: request.method,
          url: request.url,
          headers: Object.freeze({
            get: (name: string) => headers.get(name),
            has: (name: string) => headers.has(name),
          }),
        }) as ManagedHttpRequest;
        const invocation = { request, connection, active: true, consumed: false };
        invocations.set(receipt, invocation);
        try {
          const handler =
            request.method === "POST" && new URL(request.url).pathname === "/agent/run"
              ? selected!
              : fallback;
          return await handler(receipt);
        } finally {
          invocation.active = false;
        }
      });
      return track(operation);
    },
  };
}
