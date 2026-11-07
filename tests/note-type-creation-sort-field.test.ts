import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";
import { cloneNoteTypeConfig } from "../mcp/tools/note-types/clone-note-type.js";
import { createNoteTypeConfig } from "../mcp/tools/note-types/create-note-type.js";

const fields = ["Verb", "Translation"];
const templates = [{ name: "Card 1", front: "{{Verb}}", back: "{{Translation}}" }];
const css = ".card { color: black; }";
const sourceName = "Vocabulary";
const cloneInput = { sourceModelName: sourceName, targetModelName: "Vocabulary Copy" };
const createInput = { modelName: "New Vocabulary", fields, templates, css, sortField: "Translation" };
const nativeTemplates = templates.map(({ name, front, back }) => ({ name, questionHtml: front, answerHtml: back }));
const nativeFields = fields.map((name) => ({ name }));

function fixture(t: TestContext, mode: "v1" | "legacy") {
  const saved = { ANKI_URL: process.env.ANKI_URL, ANKI_API_MODE: process.env.ANKI_API_MODE };
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  process.env.ANKI_API_MODE = mode;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const source = { id: "11", name: sourceName, fields: nativeFields, css, templates: nativeTemplates, sortField: "Translation" };
  const types = new Map([[sourceName, source]]);
  const calls: string[] = [];
  const writes: Record<string, unknown>[] = [];
  const state = { source, calls, writes, session: "creation-session", ignoreSortField: false };
  const make = (name: string, sortField: string) => {
    const created = { ...source, id: String(11 + writes.length), name, sortField };
    types.set(name, created);
    return created;
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const { method, action, params, id } = JSON.parse(String(init.body));
    calls.push(method ?? action);
    if (mode === "legacy") {
      assert.equal(new URL(url).pathname, "/");
      const legacy = (result: unknown) => Response.json({ result, error: null });
      switch (action) {
        case "modelNamesAndIds": return legacy(Object.fromEntries([...types.values()].map(({ id, name }) => [name, Number(id)])));
        case "modelFieldNames": return legacy(fields);
        case "modelFieldsOnTemplates": return legacy({ "Card 1": [["Verb"], ["Translation"]] });
        case "modelStyling": return legacy({ css });
        case "modelTemplates": return legacy({ "Card 1": { Front: "{{Verb}}", Back: "{{Translation}}" } });
        case "createModel": {
          assert.ok(!("sortField" in params));
          writes.push(params);
          return legacy(make(params.modelName, "Verb"));
        }
        default: assert.fail(`Unexpected legacy action: ${action}`);
      }
    }
    assert.equal(new URL(url).pathname, "/api/v1");
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    if (method === "collection.get") {
      assert.deepEqual(params, {});
      return ok({ session: state.session });
    }
    assert.equal(params.session, state.session);
    if (method === "noteTypes.list") return ok([...types.values()].map(({ id, name }) => ({ id, name })));
    if (method === "noteTypes.get") {
      const { id, name } = params.noteType;
      const type = name === undefined ? [...types.values()].find((type) => type.id === id) : types.get(name);
      assert.ok(type, "expected a known Note Type");
      return ok(type);
    }
    if (method === "noteTypes.getTemplateUsage") return ok([
      { templateName: "Card 1", questionFields: ["Verb"], answerFields: ["Translation"] },
    ]);
    assert.equal(method, "noteTypes.create");
    assert.deepEqual(params, {
      name: params.name, kind: "normal", css, fields: nativeFields, templates: nativeTemplates, session: state.session,
      ...(params.sortField === undefined ? {} : { sortField: "Translation" }),
    });
    writes.push(params);
    return ok(make(params.name, state.ignoreSortField ? "Verb" : params.sortField ?? "Verb"));
  });
  return state;
}

async function connect(t: TestContext, version: "2025-11-25" | "2026-07-28") {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(createServer, { transport: b });
  const client = new Client({ name: "note-type-creation-sort-test", version: "0.0.0" }, {
    supportedProtocolVersions: [version],
    versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(a);
  return client;
}

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} creates with an explicit sort field and clones it using a reviewed snapshot`, async (t) => {
    const state = fixture(t, "v1");
    const client = await connect(t, version);
    const create = (args: Record<string, unknown>) => client.callTool({ name: "create-note-type", arguments: args });
    const clone = async (args: Record<string, unknown>) => cloneNoteTypeConfig.outputSchema.parse(
      (await client.callTool({ name: "clone-note-type", arguments: args })).structuredContent,
    );
    assert.equal((await create({ ...createInput, sortField: "translation" })).isError, true);
    assert.equal(state.calls.length, 0);
    const proposed = createNoteTypeConfig.outputSchema.parse((await create(createInput)).structuredContent);
    assert.ok(proposed.validation.valid && !proposed.created && proposed.sortField === "Translation");
    const preview = await clone(cloneInput);
    assert.ok(preview.validation.valid && preview.cloneHash && preview.cloneSummary.sortField === "Translation");
    const oldStyle = await clone({ ...cloneInput, dryRun: false, expectedSourceDesignHash: preview.sourceDesignHash });
    assert.ok(oldStyle.validation.issues.some(({ code }) => code === "clone_hash_required"));

    const apply = { ...cloneInput, dryRun: false, expectedCloneHash: preview.cloneHash };
    state.source.sortField = "Verb";
    const stale = await clone(apply);
    assert.equal(stale.sourceDesignHash, preview.sourceDesignHash);
    assert.notEqual(stale.cloneHash, preview.cloneHash);
    assert.ok(stale.validation.issues.some(({ code }) => code === "clone_impact_changed"));
    state.source.sortField = "Translation";
    state.session = "different-collection";
    assert.equal((await clone(apply)).created, false);
    state.session = "creation-session";
    assert.equal((await clone({ ...apply, targetModelName: "Different Copy" })).created, false);
    assert.equal(state.writes.length, 0);

    const created = createNoteTypeConfig.outputSchema.parse((await create({ ...createInput, dryRun: false })).structuredContent);
    assert.ok(created.created && created.sortField === "Translation");
    assert.deepEqual(created.fields.map(({ name }) => name), fields);
    const copied = await clone(apply);
    assert.ok(copied.created && copied.cloneSummary.sortField === "Translation");
    assert.deepEqual(state.writes.map(({ name, sortField }) => ({ name, sortField })), [
      { name: createInput.modelName, sortField: "Translation" },
      { name: cloneInput.targetModelName, sortField: "Translation" },
    ]);
    const defaultSort = await create({ ...createInput, modelName: "Default Sort", sortField: undefined, dryRun: false });
    const savedDefault = createNoteTypeConfig.outputSchema.parse(defaultSort.structuredContent);
    assert.ok(savedDefault.created && savedDefault.sortField === "Verb");
    assert.ok(!("sortField" in state.writes[2]!));
  });
}

for (const mode of ["create", "clone"] as const) {
  test(`${mode} readback refuses success if Anki saved the wrong sort field`, async (t) => {
    const state = fixture(t, "v1");
    const client = await connect(t, "2026-07-28");
    const name = mode + "-note-type";
    const call = (args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const args = mode === "create" ? createInput : {
      ...cloneInput, expectedCloneHash: cloneNoteTypeConfig.outputSchema.parse((await call(cloneInput)).structuredContent).cloneHash,
    };
    state.ignoreSortField = true;
    const result = await call({ ...args, dryRun: false });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /may already have created/u);
    assert.equal(state.writes.length, 1);
  });
}

test("legacy rejects explicit sort before HTTP and still clones with its previous design hash", async (t) => {
  const state = fixture(t, "legacy");
  const client = await connect(t, "2025-11-25");
  const incompatible = await client.callTool({ name: "create-note-type", arguments: createInput });
  assert.equal(incompatible.isError, true);
  assert.match(JSON.stringify(incompatible.content), /requires ANKI_API_MODE=v1/u);
  assert.equal(state.calls.length, 0);
  const call = (args: Record<string, unknown>) => client.callTool({ name: "clone-note-type", arguments: args });
  const preview = cloneNoteTypeConfig.outputSchema.parse((await call(cloneInput)).structuredContent);
  assert.equal(preview.cloneHash, null);
  assert.equal(preview.cloneSummary.sortField, null);
  const result = await call({ ...cloneInput, dryRun: false, expectedSourceDesignHash: preview.sourceDesignHash });
  assert.equal(cloneNoteTypeConfig.outputSchema.parse(result.structuredContent).created, true);
  const created = createNoteTypeConfig.outputSchema.parse((await client.callTool({
    name: "create-note-type", arguments: { ...createInput, sortField: undefined, dryRun: false },
  })).structuredContent);
  assert.ok(created.created && created.sortField === null);
  assert.equal(state.writes.length, 2);
  assert.ok(state.writes.every((write) => !("sortField" in write)));
});
