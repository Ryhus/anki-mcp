export type AnkiRequestErrorKind =
  | "configuration"
  | "invalid-request"
  | "timeout"
  | "cancelled"
  | "network"
  | "http"
  | "invalid-json"
  | "invalid-response";

const ERROR_CODES: Record<AnkiRequestErrorKind, string> = {
  configuration: "ANKI_CONFIGURATION_ERROR",
  "invalid-request": "ANKI_INVALID_REQUEST",
  timeout: "ANKI_TIMEOUT",
  cancelled: "ANKI_REQUEST_CANCELLED",
  network: "ANKI_NETWORK_ERROR",
  http: "ANKI_HTTP_ERROR",
  "invalid-json": "ANKI_INVALID_JSON",
  "invalid-response": "ANKI_INVALID_RESPONSE",
};

/** Transport/configuration failure without exposing endpoint or payload data. */
export class AnkiRequestError extends Error {
  readonly kind: AnkiRequestErrorKind;
  readonly action: string;
  /** True means fetch was invoked, not that Anki definitely executed anything. */
  readonly mayHaveExecuted: boolean;
  readonly status: number | null;
  readonly timeoutMs: number | null;

  constructor(
    kind: AnkiRequestErrorKind,
    action: string,
    detail: string,
    mayHaveExecuted: boolean,
    metadata: { status?: number; timeoutMs?: number } = {},
  ) {
    const state = mayHaveExecuted
      ? "No automatic retry was performed. If this request can change data, inspect Anki before retrying: some or all actions may already have run. Stopping HTTP does not roll back Anki."
      : "No HTTP request was sent.";
    super(`[${ERROR_CODES[kind]}] AnkiConnect action ${JSON.stringify(action)}: ${detail} ${state}`);
    this.name = "AnkiRequestError";
    this.kind = kind;
    this.action = action;
    this.mayHaveExecuted = mayHaveExecuted;
    this.status = metadata.status ?? null;
    this.timeoutMs = metadata.timeoutMs ?? null;
  }
}
