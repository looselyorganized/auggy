import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAugments } from "../../src/cli/augment-resolver";

test("partial resolver failure reports once only after reverse shutdown actually settles", async () => {
  for (const failingCleanup of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "host-resolver-rollback-"));
    const events = join(root, "events");
    for (const name of ["first", "second"])
      writeFileSync(
        join(root, `${name}.ts`),
        `import { appendFileSync } from "node:fs";
      export default () => ({ name: "${name}", onShutdown: async () => {
        await Bun.sleep(5); appendFileSync(${JSON.stringify(events)}, "${name}\\n");
        ${failingCleanup && name === "second" ? 'throw new Error("private cleanup failure");' : ""}
      } });`,
      );
    writeFileSync(
      join(root, "broken.ts"),
      'export default () => { throw new Error("original factory failure"); };',
    );
    let reports = 0;
    let observed: unknown;
    try {
      await expect(
        resolveAugments(
          ["first", "second", "broken"].map((name) => ({
            name,
            type: "custom",
            source: `./${name}.ts`,
          })),
          root,
          {
            onConstructionRollback(report) {
              reports++;
              observed = {
                events: readFileSync(events, "utf8"),
                frozen: Object.isFrozen(report),
                report,
              };
              throw new Error("observer must not replace original error");
            },
          },
        ),
      ).rejects.toThrow("original factory failure");
      expect(reports).toBe(1);
      expect(observed).toEqual({
        events: "second\nfirst\n",
        frozen: true,
        report: {
          resources: failingCleanup ? "unknown" : "closed",
          failures: failingCleanup ? ["augment-shutdown-failed"] : [],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
