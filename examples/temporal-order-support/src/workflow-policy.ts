import { ActivityCancellationType } from "@temporalio/workflow";

/**
 * Deployment-owned Activity policy. It is versioned with Workflow code rather
 * than supplied as a Workflow argument, so an application or model cannot
 * choose a task queue, target, credential, or retry behavior for a run.
 *
 * Change this only through a normal Temporal-compatible Worker deployment.
 */
export const orderSupportActivityPolicy = {
  startToCloseTimeout: "2 minutes",
  scheduleToCloseTimeout: "10 minutes",
  heartbeatTimeout: "15 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 3,
  },
} as const;
