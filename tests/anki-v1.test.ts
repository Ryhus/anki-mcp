import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { getDeckNameMap } from "../anki-api/decks/deck-client.js";
import { invokeAnki } from "../anki-api/anki-request.js";
import { callAnkiV1 } from "../anki-api/v1/anki-v1-request.js";
import { getV1NoteSearchPage } from "../anki-api/v1/anki-v1-note-search.js";
import { ankiRequestLimiter } from "../anki-api/anki-request-limiter.js";
import { loadNoteTypeDesign } from "../mcp/tools/note-types/note-type-design-utils.js";

const secret = "private-test-token";
const base = `http://127.0.0.1:8765/proxy/anki/?token=${secret}`;

function configure(t: TestContext, mode = "v1"): void {
  const saved = [process.env.ANKI_URL, process.env.ANKI_API_MODE];
  process.env.ANKI_URL = base;
  process.env.ANKI_API_MODE = mode;
  t.after(() => {
    for (const [index, key] of ["ANKI_URL", "ANKI_API_MODE"].entries()) {
      const value = saved[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function request(init: RequestInit | undefined) {
  return JSON.parse(String(init?.body)) as {
    id: string;
    jsonrpc?: string;
    method?: string;
    action?: string;
    params: Record<string, unknown>;
  };
}

function success(id: string, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

test("v1 sends JSON-RPC to the derived endpoint and preserves the proxy prefix and query", async (t) => {
  configure(t);
  const ids: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, `http://127.0.0.1:8765/proxy/anki/api/v1?token=${secret}`);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    const { id, jsonrpc, method, params } = request(init);
    assert.equal(jsonrpc, "2.0");
    assert.equal(method, "decks.list");
    assert.deepEqual(params, {});
    ids.push(id);
    return success(id, [{ id: "1", name: "Default", kind: "normal" }]);
  });
  assert.deepEqual(await getDeckNameMap(), { Default: 1 });
  assert.deepEqual(await getDeckNameMap(), { Default: 1 });
  assert.equal(new Set(ids).size, 2);
});

for (const fault of ["wrong-id", "both", "wrong-version", "invalid-payload", "unsafe-id", "duplicate-id"] as const) {
  test(`v1 rejects ${fault} replies without leaking contents or falling back`, async (t) => {
    configure(t);
    const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const { id } = request(init);
      switch (fault) {
        case "wrong-id": return success(secret, []);
        case "both": return Response.json({ jsonrpc: "2.0", id, result: [], error: null });
        case "wrong-version": return Response.json({ jsonrpc: "1.0", id, result: [] });
        case "invalid-payload": return success(id, { secret });
        case "unsafe-id": return success(id, [{ id: "9007199254740993", name: secret }]);
        case "duplicate-id": return success(id, [{ id: "1", name: secret }, { id: "1", name: "Other" }]);
      }
    });
    await assert.rejects(getDeckNameMap(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ANKI_INVALID_RESPONSE/u);
      assert.doesNotMatch(error.message, new RegExp(secret, "u"));
      return true;
    });
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test("v1 errors keep the typed code without exposing backend messages or retrying", async (t) => {
  configure(t);
  const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json({
    jsonrpc: "2.0", id: request(init).id,
    error: { code: 1005, message: secret, data: { type: "staleSession", detail: secret } },
  }));
  await assert.rejects(getDeckNameMap(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /staleSession \(1005\)/u);
    assert.doesNotMatch(error.message, new RegExp(secret, "u"));
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test("v1 shares the legacy limiter and a queued deadline cannot send JSON-RPC later", async (t) => {
  configure(t);
  const response = Promise.withResolvers<Response>();
  const fetch = t.mock.method(globalThis, "fetch", () => response.promise);
  const legacy = invokeAnki("version");
  const held = Array.from({ length: 3 }, () => ankiRequestLimiter.tryAcquire()!);
  t.after(() => {
    held.forEach((release) => release());
    response.resolve(Response.json({ result: 6, error: null }));
  });
  assert.ok(held.every((release) => typeof release === "function"));
  await assert.rejects(callAnkiV1("decks.list", {}, z.array(z.unknown()), { timeoutMs: 15 }), {
    kind: "timeout", mayHaveExecuted: false,
  });
  held.forEach((release) => release());
  response.resolve(Response.json({ result: 6, error: null }));
  assert.equal(await legacy, 6);
  assert.equal(fetch.mock.callCount(), 1);
});

test("unknown mode and a v1-suffixed base URL fail before any request", async (t) => {
  configure(t, secret);
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected HTTP request"));
  await assert.rejects(getDeckNameMap(), /ANKI_API_MODE must be legacy or v1/u);
  process.env.ANKI_API_MODE = "v1";
  process.env.ANKI_URL = "http://127.0.0.1:8765/api/v1/";
  await assert.rejects(getDeckNameMap(), /without \/api\/v1/u);
  assert.equal(fetch.mock.callCount(), 0);
});

test("one v1 design snapshot preserves the legacy contract and design hash", async (t) => {
  configure(t, "legacy");
  const calls: string[] = [];
  const css = ".card { color: navy }";
  const questionHtml = "{{Front}}";
  const answerHtml = "{{FrontSide}}<hr>{{Back}}";
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const { action, method, id, params } = request(init);
    calls.push(method ?? action!);
    if (method === "noteTypes.get") {
      assert.deepEqual(params, { noteType: { name: "Basic" } });
      return success(id, {
        id: "123", name: "Basic", css, fields: [{ name: "Front" }, { name: "Back" }],
        templates: [{ name: "Card 1", questionHtml, answerHtml }],
      });
    }
    const results: Record<string, unknown> = {
      modelNamesAndIds: { Basic: 123 },
      modelFieldNames: ["Front", "Back"],
      modelStyling: { css },
      modelTemplates: { "Card 1": { Front: questionHtml, Back: answerHtml } },
    };
    const result = results[action!];
    assert.notEqual(result, undefined);
    return Response.json({ result, error: null });
  });
  const legacy = await loadNoteTypeDesign("Basic");
  assert.deepEqual(calls, ["modelNamesAndIds", "modelFieldNames", "modelStyling", "modelTemplates"]);
  calls.length = 0;
  process.env.ANKI_API_MODE = "v1";
  assert.deepEqual(await loadNoteTypeDesign("Basic"), legacy);
  assert.deepEqual(calls, ["noteTypes.get"]);
});

for (const fault of ["over-limit", "wrong-index", "wrong-note", "stale-session"] as const) {
  test(`v1 native note pages reject ${fault} data instead of returning a misleading page`, async (t) => {
    configure(t);
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const { id, method, params } = request(init);
      calls.push(method!);
      if (method === "collection.get") return success(id, { session: "s" });
      assert.equal(params.session, "s");
      if (method === "notes.search") {
        return success(id, { ids: fault === "over-limit" ? ["1", "2"] : ["1"], nextCursor: null });
      }
      assert.equal(method, "notes.getMany");
      if (fault === "stale-session") return success(id, { items: [{ index: 0, error: { code: 1005, message: secret } }] });
      return success(id, {
        items: [{
          index: fault === "wrong-index" ? 1 : 0,
          result: {
            id: fault === "wrong-note" ? "2" : "1",
            noteType: { id: "1", name: "Basic" }, fields: { Front: "Cat" },
            tags: [], cardIds: ["100"], modifiedAt: "2026-11-05T00:00:00Z",
          },
        }],
      });
    });
    await assert.rejects(getV1NoteSearchPage("", 1), fault === "stale-session" ? /staleSession/u : /ANKI_INVALID_RESPONSE/u);
    assert.deepEqual(calls, fault === "over-limit"
      ? ["collection.get", "notes.search"] : ["collection.get", "notes.search", "notes.getMany"]);
  });
}
