import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { ParsedConfig, PidManifest } from "../cli/types";
import {
  claimAgentLifecycle,
  claimRuntimePidManifest,
  formatAgentAlreadyRunningMessage,
  getProcessIdentity,
  readLaunchdGenerationState,
  readPidManifest,
  releaseRuntimePidManifest,
} from "../cli/pid-registry";
import { prepareRailwayRuntimeVolume } from "../cli/runtime-volume";
import { runtimeResourceClaims } from "../cli/runtime-resource-claims";
import type { ApplicationLaunch } from "../types";

/** Only the validated package launcher/operator path constructs these options. */
export interface RuntimeOwnershipOptions {
  mode: ApplicationLaunch["mode"];
  auggyDir?: string;
  processIdentityForPid?: (pid: number) => string | null;
  /** Existing restart path already holds the operator's lifecycle fence. */
  lifecycleOwned?: boolean;
}

export function acquireRuntimeOwnership(
  configPath: string,
  config: ParsedConfig,
  options: RuntimeOwnershipOptions,
  retain?: (ownership: { readonly runtimeDataRoot?: string; release(): void }) => void,
): { runtimeDataRoot?: string; release(): void } {
  const internalMode =
    options.mode === "railway" || options.mode === "launchd" ? options.mode : undefined;
  const mode = internalMode === "launchd" ? "launchd" : "dev";
  const launchGeneration = mode === "launchd" ? process.env.AUGGY_LAUNCH_GENERATION : undefined;
  if (
    mode === "launchd" &&
    (!launchGeneration ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        launchGeneration,
      ))
  ) {
    throw new Error("[runtime] launchd mode requires a valid installation generation");
  }
  let volume: ReturnType<typeof prepareRailwayRuntimeVolume> | null = null;
  const registry = {
    auggyDir: options.auggyDir,
    processIdentityForPid: options.processIdentityForPid,
  };
  let manifest: PidManifest | undefined;
  let claimed = false;
  let released = false;
  let releaseAdmission = () => {};
  const release = () => {
    if (released) return;
    if (manifest) releaseRuntimePidManifest(manifest, claimed, registry);
    volume?.release();
    released = true;
  };
  const ownership = {
    get runtimeDataRoot() {
      return volume?.runtimeDataRoot;
    },
    release,
  };
  retain?.(ownership);
  try {
    if (internalMode === "railway")
      volume = prepareRailwayRuntimeVolume(process.env.RAILWAY_VOLUME_MOUNT_PATH, config.id);
    if (mode === "dev" && !options.lifecycleOwned) {
      releaseAdmission = claimAgentLifecycle(config.id, config.name, registry);
    }
    if (mode === "dev" && readLaunchdGenerationState(config.id, registry)?.active) {
      throw new Error(
        `[runtime] foreground admission is blocked by an active launchd installation. Run "auggy stop ${config.id}" before starting dev mode.`,
      );
    }
    const processIdentity = (options.processIdentityForPid ?? getProcessIdentity)(process.pid);
    if (!processIdentity)
      throw new Error("[runtime] unable to verify the current OS process incarnation");
    const agentDir = dirname(configPath);
    const web = config.augments.find((augment) => augment.type === "webTransport");
    manifest = {
      pid: process.pid,
      name: config.name,
      agentId: config.id,
      claimNonce: randomUUID(),
      processIdentity,
      resourceClaims: runtimeResourceClaims(config, agentDir),
      resourceClaimStore: "sqlite-v1",
      ...(launchGeneration ? { launchGeneration } : {}),
      port: web ? (web.options!.port as number) : null,
      configPath: resolve(configPath),
      agentDir: resolve(agentDir),
      startedAt: new Date().toISOString(),
      mode,
    };
    claimed = claimRuntimePidManifest(manifest, { ...registry, internalMode });
  } catch (error) {
    release();
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        formatAgentAlreadyRunningMessage(config.name, readPidManifest(config.id, registry)),
      );
    }
    throw error;
  } finally {
    releaseAdmission();
  }
  return ownership;
}
