import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { applicationHash } from "../../scripts/release-smoke/application-consumer";
import {
  prepareCIChromiumUserNamespacePolicy,
  verifyCIChromiumUserNamespacePolicy,
} from "../../scripts/release-smoke/ci-chromium-userns";

const repository = resolve(import.meta.dir, "../..");
let root: string, build: string, browser: string, bin: string;
const bytes = "ordinary nonexecuted browser fixture\n";
const sha256 = applicationHash(bytes);
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "auggy-ci-userns-test-")));
  build = join(root, "build");
  browser = join(build, "browsers", "chromium-1255", "chrome-linux64", "chrome");
  mkdirSync(dirname(browser), { recursive: true, mode: 0o700 });
  writeFileSync(browser, bytes, { mode: 0o700 });
  bin = join(root, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const scripts = {
    uname: "printf 'Linux\\n'",
    sudo: '[[ "$1" == -n && "$2" == -- ]] || exit 91\nshift 2\nexec "$@"',
    timeout: '[[ "$1" == --kill-after=2s && "$2" == 15s ]] || exit 92\nshift 2\nexec "$@"',
    head: `[[ "$*" == '-c 2097153 /sys/kernel/security/apparmor/profiles' ]] || exit 93
if [[ -s "$TEST_STATE" && "\${TEST_MODE:-}" == inventory-newline-after-add ]]; then
  exec bun --no-env-file --no-install --config=/dev/null -e 'process.stdout.write("x".repeat(2097152)+"\\n")'
fi
if [[ -s "$TEST_STATE" && "\${TEST_MODE:-}" == inventory-unicode-after-add ]]; then
  exec bun --no-env-file --no-install --config=/dev/null -e 'process.stdout.write("é".repeat(1048576)+"x")'
fi
if [[ "\${TEST_MODE:-}" == preexisting && ! -s "$TEST_STATE" ]]; then
  for p in "$TEST_BUILD"/auggy-m5-chromium-*; do printf '%s (unconfined)\\n' "\${p##*/}" > "$TEST_STATE"; done
fi
/bin/cat "$TEST_STATE"`,
    apparmor_parser: `[[ "$2" == --skip-cache ]] || exit 94
name="\${3##*/}"
printf '%s %s\\n' "$1" "$name" >> "$TEST_LOG"
/bin/cat "$3" > "$TEST_POLICY"
if [[ "$1" == --add ]]; then
  [[ "\${TEST_MODE:-}" != fail-before-add ]] || exit 41
  [[ ! -s "$TEST_STATE" ]] || exit 42
  printf '%s (unconfined)\\n' "$name" > "$TEST_STATE"
  if [[ "$TEST_MODE" == interrupt-during-add ]]; then
    kill -TERM "$PPID"
    sleep 0.1
  fi
  [[ "\${TEST_MODE:-}" != fail-after-add ]] || exit 43
elif [[ "$1" == --remove ]]; then
  [[ "\${TEST_MODE:-}" != fail-remove ]] || exit 44
  : > "$TEST_STATE"
else exit 95; fi`,
  };
  for (const [name, source] of Object.entries(scripts))
    writeFileSync(join(bin, name), `#!/bin/bash\nset -euo pipefail\n${source}\n`, { mode: 0o700 });
  writeFileSync(join(root, "state"), "");
  writeFileSync(join(root, "log"), "");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(options: { mode?: string; body?: string; optIn?: string; ci?: string } = {}) {
  return spawnSync(
    "/bin/bash",
    [
      "-c",
      `set -euo pipefail
repository_root="$TEST_REPOSITORY"
source "$repository_root/scripts/ci-chromium-userns.sh"
trap auggy_ci_userns_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
auggy_ci_userns_prepare "$TEST_BUILD" "$TEST_BROWSER" "$TEST_SHA"
${options.body ?? "exit 0"}`,
    ],
    {
      cwd: root,
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: root,
        CI: options.ci ?? "true",
        GITHUB_ACTIONS: "true",
        AUGGY_INTEGRATION_CI_USERNS: options.optIn ?? "1",
        TEST_REPOSITORY: repository,
        TEST_BUILD: build,
        TEST_BROWSER: browser,
        TEST_SHA: sha256,
        TEST_MODE: options.mode ?? "",
        TEST_STATE: join(root, "state"),
        TEST_LOG: join(root, "log"),
        TEST_POLICY: join(root, "policy"),
      },
      timeout: 8000,
      maxBuffer: 64 * 1024,
      killSignal: "SIGKILL",
      encoding: "utf8",
    },
  );
}

function policyFiles() {
  return readdirSync(build).filter((name) => name.startsWith("auggy-m5-chromium-"));
}

describe("exact CI Chromium AppArmor policy", () => {
  test("ordinary pinned executable gets a unique literal attachment and immutable source check", () => {
    const policy = prepareCIChromiumUserNamespacePolicy({
      buildDirectory: build,
      executable: browser,
      sha256,
    });
    const content = readFileSync(policy.path, "utf8");
    expect(content).toContain(`"${browser}" flags=(unconfined)`);
    expect(content).toContain("  userns,");
    expect(content).not.toContain("/**");
    expect(content).not.toContain("--no-sandbox");
    verifyCIChromiumUserNamespacePolicy(policy.path, policy.sha256);
    writeFileSync(policy.path, `${content}# changed\n`);
    expect(() => verifyCIChromiumUserNamespacePolicy(policy.path, policy.sha256)).toThrow(
      "changed",
    );
  });
  test("policy syntax injection, outside attachment, bad hash and linked executable are rejected", () => {
    const input = { buildDirectory: build, executable: browser, sha256 };
    for (const executable of [
      `${browser}*`,
      `${browser}\nuserns,`,
      `${browser}@{HOME}`,
      `${browser}"`,
    ])
      expect(() => prepareCIChromiumUserNamespacePolicy({ ...input, executable })).toThrow(
        "Unsafe",
      );
    const outside = join(root, "outside");
    writeFileSync(outside, bytes, { mode: 0o700 });
    expect(() => prepareCIChromiumUserNamespacePolicy({ ...input, executable: outside })).toThrow(
      "inside",
    );
    expect(() =>
      prepareCIChromiumUserNamespacePolicy({ ...input, sha256: "0".repeat(64) }),
    ).toThrow("hash");
    const link = join(dirname(browser), "linked");
    symlinkSync(browser, link);
    expect(() => prepareCIChromiumUserNamespacePolicy({ ...input, executable: link })).toThrow(
      "symlink",
    );
    chmodSync(build, 0o755);
    expect(() => prepareCIChromiumUserNamespacePolicy(input)).toThrow("private");
    expect(policyFiles()).toEqual([]);
  });
});

describe("CI AppArmor lifecycle with mocked privilege commands; no host policy changes", () => {
  test("explicit opt-out makes no privileged calls or policy files", () => {
    expect(run({ optIn: "" }).status).toBe(0);
    expect(readFileSync(join(root, "log"), "utf8")).toBe("");
    expect(policyFiles()).toEqual([]);
  });
  test("explicit opt-in outside the CI guard fails before privileged calls", () => {
    const result = run({ ci: "false" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("explicit Linux GitHub Actions job");
    expect(readFileSync(join(root, "log"), "utf8")).toBe("");
  });
  test("success adds and removes exactly one unique profile, preserving build inputs", () => {
    const result = run();
    expect(result.status).toBe(0);
    const events = readFileSync(join(root, "log"), "utf8").trim().split("\n");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(/^--add auggy-m5-chromium-[a-f0-9-]{36}$/);
    expect(events[1]).toBe(events[0]!.replace("--add", "--remove"));
    expect(readFileSync(join(root, "state"), "utf8")).toBe("");
    expect(readFileSync(join(root, "policy"), "utf8")).toContain(`"${browser}"`);
    expect(policyFiles()).toEqual([]);
    expect(existsSync(browser)).toBe(true);
  });
  test.each(["fail-before-add", "fail-after-add"])(
    "%s is failed and any installed policy is removed",
    (mode) => {
      expect(run({ mode }).status).toBe(1);
      const events = readFileSync(join(root, "log"), "utf8");
      expect(events.includes("--remove")).toBe(mode === "fail-after-add");
      expect(readFileSync(join(root, "state"), "utf8")).toBe("");
      expect(policyFiles()).toEqual([]);
      expect(existsSync(browser)).toBe(true);
    },
  );
  test("preexisting matching name is never replaced or removed", () => {
    const result = run({ mode: "preexisting" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("existing AppArmor profile");
    expect(readFileSync(join(root, "log"), "utf8")).toBe("");
    expect(readFileSync(join(root, "state"), "utf8")).toContain("auggy-m5-chromium-");
  });
  test("interruption while the parser installs still unloads the attempted owned profile", () => {
    expect(run({ mode: "interrupt-during-add" }).status).toBe(143);
    expect(readFileSync(join(root, "state"), "utf8")).toBe("");
    expect(readFileSync(join(root, "log"), "utf8")).toContain("--remove");
    expect(policyFiles()).toEqual([]);
  });
  test("changed policy bytes refuse privileged cleanup and remain visibly failed", () => {
    const result = run({ body: 'printf "# changed\\n" >> "$auggy_ci_userns_policy"' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Owned AppArmor policy changed");
    expect(result.stderr).toContain("cleanup failed");
    expect(readFileSync(join(root, "state"), "utf8")).toContain("auggy-m5-chromium-");
    expect(readFileSync(join(root, "log"), "utf8")).not.toContain("--remove");
    expect(policyFiles()).toHaveLength(1);
  });
  test.each([
    ["exit 17", 17],
    ["kill -TERM $$", 143],
    ["kill -INT $$", 130],
    ["kill -HUP $$", 129],
  ] as const)("%s retains the original failure after profile cleanup", (body, code) => {
    expect(run({ body }).status).toBe(code);
    expect(readFileSync(join(root, "state"), "utf8")).toBe("");
    expect(policyFiles()).toEqual([]);
    expect(existsSync(browser)).toBe(true);
  });
  test("unload failure is truthful and retains owned policy and build inputs", () => {
    const result = run({ mode: "fail-remove" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cleanup failed");
    expect(readFileSync(join(root, "state"), "utf8")).toContain("auggy-m5-chromium-");
    expect(policyFiles()).toHaveLength(1);
    expect(existsSync(browser)).toBe(true);
  });
  test.each(["inventory-newline-after-add", "inventory-unicode-after-add"])(
    "%s cannot falsely certify cleanup from a truncated inventory",
    (mode) => {
      const result = run({ mode });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("inventory exceeded its bound");
      expect(result.stderr).toContain("cleanup failed");
      expect(readFileSync(join(root, "state"), "utf8")).toContain("auggy-m5-chromium-");
      expect(policyFiles()).toHaveLength(1);
    },
  );
});
