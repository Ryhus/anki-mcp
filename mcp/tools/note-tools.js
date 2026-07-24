import { callAnki } from "../../anki-api/anki-request.js";
import { formatResult } from "../utils/formatting.js";

/**
 * Creates a note.
 */
export async function addNote({
  deckName,
  modelName,
  fields,
  tags = [],
  options,
}) {
  const { result } = await callAnki("addNote", {
    note: {
      deckName,
      modelName,
      fields,
      tags,
      options,
    },
  });

  return formatResult(result);
}

/**
 * Creates multiple notes.
 */
export async function addNotes({ notes }) {
  const { result } = await callAnki("addNotes", {
    notes,
  });

  return formatResult(result);
}

/**
 * Checks whether notes can be added.
 */
export async function canAddNotes({ notes }) {
  const { result } = await callAnki("canAddNotes", {
    notes,
  });

  return formatResult(result);
}

/**
 * Checks whether notes can be added with error details.
 */
export async function canAddNotesWithErrorDetail({ notes }) {
  const { result } = await callAnki("canAddNotesWithErrorDetail", {
    notes,
  });

  return formatResult(result);
}

/**
 * Updates note fields.
 */
export async function updateNoteFields({ noteId, fields }) {
  const { result } = await callAnki("updateNoteFields", {
    note: {
      id: noteId,
      fields,
    },
  });

  return formatResult(result);
}

/**
 * Updates note fields and/or tags.
 */
export async function updateNote({ noteId, fields, tags }) {
  const { result } = await callAnki("updateNote", {
    note: {
      id: noteId,
      fields,
      tags,
    },
  });

  return formatResult(result);
}

/**
 * Updates note model.
 */
export async function updateNoteModel({ noteId, modelName, fields, tags }) {
  const { result } = await callAnki("updateNoteModel", {
    note: {
      id: noteId,
      modelName,
      fields,
      tags,
    },
  });

  return formatResult(result);
}

/**
 * Replaces note tags.
 */
export async function updateNoteTags({ noteId, tags }) {
  const { result } = await callAnki("updateNoteTags", {
    note: noteId,
    tags,
  });

  return formatResult(result);
}

/**
 * Gets tags of a note.
 */
export async function getNoteTags({ noteId }) {
  const { result } = await callAnki("getNoteTags", {
    note: noteId,
  });

  return formatResult(result);
}

/**
 * Adds tags to notes.
 */
export async function addTags({ notes, tags }) {
  const { result } = await callAnki("addTags", {
    notes,
    tags,
  });

  return formatResult(result);
}

/**
 * Removes tags from notes.
 */
export async function removeTags({ notes, tags }) {
  const { result } = await callAnki("removeTags", {
    notes,
    tags,
  });

  return formatResult(result);
}

/**
 * Gets all tags.
 */
export async function getTags() {
  const { result } = await callAnki("getTags");

  return formatResult(result);
}

/**
 * Clears unused tags.
 */
export async function clearUnusedTags() {
  const { result } = await callAnki("clearUnusedTags");

  return formatResult(result);
}

/**
 * Replaces tags in notes.
 */
export async function replaceTags({ notes, tagToReplace, replaceWithTag }) {
  const { result } = await callAnki("replaceTags", {
    notes,
    tag_to_replace: tagToReplace,
    replace_with_tag: replaceWithTag,
  });

  return formatResult(result);
}

/**
 * Replaces tags in all notes.
 */
export async function replaceTagsInAllNotes({ tagToReplace, replaceWithTag }) {
  const { result } = await callAnki("replaceTagsInAllNotes", {
    tag_to_replace: tagToReplace,
    replace_with_tag: replaceWithTag,
  });

  return formatResult(result);
}

/**
 * Finds notes.
 */
export async function findNotes({ query }) {
  const { result } = await callAnki("findNotes", {
    query,
  });

  return formatResult(result);
}

/**
 * Gets note information.
 */
export async function notesInfo({ notes, query }) {
  const { result } = await callAnki("notesInfo", {
    notes,
    query,
  });

  return formatResult(result);
}

/**
 * Gets note modification time.
 */
export async function notesModTime({ notes }) {
  const { result } = await callAnki("notesModTime", {
    notes,
  });

  return formatResult(result);
}

/**
 * Deletes notes.
 */
export async function deleteNotes({ notes }) {
  const { result } = await callAnki("deleteNotes", {
    notes,
  });

  return formatResult(result);
}

/**
 * Removes empty notes.
 */
export async function removeEmptyNotes() {
  const { result } = await callAnki("removeEmptyNotes");

  return formatResult(result);
}
