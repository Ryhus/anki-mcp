import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";
import { exportDeckPackageConfig } from "../mcp/tools/packages/export-deck-package.js";
import { importDeckPackageConfig } from "../mcp/tools/packages/import-deck-package.js";

const exportName = "export-deck-package";
const importName = "import-deck-package";
const proposedExport = { deckId: 11, fileName: "German.apkg" };
const bytes = Buffer.alloc(150_000, 0x5a);
Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(bytes);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const changedBytes = Buffer.from(bytes);
changedBytes[20] = 0x20;

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "anki-mcp-packages-test-")));
  const importDir = join(root, "imports");
  const exportDir = join(root, "exports");
  await Promise.all([mkdir(importDir), mkdir(exportDir)]);
  const source = join(importDir, "Source.apkg");
  const existing = join(exportDir, "German.apkg");
  await Promise.all([writeFile(source, bytes), writeFile(existing, "existing")]);
  const env = {
    ANKI_URL: "http://127.0.0.1:8765", ANKI_API_MODE: "v1",
    ANKI_PACKAGE_IMPORT_DIR: importDir, ANKI_PACKAGE_EXPORT_DIR: exportDir,
    TMPDIR: root, TMP: root, TEMP: root,
  };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const state = {
    root, importDir, exportDir, source, existing, calls: [] as string[],
    writes: [] as { method: string; path: string; includeScheduling?: boolean }[],
    session: "package-session", childName: "German::Child",
    changeSourceOnCollectionRead: false, loseStatus: false, omitExportFile: false,
  };
  const operations = new Map<string, { method: string; result: unknown; polls: number }>();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1");
    const { method, id, params } = JSON.parse(String(init.body));
    state.calls.push(method);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    if (method === "collection.get") {
      assert.deepEqual(params, {});
      if (state.changeSourceOnCollectionRead) await writeFile(source, changedBytes);
      return ok({ session: state.session, profile: "Package Fixture" });
    }
    if (method === "operations.get") {
      assert.deepEqual(Object.keys(params), ["operationId"]);
      if (state.loseStatus) return Response.json({ jsonrpc: "2.0", id, error: { code: 1001, message: "lost status" } });
      const operation = operations.get(params.operationId)!;
      const handle = { operationId: params.operationId, method: operation.method, session: state.session };
      if (++operation.polls === 1) return ok({ ...handle, state: "running" });
      return ok({ ...handle, state: "succeeded", result: operation.result });
    }
    assert.equal(params.session, state.session);
    if (method === "decks.list") return ok([
      { id: "11", name: "German", kind: "normal", presetId: "1" },
      { id: "12", name: state.childName, kind: "normal", presetId: "1" },
      { id: "13", name: "Filtered", kind: "filtered", presetId: null },
    ]);
    const operationId = String(state.writes.length + 1);
    const path: string = params.path;
    state.writes.push({ method, path, ...(params.includeScheduling === undefined ? {} : { includeScheduling: params.includeScheduling }) });
    if (method === "packages.export") {
      assert.deepEqual(params, { deck: { id: "11" }, path, includeScheduling: params.includeScheduling, session: state.session });
      assert.equal(dirname(dirname(path)), exportDir);
      assert.equal(basename(path), proposedExport.fileName);
      if (!state.omitExportFile) await writeFile(path, bytes, { flag: "wx" });
      operations.set(operationId, { method, result: { path }, polls: 0 });
    } else {
      assert.equal(method, "packages.import");
      assert.deepEqual(params, { path, session: state.session });
      assert.notEqual(path, source);
      assert.equal(basename(path), "input.apkg");
      assert.deepEqual(await readFile(path), bytes);
      operations.set(operationId, { method, result: { completed: true }, polls: 0 });
    }
    return ok({ operationId, method, session: state.session });
  });
  return state;
}

async function connect(t: TestContext, version: "2025-11-25" | "2026-07-28") {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(createServer, { transport: b });
  const client = new Client({ name: "deck-package-test", version: "0.0.0" }, {
    supportedProtocolVersions: [version],
    versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(a);
  return (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
}

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version}: guarded export and import use native operations and private files`, async (t) => {
    const state = await fixture(t);
    const call = await connect(t, version);
    const exportCall = async (args: Record<string, unknown>) =>
      exportDeckPackageConfig.outputSchema.parse((await call(exportName, args)).structuredContent);
    const importCall = async (args: Record<string, unknown>) =>
      importDeckPackageConfig.outputSchema.parse((await call(importName, args)).structuredContent);
    const exported = await exportCall(proposedExport);
    assert.ok(exported.dryRun && !exported.exported && exported.impactHash && exported.package === null);
    assert.deepEqual(exported.includedDecks.map(({ id }) => id), [11, 12]);
    assert.equal(exported.profile, "Package Fixture");
    assert.equal(exported.includeScheduling, false);
    assert.deepEqual(await readdir(state.exportDir), ["German.apkg"]);
    const exportApply = { ...proposedExport, dryRun: false, confirmExport: true, expectedImpactHash: exported.impactHash };
    assert.match((await exportCall({ ...exportApply, confirmExport: false })).blockers.join(" "), /requires confirmExport/u);
    assert.match((await exportCall({ ...exportApply, includeScheduling: true })).blockers.join(" "), /changed/u);
    state.childName = "German::Renamed";
    assert.match((await exportCall(exportApply)).blockers.join(" "), /changed/u);
    state.childName = "German::Child";
    assert.equal(state.writes.length, 0);
    const saved = await exportCall(exportApply);
    assert.ok(saved.exported && saved.package);
    assert.deepEqual(saved.package, { path: state.writes[0]!.path, byteSize: bytes.length, sha256 });
    assert.equal(await readFile(state.existing, "utf8"), "existing");
    assert.equal(state.writes[0]!.includeScheduling, false);
    const optIn = { ...proposedExport, includeScheduling: true };
    const reviewedOptIn = await exportCall(optIn);
    const second = await exportCall({ ...optIn, dryRun: false, confirmExport: true, expectedImpactHash: reviewedOptIn.impactHash });
    assert.ok(second.exported && second.package?.path !== saved.package.path);
    assert.equal(state.writes[1]!.includeScheduling, true);

    const input = { localPath: state.source };
    const imported = await importCall(input);
    assert.ok(imported.dryRun && !imported.imported && imported.impactHash);
    assert.deepEqual(imported.package, { path: state.source, byteSize: bytes.length, sha256 });
    const importApply = { ...input, dryRun: false, confirmImport: true, expectedImpactHash: imported.impactHash };
    assert.match((await importCall({ ...importApply, confirmImport: false })).blockers.join(" "), /requires confirmImport/u);
    state.session = "changed-session";
    assert.match((await importCall(importApply)).blockers.join(" "), /changed/u);
    state.session = "package-session";
    await writeFile(state.source, changedBytes);
    assert.match((await importCall(importApply)).blockers.join(" "), /changed/u);
    await writeFile(state.source, bytes);
    assert.deepEqual((await readdir(state.root)).sort(), ["exports", "imports"]);
    assert.equal(state.writes.length, 2);
    assert.equal((await importCall(importApply)).imported, true);
    const snapshot = state.writes[2]!.path;
    assert.equal(state.writes[2]!.method, "packages.import");
    await assert.rejects(access(snapshot), { code: "ENOENT" });
    assert.deepEqual(await readFile(state.source), bytes);
    assert.equal(state.calls.filter((method) => method === "operations.get").length, 6);
  });
}

test("disallowed file names, archive paths, and remote or legacy endpoints fail before RPCs", async (t) => {
  const state = await fixture(t);
  const call = await connect(t, "2026-07-28");
  for (const fileName of ["../x.apkg", "collection.apkg", "a.colpkg", "a\\b.apkg", "CON.apkg"]) {
    assert.equal((await call(exportName, { ...proposedExport, fileName })).isError, true);
  }
  const external = join(state.root, "outside.apkg");
  const link = join(state.importDir, "link.apkg");
  const fake = join(state.importDir, "fake.apkg");
  const directory = join(state.importDir, "directory.apkg");
  await Promise.all([writeFile(external, bytes), writeFile(fake, "not a package"), mkdir(directory)]);
  await symlink(external, link);
  for (const localPath of [external, link, fake, directory, "relative.apkg", join(state.importDir, "collection.apkg")]) {
    assert.equal((await call(importName, { localPath })).isError, true);
  }
  process.env.ANKI_URL = "https://example.invalid";
  assert.equal((await call(importName, { localPath: state.source })).isError, true);
  assert.equal((await call(exportName, proposedExport)).isError, true);
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  process.env.ANKI_API_MODE = "legacy";
  assert.equal((await call(importName, { localPath: state.source })).isError, true);
  assert.equal((await call(exportName, proposedExport)).isError, true);
  assert.equal(state.calls.length, 0);
});

test("import detects a file changed after preflight, sends no mutation, and removes its private copy", async (t) => {
  const state = await fixture(t);
  const call = await connect(t, "2026-07-28");
  const input = { localPath: state.source };
  const preview = importDeckPackageConfig.outputSchema.parse((await call(importName, input)).structuredContent);
  state.changeSourceOnCollectionRead = true;
  const result = await call(importName, { ...input, dryRun: false, confirmImport: true, expectedImpactHash: preview.impactHash });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Import was not sent/u);
  assert.equal(state.writes.length, 0);
  assert.deepEqual((await readdir(state.root)).sort(), ["exports", "imports"]);
});

test("a lost import status retains the private copy without replay; an absent export is not success", async (t) => {
  const state = await fixture(t);
  const call = await connect(t, "2026-07-28");
  const input = { localPath: state.source };
  const preview = importDeckPackageConfig.outputSchema.parse((await call(importName, input)).structuredContent);
  state.loseStatus = true;
  const result = await call(importName, { ...input, dryRun: false, confirmImport: true, expectedImpactHash: preview.impactHash });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /may already have changed or still be working/u);
  assert.deepEqual(await readFile(state.writes[0]!.path), bytes);
  state.loseStatus = false;
  state.omitExportFile = true;
  const planned = exportDeckPackageConfig.outputSchema.parse((await call(exportName, proposedExport)).structuredContent);
  const failed = await call(exportName, {
    ...proposedExport, dryRun: false, confirmExport: true, expectedImpactHash: planned.impactHash,
  });
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed.content), /Could not confirm export/u);
  assert.deepEqual(state.writes.map(({ method }) => method), ["packages.import", "packages.export"]);
});
