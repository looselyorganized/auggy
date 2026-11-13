/** Lifecycle test process: real host, resolver, agent and managed signal owner. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runManagedApplication } from "../../src/application/runner";
import { contractComposer } from "./application-contract";

const [project, scenario] = process.argv.slice(2);
if (!project || !scenario) throw new Error("fixture arguments required");
await runManagedApplication(
  async (launch) => {
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
