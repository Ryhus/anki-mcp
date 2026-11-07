import assert from "node:assert/strict";
import test from "node:test";
import {
  approvedPreflight, archiveIntegrity, checkLatestVersion, checkMcpVersion, checkNpmVersion,
  loadReleaseMetadata, MCP_REGISTRY, NPM_REGISTRY, parsePackReport, preflight,
  validateArchive, validateReleaseMetadata, verifyNpmDownload, waitForPublication,
} from "../scripts/release.js";
import type { PackReport, ReleaseMetadata } from "../scripts/release.js";

const metadata = await loadReleaseMetadata();
const bytes = Buffer.from("test release archive");
const integrity = archiveIntegrity(bytes);
const npmUrl = `${NPM_REGISTRY}/${encodeURIComponent(metadata.package.name)}`;
const versionUrl = `${npmUrl}/${metadata.package.version}`;
const mcpUrl = `${MCP_REGISTRY}/servers/${encodeURIComponent(metadata.server.name)}/versions/${metadata.server.version}`;
const tarballUrl = `${NPM_REGISTRY}/@ryhus/anki-mcp/-/anki-mcp-${metadata.package.version}.tgz`;
const publishedNpm = {
  name: metadata.package.name, version: metadata.package.version,
  mcpName: metadata.package.mcpName, dist: { integrity, tarball: tarballUrl },
};
const publishedMcp = {
  server: metadata.server,
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } },
};
const index = {
  versions: { [metadata.package.version]: publishedNpm },
  "dist-tags": { latest: metadata.package.version },
};
const report: PackReport = {
  name: metadata.package.name, version: metadata.package.version,
  filename: "package.tgz", integrity,
  files: ["package.json", "README.md", "LICENSE", "dist/mcp/server.js"].map((path) => ({ path })),
};

function registryFetch(routes: Record<string, unknown | Response>): typeof fetch {
  return async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET", "Release checks must never write to a registry");
    assert.equal(init?.redirect, "error");
    const url = String(input);
    assert.ok(Object.hasOwn(routes, url), `Unexpected registry URL: ${url}`);
    const value = routes[url];
    return value instanceof Response ? value.clone() : Response.json(value);
  };
}

test("release versions, identity, and local stdio transport agree", () => {
  validateReleaseMetadata(metadata, `v${metadata.package.version}`);
});

const invalidMetadata: [string, (copy: ReleaseMetadata) => void][] = [
  ["npm package name", (copy) => { copy.package.name = "@other/anki-mcp"; }],
  ["prerelease version", (copy) => { copy.package.version = "1.0.0-beta.1"; }],
  ["leading-zero version", (copy) => { copy.package.version = "01.0.0"; }],
  ["namespace", (copy) => { copy.package.mcpName = "io.github.other/anki-mcp"; }],
  ["repository", (copy) => { copy.package.repository.url = "git+https://github.com/other/repo.git"; }],
  ["private publication", (copy) => { copy.package.publishConfig.access = "restricted"; }],
  ["entry point", (copy) => { copy.package.bin["anki-mcp"] = "mcp/server.ts"; }],
  ["lock version", (copy) => { copy.lock.version = "9.0.0"; }],
  ["lock root name", (copy) => { copy.lock.packages[""]!.name = "other"; }],
  ["lock root version", (copy) => { copy.lock.packages[""]!.version = "9.0.0"; }],
  ["registry name", (copy) => { copy.server.name = "io.github.other/anki-mcp"; }],
  ["registry version", (copy) => { copy.server.version = "9.0.0"; }],
  ["registry package version", (copy) => { copy.server.packages[0]!.version = "latest"; }],
  ["package registry", (copy) => { copy.server.packages[0]!.registryBaseUrl = "https://example.com"; }],
  ["transport", (copy) => { copy.server.packages[0]!.transport.type = "streamable-http"; }],
  ["remote endpoint", (copy) => { copy.server.remotes = [{ url: "https://example.com" }]; }],
];

for (const [name, mutate] of invalidMetadata) {
  test(`release validation rejects mismatched ${name}`, () => {
    const copy = structuredClone(metadata);
    mutate(copy);
    assert.throws(() => validateReleaseMetadata(copy));
  });
}

test("tag validation rejects a different version or a branch name", () => {
  for (const tag of ["v9.0.0", "main", metadata.package.version]) {
    assert.throws(() => validateReleaseMetadata(metadata, tag), /Release tag/u);
  }
});

test("release artifact must match its hash and public file allowlist", () => {
  validateArchive(metadata, report, bytes);
  assert.throws(() => validateArchive(metadata, report, Buffer.from("changed")), /integrity/u);
  for (const path of [".env", ".private/learning.md", "scripts/release.ts", "dist/.env", "dist/../secret"]) {
    const copy = structuredClone(report);
    copy.files.push({ path });
    assert.throws(() => validateArchive(metadata, copy, bytes), /allowlist/u);
  }
  const copy = structuredClone(report);
  copy.files = copy.files.filter(({ path }) => path !== "dist/mcp/server.js");
  assert.throws(() => validateArchive(metadata, copy, bytes), /missing/u);
});

test("npm pack JSON accepts npm 12 keyed reports and older array reports", () => {
  assert.deepEqual(parsePackReport(JSON.stringify({ [report.name]: report })), report);
  assert.deepEqual(parsePackReport(JSON.stringify([report])), report);
  for (const invalid of [null, {}, [], [report, report]]) {
    assert.throws(() => parsePackReport(JSON.stringify(invalid)));
  }
});

test("latest cannot be moved backwards, including numeric major/minor/patch comparisons", () => {
  for (const [version, latest] of [["0.1.1", "0.1.0"], ["0.10.0", "0.9.9"], ["2.0.0", "1.99.99"], ["1.0.0", "1.0.0"]]) {
    checkLatestVersion(version!, latest);
  }
  checkLatestVersion("0.1.1");
  for (const latest of ["0.1.2", "0.2.0", "1.0.0", "1.0.0-beta.1"]) {
    assert.throws(() => checkLatestVersion("0.1.1", latest));
  }
});

test("fresh release preflight reports both destinations absent", async () => {
  const fetcher = registryFetch({
    [versionUrl]: new Response(null, { status: 404 }),
    [mcpUrl]: new Response(null, { status: 404 }),
    [npmUrl]: { versions: {}, "dist-tags": { latest: "0.1.0" } },
  });
  assert.deepEqual(await preflight(metadata, integrity, fetcher), { npm_exists: false, mcp_exists: false });
});

test("partial release resumes npm only when its existing bytes match", async () => {
  const routes = { [versionUrl]: publishedNpm, [mcpUrl]: new Response(null, { status: 404 }), [npmUrl]: index };
  assert.deepEqual(await preflight(metadata, integrity, registryFetch(routes)), { npm_exists: true, mcp_exists: false });
  await assert.rejects(preflight(metadata, "different-hash", registryFetch(routes)), /different bytes/u);
});

test("MCP completion requires the matching npm version to be public, not merely staged", async () => {
  const pending = registryFetch({
    [versionUrl]: new Response(null, { status: 404 }),
    [mcpUrl]: new Response(null, { status: 404 }),
    [npmUrl]: { versions: {}, "dist-tags": { latest: "0.1.0" } },
  });
  await assert.rejects(approvedPreflight(metadata, integrity, pending), /Approve the staged package with 2FA/u);
  const approved = registryFetch({
    [versionUrl]: publishedNpm, [mcpUrl]: new Response(null, { status: 404 }), [npmUrl]: index,
  });
  assert.deepEqual(await approvedPreflight(metadata, integrity, approved), { npm_exists: true, mcp_exists: false });
  await assert.rejects(approvedPreflight(metadata, "wrong-integrity", approved), /different bytes/u);
});

test("completed release can be rerun without writes, even after a newer latest", async () => {
  const fetcher = registryFetch({
    [versionUrl]: publishedNpm, [mcpUrl]: publishedMcp,
    [npmUrl]: { ...index, "dist-tags": { latest: "99.0.0" } },
  });
  assert.deepEqual(await preflight(metadata, integrity, fetcher), { npm_exists: true, mcp_exists: true });
});

test("preflight refuses to publish an older release or reuse an orphan MCP entry", async () => {
  const absent = new Response(null, { status: 404 });
  await assert.rejects(preflight(metadata, integrity, registryFetch({
    [versionUrl]: absent, [mcpUrl]: absent,
    [npmUrl]: { versions: {}, "dist-tags": { latest: "99.0.0" } },
  })), /older version/u);
  await assert.rejects(preflight(metadata, integrity, registryFetch({
    [versionUrl]: absent, [mcpUrl]: publishedMcp, [npmUrl]: index,
  })), /underlying npm version is missing/u);
});

test("registry errors are not interpreted as unpublished versions", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(checkNpmVersion(metadata, integrity,
      registryFetch({ [versionUrl]: new Response(null, { status }) })), /Registry read failed/u);
    await assert.rejects(checkMcpVersion(metadata,
      registryFetch({ [mcpUrl]: new Response(null, { status }) })), /Registry read failed/u);
  }
});

test("preflight stops on inconsistent npm metadata rather than retrying publication", async () => {
  await assert.rejects(preflight(metadata, integrity, registryFetch({
    [versionUrl]: new Response(null, { status: 404 }),
    [mcpUrl]: new Response(null, { status: 404 }), [npmUrl]: index,
  })), /endpoints disagree/u);
});

test("MCP entry must match the entire manifest and remain active", async () => {
  assert.equal(await checkMcpVersion(metadata, registryFetch({ [mcpUrl]: publishedMcp })), true);
  await assert.rejects(checkMcpVersion(metadata, registryFetch({
    [mcpUrl]: { ...publishedMcp, server: { ...metadata.server, description: "Different" } },
  })), /different metadata/u);
  await assert.rejects(checkMcpVersion(metadata, registryFetch({
    [mcpUrl]: { ...publishedMcp, _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } } },
  })), /not active/u);
});

test("npm verification waits for packument propagation and checks downloaded bytes", async () => {
  const routes = { [versionUrl]: publishedNpm, [npmUrl]: index, [tarballUrl]: new Response(bytes) };
  assert.equal(await verifyNpmDownload(metadata, integrity, registryFetch(routes)), true);
  assert.equal(await verifyNpmDownload(metadata, integrity, registryFetch({
    ...routes, [npmUrl]: new Response(null, { status: 404 }),
  })), false);
  await assert.rejects(verifyNpmDownload(metadata, integrity, registryFetch({
    ...routes, [tarballUrl]: new Response("tampered"),
  })), /differs from/u);
  await assert.rejects(verifyNpmDownload(metadata, integrity, registryFetch({
    ...routes, [versionUrl]: { ...publishedNpm, dist: { integrity, tarball: "https://example.com/archive.tgz" } },
  })));
});

test("propagation polling is bounded and never retries mismatches", async () => {
  let checks = 0;
  let pauses = 0;
  await waitForPublication(async () => ++checks === 3, async () => { pauses++; });
  assert.equal(checks, 3);
  assert.equal(pauses, 2);
  checks = 0;
  await assert.rejects(waitForPublication(async () => { checks++; return false; }, async () => {}), /not visible/u);
  assert.equal(checks, 24);
  checks = 0;
  await assert.rejects(waitForPublication(async () => { checks++; throw new Error("mismatch"); }, async () => {}), /mismatch/u);
  assert.equal(checks, 1);
});
