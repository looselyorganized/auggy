import { expect, test } from "bun:test";
import { normalizeCloudRecord, validateCloudRecord } from "../../../src/cli/deploy/cloud-record";

const agentId = "aug1_00000000-0000-4000-8000-000000000001";
const v1 = {
  version: 1,
  agentId,
  provider: "railway",
  projectId: "project-name",
  serviceId: "service-name",
  volumeId: "volume-name",
  deployedAt: "2026-11-13T01:00:00.000Z",
  url: "https://agent.example/",
};

test("legacy records normalize in memory while v2 binds ingress to URL availability", () => {
  const before = JSON.stringify(v1);
  expect(normalizeCloudRecord(validateCloudRecord(v1, agentId))).toMatchObject({
    recordVersion: 1,
    profile: { kind: "http", port: 8080, healthPath: "/health", consolePath: "/console" },
    url: "https://agent.example",
  });
  expect(JSON.stringify(v1)).toBe(before);
  const worker = { ...v1, version: 2, profile: { kind: "none" }, url: null };
  expect(normalizeCloudRecord(validateCloudRecord(worker, agentId))).toMatchObject({
    recordVersion: 2,
    profile: { kind: "none" },
    url: null,
  });
  const http = {
    ...v1,
    version: 2,
    profile: { kind: "http", port: 8081, healthPath: null, consolePath: null },
  };
  expect(normalizeCloudRecord(validateCloudRecord(http, agentId))).toMatchObject({
    recordVersion: 2,
    profile: http.profile,
    url: "https://agent.example",
  });
});

test("malformed and unbound metadata cannot select a cloud target", () => {
  for (const record of [
    null,
    [],
    { ...v1, version: undefined },
    { ...v1, version: 3 },
    { ...v1, agentId: "other" },
    { ...v1, projectId: 3 },
    { ...v1, serviceId: {} },
    { ...v1, volumeId: " " },
    { ...v1, serviceId: "line\nbreak" },
    { ...v1, projectId: "x".repeat(257) },
    { ...v1, deployedAt: "invalid" },
    { ...v1, surprise: "field" },
    ...[
      "javascript:alert(1)",
      "https://user:pass@agent.example",
      "https://agent.example/path",
      "https://agent.example?",
      "https://agent.example#",
      "https://agent.example/../",
      "https://agent.example/\\evil",
    ].map((url) => ({ ...v1, url })),
    { ...v1, version: 2, profile: { kind: "none" } },
    { ...v1, version: 2, profile: { kind: "none", port: 8080 }, url: null },
    {
      ...v1,
      version: 2,
      profile: { kind: "http", port: 8080, healthPath: "/health", consolePath: null },
      url: null,
    },
  ])
    expect(() => validateCloudRecord(record, agentId)).toThrow(/metadata/);
});
