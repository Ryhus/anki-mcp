import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";
import { replaceNoteTypeText, replaceNoteTypeTextConfig } from "../mcp/tools/note-types/replace-note-type-text.js";
import { deleteUnusedTags, deleteUnusedTagsConfig } from "../mcp/tools/notes/delete-unused-tags.js";

const tagTool = "delete-unused-tags";
const replaceTool = "replace-note-type-text";
const replacement = { noteTypeIds: [9, 8, 7], targets: ["css", "answer"], find: "OLD.", replace: "$&-new" };
const unused = ["Parent", "Unused"];

function design(id: string, answerHtml: string) {
  return {
    id, name: `Type ${id}`, fields: [{ name: "Front" }, { name: "Back" }],
    css: id === "7" ? '.card { font-family: "OLD."; }' : ".card { color: black; }",
    templates: [{ name: "Card 1", questionHtml: '<div title="OLD.">{{Front}}</div>', answerHtml }],
  };
}

function fixture(t: TestContext) {
  const env = { ANKI_URL: "http://127.0.0.1:8765", ANKI_API_MODE: "v1" };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const state = {
    session: "maintenance-session",
    registry: ["Unused", "Parent::Child", "Parent", "Keep", "Cardless"],
    noteTags: new Map([["11", ["Parent::Child", "Keep"]], ["12", ["Cardless"]]]),
    types: new Map([
      ["7", design("7", "<span>OLD. OLD. OLDx old.</span>{{Back}}")],
      ["8", design("8", "{{Back}}<span>OLD.</span>")],
      ["9", design("9", "{{Back}}")],
    ]),
    calls: [] as string[],
    oversizedTagScan: false,
    deletionFault: null as "count" | "wrong-tag" | null,
    replacementFault: null as "count" | "unrelated-side" | null,
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new URL(url).pathname, "/api/v1");
    const { id, method, params } = JSON.parse(String(init.body));
    state.calls.push(method);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    if (method === "collection.get") {
      assert.deepEqual(params, {});
      return ok({ session: state.session, profile: "Fixture" });
    }
    assert.equal(params.session, state.session);
    switch (method) {
      case "tags.list":
        assert.deepEqual(Object.keys(params), ["session"]);
        return ok(state.registry);
      case "notes.search":
        assert.equal(params.query, "-tag:none");
        assert.equal(params.limit, 1000);
        if (state.oversizedTagScan) {
          const page = Number(params.cursor ?? "0");
          return ok({ ids: Array.from({ length: 1000 }, (_, index) => String(page * 1000 + index + 1)), nextCursor: String(page + 1) });
        }
        return ok(params.cursor === undefined ? { ids: ["11"], nextCursor: "second-page" }
          : { ids: ["12"], nextCursor: null });
      case "notes.getMany":
        return ok({ items: (params.ids as string[]).map((noteId, index) => {
          const tags = state.noteTags.get(noteId);
          return tags === undefined ? { index, error: { code: 1001, message: "not found" } }
            : { index, result: {
              id: noteId, noteType: { id: "7", name: "Type 7" }, tags, fields: { Front: "OLD." },
              cardIds: noteId === "12" ? [] : ["21"], modifiedAt: "2026-11-05T12:00:00Z",
            } };
        }) });
      case "tags.deleteUnused": {
        assert.deepEqual(Object.keys(params), ["session"]);
        const before = state.registry.length;
        const used = new Set([...state.noteTags.values()].flat());
        state.registry = state.registry.filter((tag) => state.deletionFault === "wrong-tag" && tag === "Keep" ? false
          : state.deletionFault === "wrong-tag" && tag === "Unused" ? true : used.has(tag));
        return ok({ changedCount: before - state.registry.length + (state.deletionFault === "count" ? 1 : 0) });
      }
      case "noteTypes.get": {
        assert.equal(typeof params.noteType.id, "string");
        const type = state.types.get(params.noteType.id);
        return type === undefined ? Response.json({ jsonrpc: "2.0", id, error: { code: 1001, message: "not found" } }) : ok(type);
      }
      case "noteTypes.replaceText": {
        assert.deepEqual(params.noteTypes, [{ id: "7" }, { id: "8" }]);
        assert.deepEqual(params.targets, ["answer", "css"]);
        assert.equal(params.allNoteTypes, undefined);
        assert.equal(params.find, replacement.find);
        assert.equal(params.replace, replacement.replace);
        for (const type of [state.types.get("7")!, state.types.get("8")!]) {
          type.css = type.css.replaceAll(params.find, () => params.replace);
          type.templates[0]!.answerHtml = type.templates[0]!.answerHtml.replaceAll(params.find, () => params.replace);
        }
        if (state.replacementFault === "unrelated-side") state.types.get("7")!.templates[0]!.questionHtml += " changed";
        return ok({ changedCount: state.replacementFault === "count" ? 1 : 2 });
      }
      default:
        throw new Error(`Unexpected method: ${method}`);
    }
  });
  return state;
}

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version}: preview and verify unused tag cleanup and scoped literal replacement`, async (t) => {
    const state = fixture(t);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(createServer, { transport: b });
    const client = new Client({ name: "collection-maintenance-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await server.close(); });
    await client.connect(a);
    const { tools } = await client.listTools();
    for (const name of [tagTool, replaceTool]) {
      assert.equal(tools.find((tool) => tool.name === name)?.annotations?.destructiveHint, true);
    }
    for (const args of [
      { ...replacement, allNoteTypes: true }, { ...replacement, noteTypeIds: [] },
      { ...replacement, noteTypeIds: [7, 7] }, { ...replacement, targets: ["css", "css"] },
      { ...replacement, targets: [] }, { ...replacement, find: "" }, { ...replacement, replace: replacement.find },
      { ...replacement, find: "\uD800" },
    ]) assert.equal((await client.callTool({ name: replaceTool, arguments: args })).isError, true);
    assert.equal(state.calls.length, 0);
    const tags = async (args: Record<string, unknown>) => deleteUnusedTagsConfig.outputSchema.parse(
      (await client.callTool({ name: tagTool, arguments: args })).structuredContent,
    );
    const replace = async (args: Record<string, unknown>) => replaceNoteTypeTextConfig.outputSchema.parse(
      (await client.callTool({ name: replaceTool, arguments: args })).structuredContent,
    );

    const tagPreview = await tags({});
    assert.ok(tagPreview.dryRun && !tagPreview.applied && tagPreview.impactHash);
    assert.equal(tagPreview.registeredTagCount, 5);
    assert.deepEqual(tagPreview.unusedTags, unused);
    const applyTags = { dryRun: false, confirmDeletion: true, expectedImpactHash: tagPreview.impactHash };
    assert.match((await tags({ ...applyTags, confirmDeletion: false })).blockers.join(" "), /requires confirmDeletion/u);
    state.noteTags.get("12")!.push("Unused");
    assert.match((await tags(applyTags)).blockers.join(" "), /tag usage/u);
    state.noteTags.get("12")!.pop();
    state.registry.reverse();
    assert.ok(!state.calls.includes("tags.deleteUnused"));
    const tagResult = await tags(applyTags);
    assert.ok(tagResult.applied && tagResult.verified);
    assert.equal(tagResult.deletedCount, 2);
    assert.deepEqual([...state.registry].sort(), ["Cardless", "Keep", "Parent::Child"]);
    assert.deepEqual(state.noteTags.get("12"), ["Cardless"]);
    assert.equal((await tags(applyTags)).applied, false);
    assert.equal(state.calls.filter((method) => method === "tags.deleteUnused").length, 1);

    const preview = await replace(replacement);
    assert.ok(preview.dryRun && !preview.applied && preview.impactHash && preview.validation.valid);
    assert.equal(preview.changedTypeCount, 2);
    assert.equal(preview.occurrenceCount, 4);
    assert.deepEqual(preview.changes[0]?.matches, [
      { target: "css", templateName: null, occurrences: 1 },
      { target: "answer", templateName: "Card 1", occurrences: 2 },
    ]);
    const applyText = { ...replacement, dryRun: false, confirmReplacement: true, expectedImpactHash: preview.impactHash };
    assert.match((await replace({ ...applyText, confirmReplacement: false })).blockers.join(" "), /requires confirmReplacement/u);
    const question = state.types.get("8")!.templates[0]!.questionHtml;
    state.types.get("8")!.templates[0]!.questionHtml += " manual edit";
    assert.match((await replace(applyText)).blockers.join(" "), /Preview again/u);
    state.types.get("8")!.templates[0]!.questionHtml = question;
    assert.ok(!state.calls.includes("noteTypes.replaceText"));
    const changed = await replace({ ...applyText, noteTypeIds: [7, 9, 8], targets: ["answer", "css"] });
    assert.ok(changed.applied && changed.verified);
    assert.equal(state.types.get("7")!.css, '.card { font-family: "$&-new"; }');
    assert.equal(state.types.get("7")!.templates[0]!.answerHtml, "<span>$&-new $&-new OLDx old.</span>{{Back}}");
    assert.equal(state.types.get("8")!.templates[0]!.questionHtml, question);
    assert.equal((await replace(applyText)).applied, false);
    assert.equal(state.calls.filter((method) => method === "noteTypes.replaceText").length, 1);
  });
}

async function directTags(args: unknown) {
  return deleteUnusedTagsConfig.outputSchema.parse(
    (await deleteUnusedTags(deleteUnusedTagsConfig.inputSchema.parse(args))).structuredContent,
  );
}

async function directReplacement(args: unknown) {
  return replaceNoteTypeTextConfig.outputSchema.parse(
    (await replaceNoteTypeText(replaceNoteTypeTextConfig.inputSchema.parse(args))).structuredContent,
  );
}

test("unsafe or stale maintenance plans and confirmed no-ops do not write", async (t) => {
  const state = fixture(t);
  const badTemplate = await directReplacement({ ...replacement, targets: ["answer"], find: "{{Back}}", replace: "{{Unknown}}" });
  assert.equal(badTemplate.impactHash, null);
  assert.ok(badTemplate.validation.issues.some(({ code }) => code === "unknown_field"));
  const badCss = await directReplacement({ ...replacement, targets: ["css"], find: "}", replace: "" });
  assert.ok(!badCss.validation.valid);
  const growth = await directReplacement({ ...replacement, targets: ["answer"], find: "A", replace: "B".repeat(4_000) });
  assert.equal(growth.changedTypeCount, 0);
  state.types.get("7")!.templates[0]!.answerHtml += "A".repeat(100);
  const oversized = await directReplacement({ ...replacement, targets: ["answer"], find: "A", replace: "B".repeat(4_000) });
  assert.ok(oversized.validation.issues.some(({ code }) => code === "invalid_replacement_length"));
  await assert.rejects(directReplacement({ ...replacement, noteTypeIds: [7, 99] }), /notFound/u);

  const tagPreview = await directTags({});
  const textPreview = await directReplacement(replacement);
  state.session = "other-profile-session";
  const stale = await directTags({ dryRun: false, confirmDeletion: true, expectedImpactHash: tagPreview.impactHash });
  assert.match(stale.blockers.join(" "), /session changed/u);
  const staleText = await directReplacement({ ...replacement, dryRun: false, confirmReplacement: true, expectedImpactHash: textPreview.impactHash });
  assert.match(staleText.blockers.join(" "), /session changed/u);

  state.registry = ["Cardless", "Keep", "Parent::Child"];
  const noTags = await directTags({});
  const noDelete = await directTags({ dryRun: false, confirmDeletion: true, expectedImpactHash: noTags.impactHash });
  assert.ok(!noDelete.applied && noDelete.verified);
  const noMatches = { ...replacement, find: "no matches" };
  const noText = await directReplacement(noMatches);
  const noReplace = await directReplacement({ ...noMatches, dryRun: false, confirmReplacement: true, expectedImpactHash: noText.impactHash });
  assert.ok(!noReplace.applied && noReplace.verified);
  state.noteTags.delete("12");
  await assert.rejects(directTags({}), /Tagged Notes changed/u);
  assert.ok(!state.calls.includes("tags.deleteUnused") && !state.calls.includes("noteTypes.replaceText"));
});

for (const fault of ["count", "readback"] as const) {
  test(`maintenance does not claim success or retry when ${fault} verification fails`, async (t) => {
    const state = fixture(t);
    const tags = await directTags({});
    const text = await directReplacement(replacement);
    state.deletionFault = fault === "count" ? "count" : "wrong-tag";
    state.replacementFault = fault === "count" ? "count" : "unrelated-side";
    await assert.rejects(directTags({
      dryRun: false, confirmDeletion: true, expectedImpactHash: tags.impactHash,
    }), /No retry or rollback/u);
    await assert.rejects(directReplacement({
      ...replacement, dryRun: false, confirmReplacement: true, expectedImpactHash: text.impactHash,
    }), /No retry or rollback/u);
    assert.equal(state.calls.filter((method) => method === "tags.deleteUnused").length, 1);
    assert.equal(state.calls.filter((method) => method === "noteTypes.replaceText").length, 1);
  });
}

test("maintenance rejects legacy mode and stops oversized scans before loading note fields", async (t) => {
  const state = fixture(t);
  process.env.ANKI_API_MODE = "legacy";
  await assert.rejects(directTags({}), /requires ANKI_API_MODE=v1/u);
  await assert.rejects(directReplacement(replacement), /requires ANKI_API_MODE=v1/u);
  assert.equal(state.calls.length, 0);
  process.env.ANKI_API_MODE = "v1";
  state.oversizedTagScan = true;
  await assert.rejects(directTags({}), /50000 tagged Notes/u);
  assert.equal(state.calls.filter((method) => method === "notes.search").length, 50);
  assert.ok(!state.calls.includes("notes.getMany") && !state.calls.includes("tags.deleteUnused"));
});
