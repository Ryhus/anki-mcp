import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const MCP_REGISTRY = "https://registry.modelcontextprotocol.io/v0.1";
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export interface ReleaseMetadata {
  package: {
    name: string; version: string; mcpName: string;
    repository: { url: string }; publishConfig: { access: string };
    bin: Record<string, string>;
  };
  lock: {
    name: string; version: string;
    packages: Record<string, { name: string; version: string }>;
  };
  server: {
    name: string; version: string; description: string;
    repository: { url: string; source: string };
    packages: {
      registryType: string; registryBaseUrl: string; identifier: string;
      version: string; transport: { type: string };
    }[];
    remotes?: unknown[];
  };
}

export interface PackReport {
  name: string; version: string; filename: string; integrity: string;
  files: { path: string }[];
}

interface NpmVersion {
  name: string; version: string; mcpName: string;
  dist: { integrity: string; tarball: string };
}

interface NpmIndex {
  versions: Record<string, NpmVersion>;
  "dist-tags": { latest?: string };
}

type Fetch = typeof globalThis.fetch;

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function loadReleaseMetadata(root = projectRoot): Promise<ReleaseMetadata> {
  const [pkg, lock, server] = await Promise.all([
    readJson<ReleaseMetadata["package"]>(join(root, "package.json")),
    readJson<ReleaseMetadata["lock"]>(join(root, "package-lock.json")),
    readJson<ReleaseMetadata["server"]>(join(root, "server.json")),
  ]);
  return { package: pkg, lock, server };
}

/** Fail closed on mismatched versions, package identity, or transport. No registry writes. */
export function validateReleaseMetadata(metadata: ReleaseMetadata, tag?: string): void {
  const { package: pkg, lock, server } = metadata;
  assert.equal(pkg.name, "@ryhus/anki-mcp");
  assert.match(pkg.version, stableVersion, "Only stable x.y.z releases are supported");
  assert.equal(pkg.mcpName, "io.github.Ryhus/anki-mcp");
  assert.equal(pkg.repository.url, "git+https://github.com/Ryhus/anki-mcp.git");
  assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.bin["anki-mcp"], "dist/mcp/server.js");
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""]?.name, pkg.name);
  assert.equal(lock.version, pkg.version, "Lockfile version must match package.json");
  assert.equal(lock.packages[""]?.version, pkg.version);
  assert.equal(server.name, pkg.mcpName, "server.json name must match mcpName");
  assert.equal(server.version, pkg.version, "MCP Registry version must match npm version");
  assert.ok(server.description.length > 0 && server.description.length <= 100);
  assert.equal(server.repository.url, "https://github.com/Ryhus/anki-mcp");
  assert.equal(server.repository.source, "github");
  assert.equal(server.remotes?.length ?? 0, 0, "This release is a local stdio server");
  assert.equal(server.packages.length, 1);
  const entry = server.packages[0]!;
  assert.equal(entry.registryType, "npm");
  assert.equal(entry.registryBaseUrl, NPM_REGISTRY);
  assert.equal(entry.identifier, pkg.name);
  assert.equal(entry.version, pkg.version, "Registry package version must match npm version");
  assert.equal(entry.transport.type, "stdio");
  if (tag !== undefined) assert.equal(tag, `v${pkg.version}`, "Release tag must match package version");
}

export function archiveIntegrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Check the artifact before granting any opportunity to publish it. */
export function validateArchive(metadata: ReleaseMetadata, report: PackReport, bytes: Uint8Array): void {
  assert.equal(report.name, metadata.package.name);
  assert.equal(report.version, metadata.package.version);
  assert.equal(report.filename, "package.tgz");
  assert.equal(report.integrity, archiveIntegrity(bytes), "Release archive integrity mismatch");
  const paths = report.files.map(({ path }) => path);
  for (const required of ["package.json", "README.md", "LICENSE", "dist/mcp/server.js"]) {
    assert.ok(paths.includes(required), `Release archive is missing ${required}`);
  }
  assert.ok(paths.every((path) =>
    ["package.json", "README.md", "LICENSE"].includes(path) ||
    (path.startsWith("dist/") && !path.split("/").some((part) => part.startsWith("."))),
  ), "Release archive contains files outside the public package allowlist");
}

async function loadArchive(metadata: ReleaseMetadata, directory: string): Promise<PackReport> {
  const report = await readJson<PackReport>(join(directory, "package-info.json"));
  validateArchive(metadata, report, await readFile(join(directory, "package.tgz")));
  return report;
}

/** npm 12 keys JSON reports by package name; older npm versions returned an array. */
export function parsePackReport(json: string): PackReport {
  const parsed: unknown = JSON.parse(json);
  assert.ok(parsed !== null && typeof parsed === "object", "Invalid npm pack report");
  const reports = Object.values(parsed) as PackReport[];
  assert.equal(reports.length, 1, "Expected exactly one npm package");
  return reports[0]!;
}

async function packRelease(metadata: ReleaseMetadata, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const report = parsePackReport(execFileSync("npm", [
    "pack", "--json", "--ignore-scripts", "--pack-destination", directory,
  ], { cwd: projectRoot, encoding: "utf8" }));
  assert.equal(report.filename, `ryhus-anki-mcp-${metadata.package.version}.tgz`);
  await rename(join(directory, report.filename), join(directory, "package.tgz"));
  report.filename = "package.tgz";
  validateArchive(metadata, report, await readFile(join(directory, report.filename)));
  await writeFile(join(directory, "package-info.json"), `${JSON.stringify(report, null, 2)}\n`);
}

async function getJson<T>(url: string, fetcher: Fetch): Promise<T | null> {
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  if (response.status === 404) return null;
  assert.ok(response.ok, `Registry read failed: HTTP ${response.status} at ${url}`);
  return await response.json() as T;
}

export async function checkNpmVersion(
  metadata: ReleaseMetadata, integrity: string, fetcher: Fetch = fetch,
): Promise<NpmVersion | null> {
  const pkg = metadata.package;
  const url = `${NPM_REGISTRY}/${encodeURIComponent(pkg.name)}/${pkg.version}`;
  const published = await getJson<NpmVersion>(url, fetcher);
  if (published) {
    assert.equal(published.name, pkg.name);
    assert.equal(published.version, pkg.version);
    assert.equal(published.mcpName, pkg.mcpName);
    assert.equal(published.dist.integrity, integrity,
      "npm already contains different bytes for this version; refusing to overwrite or skip");
  }
  return published;
}

/** Existing entries are reusable only if both their metadata and active status match. */
export async function checkMcpVersion(
  metadata: ReleaseMetadata, fetcher: Fetch = fetch,
): Promise<boolean> {
  const server = metadata.server;
  const url = `${MCP_REGISTRY}/servers/${encodeURIComponent(server.name)}/versions/${server.version}`;
  const published = await getJson<{
    server: ReleaseMetadata["server"];
    _meta: Record<string, { status: string }>;
  }>(url, fetcher);
  if (!published) return false;
  assert.deepEqual(published.server, server,
    "MCP Registry already contains different metadata for this version");
  assert.equal(published._meta["io.modelcontextprotocol.registry/official"]?.status, "active",
    "Existing MCP Registry entry is not active");
  return true;
}

/** Prevent an older stable tag from accidentally moving npm's latest backwards. */
export function checkLatestVersion(version: string, latest?: string): void {
  if (latest === undefined) return;
  assert.match(latest, stableVersion, "Unexpected npm latest version; inspect it before publishing");
  const current = version.split(".").map(BigInt);
  const previous = latest.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (current[i]! > previous[i]!) return;
    assert.ok(current[i]! >= previous[i]!, "Refusing to move npm latest to an older version");
  }
}

export async function preflight(
  metadata: ReleaseMetadata, integrity: string, fetcher: Fetch = fetch,
): Promise<{ npm_exists: boolean; mcp_exists: boolean }> {
  const [npm, mcp, index] = await Promise.all([
    checkNpmVersion(metadata, integrity, fetcher), checkMcpVersion(metadata, fetcher),
    getJson<NpmIndex>(`${NPM_REGISTRY}/${encodeURIComponent(metadata.package.name)}`, fetcher),
  ]);
  assert.ok(!mcp || npm, "MCP entry exists but its underlying npm version is missing");
  // An already-published version may be resumed even after a newer release.
  if (!npm) {
    assert.ok(!index?.versions[metadata.package.version],
      "npm endpoints disagree about this version; wait for propagation before retrying");
    checkLatestVersion(metadata.package.version, index?.["dist-tags"].latest);
  }
  return { npm_exists: npm !== null, mcp_exists: mcp };
}

/** A staged (non-public) package must never unlock MCP Registry publication. */
export async function approvedPreflight(
  metadata: ReleaseMetadata, integrity: string, fetcher: Fetch = fetch,
): Promise<{ npm_exists: boolean; mcp_exists: boolean }> {
  const result = await preflight(metadata, integrity, fetcher);
  assert.ok(result.npm_exists,
    "npm version is not public. Approve the staged package with 2FA, then run completion again.");
  return result;
}

export async function verifyNpmDownload(
  metadata: ReleaseMetadata, integrity: string, fetcher: Fetch = fetch,
): Promise<boolean> {
  const version = await checkNpmVersion(metadata, integrity, fetcher);
  if (!version) return false;
  const index = await getJson<NpmIndex>(`${NPM_REGISTRY}/${encodeURIComponent(metadata.package.name)}`, fetcher);
  if (!index?.versions[metadata.package.version]) return false;
  assert.equal(index.versions[metadata.package.version]!.dist.integrity, integrity);
  assert.equal(new URL(version.dist.tarball).origin, NPM_REGISTRY);
  const download = await fetcher(version.dist.tarball, {
    signal: AbortSignal.timeout(15_000), redirect: "error",
  });
  assert.ok(download.ok, `Anonymous npm download failed: HTTP ${download.status}`);
  assert.equal(archiveIntegrity(new Uint8Array(await download.arrayBuffer())), integrity,
    "Downloaded npm archive differs from the tested artifact");
  return true;
}

/** Retry bounded read-only propagation checks, never a publish command. */
export async function waitForPublication(
  check: () => Promise<boolean>, pause: () => Promise<unknown> = () => setTimeout(5_000),
): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt++) {
    if (await check()) return;
    if (attempt < 23) await pause();
  }
  throw new Error("Publication is not visible yet. Inspect registry status, then rerun the workflow.");
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  const metadata = await loadReleaseMetadata();
  validateReleaseMetadata(metadata, command === "validate" ? argument : undefined);
  if (command === "validate") {
    console.log(`Release metadata valid: ${metadata.package.name}@${metadata.package.version}`);
  } else if (command === "pack") {
    assert.ok(argument, "Artifact directory is required");
    await packRelease(metadata, argument);
  } else if (command === "preflight" || command === "preflight-approved" || command === "verify-npm") {
    assert.ok(argument, "Artifact directory is required");
    const report = await loadArchive(metadata, argument);
    if (command !== "verify-npm") {
      const result = await (command === "preflight-approved" ? approvedPreflight : preflight)(metadata, report.integrity);
      console.log(JSON.stringify(result));
      if (process.env.GITHUB_OUTPUT) {
        await appendFile(process.env.GITHUB_OUTPUT,
          Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(""));
      }
    } else {
      await waitForPublication(() => verifyNpmDownload(metadata, report.integrity));
      console.log("Anonymous npm metadata and archive verified.");
    }
  } else if (command === "verify-mcp") {
    await waitForPublication(() => checkMcpVersion(metadata));
    console.log("MCP Registry metadata and active status verified.");
  } else {
    throw new Error("Usage: node scripts/release.ts <validate [tag]|pack dir|preflight dir|preflight-approved dir|verify-npm dir|verify-mcp>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Release check failed");
    process.exitCode = 1;
  });
}
