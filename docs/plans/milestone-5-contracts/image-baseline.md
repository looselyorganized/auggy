# M5-00 — Bun image identity and execution-user evidence

Status: read-only baseline verification complete; root owns contract acceptance.
Observed on `2026-11-14` UTC from the isolated M5 worktree, based on merged main
`c39b746b4b743e5c29dab61a677026c10626d8b8`. No image was built or executed, no
Docker daemon was started, and no hosted resource or package was changed.

## Result

The current generated image inherits **container-visible UID 0 / GID 0** on both
`linux/amd64` and `linux/arm64`, when the operator/platform supplies no user
override. This follows from the actual registry configuration, final image
account files, and Docker's documented default-user behavior—not merely from
the absence of a `USER` line in Auggy's generator.

Both inspected image configurations omit `config.User`. Both final account sets
contain:

```text
/etc/passwd:
root:x:0:0:root:/root:/bin/sh
bun:x:1000:1000::/home/bun:/bin/sh

/etc/group:
root:x:0:root
bun:x:1000:bun
```

Creating the `bun` account does not select it as the execution user. Docker uses
root when no user is selected; its runtime user option can override that default.
The OCI image configuration describes user/group resolution against image account
files. [Docker execution-user reference](https://docs.docker.com/engine/containers/run/#user),
[OCI image configuration](https://github.com/opencontainers/image-spec/blob/main/config.md).

The inspected `src/cli/deploy/dockerfile.ts` selects `oven/bun:1.3.14-alpine`,
does not override `USER`, and replaces the base image entrypoint with Auggy's own
script. That script executes the installed CLI without switching user/group.
Its expected default therefore remains `0:0`; the presence of a base-image
entrypoint or a `bun` account does not imply privilege dropping.

## Registry identity

Image reference: `oven/bun:1.3.14-alpine`.

Observed OCI index digest:
`sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0`.

| Platform | Image manifest digest | Configuration digest |
| --- | --- | --- |
| `linux/amd64` | `sha256:efc5e42c7bedc1661ab0b7272c74c3ebf794f054297f530a62055f2d1a0eb662` | `sha256:c7b233855e038081984786c223bdcd7aa08ed8f974b40f8a9a444b4546e47756` |
| `linux/arm64` | `sha256:3c9ab1a521c82144dff537125695017a0480d3a13088fba7e012cfae0f63146f` | `sha256:bb03dc9f0724a6decf34994aac876876d1ab5e07c72371a4ed7a8466944617b2` |

All manifest/configuration bytes were hashed and checked against their registry
descriptors. Both configurations report the base entrypoint as
`/usr/local/bin/docker-entrypoint.sh` and the command as `/usr/local/bin/bun`.

All six layers per architecture were downloaded, digest/size checked and scanned
in order without filesystem extraction. Account-file replacements and applicable
whiteouts were tracked. The final `passwd` and `group` data come from:

| Platform | Final account-file layer |
| --- | --- |
| `linux/amd64` | `sha256:cf34dbd5e0ab03f713e02ef49ab5525718e0381241fe29bae7897cd0be7081f7` |
| `linux/arm64` | `sha256:a5477bc236cbad64e7a9c2b2c83cd009778dbbd2ca448f66b8dd35548564de61` |

The complete scan observed 86,462,724 compressed bytes, 203,970,773 declared
regular payload bytes, and 1,128 tar entries. This also confirms that later layers
do not replace the account mappings cited above.

## Commands, limits and retained observations

The read-only probes used:

```sh
docker version --format '{{json .Server}}'
python3 /private/tmp/m5-image-config-inspect.py
python3 /private/tmp/m5-image-account-inspect.py
```

The Docker command was wrapped in a ten-second subprocess timeout. Registry
inspection used the public Docker Hub pull-token flow, followed by these exact
request families:

```text
GET https://auth.docker.io/token?service=registry.docker.io&scope=repository:oven/bun:pull
GET https://registry-1.docker.io/v2/oven/bun/manifests/1.3.14-alpine
GET https://registry-1.docker.io/v2/oven/bun/manifests/<platform-manifest-digest>
GET https://registry-1.docker.io/v2/oven/bun/blobs/<configuration-or-layer-digest>
```

The short-lived public pull token stayed in process memory and was never printed
or saved. HTTPS verification remained enabled; cross-origin redirects removed
the Authorization header and non-HTTPS redirects were refused. The first attempt
failed because the Python installation lacked a usable default CA bundle; the
successful attempt explicitly used `/etc/ssl/cert.pem`, without disabling TLS.

Configuration requests had eight-second request timeouts, 2 MiB response limits,
and a 60-second outer process timeout. Layer inspection had ten-second request
timeouts and a 90-second outer process timeout, with 48 MiB per-layer / 96 MiB
total compressed limits, 256 MiB per-layer / 512 MiB total declared payload
limits, 20,000 entries maximum, and 64 KiB maximum per account file. Archive paths
were validated, relevant account entries had to be ordinary files, and no tar
member was extracted to disk. Only bounded account records were retained.

Local evidence files, mode `0600`:

- `/private/tmp/m5-image-config-evidence.json`: index/platform/config digests,
  configured user, command/entrypoint, build history and layer descriptors.
- `/private/tmp/m5-image-account-evidence.json`: account entries, winning layers,
  every scanned layer's digest and byte counts, aggregate entry/byte counts.

## Platform and ownership limits

The Docker CLI exists at `/usr/local/bin/docker`. Its server probe returned
exit code 1 and `null`, reporting that `~/.docker/run/docker.sock` does not exist.
Local container execution is therefore unavailable in this environment at the
time of inspection. This is not a failed container test and not proof that the
generated image runs. A12 still requires real Docker build/run evidence, using
Linux CI if the local daemon remains unavailable.

Freeze the existing default container-user compatibility as `0:0`. For this
default, an admitted private data root must be owned by container-visible UID 0;
0700 is the required directory mode. A default newly provisioned root-owned
volume normally has GID 0 as well, but this inspection does not establish any
particular Railway volume's ownership or mode. C2's narrowly admitted empty-volume
initialization and fresh-volume tests remain required.

Do not hard-code UID 0 into platform-neutral admission: direct/local launches
must continue to validate ownership against their actual runtime identity.
Rootless engines, user namespaces, explicit `--user`, and platform user overrides
can alter host mappings or effective identity; arbitrary-UID support is not
certified here. Do not infer a host-side `chown 0:0` recipe from container-visible
IDs or recursively repair an existing volume.

The observed tag is not a promise of immutable registry content. Build acceptance
must attribute the actual resolved image digest. Pinning the observed index or
re-verifying any changed image is a root-owned deployment decision; changing the
execution user is a separate compatibility change, not an incidental M5 default.
