import { fileURLToPath } from "node:url";

import { NativeConnection, Worker } from "@temporalio/worker";

import { createOrderSupportActivities } from "./activities.js";
import { readOperatorConfig } from "./operator-config.js";

async function main(): Promise<void> {
  const config = readOperatorConfig();
  const connection = await NativeConnection.connect({
    address: config.temporal.address,
    apiKey: config.temporal.apiKey,
  });
  try {
    const worker = await Worker.create({
      connection,
      namespace: config.temporal.namespace,
      taskQueue: config.temporal.taskQueue,
      workflowsPath: fileURLToPath(new URL("./workflow.ts", import.meta.url)),
      activities: createOrderSupportActivities(config.auggy),
      shutdownGraceTime: "30 seconds",
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}

void main();
