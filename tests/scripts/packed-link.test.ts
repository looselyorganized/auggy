import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertLinkMessage,
  linkRequest,
  runPackedLink,
} from "../../scripts/release-smoke/packed-link";
import { PROVIDER_FIXTURE_FINAL_TEXT } from "../../scripts/release-smoke/provider-fixture";

let root: string;
let options: Parameters<typeof runPackedLink>[0];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "auggy-link-harness-test-"));
  for (const dir of [
    "repo",
    "agent/node_modules/auggy/src/cli",
    "agent/node_modules/@auggy/link",
    "home",
  ])
    await mkdir(join(root, dir), { recursive: true });
  const cli = join(root, "agent/node_modules/auggy/src/cli/index.ts");
  await writeFile(cli, "throw new Error('fixture CLI must never execute');\n");
  options = {
    cli,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    repoRoot: join(root, "repo"),
    evidenceDir: join(root, "evidence"),
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("refuses to execute historical Link before creating evidence or runtime fixtures", async () => {
  await writeFile(
    join(options.agentDir, "node_modules/@auggy/link/package.json"),
    JSON.stringify({ name: "@auggy/link", version: "0.1.2" }),
  );
  await expect(runPackedLink(options)).rejects.toThrow("Refusing to execute historical");
  expect(existsSync(options.evidenceDir)).toBe(false);
  expect(existsSync(join(options.agentDir, ".packed-link-acceptance"))).toBe(false);
});
test("rejects a consumer alias into the repository", async () => {
  const alias = join(root, "alias");
  await symlink(options.repoRoot, alias);
  await expect(runPackedLink({ ...options, agentDir: alias })).rejects.toThrow(
    "outside the source checkout",
  );
  expect(existsSync(options.evidenceDir)).toBe(false);
});
test("rejects an external CLI instead of claiming local runtime coverage", async () => {
  const external = join(root, "external.ts");
  await writeFile(external, "throw new Error('must not execute');");
  await expect(runPackedLink({ ...options, cli: external })).rejects.toThrow("project-local CLI");
});
test("rejects a Link package symlink to the repository before importing it", async () => {
  const linkPath = join(options.agentDir, "node_modules/@auggy/link");
  await rm(linkPath, { recursive: true });
  await symlink(options.repoRoot, linkPath);
  await expect(runPackedLink(options)).rejects.toThrow("escaped the installed consumer");
  expect(existsSync(options.evidenceDir)).toBe(false);
});
test("rejects an invalid immutable identity before starting candidate resources", async () => {
  await writeFile(
    join(options.agentDir, "node_modules/@auggy/link/package.json"),
    JSON.stringify({ name: "@auggy/link", version: "0.2.0" }),
  );
  await writeFile(join(options.agentDir, "agent.yaml"), "id: not-an-immutable-id\n");
  await expect(runPackedLink(options)).rejects.toThrow("valid immutable agent identity");
  expect(existsSync(options.evidenceDir)).toBe(false);
});
test("wire assertions require the bare Message and verified final output", () => {
  const message = {
    message_id: crypto.randomUUID(),
    role: "agent",
    parts: [{ kind: "text", text: PROVIDER_FIXTURE_FINAL_TEXT }],
  };
  expect(() => assertLinkMessage(message)).not.toThrow();
  expect(() => assertLinkMessage({ kind: "message", message })).toThrow();
  expect(() =>
    assertLinkMessage({ ...message, parts: [{ kind: "text", text: "unverified" }] }),
  ).toThrow();
  expect(() => assertLinkMessage({ ...message, role: "user" })).toThrow();
  expect(() => assertLinkMessage({ ...message, message_id: "-".repeat(36) })).toThrow();
  expect(linkRequest("correlation").id).toBe("correlation");
});
