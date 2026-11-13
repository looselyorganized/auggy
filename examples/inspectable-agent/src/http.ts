import type { ConfiguredWebHttp } from "auggy/application";

const applicationHeader = "inspectable-agent";

export function configureHttp(web: ConfiguredWebHttp) {
  return web.createListener({
    routes: [
      {
        method: "POST",
        path: "/agent/run",
        handle: async (request) => {
          // This delegate retains original request identity, auth, limits and SSE.
          const response = await web.agentRun(request);
          const headers = new Headers(response.headers);
          headers.set("x-auggy-application", applicationHeader);
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        },
      },
    ],
    // Health, console, replay and augment routes use the same guarded transport.
    fallback: web.fallback,
  });
}
