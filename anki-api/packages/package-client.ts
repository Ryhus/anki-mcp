import { z } from "zod";
import { useAnkiV1 } from "../anki-api-mode.js";
import { resolveAnkiRequestConfig } from "../anki-request-config.js";
import { AnkiRequestError } from "../anki-request-error.js";
import type { V1AdapterContext } from "../v1/anki-v1-adapter-utils.js";
import { acceptV1Operation, waitForV1Operation } from "../v1/anki-v1-operation.js";

export const exportPackageMethod = "packages.export";
export const importPackageMethod = "packages.import";

/** The package path must be visible to both MCP and AnkiConnect. */
export function requireLocalPackageEndpoint(method: string): void {
  if (!useAnkiV1(method)) {
    throw new AnkiRequestError("configuration", method, "Deck package tools require ANKI_API_MODE=v1.", false);
  }
  const { url } = resolveAnkiRequestConfig(method, {});
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
    throw new AnkiRequestError("configuration", method, "Deck package tools require a local AnkiConnect endpoint on the same filesystem.", false);
  }
}

export async function startDeckPackageExport(ctx: V1AdapterContext, deckId: number, path: string, includeScheduling: boolean) {
  return acceptV1Operation(ctx, exportPackageMethod, { deck: { id: String(deckId) }, path, includeScheduling });
}

export async function finishDeckPackageExport(ctx: V1AdapterContext, operationId: string) {
  return waitForV1Operation(ctx, exportPackageMethod, operationId, z.object({ path: z.string().min(1) }));
}

export async function startDeckPackageImport(ctx: V1AdapterContext, path: string) {
  return acceptV1Operation(ctx, importPackageMethod, { path });
}

export async function finishDeckPackageImport(ctx: V1AdapterContext, operationId: string) {
  return waitForV1Operation(ctx, importPackageMethod, operationId, z.object({ completed: z.literal(true) }));
}
