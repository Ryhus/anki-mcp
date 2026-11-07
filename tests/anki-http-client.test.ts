import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer, type RequestListener } from "node:http";
import test, { type TestContext } from "node:test";
import {
  AnkiRequestError,
  callAnki,
  createAnkiAction,
  invokeAnki,
  invokeAnkiMulti,
  type AnkiRequestErrorKind,
} from "../anki-api/anki-request.js";

const SECRET = "private-endpoint-and-note-data";

function configure(t: TestContext): void {
  const previous = [process.env.ANKI_URL, process.env.ANKI_REQUEST_TIMEOUT_MS];
  process.env.ANKI_URL = `http://127.0.0.1:8765/?token=${SECRET}`;
  delete process.env.ANKI_REQUEST_TIMEOUT_MS;
  t.after(() => {
    for (const [index, key] of ["ANKI_URL", "ANKI_REQUEST_TIMEOUT_MS"].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function expectFailure(
  operation: Promise<unknown>, kind: AnkiRequestErrorKind, mayHaveExecuted = true,
): Promise<AnkiRequestError> {
  let failure: AnkiRequestError | undefined;
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof AnkiRequestError);
    assert.equal(error.kind, kind);
    assert.equal(error.mayHaveExecuted, mayHaveExecuted);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, new RegExp(SECRET, "u"));
    assert.doesNotMatch(JSON.stringify(error), new RegExp(SECRET, "u"));
    assert.match(error.message, mayHaveExecuted ? /inspect Anki before retrying/u : /No HTTP request was sent/u);
    failure = error;
    return true;
  });
  assert.ok(failure);
  return failure;
}

async function endpoint(t: TestContext, listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("successful request sends exactly one JSON POST and cleans up cancellation", async (t) => {
  configure(t);
  const caller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const mock = t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    assert.equal(init?.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.deepEqual(init.headers, { "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(String(init.body)), { action: "findNotes", version: 6, params: { query: "cat" } });
    assert.ok(init.signal);
    requestSignal = init.signal;
    assert.notEqual(requestSignal, caller.signal);
    return Response.json({ result: [1, 2], error: null });
  });
  assert.deepEqual(await invokeAnki("findNotes", { query: "cat" }, { signal: caller.signal }), [1, 2]);
  assert.equal(mock.mock.callCount(), 1);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  caller.abort(SECRET);
  assert.equal(requestSignal?.aborted, false, "a later caller abort must not affect the finished request");
});

test("completed requests clear their timers", async (t) => {
  configure(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return Response.json({ result: 6, error: null });
  });
  await invokeAnki("version", undefined, { timeoutMs: 10 });
  t.mock.timers.tick(100);
  assert.equal(requestSignal?.aborted, false);
});

test("a deadline also bounds fetch adapters that ignore AbortSignal", async (t) => {
  configure(t);
  const caller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const mock = t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  const error = await expectFailure(callAnki("deleteNotes", { secret: SECRET }, { timeoutMs: 15, signal: caller.signal }), "timeout");
  assert.equal(error.action, "deleteNotes");
  assert.equal(error.timeoutMs, 15);
  assert.equal(error.status, null);
  assert.match(error.message, /ANKI_TIMEOUT/u);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  assert.equal(mock.mock.callCount(), 1);
});

test("a deadline includes non-cooperative response-body loading", async (t) => {
  configure(t);
  let requestSignal: AbortSignal | undefined;
  const response = new Response();
  t.mock.method(response, "json", () => new Promise<unknown>(() => {}));
  const mock = t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return response;
  });
  await expectFailure(callAnki("version", undefined, { timeoutMs: 15 }), "timeout");
  assert.equal(requestSignal?.aborted, true);
  assert.equal(mock.mock.callCount(), 1);
});

test("a pre-cancelled request never calls fetch or exposes its abort reason", async (t) => {
  configure(t);
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not send"));
  const caller = new AbortController();
  caller.abort(SECRET);
  await expectFailure(callAnki("version", undefined, { signal: caller.signal }), "cancelled", false);
});

test("caller cancellation stops a pending fetch and removes its listener", async (t) => {
  configure(t);
  const caller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const mock = t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  const operation = callAnki("version", undefined, { signal: caller.signal });
  caller.abort(SECRET);
  await expectFailure(operation, "cancelled");
  assert.equal(requestSignal?.aborted, true);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  assert.equal(mock.mock.callCount(), 1);
});

test("caller cancellation also stops pending body loading", async (t) => {
  configure(t);
  const caller = new AbortController();
  const response = new Response();
  t.mock.method(response, "json", async () => {
    caller.abort(SECRET);
    return new Promise<unknown>(() => {});
  });
  t.mock.method(globalThis, "fetch", async () => response);
  await expectFailure(callAnki("version", undefined, { signal: caller.signal }), "cancelled");
});

test("late responses are discarded without reading or retrying them", async (t) => {
  configure(t);
  const deferred = Promise.withResolvers<Response>();
  const body = new ReadableStream({ start() {}, cancel() { cancelled = true; } });
  let cancelled = false;
  const response = new Response(body);
  const json = t.mock.method(response, "json", async () => assert.fail("late body must not be read"));
  const mock = t.mock.method(globalThis, "fetch", () => deferred.promise);
  await expectFailure(callAnki("version", undefined, { timeoutMs: 15 }), "timeout");
  deferred.resolve(response);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(json.mock.callCount(), 0);
  assert.equal(mock.mock.callCount(), 1);
});

test("late body rejection after timeout is handled without an unhandled rejection", async (t) => {
  configure(t);
  const deferred = Promise.withResolvers<unknown>();
  const response = new Response();
  t.mock.method(response, "json", () => deferred.promise);
  t.mock.method(globalThis, "fetch", async () => response);
  await expectFailure(callAnki("version", undefined, { timeoutMs: 15 }), "timeout");
  deferred.reject(new Error(SECRET));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("late body success cannot replace the timeout result", async (t) => {
  configure(t);
  const deferred = Promise.withResolvers<unknown>();
  const response = new Response();
  t.mock.method(response, "json", () => deferred.promise);
  const mock = t.mock.method(globalThis, "fetch", async () => response);
  const operation = callAnki("version", undefined, { timeoutMs: 15 });
  await expectFailure(operation, "timeout");
  deferred.resolve({ result: 6, error: null });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expectFailure(operation, "timeout");
  assert.equal(mock.mock.callCount(), 1);
});

test("late fetch failure after timeout does not escape as an unhandled rejection", async (t) => {
  configure(t);
  const deferred = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", () => deferred.promise);
  await expectFailure(callAnki("version", undefined, { timeoutMs: 15 }), "timeout");
  deferred.reject(new Error(SECRET));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("failed requests clear timers and caller cancellation listeners", async (t) => {
  configure(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const caller = new AbortController();
  let aborts = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => { aborts += 1; });
    throw new TypeError(SECRET);
  });
  await expectFailure(callAnki("version", undefined, { timeoutMs: 10, signal: caller.signal }), "network");
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  assert.equal(aborts, 1);
  t.mock.timers.tick(100);
  caller.abort();
  assert.equal(aborts, 1);
});

for (const status of [301, 302, 307, 400, 401, 500, 503]) {
  test(`HTTP ${status} fails without following redirects, reading the body, or retrying`, async (t) => {
    configure(t);
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status, headers: { Location: `http://example.com/${SECRET}` },
    });
    const json = t.mock.method(response, "json", async () => assert.fail("must not read error bodies"));
    const mock = t.mock.method(globalThis, "fetch", async () => response);
    const error = await expectFailure(callAnki("storeMediaFile", { secret: SECRET }), "http");
    assert.equal(error.status, status);
    assert.equal(json.mock.callCount(), 0);
    assert.equal(mock.mock.callCount(), 1);
    assert.equal(cancelled, true);
  });
}

test("invalid JSON is distinct from an interrupted response body and does not leak body content", async (t) => {
  configure(t);
  const mock = t.mock.method(globalThis, "fetch", async () => new Response(`<html>${SECRET}</html>`));
  await expectFailure(callAnki("version"), "invalid-json");
  assert.equal(mock.mock.callCount(), 1);
});

test("response read failures are network errors, not invalid JSON", async (t) => {
  configure(t);
  const response = new Response();
  t.mock.method(response, "json", async () => { throw new TypeError(SECRET); });
  t.mock.method(globalThis, "fetch", async () => response);
  const error = await expectFailure(callAnki("version"), "network");
  assert.match(error.message, /body could not be read/u);
});

for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "CERT_HAS_EXPIRED", SECRET]) {
  test(`network errors expose only allowlisted codes (${code === SECRET ? "unknown" : code})`, async (t) => {
    configure(t);
    const native = new TypeError(SECRET, { cause: Object.assign(new Error(SECRET), { code }) });
    const mock = t.mock.method(globalThis, "fetch", async () => { throw native; });
    const error = await expectFailure(callAnki("version"), "network");
    assert.equal(error.message.includes(`Network code: ${code}`), code !== SECRET);
    assert.equal(mock.mock.callCount(), 1);
  });
}

test("malformed response envelopes fail without echoing the response", async (t) => {
  configure(t);
  let payload: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  for (const value of [null, [], SECRET, {}, { result: SECRET }, { error: null }, { result: SECRET, error: 42 }]) {
    payload = value;
    await expectFailure(callAnki("version"), "invalid-response");
  }
});

test("native action-level errors and callAnki envelope behavior remain compatible", async (t) => {
  configure(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ result: null, error: "Deck counts unavailable." }));
  assert.deepEqual(await callAnki("getDeckStats"), { result: null, error: "Deck counts unavailable." });
  await assert.rejects(invokeAnki("getDeckStats"), { message: 'AnkiConnect action "getDeckStats" failed: Deck counts unavailable.' });
});

test("multi shares one deadline and never retries its nested actions", async (t) => {
  configure(t);
  const mock = t.mock.method(globalThis, "fetch", () => new Promise<Response>(() => {}));
  await expectFailure(invokeAnkiMulti([
    createAnkiAction("deleteNotes", { notes: [1] }),
    createAnkiAction("version"),
  ], { timeoutMs: 15 }), "timeout");
  assert.equal(mock.mock.callCount(), 1);
});

test("invalid multi replies use transport error metadata; empty batches send nothing", async (t) => {
  configure(t);
  let payload: unknown;
  const mock = t.mock.method(globalThis, "fetch", async () => {
    assert.notEqual(payload, undefined, "empty multi must not send");
    return Response.json({ result: payload, error: null });
  });
  assert.deepEqual(await invokeAnkiMulti([]), []);
  assert.equal(mock.mock.callCount(), 0);
  for (const result of [null, [], [{ result: 1 }], [{ result: 1, error: false }]]) {
    payload = result;
    const error = await expectFailure(invokeAnkiMulti([createAnkiAction("version")]), "invalid-response");
    assert.equal(error.action, "multi");
  }
});

for (const bodyStarted of [false, true]) {
  test(`native fetch deadline closes a stalled ${bodyStarted ? "response body" : "header exchange"} without a second request`, { timeout: 5_000 }, async (t) => {
    configure(t);
    let requests = 0;
    const closed = Promise.withResolvers<void>();
    process.env.ANKI_URL = await endpoint(t, (req, res) => {
      requests += 1;
      req.resume();
      res.on("close", closed.resolve);
      if (bodyStarted) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"result":');
      }
    });
    await expectFailure(callAnki("deleteNotes", { notes: [1] }, { timeoutMs: 250 }), "timeout");
    // This fake endpoint may have executed before its response was lost. A
    // transport failure must never trigger another POST, even for a mutation.
    await closed.promise;
    assert.equal(requests, 1);
  });
}

test("native fetch does not follow a real HTTP redirect", { timeout: 5_000 }, async (t) => {
  configure(t);
  let requests = 0;
  process.env.ANKI_URL = await endpoint(t, (req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(307, { Location: "/should-not-be-requested" });
    res.end(SECRET);
  });
  await expectFailure(callAnki("deleteNotes"), "http");
  assert.equal(requests, 1);
});

test("native fetch reports a truncated response body as a network failure", { timeout: 5_000 }, async (t) => {
  configure(t);
  let requests = 0;
  process.env.ANKI_URL = await endpoint(t, (req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
    res.write('{"result":');
    res.end();
    res.socket?.destroySoon();
  });
  await expectFailure(callAnki("version", undefined, { timeoutMs: 2_000 }), "network");
  assert.equal(requests, 1);
});
