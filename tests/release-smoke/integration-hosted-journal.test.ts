import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openHostedActionJournal } from "../../scripts/release-smoke/integration-hosted-journal";
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hosted-journal-"));
  directories.push(directory);
  const manifestBytes = Buffer.from(
    JSON.stringify({
      version: 1,
      actions: [
        {
          id: "allocate",
          phase: "execution",
          operation: "project-create",
          inputs: { project: "owned-new-project" },
        },
        {
          id: "deploy",
          phase: "execution",
          operation: "managed-deploy",
          inputs: { service: "http" },
        },
        { id: "cleanup-project", phase: "cleanup", operation: "project-delete", inputs: {} },
        { id: "cleanup-key", phase: "cleanup", operation: "key-delete", inputs: {} },
      ],
    }),
  );
  return {
    directory,
    runId: "owned-run",
    planSHA256: "a".repeat(64),
    manifestBytes,
    manifestSHA256: createHash("sha256").update(manifestBytes).digest("hex"),
    actionCount: 4,
  };
}
test("reopening preserves the immutable start time and exclusive claims/outcomes", () => {
  const options = fixture();
  const first = openHostedActionJournal(options);
  const start = first.run().startedAt;
  first.claim("allocate", "project-create", "b".repeat(64));
  first.finish("allocate", "confirmed", "c".repeat(64));
  first.close();
  const second = openHostedActionJournal(options);
  try {
    expect(second.run().startedAt).toBe(start);
    expect(second.observe("allocate").state).toBe("confirmed");
    expect(() => second.claim("allocate", "project-create", "b".repeat(64))).toThrow(
      "already claimed",
    );
    expect(() => second.finish("allocate", "confirmed", "c".repeat(64))).toThrow("another outcome");
    second.claim("deploy", "managed-deploy", "d".repeat(64));
  } finally {
    second.close();
  }
});
test("unknown mutation blocks subsequent execution and replay but allows ordered cleanup", () => {
  const options = fixture();
  const journal = openHostedActionJournal(options);
  try {
    expect(() => journal.claim("deploy", "managed-deploy", "b".repeat(64))).toThrow("Earlier");
    journal.claim("allocate", "project-create", "b".repeat(64));
    expect(journal.observe("allocate").state).toBe("unknown");
    expect(() => journal.claim("allocate", "project-create", "b".repeat(64))).toThrow(
      "already claimed",
    );
    expect(() => journal.claim("deploy", "managed-deploy", "b".repeat(64))).toThrow("Earlier");
    expect(() => journal.claim("cleanup-key", "key-delete", "b".repeat(64))).toThrow(
      "Earlier cleanup",
    );
    journal.claim("cleanup-project", "project-delete", "b".repeat(64));
    journal.finish("cleanup-project", "unknown", "c".repeat(64));
    journal.claim("cleanup-key", "key-delete", "b".repeat(64));
    journal.finish("cleanup-key", "skipped", "c".repeat(64));
    expect(() => journal.claim("deploy", "managed-deploy", "b".repeat(64))).toThrow(
      "cleanup already",
    );
  } finally {
    journal.close();
  }
});
test("plan, operation and on-disk identity changes fail before another claim", () => {
  const options = fixture();
  const journal = openHostedActionJournal(options);
  try {
    expect(() => openHostedActionJournal({ ...options, planSHA256: "b".repeat(64) })).toThrow(
      "another run",
    );
    expect(() => openHostedActionJournal({ ...options, manifestSHA256: "b".repeat(64) })).toThrow(
      "differs from approval",
    );
    expect(() => journal.claim("allocate", "project-delete", "b".repeat(64))).toThrow(
      "operation differs",
    );
    expect(() => journal.claim("unapproved", "project-create", "b".repeat(64))).toThrow(
      "Unapproved",
    );
    journal.claim("allocate", "project-create", "b".repeat(64));
    expect(() => journal.finish("allocate", "skipped", "c".repeat(64))).toThrow(
      "cannot be skipped",
    );
    const path = join(options.directory, "run.json");
    const stored = JSON.parse(readFileSync(path, "utf8"));
    stored.startedAt++;
    writeFileSync(path, JSON.stringify(stored));
    expect(() => journal.run()).toThrow("clock or identity changed");
  } finally {
    journal.close();
  }
});
test("an independent opener cannot claim an already pending mutation", () => {
  const options = fixture();
  const first = openHostedActionJournal(options),
    second = openHostedActionJournal(options);
  try {
    first.claim("allocate", "project-create", "b".repeat(64));
    expect(() => second.claim("allocate", "project-create", "b".repeat(64))).toThrow(
      "already claimed",
    );
    expect(second.observe("allocate").state).toBe("unknown");
    first.finish("allocate", "failed", "c".repeat(64));
    expect(second.observe("allocate").state).toBe("failed");
  } finally {
    first.close();
    second.close();
  }
});
test("public directories and malformed manifests refuse", () => {
  const options = fixture();
  chmodSync(options.directory, 0o755);
  expect(() => openHostedActionJournal(options)).toThrow("private");
  chmodSync(options.directory, 0o700);
  expect(() => openHostedActionJournal({ ...options, actionCount: 3 })).toThrow("ambiguous");
});

test("an orphan outcome refuses admission before writing a mutation claim", () => {
  const options = fixture();
  const journal = openHostedActionJournal(options);
  try {
    writeFileSync(join(options.directory, "allocate.outcome.json"), "{}", { mode: 0o600 });
    expect(() => journal.claim("allocate", "project-create", "b".repeat(64))).toThrow("no claim");
    expect(existsSync(join(options.directory, "allocate.claim.json"))).toBe(false);
  } finally {
    journal.close();
  }
});
