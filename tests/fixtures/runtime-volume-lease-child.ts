import { prepareRuntimeVolumeLease } from "../../src/cli/runtime-volume";

const runtimeDataRoot = process.argv[2];
const agentId = process.argv[3];
if (!runtimeDataRoot || !agentId) throw new Error("runtime root and agent id are required");

prepareRuntimeVolumeLease({
  advertisedMount: runtimeDataRoot,
  runtimeDataRoot,
  agentId,
});
console.log("lease-acquired");
await Bun.sleep(60_000);
