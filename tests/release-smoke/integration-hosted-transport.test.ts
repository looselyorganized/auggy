import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostedIntegrationPlan } from "../../scripts/release-smoke/integration-hosted";
import {
  hostedSshPublicIdentity,
  prepareHostedSshArguments,
  runHostedSshTransport,
} from "../../scripts/release-smoke/integration-hosted-transport";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function publicKey(byte: number) {
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, byte),
  ]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}
function fixture() {
  const authDirectory = mkdtempSync(join(tmpdir(), "m5-ssh-transport-"));
  roots.push(authDirectory);
  chmodSync(authDirectory, 0o700);
  const publicLine = publicKey(1);
  const relayLine = publicKey(2);
  const knownHosts = `ssh.railway.com ${relayLine}\n`;
  // Argument preparation cannot authenticate. The private bytes are deliberately unusable.
  for (const [name, content] of Object.entries({
    identity: "synthetic-not-a-private-key",
    "identity.pub": `${publicLine} test-only\n`,
    known_hosts: knownHosts,
  })) {
    writeFileSync(join(authDirectory, name), content, { mode: 0o600 });
  }
  const ssh: HostedIntegrationPlan["ssh"] = {
    scope: "workspace",
    keyName: "synthetic-rehearsal",
    ...hostedSshPublicIdentity(publicLine),
    relay: {
      hostname: "ssh.railway.com",
      port: 22,
      trust: "explicit-first-use-pin",
      providerAuthenticated: false,
      ...hostedSshPublicIdentity(relayLine),
      knownHostsSHA256: hash(knownHosts),
    },
  };
  return {
    ssh,
    authDirectory,
    instanceId: "00000000-0000-4000-8000-000000000001",
    remoteEntry: "/app/src/g4-remote/remote-command.js",
    remoteEntrySHA256: "a".repeat(64),
  };
}

describe("hosted SSH admission; never connects to a server", () => {
  test("uses a single isolated identity and explicit pinned relay, with no ambient SSH behavior", () => {
    const input = fixture();
    const prepared = prepareHostedSshArguments(input);
    expect(prepared.command.slice(0, 5)).toEqual(["/usr/bin/ssh", "-F", "/dev/null", "-T", "-o"]);
    for (const option of [
      "BatchMode=yes",
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      "StrictHostKeyChecking=yes",
      "UpdateHostKeys=no",
      "GlobalKnownHostsFile=/dev/null",
      "HostKeyAlgorithms=ssh-ed25519",
      "ForwardAgent=no",
      "ClearAllForwardings=yes",
      "ProxyCommand=none",
      "ProxyJump=none",
      "PermitLocalCommand=no",
      "ControlMaster=no",
      "ControlPath=none",
      "ControlPersist=no",
    ])
      expect(prepared.command).toContain(option);
    expect(prepared.command.at(-2)).toBe(`${input.instanceId}@ssh.railway.com`);
    expect(prepared.command.at(-1)).toBe(
      `exec /usr/local/bin/bun --no-env-file --no-install --config=/dev/null ${input.remoteEntry} ${input.remoteEntrySHA256}`,
    );
    expect(prepared.observedSsh).toEqual({
      publicKeySHA256: input.ssh.publicKeySHA256,
      relayPublicKeySHA256: input.ssh.relay.publicKeySHA256,
      knownHostsSHA256: input.ssh.relay.knownHostsSHA256,
    });
    expect(JSON.stringify(prepared)).not.toContain("synthetic-not-a-private-key");
  });

  test("rejects shell, SSH option, path and malformed public key inputs", () => {
    const input = fixture();
    for (const instanceId of [
      "-oProxyCommand=evil",
      `${input.instanceId}@other.host`,
      `${input.instanceId}\n`,
    ])
      expect(() => prepareHostedSshArguments({ ...input, instanceId })).toThrow();
    for (const remoteEntry of [
      "/app/src/g4-remote/../../other",
      "/app/src/g4-remote/x;id",
      "/tmp/remote-command.js",
      "/app/src/g4-remote/x\n",
    ])
      expect(() => prepareHostedSshArguments({ ...input, remoteEntry })).toThrow();
    for (const remoteEntrySHA256 of ["a".repeat(63), `${"a".repeat(64)};id`, "A".repeat(64)])
      expect(() => prepareHostedSshArguments({ ...input, remoteEntrySHA256 })).toThrow();
    for (const key of [
      "ssh-rsa AAAA",
      "ssh-ed25519 AAAA",
      `${publicKey(1)}\n${publicKey(2)}`,
      `${publicKey(1)} extra\nline`,
      publicKey(1).replace("AAAAC3", "AAAAC4"),
    ])
      expect(() => hostedSshPublicIdentity(key)).toThrow();
    const changedTrust = structuredClone(input.ssh);
    changedTrust.relay.providerAuthenticated = true as false;
    expect(() => prepareHostedSshArguments({ ...input, ssh: changedTrust })).toThrow("trust");
  });

  test("refuses changed public identity, additional relay keys, and first-use pin rotation", () => {
    const input = fixture();
    writeFileSync(join(input.authDirectory, "identity.pub"), publicKey(3));
    expect(() => prepareHostedSshArguments(input)).toThrow("public key differs");
    writeFileSync(join(input.authDirectory, "identity.pub"), publicKey(1));
    const known = readFileSync(join(input.authDirectory, "known_hosts"));
    writeFileSync(join(input.authDirectory, "known_hosts"), `${known}${known}`);
    expect(() => prepareHostedSshArguments(input)).toThrow("unexpected host");
    writeFileSync(join(input.authDirectory, "known_hosts"), `ssh.railway.com ${publicKey(3)}\n`);
    expect(() => prepareHostedSshArguments(input)).toThrow("differs from approval");
  });

  test("requires private owned regular files and refuses symlinks and hard links", () => {
    const input = fixture();
    chmodSync(input.authDirectory, 0o755);
    expect(() => prepareHostedSshArguments(input)).toThrow("private");
    chmodSync(input.authDirectory, 0o700);
    for (const name of ["identity", "identity.pub", "known_hosts"]) {
      const path = join(input.authDirectory, name);
      const content = readFileSync(path);
      chmodSync(path, 0o644);
      expect(() => prepareHostedSshArguments(input)).toThrow("private");
      chmodSync(path, 0o600);
      linkSync(path, `${path}.link`);
      expect(() => prepareHostedSshArguments(input)).toThrow();
      unlinkSync(`${path}.link`);
      unlinkSync(path);
      writeFileSync(`${path}.target`, content, { mode: 0o600 });
      symlinkSync(`${path}.target`, path);
      expect(() => prepareHostedSshArguments(input)).toThrow();
      unlinkSync(path);
      writeFileSync(path, content, { mode: 0o600 });
    }
  });

  test("rejects missing approval before requesting any provider readback or spawning SSH", async () => {
    const input = fixture();
    let reads = 0;
    const options = {
      ...input,
      gate: { prepared: {} },
      binding: {},
      input: Buffer.from("{}"),
      secrets: [],
      refreshDeployment: async () => {
        reads++;
        throw new Error("Unexpected provider access");
      },
    };
    await expect(
      runHostedSshTransport(options as unknown as Parameters<typeof runHostedSshTransport>[0]),
    ).rejects.toThrow();
    expect(reads).toBe(0);
  });
});
