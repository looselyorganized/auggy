import { resolve } from "node:path";
import { runApplication, type ApplicationMain } from "auggy/application";
import { configureHttp } from "./http";
import { observeFinalization, observeStartup } from "./observability";
import { turnProgram } from "./turn";

const startupLabel = "inspectable-agent";

export const main: ApplicationMain = async (launch) => {
  // The runner owns every stage and cleanup, including startup failures.
  const runtime = launch.createHost();
  const config = await runtime.prepareConfiguration();
  const model = await runtime.createModel(config);
  const augments = await runtime.createAugments(config);
  const agent = runtime.createAgent({
    config,
    model,
    augments,
    turnProgram,
    onTurnFinalized: observeFinalization,
  });
  for (const transport of runtime.transportsFrom(augments)) {
    runtime.bindTransport(transport, agent);
  }
  const http = runtime.httpBindings(agent).map(configureHttp);
  const ready = await runtime.start({ agent, http });
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
