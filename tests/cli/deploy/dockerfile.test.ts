import { describe, expect, test } from "bun:test";
import { generateDockerfile, generateEntrypoint } from "../../../src/cli/deploy/dockerfile";

describe("generateDockerfile", () => {
  test("uses a pinned Bun base image", () => {
    expect(generateDockerfile({ agentName: "zip" })).toMatch(/FROM oven\/bun:/);
  });

  test("installs auggy globally", () => {
    expect(generateDockerfile({ agentName: "zip" })).toMatch(/bun install -g auggy/);
  });

  test("copies the staging context into /app", () => {
    expect(generateDockerfile({ agentName: "zip" })).toMatch(/COPY \. \/app/);
  });

  test("declares a VOLUME at /app/data (Railway-mounted persistence)", () => {
    expect(generateDockerfile({ agentName: "zip" })).toMatch(/VOLUME \["\/app\/data"\]/);
  });

  test("exposes the webTransport port", () => {
    expect(generateDockerfile({ agentName: "zip" })).toMatch(/EXPOSE 8080/);
  });

  test("ENTRYPOINT calls the entrypoint script with the agent name", () => {
    expect(generateDockerfile({ agentName: "zip" })).toMatch(
      /ENTRYPOINT \["\/app\/auggy-entrypoint\.sh", "zip"\]/,
    );
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

  test("execs `auggy dev` with --internal-mode railway", () => {
    expect(generateEntrypoint()).toMatch(/exec auggy dev "\$1" --internal-mode railway/);
  });

  test("uses `set -e` so failed steps abort the boot", () => {
    expect(generateEntrypoint()).toMatch(/set -e/);
  });
});
