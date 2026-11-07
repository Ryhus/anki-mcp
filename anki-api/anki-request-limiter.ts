export const MAX_CONCURRENT_ANKI_REQUESTS = 4;

type ReleaseSlot = () => void;
interface WaitingRequest {
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (release: ReleaseSlot) => void;
  reject: (error: DOMException) => void;
}

/** FIFO permits for client-side HTTP exchanges, including response-body reads. */
export class AnkiRequestLimiter {
  private active = 0;
  private readonly waiting: WaitingRequest[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("The request concurrency limit must be a positive integer");
    }
  }

  /** Keeps the uncontended request path synchronous without bypassing waiters. */
  tryAcquire(): ReleaseSlot | undefined {
    if (this.active >= this.limit || this.waiting.length > 0) return undefined;
    this.active += 1;
    return this.releaseOnce();
  }

  /** Removes cancelled waiters; an aborted waiter never receives a future slot. */
  acquire(signal: AbortSignal): Promise<ReleaseSlot> {
    if (signal.aborted) return Promise.reject(waitingAborted());
    const available = this.tryAcquire();
    if (available) return Promise.resolve(available);
    return new Promise((resolve, reject) => {
      const waiter: WaitingRequest = {
        signal, resolve, reject,
        onAbort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index !== -1) this.waiting.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort);
          reject(waitingAborted());
        },
      };
      this.waiting.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private releaseOnce(): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(waitingAborted());
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseOnce());
    }
  }
}

function waitingAborted(): DOMException {
  // Never expose a caller-supplied abort reason, URL, or request contents.
  return new DOMException("Request slot waiting was cancelled", "AbortError");
}

/** Shared across all tools/server factories in this Node.js process. */
export const ankiRequestLimiter = new AnkiRequestLimiter(MAX_CONCURRENT_ANKI_REQUESTS);
