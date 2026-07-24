import { describe, expect, test } from "bun:test";
import {
  assertSecureCredentialTransport,
  assertSecureWebSocketCredentialTransport,
} from "../../src/engines/_shared/credential-transport";

const SENTINEL_URL = "http://sentinel-user:sentinel-pass@provider.example.test/v1?key=secret";

describe("assertSecureCredentialTransport", () => {
  test("allows HTTPS with credentials", () => {
    expect(() =>
      assertSecureCredentialTransport({
        provider: "test-provider",
        baseURL: "https://provider.example.test/v1",
        credential: "secret",
      }),
    ).not.toThrow();
  });

  test.each([
    "http://localhost:11434",
    "http://LOCALHOST.:11434",
    "http://127.0.0.1:11434",
    "http://127.255.255.254:11434",
    "http://127.1:11434",
    "http://0177.0.0.1:11434",
    "http://[::1]:11434",
    "http://[::ffff:127.0.0.1]:11434",
  ])("allows credentialed loopback HTTP: %s", (baseURL) => {
    expect(() =>
      assertSecureCredentialTransport({
        provider: "test-provider",
        baseURL,
        credential: "secret",
      }),
    ).not.toThrow();
  });

  test.each([
    "http://provider.example.test/v1",
    "http://10.0.0.1:11434",
    "http://[::ffff:10.0.0.1]:11434",
  ])("rejects credentialed non-loopback HTTP: %s", (baseURL) => {
    expect(() =>
      assertSecureCredentialTransport({
        provider: "test-provider",
        baseURL,
        credential: "secret",
      }),
    ).toThrow(/plaintext HTTP/);
  });

  test("allows non-loopback HTTP when no credential will be attached", () => {
    expect(() =>
      assertSecureCredentialTransport({
        provider: "test-provider",
        baseURL: "http://provider.example.test/v1",
      }),
    ).not.toThrow();
  });

  test("requires both an explicit override and development environment", () => {
    expect(() =>
      assertSecureCredentialTransport({
        provider: "test-provider",
        baseURL: "http://provider.example.test/v1",
        credential: "secret",
        allowInsecureHttpWithCredentials: true,
        nodeEnv: "production",
      }),
    ).toThrow(/plaintext HTTP/);

    expect(() =>
      assertSecureCredentialTransport({
        provider: "test-provider",
        baseURL: "http://provider.example.test/v1",
        credential: "secret",
        allowInsecureHttpWithCredentials: true,
        nodeEnv: "development",
      }),
    ).not.toThrow();
  });

  test("rejects embedded URL credentials and never echoes the raw URL", () => {
    const error = (() => {
      try {
        assertSecureCredentialTransport({
          provider: "test-provider",
          baseURL: SENTINEL_URL,
        });
      } catch (cause) {
        return cause;
      }
      throw new Error("expected transport policy failure");
    })();

    expect(String(error)).not.toContain("sentinel-user");
    expect(String(error)).not.toContain("sentinel-pass");
    expect(String(error)).not.toContain("provider.example.test");
  });

  test.each(["", "/relative", "ftp://provider.example.test"])(
    "rejects malformed or unsupported base URLs without echoing them: %s",
    (baseURL) => {
      expect(() =>
        assertSecureCredentialTransport({
          provider: "test-provider",
          baseURL,
          credential: "secret",
        }),
      ).toThrow(/valid absolute HTTP\(S\) URL/);
    },
  );
});

describe("assertSecureWebSocketCredentialTransport", () => {
  test("allows WSS and loopback WS but rejects remote credentialed WS", () => {
    expect(() =>
      assertSecureWebSocketCredentialTransport({
        provider: "test-provider",
        baseURL: "wss://provider.example.test/events",
        credential: "secret",
      }),
    ).not.toThrow();
    expect(() =>
      assertSecureWebSocketCredentialTransport({
        provider: "test-provider",
        baseURL: "ws://127.0.0.1:8080/events",
        credential: "secret",
      }),
    ).not.toThrow();
    expect(() =>
      assertSecureWebSocketCredentialTransport({
        provider: "test-provider",
        baseURL: "ws://provider.example.test/events",
        credential: "secret",
      }),
    ).toThrow(/plaintext WS/);
  });
});
