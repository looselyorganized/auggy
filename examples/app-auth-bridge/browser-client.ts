type AssertionProvider = () => string | undefined | Promise<string | undefined>;

interface GeneratedAuggyClientFactory<TClient> {
  createAuggyClient(config: {
    baseUrl: string | URL;
    fetch?: typeof fetch;
    authAssertion?: AssertionProvider;
  }): TClient;
}

export interface StorefrontClientOptions {
  baseUrl: string | URL;
  assertionEndpoint?: string;
  appAccessToken?: AssertionProvider;
  fetch?: typeof fetch;
}

export function createStorefrontAuggyClient<TClient>(
  generated: GeneratedAuggyClientFactory<TClient>,
  opts: StorefrontClientOptions,
): TClient {
  const fetchImpl = opts.fetch ?? fetch;
  const assertionEndpoint = opts.assertionEndpoint ?? "/api/auggy-auth-assertion";

  return generated.createAuggyClient({
    baseUrl: opts.baseUrl,
    fetch: fetchImpl,
    authAssertion: async () => {
      const headers = new Headers();
      const appAccessToken = await opts.appAccessToken?.();
      if (appAccessToken) headers.set("authorization", `Bearer ${appAccessToken}`);

      const res = await fetchImpl(assertionEndpoint, { credentials: "include", headers });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { assertion?: unknown };
      return typeof body.assertion === "string" ? body.assertion : undefined;
    },
  });
}
