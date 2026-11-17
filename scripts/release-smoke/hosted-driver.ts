/** Actual installed-CLI lifecycle with the existing synthetic channel and recovery assertions. */
import {
  chmodSync,
  constants,
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { applicationArtifact } from "./application-artifacts";
import {
  assertInstalledApplicationArtifact,
  inspectApplicationArtifact,
} from "./application-consumer";
import { preflightHostedExport } from "./integration-consumer";
import {
  exportHostedMaintenanceBundle,
  importHostedMaintenanceBundle,
  prepareHostedMaintenanceFixtures,
  installHostedMaintenanceEntrypoint,
  type HostedRailwayMaintenanceStopped,
} from "./integration-hosted-maintenance";
import { createExternalAuthAssertion } from "../../src/auth/external-auth";
import { createSyntheticOrdersStore } from "../../examples/company-app/fixtures/synthetic-orders";
import {
  createScenarioControl,
  observeScenarioHttp,
  observeScenarioPolling,
} from "./hosted-channels";
import {
  createScenarioRailway,
  type ScenarioDeployment,
  type ScenarioService,
} from "./hosted-railway";
import { hostedCheck as check, hostedHash as hash, type HostedContext } from "./hosted-context";
import type { HostedScenario, HostedScenarioDriver } from "./hosted-scenarios";
import {
  assertHostedExpiredAssertion,
  assertHostedHttpFixture,
  observeHostedHttpHold,
  isFreshHostedHttpFixture,
  HOSTED_HTTP_RESTORE_HOLD_MS,
  HOSTED_HTTP_EXPIRY_PROBE_TTL_SECONDS,
} from "./hosted-http-recovery";

type Generation = "baseline" | "edited" | "restored";
type HttpResult = Awaited<ReturnType<typeof observeScenarioHttp>>;
const guardSchema = z
  .object({
    guard: z
      .object({
        latestRestore: z.object({
          restoreId: z.string().uuid(),
          restoredAtMs: z.number().int().positive(),
        }),
      })
      .passthrough(),
    guardSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough();
export function stoppedScenarioInstance(expectedId: string, instances: unknown[]) {
  const observed = z
    .array(
      z
        .object({ id: z.string().uuid(), status: z.enum(["STOPPED", "EXITED", "REMOVED"]) })
        .strict(),
    )
    .min(1)
    .max(100)
    .parse(instances);
  check(
    new Set(observed.map((i) => i.id)).size === observed.length,
    "Ambiguous stopped-instance history",
  );
  const instance = observed.find((i) => i.id === expectedId);
  check(instance, "Stopped instance identity changed");
  return instance;
}

export function createHostedDriver(
  ctx: HostedContext,
  scenario: HostedScenario,
): HostedScenarioDriver {
  const http = scenario === "http" || scenario === "recovery-http";
  const recovery = scenario.startsWith("recovery-");
  const profile = http
    ? { kind: "http" as const, port: 8080, healthPath: "/health", consolePath: null }
    : { kind: "none" as const };
  // Provider discovery/auth is deferred until after all local preparation passes.
  let railway: ReturnType<typeof createScenarioRailway> | undefined;
  const provider = () => {
    check(railway, "Provider was not allocated");
    return railway;
  };
  const consumers = new Map<string, string>();
  let current:
    | {
        service: ScenarioService;
        deployment: ScenarioDeployment;
        consumer: string;
        generationId: string;
        origin: string | null;
        sealedSHA256?: string;
        previousQuiescenceTimestamp?: string;
        maintenance: boolean;
      }
    | undefined;
  let stopped: HostedRailwayMaintenanceStopped | undefined;
  let baselineHttp: HttpResult | undefined, latestHttp: HttpResult | undefined;
  let pollingReceiptSHA256: string | undefined;
  let bundle: Awaited<ReturnType<typeof exportHostedMaintenanceBundle>> | undefined;
  let restored: z.infer<typeof guardSchema> | undefined;
  let generation = 0;
  const cli = (consumer: string) => [
    process.execPath,
    "--no-env-file",
    "--no-install",
    "--config=/dev/null",
    join(consumer, "node_modules/auggy/src/cli/index.ts"),
  ];
  const clone = (source: string, target: string) => {
    const base = resolve(source);
    cpSync(base, target, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (p) =>
        ![".env", ".auggy-cloud.json", ".git", "data"].includes(relative(base, p).split("/")[0]!),
    });
    chmodSync(target, 0o700);
  };
  const start = async (kind: Generation | "maintenance", recoveryService = false) => {
    check(!current, "Previous workload must be stopped before deployment");
    const p = provider(),
      service = p.service(recoveryService);
    await p.usage();
    const consumer = consumers.get(kind === "restored" ? "restored" : kind);
    check(consumer, "Consumer not prepared");
    const previous = await p.deployment(service);
    check(!previous || previous.deploymentStopped, "Previous deployment still active");
    const generationId = `m5-${kind}-${++generation}`;
    if (kind === "maintenance") {
      const native = Bun.which("railway");
      check(native, "Railway CLI missing");
      const context = join(ctx.root, "maintenance-context");
      await ctx.command("maintenance-link", [native, "link", "--project", service.projectId], {
        cwd: context,
      });
      await ctx.command("maintenance-service", [native, "service", "link", service.id], {
        cwd: context,
      });
      await ctx.command("maintenance-upload", [native, "up", "--detach", "--no-gitignore"], {
        cwd: context,
        timeoutMs: 120000,
      });
      await p.poll(
        "maintenance deployment",
        () => p.deployment(service),
        (d) => {
          if (d && ["FAILED", "CRASHED"].includes(d.status)) throw Error(`Maintenance ${d.status}`);
          return Boolean(
            d &&
              d.id !== previous?.id &&
              d.status === "SUCCESS" &&
              !d.deploymentStopped &&
              d.instances.length === 1 &&
              d.instances[0]!.status === "RUNNING",
          );
        },
        600000,
      );
    } else {
      const values = {
        ...ctx.variables,
        AUGGY_FIXTURE_GENERATION_ID: generationId,
        ...(http
          ? { AUGGY_FIXTURE_DOWNSTREAM_CHECKPOINT: latestHttp?.checkpointSHA256 ?? "empty" }
          : {}),
      };
      writeFileSync(
        join(consumer, ".env"),
        `${Object.entries(values)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join("\n")}\n`,
        { mode: 0o600 },
      );
      const source = kind === "edited" ? consumers.get("baseline") : undefined;
      if (source && existsSync(join(source, ".auggy-cloud.json")))
        cpSync(join(source, ".auggy-cloud.json"), join(consumer, ".auggy-cloud.json"));
      const args = [
        ...cli(consumer),
        "deploy",
        "--config",
        "agent.yaml",
        "--ingress",
        profile.kind,
        ...(http ? ["--port", "8080"] : []),
      ];
      if (!existsSync(join(consumer, ".auggy-cloud.json")))
        args.push("--project", service.projectId, "--service", service.id);
      args.push("--yes");
      const result = await ctx.command(`deploy-${kind}`, args, {
        cwd: consumer,
        timeoutMs: 780000,
        deployment: true,
      });
      check(
        result.stdout.includes(
          `Platform readiness: ready; HTTP readiness: ${http ? "ready" : "not-applicable"}; channel: unverified.`,
        ),
        "CLI did not report the selected readiness; inspect retained output",
      );
      const cloud = JSON.parse(readFileSync(join(consumer, ".auggy-cloud.json"), "utf8"));
      check(
        cloud.projectId === service.projectId &&
          cloud.serviceId === service.id &&
          cloud.volumeId === service.volumeId &&
          cloud.profile.kind === profile.kind,
        "Saved deployment target differs",
      );
      if (!http) check(cloud.url === null, "Polling service must not have a public URL");
    }
    const d = await p.running(service);
    check(d.id !== previous?.id, "Upload did not create a new deployment");
    const origin =
      kind === "maintenance"
        ? null
        : JSON.parse(readFileSync(join(consumer, ".auggy-cloud.json"), "utf8")).url;
    if (kind !== "maintenance") {
      const domains = await p.inspectDomains(service);
      if (http)
        check(
          domains.customDomains.length === 0 &&
            domains.serviceDomains.length === 1 &&
            domains.serviceDomains[0]!.targetPort === 8080 &&
            origin === `https://${domains.serviceDomains[0]!.domain}`,
          "Public HTTP domain/port differs from the saved target",
        );
      else
        check(
          domains.serviceDomains.length === 0 && domains.customDomains.length === 0,
          "Polling service unexpectedly exposes ingress",
        );
    }
    current = {
      service,
      deployment: d,
      consumer,
      generationId,
      origin,
      maintenance: kind === "maintenance",
    };
    ctx.save(`deployment-${generation}.json`, {
      ...d,
      service,
      generationId,
      origin,
      maintenance: kind === "maintenance",
    });
    return current;
  };
  const stopCurrent = async () => {
    check(current, "No active workload");
    const c = current,
      p = provider();
    const live = await p.deployment(c.service);
    check(live?.id === c.deployment.id, "Active deployment changed");
    await p.stop(c.service);
    const state = await p.deployment(c.service);
    check(
      state?.deploymentStopped &&
        state.instances.length > 0 &&
        state.instances.every((i) => ["STOPPED", "EXITED", "REMOVED"].includes(i.status)),
      "Exact instance did not stop",
    );
    const logs = await p.logs(c.deployment);
    check(
      !logs.some((l) => /activity-deadline-exceeded|lifetime-expired/.test(l.message)),
      "Fixture lifetime expired; result invalid",
    );
    if (!c.maintenance) {
      const observedInstance = stoppedScenarioInstance(c.deployment.instanceId, state.instances);
      const marker = http
        ? "auggy-hosted-http-fixtures:quiescent"
        : "auggy-telegram-container-fixtures:quiescent";
      const matching = logs.filter(
        (l) =>
          l.message === marker &&
          l.tags.deploymentInstanceId === c.deployment.instanceId &&
          l.timestamp !== c.previousQuiescenceTimestamp,
      );
      check(
        matching.length === 1 && c.sealedSHA256,
        "No unique quiescence marker or sealed operation receipt",
      );
      const proof = {
        provider: "railway" as const,
        projectId: c.service.projectId,
        environmentId: c.service.environmentId,
        serviceId: c.service.id,
        deploymentId: c.deployment.id,
        imageDigest: c.deployment.imageDigest,
        volumeId: c.service.volumeId,
        deploymentStopped: true as const,
        instances: [observedInstance],
        sealedGenerationReceiptSHA256: c.sealedSHA256,
        quiescenceReceiptSHA256: hash(JSON.stringify(matching)),
        observedAtMs: Date.now(),
      };
      stopped = { ...proof, controllerReceiptSHA256: hash(JSON.stringify(proof)) };
    }
    ctx.save(`stopped-${generation}.json`, { deployment: c.deployment, stopped, logs });
    current = undefined;
  };
  const maintenanceControl = () => {
    check(current?.maintenance, "Maintenance workload required");
    const control = createScenarioControl(ctx, current.deployment, current.consumer, true);
    return async (payload: Record<string, unknown>) => {
      const result = z.record(z.string(), z.unknown()).parse(await control("maintenance", payload));
      check(result.operation === payload.operation, "Maintenance acknowledgement differs");
      if (
        ["backup", "restore", "guard", "reconcile", "reconcile-worker"].includes(
          String(payload.operation),
        )
      )
        check(
          result.singletonLeaseAcquired === true,
          "Maintenance did not acquire singleton lease",
        );
      return result;
    };
  };
  return {
    async prepare() {
      const repo = resolve(import.meta.dir, "../..");
      const packages = [];
      for (const pkg of ctx.input.packages) {
        check(hash(readFileSync(pkg.path)) === pkg.sha256, "Selected package archive changed");
        packages.push(inspectApplicationArtifact(await applicationArtifact(pkg.path, pkg.name)));
      }
      let agentId: string | undefined;
      for (const [name, source] of [
        ["baseline", ctx.input.baselineConsumer],
        ["edited", ctx.input.editedConsumer],
        ["restored", recovery ? ctx.input.editedConsumer : undefined],
        ["maintenance", recovery ? ctx.input.maintenanceConsumer : undefined],
      ] as const) {
        if (!source) {
          check(name !== "maintenance" || !recovery, "Recovery requires a maintenance consumer");
          continue;
        }
        const target = join(ctx.root, "work", name);
        clone(source, target);
        consumers.set(name, target);
        for (const pkg of packages)
          assertInstalledApplicationArtifact(
            target,
            repo,
            pkg,
            pkg.packageName === "auggy" ? "auggy/application" : pkg.packageName,
          );
        const config = parse(readFileSync(join(target, "agent.yaml"), "utf8"));
        check(
          typeof config.id === "string" && (!agentId || agentId === config.id),
          "Scenario variants must preserve agent identity",
        );
        agentId = config.id;
        if (http) assertHostedHttpFixture(config);
        check(
          config.engine?.model === "integration-fixture-model" &&
            /^http:\/\/127\.0\.0\.1:43\d{3}$/.test(config.engine?.baseURL ?? ""),
          "Only the synthetic loopback provider fixture is permitted",
        );
        if (name !== "maintenance")
          await preflightHostedExport({
            consumer: target,
            profile,
            temporaryDirectory: join(ctx.root, "tmp"),
          });
      }
      if (recovery) {
        const consumer = consumers.get("maintenance")!;
        const destination = join(consumer, "src/fixtures/g4-maintenance");
        rmSync(destination, { recursive: true, force: true });
        const prepared = await prepareHostedMaintenanceFixtures(destination);
        const context = join(ctx.root, "maintenance-context");
        await ctx.command(
          "export-maintenance",
          [
            ...cli(consumer),
            "export",
            "docker",
            "--config",
            "maintenance.yaml",
            "--out",
            context,
            "--ingress",
            "none",
          ],
          { cwd: consumer, timeoutMs: 60000 },
        );
        installHostedMaintenanceEntrypoint(context, prepared);
      }
      ctx.save("preparation.json", {
        revision: ctx.input.revision,
        packages: ctx.input.packages.map((p) => ({ name: p.name, sha256: p.sha256 })),
        profile,
        consumers: Object.fromEntries(consumers),
        agentId,
        hostedResourcesCreated: false,
      });
    },
    async allocate(restore) {
      railway = createScenarioRailway(ctx);
      await railway.allocate(restore);
    },
    async exercise(kind) {
      let active = await start(kind, kind === "restored");
      if (kind === "restored" && http) {
        check(
          restored && latestHttp && baselineHttp && active.origin,
          "HTTP restoration prerequisites missing",
        );
        const until = restored.guard.latestRestore.restoredAtMs + HOSTED_HTTP_RESTORE_HOLD_MS;
        check(Date.now() + 5000 < until, "Restore hold already elapsed before observation");
        const policyStore = createSyntheticOrdersStore(":memory:");
        const policy = policyStore.authorizationFor({
          provider: "fixture-app",
          userId: "support-agent",
          orgId: "synthetic-company",
          roles: [],
        });
        policyStore.close();
        const mintAssertion = () =>
          createExternalAuthAssertion({
            secret: ctx.variables.AUGGY_AUTH_SECRET!,
            keyId: ctx.variables.AUGGY_AUTH_KEY_ID!,
            audience: ctx.variables.AUGGY_AUTH_AUDIENCE!,
            provider: "fixture-app",
            subject: "support-agent",
            orgId: "synthetic-company",
            ...policy,
            ttlSeconds: HOSTED_HTTP_EXPIRY_PROBE_TTL_SECONDS,
          });
        const assertion = mintAssertion();
        const post = async (origin: string, token = assertion) => {
          const r = await fetch(`${origin}/agent/run`, {
            method: "POST",
            redirect: "manual",
            signal: AbortSignal.timeout(5000),
            headers: {
              "content-type": "application/json",
              "x-auggy-auth-assertion": token,
              "idempotency-key": ctx.runId,
            },
            body: JSON.stringify({
              threadId: ctx.runId,
              messages: [
                {
                  id: ctx.runId,
                  role: "user",
                  content: "Simulate the authorized synthetic refund",
                },
              ],
            }),
          });
          const status = r.status,
            retryAfter = r.headers.get("retry-after");
          const body = await r.text();
          check(Buffer.byteLength(body) <= 1024, "Unexpected authentication error payload");
          return { status, retryAfter, body: JSON.parse(body) as unknown };
        };
        const control = createScenarioControl(ctx, active.deployment, active.consumer);
        const firstHold = await observeHostedHttpHold({
          control: (input) => control("http-control", input),
          checkpoint: latestHttp.checkpoint,
          generationId: active.generationId,
          request: () => post(active.origin!),
        });
        ctx.save("http-hold-first.json", firstHold);
        const held = firstHold.held;
        active.sealedSHA256 = hash(firstHold.sealedSnapshot);
        const before = active.deployment;
        const after = await provider().restart(
          active.service,
          before,
          async (deployment, deadline) => {
            const control = createScenarioControl(ctx, deployment, active.consumer);
            const snapshot = await control(
              "http-control",
              { operation: "snapshot" },
              { snapshotDeadline: deadline },
            );
            const fresh = isFreshHostedHttpFixture(snapshot, active.generationId);
            if (fresh)
              ctx.save("http-restart-fresh.json", { deployment, snapshot, freshProcess: true });
            return fresh;
          },
          Math.min(60000, until - Date.now() - 5000),
        );
        const logs = await provider().logs(before);
        const priorQuiescence = logs.filter(
          (l) =>
            l.tags.deploymentInstanceId === before.instanceId &&
            l.message === "auggy-hosted-http-fixtures:quiescent",
        );
        check(
          !logs.some((l) => /activity-deadline-exceeded|lifetime-expired/.test(l.message)) &&
            priorQuiescence.length === 1,
          "Pre-restart instance did not quiesce cleanly",
        );
        active.deployment = after;
        active.previousQuiescenceTimestamp =
          before.instanceId === after.instanceId ? priorQuiescence[0]!.timestamp : undefined;
        active.sealedSHA256 = undefined;
        check(
          active.origin && Date.now() + 5000 < until,
          "Restore hold expired before restart observation",
        );
        const restartedControl = createScenarioControl(ctx, active.deployment, active.consumer);
        const restartedHold = await observeHostedHttpHold({
          control: (input) => restartedControl("http-control", input),
          checkpoint: latestHttp.checkpoint,
          generationId: active.generationId,
          request: () => post(active.origin!, mintAssertion()),
        });
        ctx.save("http-hold-restart.json", {
          before,
          after,
          held,
          restartedHeld: restartedHold.held,
          holdUntilMs: until,
          rebuild: false,
          freshProcess: true,
          previousQuiescenceTimestamp: active.previousQuiescenceTimestamp,
        });
        active.sealedSHA256 = hash(restartedHold.sealedSnapshot);
        await stopCurrent();
        while (Date.now() <= until) {
          check(
            ctx.remaining() > until - Date.now() + 30000,
            "Insufficient remaining budget for hold",
          );
          await Bun.sleep(Math.min(30000, until - Date.now() + 1));
        }
        active = await start("restored", true);
        check(active.origin, "Restored origin missing");
        const expired = await post(active.origin);
        assertHostedExpiredAssertion(expired);
        ctx.save("http-held-expiry.json", { expired, assertionRetainedInMemoryOnly: true });
      }
      const control = createScenarioControl(ctx, active.deployment, active.consumer);
      if (http) {
        check(active.origin, "HTTP origin missing");
        const previous =
          latestHttp && baselineHttp
            ? {
                checkpoint: latestHttp.checkpoint,
                operationId: baselineHttp.operationId,
                threadId: baselineHttp.threadId,
              }
            : undefined;
        latestHttp = await observeScenarioHttp(
          ctx,
          control,
          active.origin,
          previous,
          kind !== "baseline",
          active.generationId,
        );
        if (kind === "baseline") baselineHttp = latestHttp;
        active.sealedSHA256 = hash(latestHttp.sealedSnapshot);
        ctx.save(`http-${kind}.json`, latestHttp);
      } else {
        const result = await observeScenarioPolling(control, kind, active.generationId);
        active.sealedSHA256 = hash(JSON.stringify(result.sealed));
        pollingReceiptSHA256 = active.sealedSHA256;
        ctx.save(`polling-${kind}.json`, result);
      }
    },
    stop: stopCurrent,
    async backup() {
      check(stopped, "Backup requires stopped app proof");
      const proof = stopped;
      await start("maintenance");
      const control = maintenanceControl();
      const made = await control({ operation: "backup", stopped: proof });
      bundle = await exportHostedMaintenanceBundle({
        directory: join(ctx.root, "bundle"),
        control: (payload) => control({ ...payload }),
      });
      check(bundle.manifestSHA256 === made.manifestSHA256, "Transferred backup manifest changed");
      ctx.save("backup.json", { ...bundle, stopped: proof });
      await stopCurrent();
    },
    async restore() {
      check(bundle && stopped, "Restore requires a bundle and stopped source proof");
      const proof = stopped;
      await start("maintenance", true);
      const control = maintenanceControl();
      await control({ operation: "prepare-empty-volume" });
      await importHostedMaintenanceBundle({
        directory: bundle.directory,
        control: (payload) => control({ ...payload }),
      });
      restored = guardSchema.parse(
        await control({
          operation: "restore",
          stopped: proof,
          destinationVolumeId: provider().service(true).volumeId,
        }),
      );
      const reconciled = guardSchema.parse(
        await control(
          http
            ? {
                operation: "reconcile",
                stopped: proof,
                restoreId: restored.guard.latestRestore.restoreId,
                downstreamCheckpointSHA256: latestHttp!.checkpointSHA256,
                unreplayedOperationId: latestHttp!.operationId,
                outcome: "preserved-downstream-not-retried",
              }
            : {
                operation: "reconcile-worker",
                stopped: proof,
                restoreId: restored.guard.latestRestore.restoreId,
                sealedGenerationReceiptSHA256: pollingReceiptSHA256,
                backupManifestSHA256: bundle.manifestSHA256,
                confirmedUpdateIds: [1, 2, 3],
              },
        ),
      );
      check(
        reconciled.guardSHA256 === restored.guardSHA256 &&
          JSON.stringify(reconciled.guard) === JSON.stringify(restored.guard),
        "Reconciliation rewrote restore guard",
      );
      ctx.save("restore.json", { guard: restored, reconciled });
      await stopCurrent();
    },
    async cleanup() {
      if (railway) await railway.cleanup();
    },
  };
}
