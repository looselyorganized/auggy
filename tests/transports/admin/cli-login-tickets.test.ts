import { describe, expect, test } from "bun:test";
import { createConsoleCliLoginTicketStore } from "../../../src/transports/admin/cli-login-tickets";

const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);

describe("Console CLI login tickets", () => {
  test("issues a short-lived ticket and consumes it once", () => {
    let now = 1_000;
    const store = createConsoleCliLoginTicketStore({
      now: () => now,
      randomToken: () => TOKEN_A,
      ttlMs: 30_000,
    });

    expect(store.issue({ bearer: "secret", origin: "https://agent.example" })).toEqual({
      token: TOKEN_A,
      expiresInSeconds: 30,
    });
    expect(
      store.consume({
        token: TOKEN_A,
        bearer: "secret",
        origin: "https://agent.example",
      }),
    ).toEqual({ ok: true, nextPath: "/console/chat" });
    expect(
      store.consume({
        token: TOKEN_A,
        bearer: "secret",
        origin: "https://agent.example",
      }),
    ).toEqual({ ok: false });

    now += 1;
  });

  test("expires tickets and rejects malformed values", () => {
    let now = 1_000;
    const store = createConsoleCliLoginTicketStore({
      now: () => now,
      randomToken: () => TOKEN_A,
      ttlMs: 30_000,
    });
    store.issue({ bearer: "secret", origin: "https://agent.example" });
    now = 31_000;

    expect(
      store.consume({
        token: TOKEN_A,
        bearer: "secret",
        origin: "https://agent.example",
      }),
    ).toEqual({ ok: false });
    expect(
      store.consume({ token: "not-a-ticket", bearer: "secret", origin: "https://agent.example" }),
    ).toEqual({ ok: false });
  });

  test("binds tickets to the exact origin and bearer", () => {
    const tokens = [TOKEN_A, TOKEN_B];
    const store = createConsoleCliLoginTicketStore({ randomToken: () => tokens.shift()! });
    store.issue({ bearer: "secret", origin: "https://agent.example" });
    store.issue({ bearer: "secret", origin: "https://agent.example" });

    expect(
      store.consume({
        token: TOKEN_A,
        bearer: "wrong",
        origin: "https://agent.example",
      }),
    ).toEqual({ ok: false });
    expect(
      store.consume({
        token: TOKEN_B,
        bearer: "secret",
        origin: "https://other.example",
      }),
    ).toEqual({ ok: false });
  });

  test("bounds outstanding tickets", () => {
    const tokens = [TOKEN_A, TOKEN_B];
    const store = createConsoleCliLoginTicketStore({
      randomToken: () => tokens.shift()!,
      maxPendingTickets: 1,
    });
    store.issue({ bearer: "secret", origin: "https://agent.example" });

    expect(() => store.issue({ bearer: "secret", origin: "https://agent.example" })).toThrow(
      "too many pending Console sign-in tickets",
    );
  });
});
