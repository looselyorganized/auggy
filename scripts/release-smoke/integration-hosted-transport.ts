/** Isolated native SSH transport. Argument preparation never grants hosted approval. */
import { closeSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inspectPinnedFile, pinDirectory, readPinnedFile } from "../../src/lib/anchored-files";
import { APPLICATION_BOUNDS, startApplicationChild } from "./application-child";
import {
  assertHostedInstanceBinding,
  assertHostedIntegrationApproval,
  type HostedDeploymentBinding,
  type HostedIntegrationPlan,
} from "./integration-hosted";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Only an exact ED25519 public blob; comments never enter identity or evidence. */
export function hostedSshPublicIdentity(publicLine: string) {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]{0,160})?\n?$/.exec(publicLine);
  check(match, "Hosted SSH public key is malformed");
  const bytes = Buffer.from(match[1]!, "base64");
  check(
    bytes.length === 51 &&
      bytes.toString("base64") === match[1] &&
      bytes.readUInt32BE(0) === 11 &&
      bytes.subarray(4, 15).toString() === "ssh-ed25519" &&
      bytes.readUInt32BE(15) === 32,
    "Hosted SSH public key blob is malformed",
  );
  const hash = createHash("sha256").update(bytes).digest();
  return {
    publicKeySHA256: hash.toString("hex"),
    fingerprint: `SHA256:${hash.toString("base64").replace(/=+$/, "")}`,
  };
}

export function prepareHostedSshArguments(options: {
  ssh: HostedIntegrationPlan["ssh"];
  authDirectory: string;
  instanceId: string;
  remoteEntry: string;
  remoteEntrySHA256: string;
}) {
  check(
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.instanceId),
    "Hosted SSH requires an exact instance UUID",
  );
  check(
    [
      "/app/src/g4-remote/remote-command.js",
      "/app/src/fixtures/g4-maintenance/remote-command.js",
    ].includes(options.remoteEntry) && /^[a-f0-9]{64}$/.test(options.remoteEntrySHA256),
    "Hosted remote entry is not a fixed reviewed fixture",
  );
  check(
    options.ssh.scope === "workspace" &&
      options.ssh.relay.hostname === "ssh.railway.com" &&
      options.ssh.relay.port === 22 &&
      options.ssh.relay.trust === "explicit-first-use-pin" &&
      options.ssh.relay.providerAuthenticated === false,
    "Hosted SSH trust policy differs from the reviewed first-use pin",
  );
  const directory = pinDirectory(options.authDirectory, "Hosted SSH identity directory");
  try {
    check(
      /^\/[A-Za-z0-9_./-]+$/.test(directory.canonical),
      "Hosted SSH identity path contains option expansion characters",
    );
    const stat = fstatSync(directory.fd);
    check((stat.mode & 0o777) === 0o700, "Hosted SSH identity directory must be private");
    for (const name of ["identity", "identity.pub", "known_hosts"]) {
      const file = inspectPinnedFile(directory.fd, name, "Hosted SSH identity input");
      check(file, "Hosted SSH identity input is missing");
      try {
        check(
          (file.stat.mode & 0o777) === 0o600 && file.stat.size > 0 && file.stat.size <= 16_384,
          "Hosted SSH identity input must be bounded and private",
        );
      } finally {
        closeSync(file.fd);
      }
    }
    const publicKey = hostedSshPublicIdentity(
      readPinnedFile(directory.fd, "identity.pub", "Hosted public key", 16_384).toString("utf8"),
    );
    check(
      publicKey.publicKeySHA256 === options.ssh.publicKeySHA256 &&
        publicKey.fingerprint === options.ssh.fingerprint,
      "Hosted SSH public key differs from approval",
    );
    const knownHosts = readPinnedFile(directory.fd, "known_hosts", "Hosted relay pin", 16_384);
    const line = /^ssh\.railway\.com (ssh-ed25519 [A-Za-z0-9+/]+={0,2})\n$/.exec(
      knownHosts.toString("utf8"),
    );
    check(line, "Hosted relay pin contains an unexpected host or key");
    const relay = hostedSshPublicIdentity(line[1]!);
    check(
      createHash("sha256").update(knownHosts).digest("hex") ===
        options.ssh.relay.knownHostsSHA256 &&
        relay.publicKeySHA256 === options.ssh.relay.publicKeySHA256 &&
        relay.fingerprint === options.ssh.relay.fingerprint,
      "Hosted relay pin differs from approval",
    );
    const command = [
      "/usr/bin/ssh",
      "-F",
      "/dev/null",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "IdentityAgent=none",
      "-o",
      `UserKnownHostsFile=${join(directory.canonical, "known_hosts")}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "HostKeyAlgorithms=ssh-ed25519",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ProxyCommand=none",
      "-o",
      "ProxyJump=none",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "ControlPersist=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=2",
      "-i",
      join(directory.canonical, "identity"),
      `${options.instanceId}@ssh.railway.com`,
      `exec /usr/local/bin/bun --no-env-file --no-install --config=/dev/null ${options.remoteEntry} ${options.remoteEntrySHA256}`,
    ];
    return {
      command,
      directory: directory.canonical,
      directoryIdentity: { dev: stat.dev, ino: stat.ino },
      observedSsh: {
        publicKeySHA256: publicKey.publicKeySHA256,
        relayPublicKeySHA256: relay.publicKeySHA256,
        knownHostsSHA256: options.ssh.relay.knownHostsSHA256,
      },
    };
  } finally {
    closeSync(directory.fd);
  }
}

/** Local completion is not remote cleanup: caller must validate the durable remote receipt. */
export async function runHostedSshTransport(options: {
  gate: Parameters<typeof assertHostedIntegrationApproval>[0];
  binding: HostedDeploymentBinding;
  /** Caller uses the owned API supervisor with a maximum 15-second deadline. */
  refreshDeployment: (deploymentId: string) => Promise<unknown>;
  authDirectory: string;
  remoteEntry: string;
  remoteEntrySHA256: string;
  input: Uint8Array;
  secrets: readonly string[];
}) {
  check(
    options.input instanceof Uint8Array &&
      options.input.byteLength <= APPLICATION_BOUNDS.outputBytes,
    "Hosted command input exceeded its bound",
  );
  const input = Buffer.from(options.input);
  const inputSHA256 = createHash("sha256").update(input).digest("hex");
  assertHostedIntegrationApproval({ ...options.gate, now: Date.now() });
  const prepared = prepareHostedSshArguments({
    ssh: options.gate.prepared.plan.ssh,
    authDirectory: options.authDirectory,
    instanceId: options.binding.instanceId,
    remoteEntry: options.remoteEntry,
    remoteEntrySHA256: options.remoteEntrySHA256,
  });
  const readback = await options.refreshDeployment(options.binding.deploymentId);
  assertHostedInstanceBinding({
    prepared: options.gate.prepared,
    binding: options.binding,
    selectedInstanceId: options.binding.instanceId,
    readback,
  });
  const current = prepareHostedSshArguments({
    ssh: options.gate.prepared.plan.ssh,
    authDirectory: options.authDirectory,
    instanceId: options.binding.instanceId,
    remoteEntry: options.remoteEntry,
    remoteEntrySHA256: options.remoteEntrySHA256,
  });
  check(
    JSON.stringify(current) === JSON.stringify(prepared),
    "Hosted SSH identity directory changed during admission",
  );
  assertHostedIntegrationApproval({ ...options.gate, now: Date.now() });
  const limits = options.gate.prepared.plan.limits;
  const phaseEnd =
    options.gate.startedAt +
    (limits.maxRunSeconds + (options.gate.phase === "cleanup" ? limits.cleanupReserveSeconds : 0)) *
      1000;
  const commandMs = limits.remoteCommandSeconds * 1000;
  check(
    Date.now() + commandMs + APPLICATION_BOUNDS.reapMs <=
      Math.min(phaseEnd, Date.parse(options.gate.approval.expiresAt)),
    "Insufficient approved time to run and reap a hosted command",
  );
  const local = await startApplicationChild({
    command: current.command,
    cwd: current.directory,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC", TERM: "dumb" },
    secrets: options.secrets,
    input,
    timeoutMs: commandMs,
  }).finish();
  const after = prepareHostedSshArguments({
    ssh: options.gate.prepared.plan.ssh,
    authDirectory: options.authDirectory,
    instanceId: options.binding.instanceId,
    remoteEntry: options.remoteEntry,
    remoteEntrySHA256: options.remoteEntrySHA256,
  });
  check(JSON.stringify(after) === JSON.stringify(prepared), "Hosted SSH identity inputs changed");
  return { local, inputSHA256 };
}
