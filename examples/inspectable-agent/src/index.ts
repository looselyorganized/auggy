import { resolve } from "node:path";
import { runApplication, type ApplicationMain } from "auggy/application";
import { composeAgent } from "./agent";
import { configureHttp } from "./http";
import { observeStartup } from "./observability";

const startupLabel = "inspectable-agent";

export const main: ApplicationMain = async (launch) => {
  // The runner owns cleanup before prepare acquires claims or creates augments.
  const host = launch.createHost({ compose: composeAgent });
  const prepared = await host.prepare();
  const ready = await host.start({ http: prepared.http.map(configureHttp) });
  observeStartup({
    label: startupLabel,
    mode: launch.mode,
    bindings: ready.http.map(({ name, port }) => ({ name, port })),
    appSource: import.meta.url,
    processEntry: process.argv[1] ? resolve(process.argv[1]) : null,
    applicationModule: import.meta.resolve("auggy/application"),
  });
};

// CLI launches import named main; direct launches invoke the same managed runner.
if (import.meta.main) {
  await runApplication(main, {
    config: new URL("../agent.yaml", import.meta.url),
    entrypoint: import.meta.url,
  });
}
