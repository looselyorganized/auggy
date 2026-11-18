/** Lifecycle test process: real host, resolver, agent and managed signal owner. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runManagedApplication } from "../../src/application/runner";
import { contractComposer, contractTurnProgram } from "./application-contract";

const [project, scenario, assembly] = process.argv.slice(2);
if (!project || !scenario) throw new Error("fixture arguments required");
await runManagedApplication(
  async (launch) => {
    if (assembly === "phased") {
      const host = launch.createHost();
      const config = await host.prepareConfiguration();
      const model = await host.createModel(config);
      const augments = await host.createAugments(config);
      const agent = host.createAgent({ config, model, augments, turnProgram: contractTurnProgram });
      for (const transport of host.transportsFrom(augments)) host.bindTransport(transport, agent);
      const http = host.httpBindings(agent).map((web) =>
        web.createListener({
          routes: [{ method: "POST", path: "/agent/run", handle: web.agentRun }],
          fallback: web.fallback,
        }),
      );
      await host.start({ agent, http });
      if (scenario === "startup-throw") throw new Error("fixture startup failure");
      return;
    }
    const host = launch.createHost({ compose: contractComposer });
    const prepared = await host.prepare();
    await host.start({
      http: prepared.http.map((web) =>
        web.createListener({
          routes: [{ method: "POST", path: "/agent/run", handle: web.agentRun }],
          fallback: web.fallback,
        }),
      ),
    });
    if (scenario === "startup-throw") throw new Error("fixture startup failure");
  },
  {
    configPath: join(project, "agent.yaml"),
    mode: "foreground",
    auggyDir: join(project, "registry"),
    lifetime: scenario === "return-after-ready" ? "return-after-ready" : "until-shutdown",
    onReady: () => {
      writeFileSync(join(project, "ready"), "ready\n");
    },
  },
);
writeFileSync(join(project, "returned"), "returned\n");
