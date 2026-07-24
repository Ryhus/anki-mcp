import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as deck from "./tools/deck-tools.js";
import * as card from "./tools/card-tools.js";
import * as note from "./tools/note-tools.js";

const server = new McpServer({ name: "anki-mcp-server", version: "1.0.0" });

server.registerTool(
  "get-deck-names",
  {
    description: "Gets the complete list of deck names",
  },
  deck.getDeckNames,
);

server.registerTool(
  "get-deck-names-and-ids",
  {
    description:
      "Gets the complete list of deck names and their respective IDs",
  },
  deck.getDeckNamesAndIds,
);

server.registerTool(
  "create-deck",
  {
    description: "Creates a new empty deck.",
    inputSchema: {
      deck: z.string().describe("Name of the deck to create"),
    },
  },
  deck.createDeck,
);

server.registerTool(
  "delete-decks",
  {
    description:
      "Deletes decks by name. Optionally deletes cards contained in those decks.",
    inputSchema: {
      decks: z.array(z.string()).describe("Names of decks to delete"),
      cardsToo: z
        .boolean()
        .optional()
        .describe("Whether cards inside the decks should also be deleted"),
    },
  },
  deck.deleteDecks,
);

server.registerTool(
  "change-deck",
  {
    description: "Moves cards to another deck.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards to move"),
      deck: z.string().describe("Target deck name"),
    },
  },
  deck.changeDeck,
);

server.registerTool(
  "get-decks",
  {
    description: "Gets the decks that contain the specified cards.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards"),
    },
  },
  deck.getDecks,
);

server.registerTool(
  "get-deck-config",
  {
    description: "Gets the configuration of a deck.",
    inputSchema: {
      deck: z.string().describe("Name of the deck"),
    },
  },
  deck.getDeckConfig,
);

server.registerTool(
  "get-deck-stats",
  {
    description: "Gets statistics for the specified decks.",
    inputSchema: {
      decks: z.array(z.string()).describe("Names of decks"),
    },
  },
  deck.getDeckStats,
);

server.registerTool(
  "set-deck-config-id",
  {
    description: "Changes the configuration group used by specified decks.",
    inputSchema: {
      decks: z.array(z.string()).describe("Names of decks"),
      configId: z.number().describe("ID of the deck configuration group"),
    },
  },
  deck.setDeckConfigId,
);

server.registerTool(
  "clone-deck-config-id",
  {
    description:
      "Creates a new deck configuration group by cloning an existing one.",
    inputSchema: {
      name: z.string().describe("Name of the new configuration group"),
      cloneFrom: z
        .number()
        .optional()
        .describe("ID of configuration group to clone"),
    },
  },
  deck.cloneDeckConfigId,
);

server.registerTool(
  "remove-deck-config-id",
  {
    description: "Removes a deck configuration group.",
    inputSchema: {
      configId: z.number().describe("ID of configuration group to remove"),
    },
  },
  deck.removeDeckConfigId,
);
server.registerTool(
  "save-deck-config",
  {
    description: "Saves a deck configuration object.",
    inputSchema: {
      deckConfig: z
        .object({})
        .passthrough()
        .describe("Deck configuration object"),
    },
  },
  deck.saveDeckConfig,
);

/*
 *  CARD TOOLS
 */

server.registerTool(
  "get-ease-factors",
  {
    description: "Gets ease factors for the specified cards.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards"),
    },
  },
  card.getEaseFactors,
);

server.registerTool(
  "set-ease-factors",
  {
    description: "Sets ease factors for cards.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards"),

      easeFactors: z.array(z.number()).describe("New ease factors for cards"),
    },
  },
  card.setEaseFactors,
);

server.registerTool(
  "set-specific-value-of-card",
  {
    description: "Sets a specific internal value of a card.",
    inputSchema: {
      card: z.number().describe("Card ID"),

      keys: z.array(z.string()).describe("Internal card fields to modify"),

      newValues: z.array(z.any()).describe("New values for specified fields"),
    },
  },
  card.setSpecificValueOfCard,
);

server.registerTool(
  "suspend-cards",
  {
    description: "Suspends cards so they will not appear during reviews.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards to suspend"),
    },
  },
  card.suspend,
);

server.registerTool(
  "unsuspend-cards",
  {
    description: "Unsuspends cards and allows them to appear during reviews.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards to unsuspend"),
    },
  },
  card.unsuspend,
);

server.registerTool(
  "is-card-suspended",
  {
    description: "Checks whether a card is suspended.",
    inputSchema: {
      card: z.number().describe("Card ID"),
    },
  },
  card.suspended,
);

server.registerTool(
  "are-cards-suspended",
  {
    description: "Checks suspension status for multiple cards.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards"),
    },
  },
  card.areSuspended,
);

server.registerTool(
  "are-cards-due",
  {
    description: "Checks whether cards are due for review.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards"),
    },
  },
  card.areDue,
);

server.registerTool(
  "get-card-intervals",
  {
    description: "Gets review intervals for cards.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards"),
    },
  },
  card.getIntervals,
);

server.registerTool(
  "find-cards",
  {
    description:
      "Finds cards using Anki search syntax.Returns an array of card IDs for a given query.",
    inputSchema: {
      query: z.string().describe("Anki search query"),
    },
  },
  card.findCards,
);

server.registerTool(
  "cards-to-notes",
  {
    description: "Returns note IDs associated with cards.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards"),
    },
  },
  card.cardsToNotes,
);

server.registerTool(
  "cards-mod-time",
  {
    description: "Gets modification timestamps for cards.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards"),
    },
  },
  card.cardsModTime,
);

server.registerTool(
  "cards-info",
  {
    description:
      "Gets detailed information about cards including fields, deck, note, and scheduling data.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards"),
    },
  },
  card.cardsInfo,
);

server.registerTool(
  "forget-cards",
  {
    description: "Resets cards and makes them new again.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards"),
    },
  },
  card.forgetCards,
);

server.registerTool(
  "relearn-cards",
  {
    description: "Moves cards into relearning state.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards"),
    },
  },
  card.relearnCards,
);

server.registerTool(
  "answer-cards",
  {
    description:
      "Answers cards using Anki ease values from 1 (Again) to 4 (Easy).",
    inputSchema: {
      answers: z
        .array(
          z.object({
            cardId: z.number(),
            ease: z.number().min(1).max(4),
          }),
        )
        .describe("Card answers"),
    },
  },
  card.answerCards,
);

server.registerTool(
  "set-due-date",
  {
    description: "Sets due date for cards.",
    inputSchema: {
      cards: z.array(z.number()).describe("IDs of cards"),
      days: z
        .string()
        .describe("Due date interval. Examples: '5', '1-3', '10'"),
    },
  },
  card.setDueDate,
);

/*
 *  Note Tools
 */

server.registerTool(
  "add-note",
  {
    description: "Creates a new Anki note and automatically generates cards.",
    inputSchema: {
      deckName: z.string(),
      modelName: z.string(),
      fields: z.record(z.string()),
      tags: z.array(z.string()).optional(),
      options: z
        .object({
          allowDuplicate: z.boolean().optional(),
          duplicateScope: z.string().optional(),
        })
        .optional(),
    },
  },
  note.addNote,
);

server.registerTool(
  "add-notes",
  {
    description: "Creates multiple Anki notes.",
    inputSchema: {
      notes: z.array(
        z.object({
          deckName: z.string(),
          modelName: z.string(),
          fields: z.record(z.string()),
          tags: z.array(z.string()).optional(),
        }),
      ),
    },
  },
  note.addNotes,
);

server.registerTool(
  "can-add-notes",
  {
    description: "Checks whether notes can be created.",
    inputSchema: {
      notes: z.array(
        z.object({
          deckName: z.string(),
          modelName: z.string(),
          fields: z.record(z.string()),
        }),
      ),
    },
  },
  note.canAddNotes,
);

server.registerTool(
  "can-add-notes-with-error-detail",
  {
    description: "Checks whether notes can be created and returns errors.",
    inputSchema: {
      notes: z.array(
        z.object({
          deckName: z.string(),
          modelName: z.string(),
          fields: z.record(z.string()),
        }),
      ),
    },
  },
  note.canAddNotesWithErrorDetail,
);

server.registerTool(
  "update-note-fields",
  {
    description: "Updates fields of an existing note.",
    inputSchema: {
      noteId: z.number(),
      fields: z.record(z.string()),
    },
  },
  note.updateNoteFields,
);

server.registerTool(
  "update-note",
  {
    description: "Updates fields and tags of a note.",
    inputSchema: {
      noteId: z.number(),
      fields: z.record(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  note.updateNote,
);

server.registerTool(
  "update-note-model",
  {
    description: "Changes the model of an existing note.",
    inputSchema: {
      noteId: z.number(),
      modelName: z.string(),
      fields: z.record(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  note.updateNoteModel,
);

server.registerTool(
  "update-note-tags",
  {
    description: "Replaces all tags of an existing note.",
    inputSchema: {
      noteId: z.number().describe("ID of the note"),
      tags: z.array(z.string()).describe("New tags for the note"),
    },
  },
  note.updateNoteTags,
);

server.registerTool(
  "get-note-tags",
  {
    description: "Gets tags assigned to a specific note.",
    inputSchema: {
      noteId: z.number().describe("ID of the note"),
    },
  },
  note.getNoteTags,
);

server.registerTool(
  "add-tags",
  {
    description: "Adds tags to one or more notes.",
    inputSchema: {
      notes: z.array(z.number()).describe("IDs of notes"),
      tags: z
        .string()
        .describe("Tags to add. Multiple tags can be separated by spaces"),
    },
  },
  note.addTags,
);

server.registerTool(
  "remove-tags",
  {
    description: "Removes tags from one or more notes.",
    inputSchema: {
      notes: z.array(z.number()).describe("IDs of notes"),
      tags: z
        .string()
        .describe("Tags to remove. Multiple tags can be separated by spaces"),
    },
  },
  note.removeTags,
);

server.registerTool(
  "get-tags",
  {
    description: "Gets the complete list of tags in the collection.",
  },
  note.getTags,
);

server.registerTool(
  "clear-unused-tags",
  {
    description: "Removes all tags that are not used by any notes.",
  },
  note.clearUnusedTags,
);

server.registerTool(
  "replace-tags",
  {
    description: "Replaces a tag with another tag in specified notes.",
    inputSchema: {
      notes: z.array(z.number()).describe("IDs of notes"),
      tagToReplace: z.string().describe("Existing tag"),
      replaceWithTag: z.string().describe("Replacement tag"),
    },
  },
  note.replaceTags,
);

server.registerTool(
  "replace-tags-in-all-notes",
  {
    description: "Replaces a tag with another tag in all notes.",
    inputSchema: {
      tagToReplace: z.string().describe("Existing tag"),
      replaceWithTag: z.string().describe("Replacement tag"),
    },
  },
  note.replaceTagsInAllNotes,
);

server.registerTool(
  "find-notes",
  {
    description: "Finds notes using Anki search syntax and returns note IDs.",
    inputSchema: {
      query: z
        .string()
        .describe("Anki search query. Examples: deck:German, tag:A1, is:new"),
    },
  },
  note.findNotes,
);

server.registerTool(
  "notes-info",
  {
    description:
      "Returns detailed information about notes including fields, tags, model, modification time, and associated cards.",
    inputSchema: {
      notes: z.array(z.number()).optional().describe("IDs of notes"),
      query: z.string().optional().describe("Anki search query to find notes"),
    },
  },
  note.notesInfo,
);

server.registerTool(
  "notes-mod-time",
  {
    description: "Gets modification timestamps for notes.",
    inputSchema: {
      notes: z.array(z.number()).describe("IDs of notes"),
    },
  },
  note.notesModTime,
);

server.registerTool(
  "delete-notes",
  {
    description: "Deletes notes and all cards associated with them.",
    inputSchema: {
      notes: z.array(z.number()).describe("IDs of notes to delete"),
    },
  },
  note.deleteNotes,
);

server.registerTool(
  "remove-empty-notes",
  {
    description: "Removes all empty notes from the collection.",
  },
  note.removeEmptyNotes,
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ANKI MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
