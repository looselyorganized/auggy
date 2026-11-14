/** Explicit test-only network adapter. Copied verbatim into an installed generated consumer. */
export const TELEGRAM_FIXTURE_TOKEN = "123456789:auggy-integration-fixture-only";
export const TELEGRAM_FIXTURE_INSTALL_MARKER = "auggy-telegram-fixture-network-v1";

function ownedOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Telegram fixture requires an owned loopback origin.");
  return url.origin;
}

/** No import-time behavior: installation must be main's first statement. */
export function installTelegramFixtureNetwork(
  marker: string,
  options = {
    telegramOrigin: process.env.AUGGY_FIXTURE_TELEGRAM_ORIGIN ?? "",
    modelOrigin: process.env.AUGGY_FIXTURE_MODEL_ORIGIN ?? "",
  },
): () => void {
  if (marker !== TELEGRAM_FIXTURE_INSTALL_MARKER) {
    throw new Error("Telegram fixture installation marker mismatch.");
  }
  const telegramOrigin = ownedOrigin(options.telegramOrigin);
  const modelOrigin = ownedOrigin(options.modelOrigin);
  const nativeFetch = globalThis.fetch;
  const methods = new Set(["getUpdates", "sendMessage", "getChat", "deleteWebhook", "setWebhook"]);
  const adaptedFetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const url = new URL(request.url);
    let destination = request.url;
    if (url.origin === "https://api.telegram.org") {
      const prefix = `/bot${TELEGRAM_FIXTURE_TOKEN}/`;
      if (
        request.method !== "POST" ||
        !url.pathname.startsWith(prefix) ||
        !methods.has(url.pathname.slice(prefix.length)) ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        throw new Error("Telegram fixture refused an unreviewed Bot API request.");
      destination = `${telegramOrigin}/telegram/${url.pathname.slice(prefix.length)}`;
    } else if (
      request.method !== "POST" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !(
        (url.origin === modelOrigin && url.pathname === "/v1/messages") ||
        (url.origin === telegramOrigin && ["/attempt", "/effect"].includes(url.pathname))
      )
    ) {
      throw new Error("Telegram fixture refused an unowned network destination.");
    }
    // Constructing from Request retains headers, streaming body and abort signal.
    // All fixture traffic is manual: no redirect can escape the reviewed origins.
    return nativeFetch.call(globalThis, new Request(destination, request), { redirect: "manual" });
  }) as typeof fetch;
  globalThis.fetch = adaptedFetch;
  const restore = () => {
    if (globalThis.fetch === adaptedFetch) globalThis.fetch = nativeFetch;
    process.removeListener("exit", restore);
  };
  process.once("exit", restore);
  return restore;
}
