import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { AnkiRequestError, invokeAnki, invokeAnkiMulti, createAnkiAction } from "../anki-api/anki-request.js";
import { ankiRequestLimiter } from "../anki-api/anki-request-limiter.js";

function configure(t: TestContext): void {
  const previous = [process.env.ANKI_URL, process.env.ANKI_REQUEST_TIMEOUT_MS];
  process.env.ANKI_URL = "http://127.0.0.1:8765/?token=private-token";
  delete process.env.ANKI_REQUEST_TIMEOUT_MS;
  t.after(() => {
    for (const [index, key] of ["ANKI_URL", "ANKI_REQUEST_TIMEOUT_MS"].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

function reserveAll(t: TestContext): Array<() => void> {
  const releases: Array<() => void> = [];
  t.after(() => releases.forEach((release) => release()));
  for (let index = 0; index < 4; index += 1) {
    const release = ankiRequestLimiter.tryAcquire();
    assert.ok(release, "all four permits must be available at test entry/after cleanup");
    releases.push(release);
  }
  assert.equal(ankiRequestLimiter.tryAcquire(), undefined);
  return releases;
}

async function expectFailure(operation: Promise<unknown>, kind: "timeout" | "cancelled", sent: boolean) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof AnkiRequestError);
    assert.equal(error.kind, kind);
    assert.equal(error.mayHaveExecuted, sent);
    assert.doesNotMatch(error.message, /private-token|private-reason/u);
    assert.match(error.message, sent ? /inspect Anki before retrying/u : /No HTTP request was sent/u);
    return true;
  });
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a burst is FIFO and holds permits through JSON body loading, not just headers", async (t) => {
  configure(t);
  const bodies = Array.from({ length: 20 }, () => Promise.withResolvers<unknown>());
  const started: number[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const { params } = JSON.parse(String(init?.body)) as { params: { index: number } };
    started.push(params.index);
    const response = new Response();
    t.mock.method(response, "json", () => bodies[params.index]!.promise);
    return response;
  });
  const calls = bodies.map((_body, index) => invokeAnki<number>("version", { index }));
  const settled = Promise.allSettled(calls);
  t.after(async () => {
    bodies.forEach(({ resolve }, index) => resolve({ result: index, error: null }));
    await settled;
  });
  assert.deepEqual(started, [0, 1, 2, 3]);
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3], "already-arrived headers do not release permits");
  for (let index = 0; index < calls.length; index += 1) {
    bodies[index]!.resolve({ result: index, error: null });
    assert.equal(await calls[index], index);
    assert.equal(started.length, Math.min(index + 5, calls.length));
    assert.deepEqual(started, Array.from({ length: started.length }, (_unused, id) => id));
  }
  reserveAll(t);
});

test("a queued timeout is known not-sent and is never delivered after capacity returns", async (t) => {
  configure(t);
  const held = reserveAll(t);
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ result: 6, error: null }));
  await expectFailure(invokeAnki("deleteNotes", { notes: [1] }, { timeoutMs: 15 }), "timeout", false);
  assert.equal(mock.mock.callCount(), 0);
  held.forEach((release) => release());
  await nextTurn();
  assert.equal(mock.mock.callCount(), 0, "the expired mutation must not be sent later");
  assert.equal(await invokeAnki("version"), 6);
  assert.equal(mock.mock.callCount(), 1);
});

test("queued caller cancellation removes listeners and skips only the cancelled waiter", async (t) => {
  configure(t);
  const held = reserveAll(t);
  const started: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const { action } = JSON.parse(String(init?.body)) as { action: string };
    started.push(action);
    return Response.json({ result: 6, error: null });
  });
  const caller = new AbortController();
  const cancelled = invokeAnki("deleteNotes", { notes: [1] }, { signal: caller.signal });
  const next = invokeAnki("version");
  caller.abort("private-reason");
  await expectFailure(cancelled, "cancelled", false);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  held.forEach((release) => release());
  assert.equal(await next, 6);
  assert.deepEqual(started, ["version"]);
});

test("abort immediately after a queued grant cannot leak that late permit or send HTTP", async (t) => {
  configure(t);
  const held = reserveAll(t);
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ result: 6, error: null }));
  const caller = new AbortController();
  const operation = invokeAnki("deleteNotes", { notes: [1] }, { signal: caller.signal });
  held[0]!(); // Grant synchronously, before the queued continuation runs.
  caller.abort("private-reason");
  await expectFailure(operation, "cancelled", false);
  await nextTurn();
  held.forEach((release) => release());
  assert.equal(mock.mock.callCount(), 0);
  reserveAll(t);
});

test("queue time and HTTP time share one deadline rather than resetting it after admission", async (t) => {
  configure(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = reserveAll(t);
  const late = Promise.withResolvers<Response>();
  const mock = t.mock.method(globalThis, "fetch", () => late.promise);
  t.after(() => late.resolve(Response.json({ result: 6, error: null })));
  const operation = invokeAnki("version", undefined, { timeoutMs: 100 });
  t.mock.timers.tick(60);
  held[0]!();
  await nextTurn();
  assert.equal(mock.mock.callCount(), 1);
  const failure = expectFailure(operation, "timeout", true);
  t.mock.timers.tick(40);
  await failure;
  held.forEach((release) => release());
  reserveAll(t);
});

test("a non-cooperative active fetch cannot retain a permit forever after timeout", async (t) => {
  configure(t);
  const held = reserveAll(t);
  const late = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const mock = t.mock.method(globalThis, "fetch", () => { started.resolve(); return late.promise; });
  t.after(() => late.resolve(Response.json({ result: 6, error: null })));
  held[0]!();
  const operation = invokeAnki("version", undefined, { timeoutMs: 15 });
  await started.promise;
  await expectFailure(operation, "timeout", true);
  held.forEach((release) => release());
  assert.equal(mock.mock.callCount(), 1);
  reserveAll(t);
});

for (const failure of ["network", "http", "json", "envelope", "action", "cleanup"] as const) {
  test(`${failure} errors free capacity and allow the next queued request exactly once`, async (t) => {
    configure(t);
    const held = reserveAll(t);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests += 1;
      if (requests > 1) return Response.json({ result: 6, error: null });
      switch (failure) {
        case "network": throw new TypeError("private-token");
        case "http": return new Response("private-token", { status: 500 });
        case "json": return new Response("not json");
        case "envelope": return Response.json({ invalid: true });
        case "action": return Response.json({ result: null, error: "Action failed" });
        case "cleanup": {
          const response = new Response("not read", { status: 500 });
          assert.ok(response.body);
          t.mock.method(response.body, "cancel", () => { throw new Error("private-token"); });
          return response;
        }
      }
    });
    const failed = invokeAnki("version");
    const succeeded = invokeAnki("version");
    const rejection = assert.rejects(failed, (error: unknown) => {
      if (failure === "cleanup") {
        assert.ok(error instanceof AnkiRequestError);
        assert.equal(error.kind, "http");
        assert.doesNotMatch(error.message, /private-token/u);
      }
      return true;
    });
    held[0]!();
    await rejection;
    assert.equal(await succeeded, 6);
    assert.equal(requests, 2);
    held.forEach((release) => release());
    reserveAll(t);
  });
}

test("a multi batch reserves one HTTP slot, not one per nested action", async (t) => {
  configure(t);
  const held = reserveAll(t);
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({
    result: [{ result: 6, error: null }, { result: [], error: null }], error: null,
  }));
  held[0]!();
  assert.deepEqual(await invokeAnkiMulti([createAnkiAction("version"), createAnkiAction("findCards", { query: "" })]), [6, []]);
  assert.equal(mock.mock.callCount(), 1);
});

test("native HTTP bursts keep four live body reads and deliver all queued requests", { timeout: 10_000 }, async (t) => {
  configure(t);
  const replies = new Map<number, () => void>();
  let active = 0, maximum = 0, received = 0;
  const arrivals: Array<{ count: number; resolve: () => void }> = [];
  const server = createServer(async (req, res) => {
    active += 1; maximum = Math.max(maximum, active);
    res.on("close", () => { active -= 1; });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const { params } = JSON.parse(Buffer.concat(chunks).toString()) as { params: { index: number } };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"result":');
    replies.set(params.index, () => { if (!res.writableEnded && !res.destroyed) res.end(`${params.index},"error":null}`); });
    received += 1;
    for (const waiter of arrivals) if (received >= waiter.count) waiter.resolve();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.ANKI_URL = `http://127.0.0.1:${address.port}`;
  const calls = Array.from({ length: 12 }, (_unused, index) => invokeAnki<number>("version", { index }, { timeoutMs: 5_000 }));
  const settled = Promise.allSettled(calls);
  t.after(async () => { for (const send of replies.values()) send(); await settled; });
  const waitFor = (count: number) => received >= count ? Promise.resolve() : new Promise<void>((resolve) => arrivals.push({ count, resolve }));
  for (let group = 0; group < 3; group += 1) {
    await waitFor((group + 1) * 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, (group + 1) * 4, "headers alone must not admit the next group");
    for (let index = group * 4; index < (group + 1) * 4; index += 1) replies.get(index)!();
    await Promise.all(calls.slice(group * 4, (group + 1) * 4));
  }
  assert.deepEqual(await Promise.all(calls), Array.from({ length: 12 }, (_unused, index) => index));
  assert.equal(maximum, 4);
  reserveAll(t);
});
