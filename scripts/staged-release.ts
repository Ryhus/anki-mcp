import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface StagingRun {
  id: number;
  head_sha: string;
  path: string;
  event: string;
  status: string;
  conclusion: string;
  repository: { full_name: string };
}

interface StagePackage {
  name: string; version: string; integrity: string;
}

const stageIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** Validate before using manual inputs as Git refs, API paths, or artifact identifiers. */
export function validateCompletionInputs(tag: string, runId: string): void {
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
    "Release tag must be a stable vX.Y.Z tag");
  assert.match(runId, /^[1-9]\d*$/u, "Staging run ID must be a positive integer");
  assert.ok(Number.isSafeInteger(Number(runId)), "Staging run ID is outside the supported range");
}

/** Bind a cross-run artifact to the successful tag workflow for this exact commit. */
export function validateStagingRun(run: StagingRun, runId: string, commit: string): void {
  assert.equal(String(run.id), runId, "Staging run ID mismatch");
  assert.equal(run.repository.full_name, "Ryhus/anki-mcp", "Unexpected staging repository");
  assert.equal(run.path, ".github/workflows/publish.yml", "Unexpected staging workflow");
  assert.equal(run.event, "push", "Source run must be triggered by a release tag, not manual completion");
  assert.equal(run.head_sha, commit, "Staging run must match the release tag's commit");
  assert.equal(run.status, "completed", "Staging run has not finished");
  assert.equal(run.conclusion, "success", "Staging run must have succeeded");
}

/** Extract only a verified stage identifier; never approve or query pending npm stages from CI. */
export function parseStageResult(json: string, expected: StagePackage): string {
  const parsed: unknown = JSON.parse(json);
  assert.ok(parsed !== null && typeof parsed === "object");
  const reports = Object.values(parsed) as (StagePackage & { stageId: string })[];
  assert.equal(reports.length, 1, "Expected exactly one staged package");
  const result = reports[0]!;
  assert.equal(result.name, expected.name);
  assert.equal(result.version, expected.version);
  assert.equal(result.integrity, expected.integrity, "Staged archive differs from the tested artifact");
  assert.match(result.stageId, stageIdPattern,
    "npm did not return a valid stage identifier");
  return result.stageId;
}

export function stageSummary(pkg: StagePackage, tag: string, runId: string, stageId?: string): string {
  validateCompletionInputs(tag, runId);
  assert.equal(pkg.name, "@ryhus/anki-mcp");
  assert.equal(tag, `v${pkg.version}`);
  assert.match(pkg.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u);
  if (stageId !== undefined) assert.match(stageId, stageIdPattern);
  return [
    stageId ? "## Awaiting npm approval" : "## npm version already approved",
    "", `Package: ${pkg.name}@${pkg.version}`,
    ...(stageId ? [`Stage ID: \`${stageId}\``, "", "Review this package under npm's Staged Packages tab and approve it with 2FA."] : []),
    "", "After npm approval, run **Publish → Run workflow** on **main** with:",
    `- Release tag: \`${tag}\``, `- Staging run ID: \`${runId}\``,
    "", `Tested archive integrity: \`${pkg.integrity}\``,
    "", "This run does not approve npm packages or publish MCP Registry metadata.", "",
  ].join("\n");
}

async function main(): Promise<void> {
  const [command, resultPath, reportPath] = process.argv.slice(2);
  const tag = process.env.RELEASE_TAG ?? "";
  const runId = process.env.STAGING_RUN_ID ?? "";
  validateCompletionInputs(tag, runId);
  if (command === "validate-inputs") return;
  if (command === "check-run") {
    const token = process.env.GH_TOKEN;
    assert.ok(token, "GitHub workflow token is required to read the staging run");
    const response = await fetch(`https://api.github.com/repos/Ryhus/anki-mcp/actions/runs/${runId}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    assert.ok(response.ok, `Cannot read the staging run: HTTP ${response.status}`);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    validateStagingRun(await response.json() as StagingRun, runId, commit);
    console.log(`Verified staging run ${runId} for ${tag}.`);
  } else if (command === "summarize") {
    assert.ok(resultPath && reportPath, "Stage result and archive report paths are required");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as StagePackage;
    assert.ok(["true", "false"].includes(process.env.NPM_EXISTS ?? ""));
    const stageId = process.env.NPM_EXISTS === "true" ? undefined :
      parseStageResult(await readFile(resultPath, "utf8"), report);
    const summary = stageSummary(report, tag, runId, stageId);
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  } else {
    throw new Error("Usage: node scripts/staged-release.ts <validate-inputs|check-run|summarize result.json report.json>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Staged release check failed");
    process.exitCode = 1;
  });
}
