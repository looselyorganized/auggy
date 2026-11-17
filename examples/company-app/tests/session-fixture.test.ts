import { afterAll, expect, mock, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifiedSessionAdapter } from "../src/server/contracts";

// The production build enforces this boundary. Unit tests run the exact fixture
// composition outside Next's server condition; no fixture switch enters the app.
mock.module("server-only", () => ({}));
const output = new URL(`../.next/fixture-adapter-test-${crypto.randomUUID()}.ts`, import.meta.url);
mkdirSync(new URL("../.next/", import.meta.url), { recursive: true });
writeFileSync(
  output,
  readFileSync(new URL("../fixtures/session-adapter.ts.fixture", import.meta.url)),
);
const { sessionAdapter } = (await import(output.href)) as {
  sessionAdapter: VerifiedSessionAdapter;
};
const directory = mkdtempSync(join(tmpdir(), "auggy-company-session-"));
const registry = join(directory, "sessions.json");
const originalPath = process.env.AUGGY_FIXTURE_SESSIONS_FILE;
const cookie = "a".repeat(64);
const session = {
  provider: "fixture-app",
  userId: "customer-a",
  orgId: "synthetic-company",
  roles: ["customer"],
};
const request = (value: string) =>
  new Request("https://company.example", { headers: { cookie: value } });
function seed(value: unknown) {
  writeFileSync(registry, JSON.stringify(value), { mode: 0o600 });
  chmodSync(registry, 0o600);
  process.env.AUGGY_FIXTURE_SESSIONS_FILE = registry;
}
afterAll(() => {
  if (originalPath === undefined) delete process.env.AUGGY_FIXTURE_SESSIONS_FILE;
  else process.env.AUGGY_FIXTURE_SESSIONS_FILE = originalPath;
  rmSync(output, { force: true });
  rmSync(directory, { recursive: true, force: true });
});

test("fixture adapter accepts only a seeded opaque cookie, never browser identity or roles", async () => {
  seed({ version: 1, sessions: [{ cookie, session }] });
  expect(await sessionAdapter.verify(request(`auggy_fixture_session=${cookie}`))).toEqual(session);
  for (const value of [
    "",
    "userId=customer-a; role=creator",
    "auggy_fixture_session=customer-a",
    `auggy_fixture_session=${"b".repeat(64)}`,
    `auggy_fixture_session=${cookie}; auggy_fixture_session=${cookie}`,
  ]) {
    expect(await sessionAdapter.verify(request(value))).toBeNull();
  }
  seed({
    version: 1,
    sessions: [
      { cookie, session },
      { cookie, session },
    ],
  });
  expect(await sessionAdapter.verify(request(`auggy_fixture_session=${cookie}`))).toBeNull();
});

test("fixture registry fails closed for unsafe files, missing configuration and invalid principals", async () => {
  const input = request(`auggy_fixture_session=${cookie}`);
  seed({ version: 1, sessions: [{ cookie, session }] });
  chmodSync(registry, 0o644);
  await expect(sessionAdapter.verify(input)).rejects.toThrow();
  chmodSync(registry, 0o600);
  const alias = join(directory, "alias.json");
  symlinkSync(registry, alias);
  process.env.AUGGY_FIXTURE_SESSIONS_FILE = alias;
  await expect(sessionAdapter.verify(input)).rejects.toThrow();
  delete process.env.AUGGY_FIXTURE_SESSIONS_FILE;
  await expect(sessionAdapter.verify(input)).rejects.toThrow();
  for (const forged of [
    { ...session, userId: "creator" },
    { ...session, provider: "another-provider" },
    { ...session, orgId: "another-company" },
    { ...session, roles: [42] },
  ]) {
    seed({ version: 1, sessions: [{ cookie, session: forged }] });
    await expect(sessionAdapter.verify(input)).rejects.toThrow();
  }
  seed("x".repeat(65537));
  await expect(sessionAdapter.verify(input)).rejects.toThrow();
});
