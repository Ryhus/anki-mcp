import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseStageResult, stageSummary, validateCompletionInputs, validateStagingRun,
} from "../scripts/staged-release.js";
import type { StagingRun } from "../scripts/staged-release.js";

const runId = "42368069222";
const commit = "27e918c3be20fcdf6c330d20a1a0f09d68087c29";
const source: StagingRun = {
  id: Number(runId), head_sha: commit, path: ".github/workflows/publish.yml",
  event: "push", status: "completed", conclusion: "success",
  repository: { full_name: "Ryhus/anki-mcp" },
};
const pkg = {
  name: "@ryhus/anki-mcp", version: "0.1.1",
  integrity: `sha512-${createHash("sha512").update("archive").digest("base64")}`,
};
const stageId = "123e4567-e89b-42d3-a456-426614174000";
const result = { ...pkg, stageId };

test("manual completion accepts only stable version tags and numeric source run IDs", () => {
  validateCompletionInputs("v0.1.1", runId);
  for (const tag of ["", "main", "refs/tags/v0.1.1", "v01.1.1", "v0.1.1-beta.1", "v0.1.1;echo secret"]) {
    assert.throws(() => validateCompletionInputs(tag, runId));
  }
  for (const id of ["", "0", "-1", "01", "../runs", "12?x=y", "9007199254740992"]) {
    assert.throws(() => validateCompletionInputs("v0.1.1", id));
  }
});

test("completion accepts only the original successful staging run", () => {
  validateStagingRun(source, runId, commit);
});

const invalidRuns: [string, (run: StagingRun) => void][] = [
  ["another run ID", (run) => { run.id++; }],
  ["another repository", (run) => { run.repository.full_name = "other/anki-mcp"; }],
  ["another workflow", (run) => { run.path = ".github/workflows/ci.yml"; }],
  ["manual completion as a source", (run) => { run.event = "workflow_dispatch"; }],
  ["a pull request source", (run) => { run.event = "pull_request"; }],
  ["another tagged commit", (run) => { run.head_sha = "0".repeat(40); }],
  ["an unfinished run", (run) => { run.status = "in_progress"; }],
  ["a failed run", (run) => { run.conclusion = "failure"; }],
  ["a cancelled run", (run) => { run.conclusion = "cancelled"; }],
];
for (const [name, mutate] of invalidRuns) {
  test(`completion rejects ${name}`, () => {
    const copy = structuredClone(source);
    mutate(copy);
    assert.throws(() => validateStagingRun(copy, runId, commit));
  });
}

test("stage output must identify the exact tested package and return a stage UUID", () => {
  assert.equal(parseStageResult(JSON.stringify({ [pkg.name]: result }), pkg), stageId);
  assert.equal(parseStageResult(JSON.stringify([result]), pkg), stageId);
  for (const invalid of [
    { ...result, name: "other-package" }, { ...result, version: "9.0.0" },
    { ...result, integrity: "different" }, { ...result, stageId: undefined },
    { ...result, stageId: "not-a-uuid" },
  ]) {
    assert.throws(() => parseStageResult(JSON.stringify([invalid]), pkg));
  }
  for (const invalid of ["null", "{}", "[]", "not-json", JSON.stringify([result, result])]) {
    assert.throws(() => parseStageResult(invalid, pkg));
  }
});

test("job summary exposes the human approval step and exact completion inputs", () => {
  const pending = stageSummary(pkg, "v0.1.1", runId, stageId);
  assert.match(pending, /Awaiting npm approval/u);
  assert.match(pending, /approve it with 2FA/u);
  assert.ok(pending.includes(stageId) && pending.includes(runId) && pending.includes(pkg.integrity));
  const approved = stageSummary(pkg, "v0.1.1", runId);
  assert.match(approved, /already approved/u);
  assert.doesNotMatch(approved, /Stage ID|Awaiting npm approval/u);
  assert.throws(() => stageSummary(pkg, "v9.0.0", runId));
});

test("workflow cannot directly publish, approve, reject, or query pending npm packages", () => {
  const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.match(workflow, /npm stage publish/u);
  assert.doesNotMatch(workflow, /npm\s+(?:publish|stage\s+(?:approve|reject|list|view|download))\b/u);
  const [staging, completion] = workflow.split(/\n  complete:/u);
  assert.ok(staging && completion);
  assert.doesNotMatch(staging, /run: mcp-publisher (?:publish|login github-oidc)/u);
  assert.match(completion, /github\.event_name == 'workflow_dispatch'/u);
  assert.match(completion, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(completion, /run-id: \$\{\{ inputs\.staging_run_id \}\}/u);
  assert.ok(completion.indexOf("check-run") < completion.indexOf("actions/download-artifact@"));
  assert.ok(completion.indexOf("preflight-approved") < completion.indexOf("run: mcp-publisher publish"));
  assert.ok(completion.indexOf("verify-npm") < completion.indexOf("run: mcp-publisher publish"));
});
