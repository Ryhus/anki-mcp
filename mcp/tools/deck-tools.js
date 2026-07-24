import { callAnki } from "../../anki-api/anki-request.js";

// /**
//  * Gets the complete list of deck names for the current user.
//  */
export async function getDeckNames() {
  const { result } = await callAnki("deckNames");
  const deckNames = result.join("\n");

  return { content: [{ type: "text", text: deckNames }] };
}

// /**
//  * Gets the complete list of deck names and their respective IDs for the current user.
//  */
export async function getDeckNamesAndIds() {
  const { result } = await callAnki("deckNamesAndIds");
  const deckNamesWithIds = JSON.stringify(result);

  return { content: [{ type: "text", text: deckNamesWithIds }] };
}

/**
 * Creates a new empty deck.
 */
export async function createDeck({ deck }) {
  const { result } = await callAnki("createDeck", {
    deck,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}

/**

 * Deletes decks by name.
 * Warning: depending on cardsToo parameter, cards can also be deleted.
 */
export async function deleteDecks({ decks, cardsToo = false }) {
  const { result } = await callAnki("deleteDecks", {
    decks,
    cardsToo,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}

/**
 * Moves cards to another deck.
 */
export async function changeDeck({ cards, deck }) {
  const { result } = await callAnki("changeDeck", {
    cards,
    deck,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}

/**
 * Gets decks containing specified cards.
 */
export async function getDecks({ cards }) {
  const { result } = await callAnki("getDecks", {
    cards,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}

/**
 * Gets deck configuration.
 */
export async function getDeckConfig({ deck }) {
  const { result } = await callAnki("getDeckConfig", {
    deck,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

/**
 * Gets deck statistics.
 */
export async function getDeckStats({ decks }) {
  const { result } = await callAnki("getDeckStats", {
    decks,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

/**
 * Changes configuration group for decks.
 */
export async function setDeckConfigId({ decks, configId }) {
  const { result } = await callAnki("setDeckConfigId", {
    decks,
    configId,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}

/**
 * Creates a new configuration group cloned from another.
 */
export async function cloneDeckConfigId({ name, cloneFrom }) {
  const { result } = await callAnki("cloneDeckConfigId", {
    name,
    cloneFrom,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}

/**
 * Removes a configuration group.
 */
export async function removeDeckConfigId({ configId }) {
  const { result } = await callAnki("removeDeckConfigId", {
    configId,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}

/**
 * Saves a deck configuration object.
 */
export async function saveDeckConfig({ deckConfig }) {
  const { result } = await callAnki("saveDeckConfig", deckConfig);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}
