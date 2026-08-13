import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("packed release smoke dependency ordering", () => {
  test("installs same-release adapter prerequisites before their consumer", () => {
    const source = readFileSync(join(import.meta.dir, "../../scripts/release-smoke.sh"), "utf8");
    const prerequisiteInstall = source.indexOf(
      'bun add --offline --no-summary "$prerequisite_tarball"',
    );
    const prerequisiteOverride = source.indexOf("manifest.overrides[packageName] = tarball");
    const adapterInstall = source.indexOf('bun add --offline --no-summary "$adapter_tarball"');
    const openRouterInvocation = source.indexOf('"$OPENROUTER_TARBALL" "$OPENAI_TARBALL"');

    expect(prerequisiteInstall).toBeGreaterThan(-1);
    expect(prerequisiteOverride).toBeGreaterThan(-1);
    expect(prerequisiteInstall).toBeGreaterThan(prerequisiteOverride);
    expect(adapterInstall).toBeGreaterThan(prerequisiteInstall);
    expect(openRouterInvocation).toBeGreaterThan(adapterInstall);
  });
});
