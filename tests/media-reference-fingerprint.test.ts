import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/create-server.js";
import type { AnkiNoteInfo } from "../anki-api/notes/note-types.js";
import type { AnkiNoteTypeTemplates } from "../anki-api/note-types/note-type-types.js";
import {
  deleteMediaFile,
  deleteMediaFileConfig,
} from "../mcp/tools/media/delete-media-file.js";
import {
  calculateMediaReferenceFingerprint,
  type MediaReferenceFingerprintEntry,
} from "../mcp/tools/media/media-reference-fingerprint.js";
import { findMediaReferencesConfig } from "../mcp/tools/media/find-media-references.js";
import { findMediaUsage } from "../mcp/tools/media/media-usage-utils.js";
import { MEDIA_REFERENCE_SCAN_NOTE_LIMIT } from "../mcp/tools/media/shared-schemas.js";

const FILENAME = "reference-test.png";
const IMAGE = `<img src="${FILENAME}">`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("reference fingerprints are order-independent, filename-specific, and unambiguous", () => {
  const entries: MediaReferenceFingerprintEntry[] = [
    ["note", 1, "Basic", "Front", 2],
    ["template", "Basic", "Card 1", "front", 1],
    ["css", "Basic", 1],
  ];
  const hash = calculateMediaReferenceFingerprint(FILENAME, entries);
  assert.match(hash, /^[a-f0-9]{64}$/u);
  assert.equal(hash, calculateMediaReferenceFingerprint(FILENAME, [...entries].reverse()));
  assert.notEqual(hash, calculateMediaReferenceFingerprint("other.png", entries));
  assert.notEqual(
    calculateMediaReferenceFingerprint(FILENAME, []),
    calculateMediaReferenceFingerprint("other.png", []),
  );
  assert.notEqual(
    calculateMediaReferenceFingerprint(FILENAME, [["css", "A,B", 1]]),
    calculateMediaReferenceFingerprint(FILENAME, [["css", "A", 1], ["css", "B", 1]]),
  );
});

test("every reference identity component and occurrence count affects its fingerprint", () => {
  const pairs: Array<readonly [MediaReferenceFingerprintEntry, MediaReferenceFingerprintEntry]> = [
    [["note", 1, "Basic", "Front", 1], ["note", 2, "Basic", "Front", 1]],
    [["note", 1, "Basic", "Front", 1], ["note", 1, "Other", "Front", 1]],
    [["note", 1, "Basic", "Front", 1], ["note", 1, "Basic", "Back", 1]],
    [["note", 1, "Basic", "Front", 1], ["note", 1, "Basic", "Front", 2]],
    [["template", "Basic", "Card 1", "front", 1], ["template", "Other", "Card 1", "front", 1]],
    [["template", "Basic", "Card 1", "front", 1], ["template", "Basic", "Card 2", "front", 1]],
    [["template", "Basic", "Card 1", "front", 1], ["template", "Basic", "Card 1", "back", 1]],
    [["template", "Basic", "Card 1", "front", 1], ["template", "Basic", "Card 1", "front", 2]],
    [["css", "Basic", 1], ["css", "Other", 1]],
    [["css", "Basic", 1], ["css", "Basic", 2]],
  ];
  for (const [before, after] of pairs) {
    assert.notEqual(
      calculateMediaReferenceFingerprint(FILENAME, [before]),
      calculateMediaReferenceFingerprint(FILENAME, [after]),
      JSON.stringify([before, after]),
    );
  }
});

test("deletion requires a valid reviewed reference fingerprint in addition to existing guards", () => {
  assert.equal(deleteMediaFileConfig.inputSchema.parse({ filename: FILENAME }).dryRun, true);
  const input = {
    filename: FILENAME, dryRun: false, expectedSha256: "a".repeat(64),
    expectedReferenceCount: 0, confirmDeletion: true,
  };
  for (const expectedReferenceFingerprint of [undefined, null, "", "invalid", "A".repeat(64)]) {
    assert.equal(deleteMediaFileConfig.inputSchema.safeParse({
      ...input, expectedReferenceFingerprint,
    }).success, false);
  }
  assert.equal(deleteMediaFileConfig.inputSchema.safeParse({
    ...input, expectedReferenceFingerprint: "b".repeat(64),
  }).success, true);
});

test("moving a reference between Notes blocks stale deletion despite unchanged count", async (t) => {
  const anki = mockMedia(t);
  anki.notes.set(1, note(1, { Front: IMAGE }));
  const preview = await inspectDeletion();
  assert.equal(preview.usage.totalReferenceCount, 1);
  anki.notes.set(1, note(1, { Front: "No image" }));
  anki.notes.set(2, note(2, { Front: IMAGE }));
  const result = await applyPreview(preview);
  assert.equal(result.usage.totalReferenceCount, 1);
  assert.notEqual(result.usage.referenceFingerprint, preview.usage.referenceFingerprint);
  assertFingerprintBlocked(result, anki);
});

test("moving references between fields or changing per-field counts invalidates review", async (t) => {
  const anki = mockMedia(t);
  anki.notes.set(1, note(1, { Front: IMAGE, Back: IMAGE.repeat(2) }));
  const preview = await inspectDeletion();
  anki.notes.set(1, note(1, { Front: IMAGE.repeat(2), Back: IMAGE }));
  const result = await applyPreview(preview);
  assert.equal(result.usage.totalReferenceCount, preview.usage.totalReferenceCount);
  assertFingerprintBlocked(result, anki);
});

test("template side, template name, and CSS owner changes invalidate deletion review", async (t) => {
  const anki = mockMedia(t);
  anki.models.set("Basic", {
    templates: { "Card 1": { Front: IMAGE, Back: "" } }, css: "",
  });
  const frontPreview = await inspectDeletion();
  anki.models.set("Basic", {
    templates: { "Card 1": { Front: "", Back: IMAGE } }, css: "",
  });
  assertFingerprintBlocked(await applyPreview(frontPreview), anki);
  const backPreview = await inspectDeletion();
  anki.models.set("Basic", {
    templates: { "Card 2": { Front: "", Back: IMAGE } }, css: "",
  });
  assertFingerprintBlocked(await applyPreview(backPreview), anki);
  anki.models.set("Basic", { templates: {}, css: `.card { background: url("${FILENAME}") }` });
  const cssPreview = await inspectDeletion();
  anki.models.set("Other", anki.models.get("Basic")!);
  anki.models.delete("Basic");
  const result = await applyPreview(cssPreview);
  assert.equal(result.usage.totalReferenceCount, 1);
  assertFingerprintBlocked(result, anki);
});

test("fingerprints cover references omitted from the bounded response samples", async (t) => {
  const anki = mockMedia(t);
  for (let id = 1; id <= 101; id += 1) anki.notes.set(id, note(id, { Front: IMAGE }));
  const preview = await inspectDeletion();
  assert.equal(preview.usage.noteReferences.length, 100);
  assert.equal(preview.usage.totalReferenceCount, 101);
  assert.equal(preview.usage.referencesTruncated, true);
  anki.notes.set(101, note(101, { Back: IMAGE }));
  const result = await applyPreview(preview);
  assert.deepEqual(result.usage.noteReferences, preview.usage.noteReferences);
  assert.equal(result.usage.totalReferenceCount, preview.usage.totalReferenceCount);
  assertFingerprintBlocked(result, anki);
});

test("unrelated HTML and scan order changes preserve review without extra Anki requests", async (t) => {
  const anki = mockMedia(t);
  anki.notes.set(1, note(1, { Front: IMAGE, Back: "First" }));
  anki.notes.set(2, note(2, { Front: IMAGE }));
  anki.models.set("Basic", {
    templates: { "Card 1": { Front: IMAGE, Back: "" } }, css: "",
  });
  const before = await findMediaUsage(FILENAME);
  assert.deepEqual(anki.requests, ["multi", "multi"]);
  anki.notes.set(1, note(1, { Back: "Edited text", Front: `<b>Changed HTML</b>${IMAGE}` }));
  anki.candidateIds = [2, 1, 2];
  const after = await findMediaUsage(FILENAME);
  assert.equal(before.referenceFingerprint, after.referenceFingerprint);
  assert.equal(after.scanComplete, true);
  assert.equal(after.scannedNoteCount, 2);
  const expected: MediaReferenceFingerprintEntry[] = [
    ["note", 1, "Basic", "Front", 1], ["note", 2, "Basic", "Front", 1],
    ["template", "Basic", "Card 1", "front", 1],
  ];
  assert.equal(after.referenceFingerprint, calculateMediaReferenceFingerprint(FILENAME, expected));
});

test("missing notesInfo results make scans incomplete and block deletion", async (t) => {
  const anki = mockMedia(t);
  anki.notes.set(1, note(1, { Front: IMAGE }));
  const preview = await inspectDeletion();
  anki.candidateIds = [1, 2];
  const result = await applyPreview(preview);
  assert.equal(result.usage.candidateNoteCount, 2);
  assert.equal(result.usage.scannedNoteCount, 1);
  assert.equal(result.usage.scanComplete, false);
  assert.equal(result.usage.referenceFingerprint, null);
  assertFingerprintBlocked(result, anki);
  assert.match(result.blockers.join(" "), /complete candidate reference scan/u);
});

test("bounded partial scans never expose a usable fingerprint", async (t) => {
  const anki = mockMedia(t);
  anki.candidateIds = Array.from({ length: MEDIA_REFERENCE_SCAN_NOTE_LIMIT + 1 }, (_, index) => index + 1);
  anki.generateEmptyNotes = true;
  const usage = await findMediaUsage(FILENAME);
  assert.equal(usage.candidateNoteCount, MEDIA_REFERENCE_SCAN_NOTE_LIMIT + 1);
  assert.equal(usage.scannedNoteCount, MEDIA_REFERENCE_SCAN_NOTE_LIMIT);
  assert.equal(usage.scanComplete, false);
  assert.equal(usage.referenceFingerprint, null);
});

test("CSS failures suppress fingerprints while preserving known Note and template references", async (t) => {
  const anki = mockMedia(t);
  anki.notes.set(1, note(1, { Front: IMAGE }));
  anki.models.set("Basic", {
    templates: { "Card 1": { Front: IMAGE, Back: "" } },
    css: `.card { broken; background: url("${FILENAME}"); }`,
  });
  const usage = await findMediaUsage(FILENAME);
  assert.equal(usage.scannedNoteCount, usage.candidateNoteCount);
  assert.equal(usage.scannedNoteTypeCount, 1);
  assert.equal(usage.scanComplete, false);
  assert.equal(usage.referenceFingerprint, null);
  assert.equal(usage.noteReferenceCount, 1);
  assert.equal(usage.templateReferenceCount, 1);
  assert.equal(usage.cssReferenceCount, 1);
  assert.equal(usage.totalReferenceCount, 3);
  assert.equal(usage.cssScanFailureCount, 1);
  assert.equal(usage.cssScanFailures[0]?.modelName, "Basic");
  assert.match(usage.cssScanFailures[0]?.error ?? "", /line 1, column/u);
  assert.deepEqual(anki.requests, ["multi", "multi"]);
});

test("CSS parse failure alone blocks deletion even with both confirmations and zero detected references", async (t) => {
  const anki = mockMedia(t);
  const preview = await inspectDeletion();
  anki.models.set("Basic", { templates: {}, css: "/* unterminated" });
  const result = await applyPreview(preview);
  assert.equal(result.usage.totalReferenceCount, 0);
  assert.equal(result.usage.scannedNoteCount, result.usage.candidateNoteCount);
  assert.equal(result.usage.cssScanFailureCount, 1);
  assertFingerprintBlocked(result, anki);
  assert.match(result.blockers.join(" "), /complete CSS reference scan/u);
});

test("CSS failure diagnostics are bounded without incorrectly completing a scan", async (t) => {
  const anki = mockMedia(t);
  anki.models.clear();
  for (let index = 0; index < 101; index += 1) {
    anki.models.set(`Broken ${index}`, { templates: {}, css: ".x { broken; }" });
  }
  const usage = await findMediaUsage(FILENAME);
  assert.equal(usage.cssScanFailureCount, 101);
  assert.equal(usage.cssScanFailures.length, 100);
  assert.equal(usage.scanComplete, false);
  assert.equal(usage.referenceFingerprint, null);
});

test("valid CSS yields fingerprints, including references inside custom properties", async (t) => {
  const anki = mockMedia(t);
  anki.models.set("Basic", { templates: {}, css: `:root { --image: url("${FILENAME}"); }` });
  const usage = await findMediaUsage(FILENAME);
  assert.equal(usage.cssReferenceCount, 1);
  assert.equal(usage.scanComplete, true);
  assert.equal(usage.cssScanFailureCount, 0);
  assert.deepEqual(usage.cssScanFailures, []);
  assert.equal(usage.referenceFingerprint, calculateMediaReferenceFingerprint(FILENAME, [["css", "Basic", 1]]));
});

test("a fresh complete scan after CSS repair allows reviewed deletion without rewriting CSS", async (t) => {
  const anki = mockMedia(t);
  const brokenCss = ".card { broken; }";
  anki.models.set("Basic", { templates: {}, css: brokenCss });
  const blocked = await inspectDeletion();
  assert.equal(blocked.usage.scanComplete, false);
  assert.equal(blocked.usage.referenceFingerprint, null);
  assert.equal(anki.models.get("Basic")?.css, brokenCss);
  assert.equal(anki.deleteCalls, 0);
  anki.models.set("Basic", { templates: {}, css: ".card { color: black; }" });
  const reviewed = await inspectDeletion();
  assert.equal(reviewed.usage.scanComplete, true);
  assert.equal(reviewed.usage.cssScanFailureCount, 0);
  assert.deepEqual(reviewed.usage.cssScanFailures, []);
  const result = await applyPreview(reviewed, false);
  assert.equal(result.applied, true);
  assert.equal(anki.deleteCalls, 1);
});

test("a fresh fingerprint permits confirmed deletion but does not bypass broken-reference confirmation", async (t) => {
  const anki = mockMedia(t);
  anki.notes.set(1, note(1, { Front: IMAGE }));
  const preview = await inspectDeletion();
  const refused = await applyPreview(preview, false);
  assert.equal(refused.applied, false);
  assert.match(refused.blockers.join(" "), /confirmBrokenReferences/u);
  assert.equal(anki.deleteCalls, 0);
  const deleted = await applyPreview(preview);
  assert.equal(deleted.applied, true);
  assert.deepEqual(deleted.blockers, []);
  assert.equal(anki.deleteCalls, 1);
  assert.equal(anki.mediaExists, false);
});

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} exposes fingerprints and refuses stale or missing deletion review`, async (t) => {
    const anki = mockMedia(t);
    anki.notes.set(1, note(1, { Front: IMAGE }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "media-fingerprint-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await handle.close(); });
    await client.connect(clientTransport);
    const references = findMediaReferencesConfig.outputSchema.parse(
      (await client.callTool({ name: "find-media-references", arguments: { filename: FILENAME } })).structuredContent,
    );
    const preview = deleteMediaFileConfig.outputSchema.parse(
      (await client.callTool({ name: "delete-media-file", arguments: { filename: FILENAME } })).structuredContent,
    );
    assert.equal(preview.usage.referenceFingerprint, references.usage.referenceFingerprint);
    assert.ok(preview.file);
    const apply = {
      filename: FILENAME, dryRun: false, expectedSha256: preview.file.sha256,
      expectedReferenceCount: 1, confirmDeletion: true, confirmBrokenReferences: true,
    };
    const requestCount = anki.requests.length;
    assert.equal((await client.callTool({ name: "delete-media-file", arguments: apply })).isError, true);
    assert.equal(anki.requests.length, requestCount, "missing review must fail before contacting Anki");
    anki.notes.clear();
    anki.notes.set(2, note(2, { Front: IMAGE }));
    const stale = deleteMediaFileConfig.outputSchema.parse((await client.callTool({
      name: "delete-media-file",
      arguments: { ...apply, expectedReferenceFingerprint: preview.usage.referenceFingerprint },
    })).structuredContent);
    assert.equal(stale.usage.totalReferenceCount, 1);
    assertFingerprintBlocked(stale, anki);
    const fresh = deleteMediaFileConfig.outputSchema.parse((await client.callTool({
      name: "delete-media-file",
      arguments: { ...apply, expectedReferenceFingerprint: stale.usage.referenceFingerprint },
    })).structuredContent);
    assert.equal(fresh.applied, true);
    assert.equal(anki.deleteCalls, 1);
  });

  test(`MCP ${version} reports incomplete CSS scans and blocks confirmed deletion`, async (t) => {
    const anki = mockMedia(t);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "media-css-failure-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await handle.close(); });
    await client.connect(clientTransport);
    const preview = deleteMediaFileConfig.outputSchema.parse((await client.callTool({
      name: "delete-media-file", arguments: { filename: FILENAME },
    })).structuredContent);
    assert.ok(preview.file);
    anki.models.set("Basic", { templates: {}, css: "/* no closing comment" });
    const response = await client.callTool({ name: "find-media-references", arguments: { filename: FILENAME } });
    const references = findMediaReferencesConfig.outputSchema.parse(response.structuredContent);
    assert.equal(references.usage.scanComplete, false);
    assert.equal(references.usage.referenceFingerprint, null);
    assert.equal(references.usage.cssScanFailureCount, 1);
    assert.equal(references.usage.cssScanFailures[0]?.modelName, "Basic");
    assert.match(JSON.stringify(response.content), /at least 0.*incomplete.*CSS/u);
    const deleted = deleteMediaFileConfig.outputSchema.parse((await client.callTool({
      name: "delete-media-file", arguments: {
        filename: FILENAME, dryRun: false, expectedSha256: preview.file.sha256,
        expectedReferenceCount: 0, expectedReferenceFingerprint: preview.usage.referenceFingerprint,
        confirmDeletion: true, confirmBrokenReferences: true,
      },
    })).structuredContent);
    assert.match(deleted.blockers.join(" "), /complete CSS reference scan/u);
    assertFingerprintBlocked(deleted, anki);
  });
}

async function inspectDeletion(input: Record<string, unknown> = {}) {
  const parsed = deleteMediaFileConfig.inputSchema.parse({ filename: FILENAME, ...input });
  return deleteMediaFileConfig.outputSchema.parse((await deleteMediaFile(parsed)).structuredContent);
}

type DeletePreview = Awaited<ReturnType<typeof inspectDeletion>>;

async function applyPreview(preview: DeletePreview, confirmBrokenReferences = true) {
  assert.ok(preview.file);
  assert.ok(preview.usage.referenceFingerprint);
  return inspectDeletion({
    dryRun: false, expectedSha256: preview.file.sha256,
    expectedReferenceCount: preview.usage.totalReferenceCount,
    expectedReferenceFingerprint: preview.usage.referenceFingerprint,
    confirmDeletion: true, confirmBrokenReferences,
  });
}

function assertFingerprintBlocked(result: DeletePreview, anki: { deleteCalls: number; mediaExists: boolean }) {
  assert.equal(result.applied, false);
  assert.match(result.blockers.join(" "), /reference fingerprint/u);
  assert.equal(anki.deleteCalls, 0);
  assert.equal(anki.mediaExists, true);
}

function note(noteId: number, values: Record<string, string>): AnkiNoteInfo {
  return {
    noteId, modelName: "Basic", tags: [], cards: [noteId * 10], mod: 1_700_000_000,
    fields: Object.fromEntries(Object.entries(values).map(([name, value], order) => [name, { value, order }])),
  };
}

function mockMedia(t: TestContext) {
  const originalUrl = process.env.ANKI_URL;
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ANKI_URL;
    else process.env.ANKI_URL = originalUrl;
  });
  const state = {
    notes: new Map<number, AnkiNoteInfo>(),
    models: new Map<string, { templates: AnkiNoteTypeTemplates; css: string }>([
      ["Basic", { templates: {}, css: "" }],
    ]),
    candidateIds: undefined as number[] | undefined,
    generateEmptyNotes: false, mediaExists: true, deleteCalls: 0,
    requests: [] as string[],
  };
  interface Request {
    action: string;
    params?: Record<string, unknown>;
  }
  function execute(action: string, params: Record<string, unknown>): unknown {
    switch (action) {
      case "multi": return (params.actions as Request[]).map((request) => ({
        result: execute(request.action, request.params ?? {}), error: null,
      }));
      case "findNotes": return state.candidateIds ?? [...state.notes.keys()];
      case "notesInfo": return (params.notes as number[]).map((id) =>
        state.notes.get(id) ?? (state.generateEmptyNotes ? note(id, {}) : {}));
      case "modelNamesAndIds": return Object.fromEntries([...state.models.keys()].map((name, index) => [name, index + 1]));
      case "modelTemplates": return state.models.get(String(params.modelName))?.templates;
      case "modelStyling": return { css: state.models.get(String(params.modelName))?.css };
      case "retrieveMediaFile": return state.mediaExists ? PNG : false;
      case "deleteMediaFile": state.deleteCalls += 1; state.mediaExists = false; return null;
      default: throw new Error(`Unexpected Anki action: ${action}`);
    }
  }
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as Request;
    state.requests.push(request.action);
    return Response.json({ result: execute(request.action, request.params ?? {}), error: null });
  });
  return state;
}
