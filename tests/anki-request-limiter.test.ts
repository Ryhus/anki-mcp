import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { AnkiRequestLimiter, MAX_CONCURRENT_ANKI_REQUESTS } from "../anki-api/anki-request-limiter.js";

test("the shared concurrency cap is four and limiter limits must be positive integers", () => {
  assert.equal(MAX_CONCURRENT_ANKI_REQUESTS, 4);
  for (const limit of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new AnkiRequestLimiter(limit), RangeError);
});

test("permits are bounded, FIFO, and cannot be released twice", async () => {
  const limiter = new AnkiRequestLimiter(1);
  const first = limiter.tryAcquire();
  assert.ok(first);
  assert.equal(limiter.tryAcquire(), undefined);
  const order: number[] = [];
  const second = limiter.acquire(new AbortController().signal).then((release) => { order.push(2); return release; });
  const third = limiter.acquire(new AbortController().signal).then((release) => { order.push(3); return release; });
  first();
  first();
  const releaseSecond = await second;
  assert.deepEqual(order, [2]);
  assert.equal(limiter.tryAcquire(), undefined, "a new arrival cannot jump past the third waiter");
  releaseSecond();
  const releaseThird = await third;
  assert.deepEqual(order, [2, 3]);
  releaseThird();
  const final = limiter.tryAcquire();
  assert.ok(final);
  assert.equal(limiter.tryAcquire(), undefined);
  final();
});

test("cancelled waiters are removed without consuming a future permit or exposing abort reasons", async () => {
  const limiter = new AnkiRequestLimiter(1);
  const release = limiter.tryAcquire()!;
  const cancelled = new AbortController();
  const waiting = limiter.acquire(cancelled.signal);
  const survivor = new AbortController();
  const next = limiter.acquire(survivor.signal);
  assert.equal(getEventListeners(cancelled.signal, "abort").length, 1);
  cancelled.abort("private-reason");
  await assert.rejects(waiting, (error: unknown) => {
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, "AbortError");
    assert.doesNotMatch(error.message, /private-reason/u);
    return true;
  });
  assert.equal(getEventListeners(cancelled.signal, "abort").length, 0);
  release();
  const releaseNext = await next;
  assert.equal(getEventListeners(survivor.signal, "abort").length, 0);
  survivor.abort();
  assert.equal(limiter.tryAcquire(), undefined, "cancelling after delivery does not release a permit owned by its caller");
  releaseNext();
  limiter.tryAcquire()!();
});

test("pre-aborted waiters do not consume otherwise free capacity", async () => {
  const limiter = new AnkiRequestLimiter(1);
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(limiter.acquire(caller.signal), { name: "AbortError" });
  const release = await limiter.acquire(new AbortController().signal);
  assert.equal(limiter.tryAcquire(), undefined);
  release();
});
