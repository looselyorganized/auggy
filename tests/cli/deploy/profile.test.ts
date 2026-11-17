import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuthoringDocument } from "../../../src/cli/authoring/document";
import { BUILTIN_INGRESS } from "../../../src/cli/deploy/contracts";
import {
  reconcileDeploymentProfile,
  resolveDeploymentProfile,
  validateDeploymentProfile,
  validateHealthPath,
} from "../../../src/cli/deploy/profile";
import type { AugmentConfig } from "../../../src/cli/types";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "auggy-profile-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function document(augments: unknown[]) {
  const path = join(root, "agent.yaml");
  writeFileSync(path, JSON.stringify({ name: "fixture", augments }));
  return readAuthoringDocument(path);
}
const web = (port: unknown = 8080, adminRoute?: unknown) => ({
  name: "web",
  type: "webTransport",
  options: { port, ...(adminRoute === undefined ? {} : { adminRoute }) },
});
const polling = {
  name: "tg",
  type: "telegramTransport",
  options: { inbound: { mode: "polling" } },
};

describe("passive deployment profile", () => {
  test("all classified non-listener built-ins and Telegram polling remain workers", () => {
    const augments = Object.entries(BUILTIN_INGRESS)
      .filter(([, kind]) => kind === "none")
      .map(([type]) => ({ name: type, type }));
    expect(
      resolveDeploymentProfile(document([...augments, polling]), { ingress: "auto" }),
    ).toMatchObject({ profile: { kind: "none" }, evidence: "known-config" });
  });
  test("web capability and known port are independent from Telegram polling", () => {
    expect(
      resolveDeploymentProfile(document([web(4321), polling]), { ingress: "auto", port: 4321 })
        .profile,
    ).toEqual({ kind: "http", port: 4321, healthPath: "/health", consolePath: "/console" });
    expect(
      resolveDeploymentProfile(document([web(4321, false)]), {
        ingress: "http",
        healthPath: "/ready",
      }).profile,
    ).toEqual({ kind: "http", port: 4321, healthPath: "/ready", consolePath: null });
  });
  test("Link and webhook have actual ports without invented health/console", () => {
    for (const augment of [
      { name: "link", type: "link", options: { outbound: true } },
      {
        name: "tg",
        type: "telegramTransport",
        options: { inbound: { mode: "webhook", webhook: {} } },
      },
    ])
      expect(resolveDeploymentProfile(document([augment]), { ingress: "auto" }).profile).toEqual({
        kind: "http",
        port: 8081,
        healthPath: null,
        consolePath: null,
      });
  });
  test("unknown code needs an explicit operator assertion", () => {
    const custom = document([{ name: "custom", type: "custom", source: "./never-import.ts" }]);
    expect(() => resolveDeploymentProfile(custom, { ingress: "auto", port: 8080 })).toThrow(
      "unresolved",
    );
    expect(resolveDeploymentProfile(custom, { ingress: "none" })).toMatchObject({
      profile: { kind: "none" },
      evidence: "operator-declared",
    });
    expect(() => resolveDeploymentProfile(custom, { ingress: "http" })).toThrow("literal --port");
    expect(resolveDeploymentProfile(custom, { ingress: "http", port: 3001 }).profile).toEqual({
      kind: "http",
      port: 3001,
      healthPath: null,
      consolePath: null,
    });
  });
  test("unresolved values are never evaluated and effective listeners must reconcile", () => {
    const raw = document([web("${SECRET_PORT}", "${ADMIN_ENABLED}")]);
    process.env.SECRET_PORT = "4321";
    try {
      expect(() => resolveDeploymentProfile(raw, { ingress: "auto" })).toThrow("unresolved");
      const result = resolveDeploymentProfile(raw, { ingress: "http", port: 4321 });
      expect(result.profile).toEqual({
        kind: "http",
        port: 4321,
        healthPath: "/health",
        consolePath: null,
      });
      expect(() =>
        reconcileDeploymentProfile(result.profile, [web(4321)] as AugmentConfig[]),
      ).not.toThrow();
      expect(() =>
        reconcileDeploymentProfile(result.profile, [web(4322)] as AugmentConfig[]),
      ).toThrow("conflicts");
      expect(() =>
        reconcileDeploymentProfile(result.profile, [polling] as AugmentConfig[]),
      ).toThrow("worker");
    } finally {
      delete process.env.SECRET_PORT;
    }
  });
  test("invalid known options cannot be repaired by flags", () => {
    for (const augment of [
      { name: "link", type: "link", options: { port: null } },
      {
        name: "tg",
        type: "telegramTransport",
        options: { inbound: { mode: "webhook", webhook: { port: null } } },
      },
    ])
      expect(() =>
        resolveDeploymentProfile(document([augment]), { ingress: "http", port: 8081 }),
      ).toThrow("Known listener port");
    for (const value of [null, 0, 65536, 3.5, "8080"])
      expect(() =>
        resolveDeploymentProfile(document([web(value)]), { ingress: "http", port: 8080 }),
      ).toThrow();
    expect(() =>
      resolveDeploymentProfile(document([{ name: "web", type: "webTransport", options: {} }]), {
        ingress: "http",
        port: 8080,
      }),
    ).toThrow();
    expect(() =>
      resolveDeploymentProfile(document([{ name: "tg", type: "telegramTransport" }]), {
        ingress: "none",
      }),
    ).toThrow("inbound");
  });
  test("rejects ambiguous topology and flags that would invent or contradict ingress", () => {
    for (const ingress of ["auto", "none", "http"] as const)
      expect(() =>
        resolveDeploymentProfile(
          document([web(), { name: "link", type: "link", options: { port: 8080 } }]),
          { ingress, port: 8080 },
        ),
      ).toThrow("Multiple");
    expect(() => resolveDeploymentProfile(document([web()]), { ingress: "none" })).toThrow(
      "conflicts",
    );
    expect(() =>
      resolveDeploymentProfile(document([web()]), { ingress: "http", port: 9999 }),
    ).toThrow("conflicts");
    expect(() =>
      resolveDeploymentProfile(document([polling]), { ingress: "auto", port: 9999 }),
    ).toThrow("HTTP flags");
    expect(() =>
      resolveDeploymentProfile(document([polling]), { ingress: "http", port: 9999 }),
    ).toThrow("does not enable");
  });
  test("validates safe health paths and closed profile shapes", () => {
    for (const value of [
      "https://private.invalid",
      "//private.invalid",
      "/?secret=1",
      "/#secret",
      "/bad\\path",
      "/%5cpath",
      "/%0apath",
      "/%",
      "/%2fprivate.invalid",
      `/${"a".repeat(2048)}`,
    ])
      expect(() => validateHealthPath(value)).toThrow();
    expect(() => validateHealthPath("/ready%20now")).not.toThrow();
    expect(() => validateDeploymentProfile({ kind: "none", port: 80 })).toThrow();
    expect(() =>
      validateDeploymentProfile({ kind: "http", port: 80, consolePath: null }),
    ).toThrow();
  });
});
