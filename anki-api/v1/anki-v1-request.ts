import { randomUUID } from "node:crypto";
import { z } from "zod";
import { postAnkiRequest } from "../anki-http-client.js";
import { resolveAnkiRequestConfig, type AnkiRequestOptions } from "../anki-request-config.js";
import { AnkiRequestError } from "../anki-request-error.js";

const errorTypes: Readonly<Record<number, string>> = {
  [-32700]: "parseError", [-32600]: "invalidRequest", [-32601]: "methodNotFound",
  [-32602]: "invalidParams", [-32603]: "internalError",
  1001: "notFound", 1002: "validationFailed", 1003: "editorConflict",
  1004: "collectionUnavailable", 1005: "staleSession", 1006: "unsupportedCapability",
  1007: "cancelled", 1008: "conflict", 1009: "invalidState", 1010: "busy",
  1011: "authenticationRequired", 1012: "ioError", 1013: "invalidSearch",
  1014: "staleCursor", 1015: "vetoed", 1016: "compatibilityError",
};

export const ankiV1ErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
});

const envelopeSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
});

/** Keeps the stable error code without echoing the remote message or payload. */
export class AnkiV1Error extends Error {
  constructor(readonly method: string, readonly code: number) {
    const type = errorTypes[code] ?? "rpcError";
    super(`[ANKI_V1_ERROR] AnkiConnect v1 method ${JSON.stringify(method)} failed: ${type} (${code}).`);
    this.name = "AnkiV1Error";
  }
}

export function invalidAnkiV1Response(method: string): AnkiRequestError {
  return new AnkiRequestError(
    "invalid-response", method, "The endpoint returned an invalid AnkiConnect v1 reply.", true,
  );
}

/** Validates one correlated JSON-RPC reply using the shared HTTP deadline and limiter. */
export async function callAnkiV1<T>(
  method: string,
  params: Record<string, unknown>,
  schema: z.ZodType<T>,
  options: AnkiRequestOptions = {},
): Promise<T> {
  const config = resolveAnkiRequestConfig(method, options);
  const url = new URL(config.url);
  const basePath = url.pathname.replace(/\/+$/u, "");
  if (basePath.endsWith("/api/v1")) {
    throw new AnkiRequestError(
      "configuration", method, "ANKI_URL must point to the legacy base endpoint, without /api/v1.", false,
    );
  }
  url.pathname = `${basePath}/api/v1`;
  url.hash = "";
  const id = randomUUID();
  let body: string;
  try {
    body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  } catch {
    throw new AnkiRequestError(
      "invalid-request", method, "Request parameters could not be serialized as JSON.", false,
    );
  }
  const payload = await postAnkiRequest(method, body, { ...config, url: url.href }, options);
  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success || envelope.data.id !== id) throw invalidAnkiV1Response(method);
  const reply = envelope.data;
  const hasResult = Object.hasOwn(reply, "result");
  const hasError = Object.hasOwn(reply, "error");
  if (hasResult === hasError) throw invalidAnkiV1Response(method);
  if (hasError) {
    const error = ankiV1ErrorSchema.safeParse(reply.error);
    if (!error.success) throw invalidAnkiV1Response(method);
    throw new AnkiV1Error(method, error.data.code);
  }
  const result = schema.safeParse(reply.result);
  if (!result.success) throw invalidAnkiV1Response(method);
  return result.data;
}
