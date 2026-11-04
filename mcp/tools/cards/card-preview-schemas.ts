import { z } from "zod";
import { cardIdSchema } from "./shared-schemas.js";

/** Refuse oversized source instead of silently previewing truncated HTML/CSS. */
export const CARD_PREVIEW_SOURCE_BYTE_LIMIT = 256 * 1024;

export const cardPreviewInputSchema = z.object({
  cardId: cardIdSchema,
  side: z.enum(["front", "back", "both"]).default("both").describe(
    "Which existing card side to inspect; Anki resolves fields and template filters",
  ),
  theme: z.enum(["light", "dark"]).default("light").describe(
    "Document color scheme; dark adds Anki's nightMode and night_mode classes",
  ),
});

export const cardPreviewOutputSchema = z.object({
  cardId: cardIdSchema,
  exists: z.boolean(),
  preview: z.object({
    noteId: z.number().int().positive(),
    modelName: z.string(),
    deckName: z.string(),
    templateOrdinal: z.number().int().nonnegative(),
    theme: z.enum(["light", "dark"]),
    css: z.string().describe("Unmodified shared CSS returned by AnkiConnect"),
    sides: z.array(z.object({
      side: z.enum(["front", "back"]),
      html: z.string().describe("Unmodified side HTML rendered by Anki; untrusted source, not a safe document"),
      document: z.string().describe(
        "Standalone static HTML document with restricted markup and CSP; scripts, links, and resource loading are disabled",
      ),
      removedElementCount: z.number().int().nonnegative(),
      removedAttributeCount: z.number().int().nonnegative(),
    })),
  }).nullable(),
  warnings: z.array(z.string()),
});

export type CardPreviewInput = z.infer<typeof cardPreviewInputSchema>;
export type CardPreviewTheme = CardPreviewInput["theme"];
