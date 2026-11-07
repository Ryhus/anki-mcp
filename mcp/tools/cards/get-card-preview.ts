import type { CallToolResult } from "@modelcontextprotocol/server";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadCardInfo } from "./card-loader.js";
import { buildCardPreviewDocument } from "./card-preview-document.js";
import {
  CARD_PREVIEW_SOURCE_BYTE_LIMIT,
  cardPreviewInputSchema,
  cardPreviewOutputSchema,
  type CardPreviewInput,
} from "./card-preview-schemas.js";

export const getCardPreviewConfig = {
  title: "Get card preview",
  description:
    "Returns Anki-rendered HTML, shared CSS, and standalone static HTML documents for one existing card. Supports front/back and light/dark inspection without changing Anki. Not a screenshot: JavaScript, navigation, media, and external resources are disabled in documents. Raw source is untrusted.",
  inputSchema: cardPreviewInputSchema,
  outputSchema: cardPreviewOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
};

/** Reads rendered HTML; does not open the reviewer or change scheduling. */
export async function getCardPreview({
  cardId, side, theme,
}: CardPreviewInput): Promise<CallToolResult> {
  const { cards } = await loadCardInfo([cardId], true);
  const card = cards[0];
  if (card === undefined) {
    return createToolResult(`Card ${cardId} was not found.`, {
      cardId, exists: false, preview: null, warnings: [],
    });
  }
  if (typeof card.css !== "string") {
    throw new Error(`AnkiConnect omitted CSS for card ${cardId}; a complete preview cannot be built.`);
  }

  const selectedSides = [
    { side: "front" as const, html: card.question },
    { side: "back" as const, html: card.answer },
  ].filter((entry) => side === "both" || entry.side === side);
  const sourceByteLength = Buffer.byteLength(card.css, "utf8") + selectedSides.reduce(
    (total, entry) => total + Buffer.byteLength(entry.html, "utf8"), 0,
  );
  if (sourceByteLength > CARD_PREVIEW_SOURCE_BYTE_LIMIT) {
    throw new Error(
      `Card preview source is ${sourceByteLength} bytes; the limit is ${CARD_PREVIEW_SOURCE_BYTE_LIMIT}. Request a single side or reduce the card content. No truncated preview was returned.`,
    );
  }

  const sides = selectedSides.map((entry) => ({
    ...entry,
    ...buildCardPreviewDocument({
      html: entry.html, css: card.css,
      title: `${card.modelName} — card ${cardId} — ${entry.side}`,
      templateOrdinal: card.ord, theme,
    }),
  }));
  const warnings = [
    "This is a static HTML/CSS inspection preview, not a screenshot or a pixel-exact Anki reviewer.",
    "Documents disable scripts, links, form controls, and resource loading. Images, fonts, audio, video, MathJax, hints, and reviewer interactions may be missing or nonfunctional.",
    "Raw html and css are untrusted source. Load document only as a separate document or sandboxed iframe, never as innerHTML in a privileged page. Its CSP must be honored.",
    "No platform-specific classes or Anki reviewer runtime are emulated. Dark mode adds classes but does not override the Note Type's own colors.",
  ];
  if (sides.some((entry) => entry.removedElementCount > 0 || entry.removedAttributeCount > 0)) {
    warnings.push("Unsupported elements or attributes were removed from the documents; raw side HTML is unchanged in this response and in Anki.");
  }

  return createToolResult(
    `Prepared ${sides.length} static ${theme} preview document${sides.length === 1 ? "" : "s"} for card ${cardId}. Anki was not changed; no browser was launched.`,
    {
      cardId, exists: true,
      preview: {
        noteId: card.note, modelName: card.modelName, deckName: card.deckName,
        templateOrdinal: card.ord, theme, css: card.css, sides,
      },
      warnings,
    },
  );
}
