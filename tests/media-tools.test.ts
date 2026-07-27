import assert from "node:assert/strict";
import test from "node:test";
import { attachMediaToNotes } from "../mcp/tools/media/attach-media-to-notes.js";
import { deleteMediaFile } from "../mcp/tools/media/delete-media-file.js";
import { detachMediaFromNotes } from "../mcp/tools/media/detach-media-from-notes.js";
import { findMediaReferences } from "../mcp/tools/media/find-media-references.js";
import { getMediaFile } from "../mcp/tools/media/get-media-file.js";
import { searchMediaFiles } from "../mcp/tools/media/search-media-files.js";
import { storeMediaFile } from "../mcp/tools/media/store-media-file.js";
import { prepareNoteDrafts } from "../mcp/tools/notes/note-draft-validator.js";
import { noteDraftSchema } from "../mcp/tools/notes/shared-schemas.js";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

interface MockNote {
  noteId: number;
  modelName: string;
  tags: string[];
  fields: Record<string, { value: string; order: number }>;
  mod: number;
  cards: number[];
}

test("Media tools complete store, inspect, attach, detach, and delete lifecycle", async () => {
  const originalFetch = globalThis.fetch;
  const originalAnkiUrl = process.env.ANKI_URL;
  const media = new Map<string, string>();
  const notes = new Map<number, MockNote>([
    [
      1,
      {
        noteId: 1,
        modelName: "Basic",
        tags: [],
        fields: {
          Front: { value: "Cat", order: 0 },
          Image: { value: "<b>Existing HTML</b>", order: 1 },
        },
        mod: 1_700_000_000,
        cards: [10],
      },
    ],
  ]);
  const actions: string[] = [];

  process.env.ANKI_URL = "http://127.0.0.1:8765";
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      action: string;
      params?: Record<string, unknown>;
    };
    actions.push(request.action);

    try {
      const result = handleMockAnkiAction(
        request.action,
        request.params ?? {},
        media,
        notes,
      );

      return Response.json({ result, error: null });
    } catch (error) {
      return Response.json({
        result: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  try {
    const stored = await storeMediaFile({
      filename: "cat.png",
      source: { type: "base64", data: ONE_PIXEL_PNG },
      collisionPolicy: "rename",
      usage: "note-field",
    });
    const storedContent = structured<{
      storedFilename: string;
      file: { sha256: string };
    }>(stored);

    assert.equal(storedContent.storedFilename, "cat.png");
    assert.equal(storedContent.file.sha256.length, 64);

    const preparedDrafts = await prepareNoteDrafts([
      noteDraftSchema.parse({
        deckName: "Default",
        modelName: "Basic",
        fields: { Front: "A new cat" },
        mediaReferences: [
          {
            fieldName: "Image",
            filename: "cat.png",
            altText: "A cat",
          },
        ],
      }),
    ]);
    assert.match(
      preparedDrafts.notes[0]?.fields.Image ?? "",
      /<img src="cat\.png" alt="A cat">/u,
    );
    assert.equal(preparedDrafts.validations[0]?.canCreate, true);

    const search = structured<{ total: number }>(
      await searchMediaFiles({
        pattern: "*.png",
        offset: 0,
        limit: 20,
      }),
    );
    assert.equal(search.total, 1);

    const inspected = await getMediaFile({
      filename: "cat.png",
      includeContent: true,
    });
    const inspectedContent = structured<{
      exists: boolean;
      contentIncluded: boolean;
    }>(inspected);

    assert.equal(inspectedContent.exists, true);
    assert.equal(inspectedContent.contentIncluded, true);
    assert.equal(
      inspected.content.some(({ type }) => type === "image"),
      true,
    );

    const attachPreview = structured<{
      changes: Array<{
        beforeFieldHash: string;
        proposedPreview: string;
      }>;
    }>(
      await attachMediaToNotes({
        attachments: [
          {
            noteId: 1,
            fieldName: "Image",
            filename: "cat.png",
            placement: "append",
            altText: "A cat",
          },
        ],
        dryRun: true,
      }),
    );
    const attachment = attachPreview.changes[0];

    assert.ok(attachment);
    assert.match(attachment.proposedPreview, /<b>Existing HTML<\/b>/u);
    assert.match(attachment.proposedPreview, /cat\.png/u);

    await attachMediaToNotes({
      attachments: [
        {
          noteId: 1,
          fieldName: "Image",
          filename: "cat.png",
          placement: "append",
          altText: "A cat",
          expectedFieldHash: attachment.beforeFieldHash,
        },
      ],
      dryRun: false,
    });

    const usageAfterAttach = structured<{
      usage: {
        totalReferenceCount: number;
        candidateNoteCount: number;
        scannedNoteCount: number;
        totalNoteCount: number;
        scanStrategy: string;
      };
    }>(
      await findMediaReferences({
        filename: "cat.png",
      }),
    );
    assert.equal(usageAfterAttach.usage.totalReferenceCount, 1);
    assert.equal(usageAfterAttach.usage.candidateNoteCount, 1);
    assert.equal(usageAfterAttach.usage.scannedNoteCount, 1);
    assert.equal(usageAfterAttach.usage.totalNoteCount, 1);
    assert.equal(
      usageAfterAttach.usage.scanStrategy,
      "native-candidates",
    );

    const detachPreview = structured<{
      changes: Array<{
        beforeFieldHash: string;
        proposedPreview: string;
      }>;
    }>(
      await detachMediaFromNotes({
        detachments: [
          {
            noteId: 1,
            fieldName: "Image",
            filename: "cat.png",
          },
        ],
        dryRun: true,
      }),
    );
    const detachment = detachPreview.changes[0];

    assert.ok(detachment);
    assert.equal(detachment.proposedPreview, "<b>Existing HTML</b>");

    await detachMediaFromNotes({
      detachments: [
        {
          noteId: 1,
          fieldName: "Image",
          filename: "cat.png",
          expectedFieldHash: detachment.beforeFieldHash,
        },
      ],
      dryRun: false,
    });

    const deletePreview = structured<{
      file: { sha256: string };
      usage: { totalReferenceCount: number };
    }>(
      await deleteMediaFile({
        filename: "cat.png",
        dryRun: true,
        confirmDeletion: false,
        confirmBrokenReferences: false,
      }),
    );

    assert.equal(deletePreview.usage.totalReferenceCount, 0);

    const deleted = structured<{ applied: boolean }>(
      await deleteMediaFile({
        filename: "cat.png",
        dryRun: false,
        expectedSha256: deletePreview.file.sha256,
        expectedReferenceCount:
          deletePreview.usage.totalReferenceCount,
        confirmDeletion: true,
        confirmBrokenReferences: false,
      }),
    );

    assert.equal(deleted.applied, true);
    assert.equal(media.has("cat.png"), false);
    assert.ok(actions.includes("storeMediaFile"));
    assert.ok(actions.includes("retrieveMediaFile"));
    assert.ok(actions.includes("updateNoteFields"));
    assert.ok(actions.includes("deleteMediaFile"));
    assert.ok(actions.includes("multi"));
  } finally {
    globalThis.fetch = originalFetch;

    if (originalAnkiUrl === undefined) {
      delete process.env.ANKI_URL;
    } else {
      process.env.ANKI_URL = originalAnkiUrl;
    }
  }
});

test("Media reference scanning falls back safely when native search fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalAnkiUrl = process.env.ANKI_URL;
  let requestIndex = 0;

  process.env.ANKI_URL = "http://127.0.0.1:8765";
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      action: string;
      params: {
        actions: Array<{ action: string }>;
      };
    };

    assert.equal(request.action, "multi");
    requestIndex += 1;

    if (requestIndex === 1) {
      return Response.json({
        result: [
          { result: null, error: "invalid search" },
          { result: [1], error: null },
          { result: {}, error: null },
        ],
        error: null,
      });
    }

    if (requestIndex === 2) {
      return Response.json({
        result: [
          { result: [1], error: null },
          { result: {}, error: null },
        ],
        error: null,
      });
    }

    assert.equal(requestIndex, 3);
    assert.deepEqual(
      request.params.actions.map(({ action }) => action),
      ["notesInfo"],
    );

    return Response.json({
      result: [
        {
          result: [
            {
              noteId: 1,
              modelName: "Basic",
              tags: [],
              fields: {
                Front: {
                  value: '<img src="fallback.png">',
                  order: 0,
                },
              },
              mod: 1_700_000_000,
              cards: [10],
            },
          ],
          error: null,
        },
      ],
      error: null,
    });
  };

  try {
    const result = structured<{
      usage: {
        totalReferenceCount: number;
        candidateNoteCount: number;
        scannedNoteCount: number;
        scanStrategy: string;
        scanFallbackReason: string | null;
        scanComplete: boolean;
      };
    }>(
      await findMediaReferences({
        filename: "fallback.png",
      }),
    );

    assert.equal(result.usage.totalReferenceCount, 1);
    assert.equal(result.usage.candidateNoteCount, 1);
    assert.equal(result.usage.scannedNoteCount, 1);
    assert.equal(result.usage.scanStrategy, "full-scan-fallback");
    assert.match(
      result.usage.scanFallbackReason ?? "",
      /invalid search/u,
    );
    assert.equal(result.usage.scanComplete, true);
  } finally {
    globalThis.fetch = originalFetch;

    if (originalAnkiUrl === undefined) {
      delete process.env.ANKI_URL;
    } else {
      process.env.ANKI_URL = originalAnkiUrl;
    }
  }
});

function handleMockAnkiAction(
  action: string,
  params: Record<string, unknown>,
  media: Map<string, string>,
  notes: Map<number, MockNote>,
): unknown {
  switch (action) {
    case "storeMediaFile": {
      const filename = String(params.filename);
      const data = String(params.data);
      let storedFilename = filename;
      let suffix = 1;

      while (media.has(storedFilename)) {
        const dot = filename.lastIndexOf(".");
        const stem = dot === -1 ? filename : filename.slice(0, dot);
        const extension = dot === -1 ? "" : filename.slice(dot);
        storedFilename = `${stem}_${suffix}${extension}`;
        suffix += 1;
      }

      media.set(storedFilename, data);
      return storedFilename;
    }
    case "retrieveMediaFile":
      return media.get(String(params.filename)) ?? false;
    case "getMediaFilesNames": {
      const pattern = String(params.pattern);
      const expression = new RegExp(
        `^${pattern
          .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
          .replaceAll("*", ".*")
          .replaceAll("?", ".")}$`,
        "u",
      );
      return [...media.keys()].filter((filename) =>
        expression.test(filename),
      );
    }
    case "deleteMediaFile":
      media.delete(String(params.filename));
      return null;
    case "multi":
      return (params.actions as Array<{
        action: string;
        params?: Record<string, unknown>;
      }>).map((nestedAction) => {
        try {
          return {
            result: handleMockAnkiAction(
              nestedAction.action,
              nestedAction.params ?? {},
              media,
              notes,
            ),
            error: null,
          };
        } catch (error) {
          return {
            result: null,
            error:
              error instanceof Error ? error.message : String(error),
          };
        }
      });
    case "findNotes":
      return [...notes.keys()];
    case "notesInfo":
      return (params.notes as number[]).map(
        (noteId) => notes.get(noteId) ?? {},
      );
    case "updateNoteFields": {
      const update = params.note as {
        id: number;
        fields: Record<string, string>;
      };
      const note = notes.get(update.id);

      if (note === undefined) {
        throw new Error("note not found");
      }

      for (const [fieldName, value] of Object.entries(update.fields)) {
        const field = note.fields[fieldName];

        if (field !== undefined) {
          field.value = value;
        }
      }
      note.mod += 1;
      return null;
    }
    case "modelNamesAndIds":
      return { Basic: 1 };
    case "deckNamesAndIds":
      return { Default: 1 };
    case "modelFieldNames":
      return ["Front", "Image"];
    case "canAddNotesWithErrorDetail":
      return (params.notes as unknown[]).map(() => ({ canAdd: true }));
    case "modelTemplates":
      return {
        "Card 1": {
          Front: "{{Front}}",
          Back: "{{FrontSide}}<hr>{{Image}}",
        },
      };
    case "modelStyling":
      return { css: ".card { color: black; }" };
    default:
      throw new Error(`unsupported mock action: ${action}`);
  }
}

function structured<T>(
  result: Awaited<ReturnType<typeof storeMediaFile>>,
): T {
  assert.ok(result.structuredContent);
  return result.structuredContent as T;
}
