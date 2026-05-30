import { describe, expect, test } from "bun:test";
import { generateDockerfile, generateEntrypoint } from "../../../src/cli/deploy/dockerfile";

describe("generateDockerfile", () => {
  test("uses a pinned Bun base image", () => {
    expect(generateDockerfile()).toMatch(/FROM oven\/bun:/);
  });

  test("copies package.json + bun.lock before COPY . for per-agent install layer caching", () => {
    const df = generateDockerfile();
    const copyManifest = df.indexOf("COPY package.json");
    const runInstall = df.indexOf("RUN bun install");
    const copyAll = df.indexOf("COPY . /app");
    expect(copyManifest).toBeGreaterThan(-1);
    expect(runInstall).toBeGreaterThan(copyManifest);
    expect(copyAll).toBeGreaterThan(runInstall);
  });

  test("copies bun.lock via bracket-glob so absent lockfile doesn't fail the build", () => {
    expect(generateDockerfile()).toMatch(/COPY bun\.loc\[k\] \/app\//);
  });

  test("runs the per-agent `bun install` (v0.3.2 package split), NOT the legacy global install", () => {
    const df = generateDockerfile();
    expect(df).toMatch(/RUN bun install\b/);
    expect(df).not.toMatch(/bun install -g auggy/);
  });

  test("copies the staging context into /app after the install layer", () => {
    expect(generateDockerfile()).toMatch(/COPY \. \/app/);
  });

  test("does not declare Docker VOLUME because Railway rejects it", () => {
    expect(generateDockerfile()).not.toMatch(/\bVOLUME\b/);
  });

  test("exposes the webTransport port", () => {
    expect(generateDockerfile()).toMatch(/EXPOSE 8080/);
  });

  test("ENTRYPOINT calls the entrypoint script without an agent name", () => {
    const df = generateDockerfile();
    expect(df).toMatch(/ENTRYPOINT \["\/app\/auggy-entrypoint\.sh"\]/);
    expect(df).not.toMatch(/ENTRYPOINT \["\/app\/auggy-entrypoint\.sh",/);
  });
});

describe("generateEntrypoint", () => {
  test("creates /app/data before symlinks (idempotent)", () => {
    expect(generateEntrypoint()).toMatch(/mkdir -p \/app\/data/);
  });

  test("symlinks all four v1.0 SQLite dbs to the volume", () => {
    const script = generateEntrypoint();
    expect(script).toMatch(/ln -sf \/app\/data\/memory\.db \/app\/memory\.db/);
    expect(script).toMatch(/ln -sf \/app\/data\/budgets\.db \/app\/budgets\.db/);
    expect(script).toMatch(/ln -sf \/app\/data\/visitor-auth\.db \/app\/visitor-auth\.db/);
    expect(script).toMatch(/ln -sf \/app\/data\/link\.db \/app\/link\.db/);
  });

  test("uses -f flag so redeploys don't trip on existing symlinks", () => {
    expect(generateEntrypoint()).toMatch(/ln -sf/);
  });

  test("execs auggy via `bunx` with explicit /app/agent.yaml config", () => {
    const script = generateEntrypoint();
    expect(script).toMatch(
      /exec bunx auggy dev --config \/app\/agent\.yaml --internal-mode railway/,
    );
    // Negative assertion: the bare `auggy dev` shape would resolve to a
    // global install that the v0.3.2 split no longer ships.
    expect(script).not.toMatch(/exec auggy dev/);
    expect(script).not.toMatch(/exec bunx auggy run/);
    // Negative assertion: passing a name asks the cloud image to perform
    // name discovery; the deployed app has one authoritative /app/agent.yaml.
    expect(script).not.toMatch(/"\$1"/);
  });

  test("uses `set -e` so failed steps abort the boot", () => {
    expect(generateEntrypoint()).toMatch(/set -e/);
  });
});
