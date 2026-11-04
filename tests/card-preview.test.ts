import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { AnkiCardInfo, AnkiCardInfoResult } from "../anki-api/cards/card-types.js";
import { createServer } from "../mcp/create-server.js";
import { buildCardPreviewDocument, CARD_PREVIEW_CSP } from "../mcp/tools/cards/card-preview-document.js";
import {
  CARD_PREVIEW_SOURCE_BYTE_LIMIT,
  cardPreviewInputSchema,
  cardPreviewOutputSchema,
} from "../mcp/tools/cards/card-preview-schemas.js";
import { getCardPreview } from "../mcp/tools/cards/get-card-preview.js";

test("card preview defaults to both sides in light mode and validates its small input", () => {
  assert.deepEqual(cardPreviewInputSchema.parse({ cardId: 123 }), {
    cardId: 123, side: "both", theme: "light",
  });
  for (const input of [
    {}, { cardId: 0 }, { cardId: -1 }, { cardId: 1.5 }, { cardId: "123" },
    { cardId: 123, side: "question" }, { cardId: 123, theme: "auto" },
  ]) assert.equal(cardPreviewInputSchema.safeParse(input).success, false);
});

test("preview preserves Anki's exact rendered HTML and CSS using just one read", async (t) => {
  const anki = mockCard(t);
  const before = structuredClone(anki.card);
  const result = await preview();
  assert.equal(result.exists, true);
  assert.ok(result.preview);
  assert.equal(result.preview.noteId, 456);
  assert.equal(result.preview.modelName, "Basic");
  assert.equal(result.preview.deckName, "Example");
  assert.equal(result.preview.css, anki.card.css);
  assert.deepEqual(result.preview.sides.map(({ side }) => side), ["front", "back"]);
  assert.equal(result.preview.sides[0]?.html, anki.card.question);
  assert.equal(result.preview.sides[1]?.html, anki.card.answer);
  assert.match(result.preview.sides[0]?.document ?? "", /<b>das Haus<\/b>/u);
  assert.match(result.preview.sides[1]?.document ?? "", /<hr id="answer">House/u);
  assert.deepEqual(anki.requests, [{ action: "cardsInfo", params: { cards: [123] } }]);
  assert.deepEqual(anki.card, before);
  assert.match(result.warnings.join(" "), /not a screenshot/u);
});

test("front/back selection and dark mode affect only the preview wrapper", async (t) => {
  const anki = mockCard(t);
  anki.card.ord = 2;
  const dark = await preview({ side: "back", theme: "dark" });
  assert.ok(dark.preview);
  assert.equal(dark.preview.templateOrdinal, 2);
  assert.equal(dark.preview.theme, "dark");
  assert.equal(dark.preview.sides.length, 1);
  assert.equal(dark.preview.sides[0]?.side, "back");
  assert.match(dark.preview.sides[0]?.document ?? "", /class="card card3 nightMode night_mode"/u);
  assert.match(dark.preview.sides[0]?.document ?? "", /color-scheme: dark/u);
  assert.equal(dark.preview.css, anki.card.css);
  const light = await preview({ side: "front" });
  assert.equal(light.preview?.sides.length, 1);
  assert.equal(light.preview?.sides[0]?.side, "front");
  assert.match(light.preview?.sides[0]?.document ?? "", /class="card card3"/u);
  assert.doesNotMatch(light.preview?.sides[0]?.document ?? "", /class="[^"]*nightMode/u);
});

test("missing cards return an explicit empty preview rather than opening the reviewer", async (t) => {
  const anki = mockCard(t);
  anki.card = {};
  assert.deepEqual(await preview(), { cardId: 123, exists: false, preview: null, warnings: [] });
  assert.equal(anki.requests.length, 1);
});

test("missing CSS refuses an incomplete preview", async (t) => {
  const anki = mockCard(t);
  delete anki.card.css;
  await assert.rejects(preview(), /omitted CSS/u);
});

test("source limits count UTF-8 bytes and never return silently truncated previews", async (t) => {
  const anki = mockCard(t);
  anki.card.css = "";
  anki.card.question = "é".repeat(CARD_PREVIEW_SOURCE_BYTE_LIMIT / 2);
  const exact = await preview({ side: "front" });
  assert.equal(exact.preview?.sides[0]?.html, anki.card.question);
  anki.card.question += "x";
  await assert.rejects(preview({ side: "front" }), /No truncated preview was returned/u);
});

test("requesting one side can avoid the combined source limit", async (t) => {
  const anki = mockCard(t);
  anki.card.answer = "x".repeat(CARD_PREVIEW_SOURCE_BYTE_LIMIT);
  await assert.rejects(preview(), /Request a single side/u);
  assert.equal((await preview({ side: "front" })).preview?.sides.length, 1);
  anki.card.css = "x".repeat(CARD_PREVIEW_SOURCE_BYTE_LIMIT);
  await assert.rejects(preview({ side: "front" }), /limit/u);
});

test("documents preserve useful static markup, inline styles, Unicode, and CSS", () => {
  const html = '<div class="word" style="color: red" lang="de" dir="ltr" data-kind="verb" aria-label="word"><ruby>漢<rt>かん</rt></ruby> 🏠<table><tr><td colspan="2">House</td></tr></table><details open><summary>Hint</summary>Answer</details></div>';
  const result = documentFor(html);
  assert.equal(result.removedElementCount, 0);
  assert.equal(result.removedAttributeCount, 0);
  const elements = elementsIn(result.document);
  assert.ok(elements.some((node) => node.tagName === "ruby"));
  assert.ok(elements.some((node) => node.tagName === "td" && node.attrs.some(({ name, value }) => name === "colspan" && value === "2")));
  assert.match(result.document, /style="color: red"/u);
  assert.match(result.document, /data-kind="verb"/u);
  assert.match(result.document, /aria-label="word"/u);
  assert.match(result.document, /🏠/u);
});

test("documents drop scripts, embeds, foreign namespaces, refresh, base URLs, and templates", () => {
  const malicious = '<script>alert(1)</script><iframe src="http://localhost:8765"></iframe><object data="file:///etc/passwd"></object><embed src="https://example.org"><meta http-equiv="refresh" content="0;url=https://example.org"><base href="https://example.org"><link rel="stylesheet" href="https://example.org"><svg><a href="javascript:alert(1)">SVG</a></svg><math><mtext>MathML</mtext></math><template><img src="https://example.org"></template><form action="https://example.org"><input></form><p>Kept</p>';
  const result = documentFor(malicious);
  const elements = elementsIn(result.document);
  const forbidden = new Set(["script", "iframe", "object", "embed", "base", "link", "svg", "math", "template", "form"]);
  assert.ok(elements.every((node) => !forbidden.has(node.tagName)));
  assert.equal(elements.filter((node) => node.tagName === "meta" && node.attrs.some(({ value }) => value === "refresh")).length, 0);
  assert.match(result.document, /<p>Kept<\/p>/u);
  assert.ok(result.removedElementCount >= 10);
});

test("event handlers, URL attributes, and media sources never survive into documents", () => {
  const result = documentFor('<a href="javascript:alert(1)" ping="https://example.org" onclick="alert(1)">Link</a><img src="file:///etc/passwd" srcset="https://example.org 2x" onerror="alert(1)" alt="Cat"><div background="https://example.org" onmouseover="alert(1)">Text</div><input formaction="https://example.org" autofocus value="Answer"><audio autoplay src="sound.mp3"></audio>');
  const forbiddenAttributes = new Set(["href", "ping", "src", "srcset", "background", "formaction", "autofocus", "autoplay"]);
  for (const element of elementsIn(result.document)) {
    for (const attribute of element.attrs) {
      assert.equal(attribute.name.startsWith("on"), false);
      assert.equal(forbiddenAttributes.has(attribute.name), false);
    }
    if (element.tagName === "input") assert.ok(element.attrs.some(({ name }) => name === "disabled"));
  }
  assert.match(result.document, /alt="Cat"/u);
  assert.ok(result.removedAttributeCount >= 10);
});

test("CSP precedes untrusted content and blocks requests, scripts, forms, and frames", () => {
  const result = documentFor('<style>@import "https://example.org/x.css";</style><p style="background: url(http://127.0.0.1:8765)">Offline</p>');
  const elements = elementsIn(result.document);
  const cspIndex = elements.findIndex((node) => node.tagName === "meta" && node.attrs.some(({ name, value }) => name === "http-equiv" && value === "Content-Security-Policy"));
  const csp = elements[cspIndex]?.attrs.find(({ name }) => name === "content")?.value;
  assert.equal(csp, CARD_PREVIEW_CSP);
  assert.match(csp ?? "", /default-src 'none'/u);
  assert.match(csp ?? "", /script-src 'none'/u);
  assert.match(csp ?? "", /style-src 'unsafe-inline'/u);
  assert.match(csp ?? "", /form-action 'none'/u);
  assert.match(csp ?? "", /base-uri 'none'/u);
  assert.ok(cspIndex < elements.findIndex((node) => node.tagName === "style"));
});

test("metadata and raw CSS cannot break out of the generated head", () => {
  const result = buildCardPreviewDocument({
    html: "<b>Safe</b>", css: '.card::after { content: "</style><script>alert(1)</script>"; }',
    title: '</title><img src=x onerror="alert(1)">', theme: "light", templateOrdinal: 0,
  });
  const elements = elementsIn(result.document);
  assert.equal(elements.some((node) => node.tagName === "script" || node.tagName === "img"), false);
  assert.equal(elements.filter((node) => node.tagName === "title").length, 1);
  assert.match(result.document, /\\3c \/style>/u);
  assert.match(result.document, /&lt;\/title&gt;/u);
});

test("scripts and media are removed only from documents, never from returned raw HTML", async (t) => {
  const anki = mockCard(t);
  anki.card.question = '<script>window.answer = 42</script><img src="cat.png" onerror="alert(1)"><span class="cloze">[...]</span>[sound:cat.mp3]';
  const result = await preview({ side: "front" });
  assert.equal(result.preview?.sides[0]?.html, anki.card.question);
  assert.match(result.preview?.sides[0]?.document ?? "", /class="cloze"/u);
  assert.doesNotMatch(result.preview?.sides[0]?.document ?? "", /window\.answer|onerror|src="cat\.png"/u);
  assert.match(result.warnings.join(" "), /removed/u);
});

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  test(`MCP ${version} discovers and validates the read-only preview tool`, async (t) => {
    const anki = mockCard(t);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, { transport: serverTransport });
    const client = new Client({ name: "card-preview-test", version: "0.0.0" }, {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
    });
    t.after(async () => { await client.close(); await handle.close(); });
    await client.connect(clientTransport);
    const tool = (await client.listTools()).tools.find(({ name }) => name === "get-card-preview");
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(anki.requests.length, 0);
    const invalid = await client.callTool({ name: "get-card-preview", arguments: { cardId: "123" } });
    assert.equal(invalid.isError, true);
    assert.equal(anki.requests.length, 0);
    const response = await client.callTool({ name: "get-card-preview", arguments: { cardId: 123, theme: "dark" } });
    assert.notEqual(response.isError, true);
    const result = cardPreviewOutputSchema.parse(response.structuredContent);
    assert.equal(result.preview?.sides.length, 2);
    assert.equal(result.preview?.theme, "dark");
    anki.card = {};
    const missing = cardPreviewOutputSchema.parse((await client.callTool({ name: "get-card-preview", arguments: { cardId: 123 } })).structuredContent);
    assert.equal(missing.exists, false);
    anki.card = { ...card(), css: "x".repeat(CARD_PREVIEW_SOURCE_BYTE_LIMIT) };
    assert.equal((await client.callTool({ name: "get-card-preview", arguments: { cardId: 123 } })).isError, true);
    assert.ok(anki.requests.every(({ action }) => action === "cardsInfo"));
  });
}

async function preview(input: Record<string, unknown> = {}) {
  return cardPreviewOutputSchema.parse((await getCardPreview(
    cardPreviewInputSchema.parse({ cardId: 123, ...input }),
  )).structuredContent);
}

function documentFor(html: string) {
  return buildCardPreviewDocument({ html, css: ".card { color: black; }", title: "Preview", templateOrdinal: 0, theme: "light" });
}

function elementsIn(html: string) {
  const pending: DefaultTreeAdapterTypes.Node[] = [parse(html)];
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node) elements.push(node);
    if ("childNodes" in node) pending.push(...[...node.childNodes].reverse());
    if ("content" in node) pending.push(node.content);
  }
  return elements;
}

function card(): AnkiCardInfo {
  return {
    cardId: 123, note: 456, deckName: "Example", modelName: "Basic", ord: 0,
    question: "<b>das Haus</b>", answer: '<b>das Haus</b><hr id="answer">House',
    css: ".card { color: black; } .nightMode { color: white; }",
    fields: { Front: { value: "das Haus", order: 0 } }, fieldOrder: 0,
    type: 0, queue: 0, factor: 0, interval: 0, due: 1, reps: 0, lapses: 0,
    left: 0, mod: 1_700_000_000,
  };
}

function mockCard(t: TestContext) {
  const originalUrl = process.env.ANKI_URL;
  process.env.ANKI_URL = "http://127.0.0.1:8765";
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ANKI_URL;
    else process.env.ANKI_URL = originalUrl;
  });
  const state = { card: card() as AnkiCardInfoResult, requests: [] as Array<{ action: string; params: unknown }> };
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as (typeof state.requests)[number];
    state.requests.push({ action: request.action, params: request.params });
    assert.equal(request.action, "cardsInfo", "previews must not mutate Anki, request media, or query scheduling");
    assert.deepEqual(request.params, { cards: [123] });
    return Response.json({ result: [state.card], error: null });
  });
  return state;
}
