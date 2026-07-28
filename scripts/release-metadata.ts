import { appendFileSync } from "node:fs";

const numericIdentifier = "(?:0|[1-9][0-9]*)";
const alphanumericIdentifier = "(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const prereleaseIdentifier = `(?:${numericIdentifier}|${alphanumericIdentifier})`;
const releaseTagPattern = new RegExp(
  `^v(${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier})(?:-(${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*))?$`,
);

export interface ReleaseMetadata {
  version: string;
  npmTag: "latest" | "next";
  prerelease: boolean;
}

export function resolveReleaseMetadata(tag: string): ReleaseMetadata {
  const match = releaseTagPattern.exec(tag);
  if (!match) {
    throw new Error(
      "release tag must be exact vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-PRERELEASE without build metadata",
    );
  }

  const stableVersion = match[1];
  if (!stableVersion) {
    throw new Error("release tag did not contain a semantic version");
  }
  const version = match[2] ? `${stableVersion}-${match[2]}` : stableVersion;
  const prerelease = match[2] !== undefined;
  return {
    version,
    npmTag: prerelease ? "next" : "latest",
    prerelease,
  };
}

if (import.meta.main) {
  const tag = process.argv[2];
  if (!tag) {
    throw new Error("usage: bun scripts/release-metadata.ts <release-tag>");
  }

  const metadata = resolveReleaseMetadata(tag);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      [
        `version=${metadata.version}`,
        `npm_tag=${metadata.npmTag}`,
        `is_prerelease=${metadata.prerelease}`,
        "",
      ].join("\n"),
    );
  } else {
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
  }
}
