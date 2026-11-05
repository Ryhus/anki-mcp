import { randomBytes } from "node:crypto";
import { AnkiRequestError } from "../../../anki-api/anki-request-error.js";
import {
  type CollectionContext, type CollectionOperationProposal, type CollectionOperationStatus,
  readCollectionOperationStatus, startCollectionOperation, syncMethod,
} from "../../../anki-api/collection/collection-client.js";
import { AnkiV1Error } from "../../../anki-api/v1/anki-v1-request.js";

const maxPreviews = 128;
const maxOperations = 64;
export const confirmationLifetimeSeconds = 120;

type Preview = {
  session: string;
  proposal: CollectionOperationProposal;
  expiresAt: number;
};
type Receipt = {
  profile: string;
  session: string;
  method: CollectionOperationProposal["method"];
  settled?: CollectionOperationStatus;
};
type Phase = "idle" | "submitting" | "uncertain" | { operationId: string };

/** Server-local confirmations and receipts; never persists or repeats a collection mutation. */
export class CollectionOperationRegistry {
  #phase: Phase = "idle";
  readonly #previews = new Map<string, Preview>();
  readonly #operations = new Map<string, Receipt>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  assertIdle(): void {
    if (this.#phase === "submitting") throw new Error("A collection operation is being submitted. Do not start another.");
    if (this.#phase === "uncertain") {
      throw new Error("A previous collection submission could not be confirmed. Inspect Anki, then restart MCP before starting another collection operation.");
    }
    if (typeof this.#phase === "object") {
      throw new Error(`Collection operation "${this.#phase.operationId}" is still being tracked. Check it with get-collection-operation before starting another.`);
    }
  }

  issue(ctx: CollectionContext, proposal: CollectionOperationProposal): string {
    this.assertIdle();
    const now = this.now();
    for (const [token, preview] of this.#previews) {
      if (preview.expiresAt <= now) this.#previews.delete(token);
    }
    const token = randomBytes(32).toString("hex");
    this.#previews.set(token, { session: ctx.session, proposal, expiresAt: now + 1_000 * confirmationLifetimeSeconds });
    trim(this.#previews, maxPreviews);
    return token;
  }

  async submit(ctx: CollectionContext, proposal: CollectionOperationProposal, token: string): Promise<string> {
    this.assertIdle();
    const preview = this.#previews.get(token);
    if (!preview || preview.expiresAt <= this.now() || preview.session !== ctx.session || !sameProposal(preview.proposal, proposal)) {
      throw new Error("The confirmation is stale, expired, already used, or does not match the active collection and operation. Preview again.");
    }
    // Claim before any await. Also invalidate other previews, especially Undo after any accepted change.
    this.#previews.clear();
    this.#phase = "submitting";
    try {
      const operationId = await startCollectionOperation(ctx, proposal);
      if (operationId.length > 256 || this.#operations.has(operationId)) throw new Error("Invalid or reused Anki operation ID.");
      this.#operations.set(operationId, { profile: ctx.profile, session: ctx.session, method: proposal.method });
      this.#phase = { operationId };
      trim(this.#operations, maxOperations);
      return operationId;
    } catch (error) {
      if (error instanceof AnkiV1Error || (error instanceof AnkiRequestError && !error.mayHaveExecuted)) {
        this.#phase = "idle";
        throw error;
      }
      this.#phase = "uncertain";
      throw new Error("Could not confirm submission. Anki may already be working. No retry was performed; inspect Anki and restart MCP before starting another collection operation.", { cause: error });
    }
  }

  async inspect(operationId: string) {
    const receipt = this.#operations.get(operationId);
    if (!receipt) throw new Error("Unknown collection operation. Use an operation ID returned by this running MCP server.");
    if (receipt.settled === undefined) {
      let status: CollectionOperationStatus;
      try {
        status = await readCollectionOperationStatus(operationId, receipt.method, receipt.session);
      } catch (error) {
        if (!(error instanceof AnkiV1Error) || error.code !== 1001) throw error;
        status = { state: "unknown", result: null, error: { code: error.code, message: "Anki no longer has this operation record. Inspect Anki before taking any further action." } };
      }
      // An overlapping poll may already have observed a terminal result.
      if (receipt.settled === undefined && isSettled(status)) {
        receipt.settled = status;
        if (typeof this.#phase === "object" && this.#phase.operationId === operationId) this.#phase = "idle";
      }
      return { operationId, method: receipt.method, profile: receipt.profile, ...(receipt.settled ?? status) };
    }
    return { operationId, method: receipt.method, profile: receipt.profile, ...receipt.settled };
  }
}

function sameProposal(a: CollectionOperationProposal, b: CollectionOperationProposal): boolean {
  if (a.method !== b.method) return false;
  return a.method !== syncMethod || (b.method === syncMethod && a.includeMedia === b.includeMedia);
}

function isSettled({ state }: CollectionOperationStatus): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "unknown";
}

function trim<T>(items: Map<string, T>, max: number): void {
  if (items.size > max) items.delete(items.keys().next().value!);
}
