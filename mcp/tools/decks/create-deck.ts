import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createAnkiDeck,
  getDeckNameMap,
} from "../../../anki-api/decks/deck-client.js";
import { ADDITIVE_TOOL_ANNOTATIONS } from "../../utils/tool-annotations.js";
import { createToolResult } from "../../utils/tool-result.js";
import { deckIdSchema, deckNameSchema } from "./shared-schemas.js";

const createDeckInputSchema = z.object({
  name: deckNameSchema,
});

type CreateDeckInput = z.infer<typeof createDeckInputSchema>;

export const createDeckConfig = {
  title: "Create deck",
  description:
    'Creates a deck or returns the existing deck with the same name. Use "::" to create nested decks.',
  inputSchema: createDeckInputSchema,
  outputSchema: z.object({
    deck: z.object({
      id: deckIdSchema,
      name: z.string(),
    }),
    created: z
      .boolean()
      .describe(
        "True when a new deck was created, false when it already existed",
      ),
  }),
  annotations: ADDITIVE_TOOL_ANNOTATIONS,
};

/**
 * Creates a deck when necessary and reports whether it already existed.
 */
export async function createDeck({
  name,
}: CreateDeckInput): Promise<CallToolResult> {
  const decks = await getDeckNameMap();
  const existingId = decks[name];

  if (existingId !== undefined) {
    return createToolResult(`Deck "${name}" already exists.`, {
      deck: { id: existingId, name },
      created: false,
    });
  }

  const id = await createAnkiDeck(name);

  return createToolResult(`Created deck "${name}" (ID: ${id}).`, {
    deck: { id, name },
    created: true,
  });
}
