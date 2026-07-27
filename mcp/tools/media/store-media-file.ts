import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { storeAnkiMediaFile } from "../../../anki-api/media/media-client.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { createToolResult } from "../../utils/tool-result.js";
import { loadAnkiMediaFile } from "./media-loader.js";
import { loadMediaSource } from "./media-source-loader.js";
import {
  buildMediaFieldReference,
} from "./media-reference-utils.js";
import {
  describeMediaFile,
  isAttachableMediaKind,
  validateStorableMediaFile,
} from "./media-utils.js";
import {
  mediaFileDescriptorSchema,
  mediaFilenameSchema,
  mediaSourceSchema,
} from "./shared-schemas.js";

const storeMediaFileInputSchema = z
  .object({
    filename: mediaFilenameSchema,
    source: mediaSourceSchema,
    collisionPolicy: z
      .enum(["rename", "reject"])
      .default("rename")
      .describe(
        "rename lets Anki choose a non-conflicting filename; reject makes an existing filename an error",
      ),
    usage: z
      .enum(["note-field", "template-static"])
      .default("note-field")
      .describe(
        "Static template assets must start with an underscore so Anki's media checker preserves them",
      ),
  })
  .superRefine(({ filename, usage }, context) => {
    if (usage === "template-static" && !filename.startsWith("_")) {
      context.addIssue({
        code: "custom",
        path: ["filename"],
        message:
          "A static Card Template or CSS asset filename must start with an underscore",
      });
    }
  });

type StoreMediaFileInput = z.infer<
  typeof storeMediaFileInputSchema
>;

const STORE_MEDIA_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} satisfies ToolAnnotations;

export const storeMediaFileConfig = {
  title: "Store media file",
  description:
    "Safely imports bounded media bytes into Anki from base64, a public HTTPS URL, or an explicitly allowed local directory. Existing files are never overwritten.",
  inputSchema: storeMediaFileInputSchema,
  outputSchema: z.object({
    stored: z.boolean(),
    requestedFilename: z.string(),
    storedFilename: z.string().nullable(),
    collisionRenamed: z.boolean(),
    sourceType: z.enum(["base64", "url", "localPath"]),
    sourceDescription: z.string(),
    file: mediaFileDescriptorSchema.nullable(),
    fieldReference: z.string().nullable(),
    templateReference: z.string().nullable(),
  }),
  annotations: STORE_MEDIA_ANNOTATIONS,
};

/** Imports verified bytes and performs a round-trip integrity check. */
export async function storeMediaFile({
  filename,
  source,
  collisionPolicy,
  usage: _usage,
}: StoreMediaFileInput): Promise<CallToolResult> {
  const loadedSource = await loadMediaSource(source);
  const candidate = await describeMediaFile(
    filename,
    loadedSource.bytes,
  );
  const validationErrors = validateStorableMediaFile(candidate);

  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("; "));
  }

  const existing = await loadAnkiMediaFile(filename);

  if (existing !== null && collisionPolicy === "reject") {
    throw new Error(
      `Media file "${filename}" already exists with SHA-256 ${existing.descriptor.sha256}`,
    );
  }

  const storedFilename = await storeAnkiMediaFile({
    filename,
    data: loadedSource.bytes.toString("base64"),
    deleteExisting: false,
  });

  if (storedFilename === null) {
    throw new Error("AnkiConnect skipped the media file unexpectedly");
  }

  const stored = await loadAnkiMediaFile(storedFilename);

  if (stored === null) {
    throw new Error(
      `AnkiConnect did not return stored media file "${storedFilename}"`,
    );
  }

  if (stored.descriptor.sha256 !== candidate.sha256) {
    throw new Error(
      `Stored media verification failed for "${storedFilename}"`,
    );
  }

  const fieldReference = isAttachableMediaKind(stored.descriptor.kind)
    ? buildMediaFieldReference(
        storedFilename,
        stored.descriptor.kind,
      )
    : null;
  const templateReference = createTemplateReference(
    storedFilename,
    stored.descriptor.kind,
  );

  return createToolResult(
    `Stored ${stored.descriptor.kind} media as "${storedFilename}" (${stored.descriptor.byteLength} bytes)${storedFilename === filename ? "." : `; Anki renamed it to avoid overwriting "${filename}".`}`,
    {
      stored: true,
      requestedFilename: filename,
      storedFilename,
      collisionRenamed: storedFilename !== filename,
      sourceType: loadedSource.sourceType,
      sourceDescription: loadedSource.sourceDescription,
      file: stored.descriptor,
      fieldReference,
      templateReference,
    },
  );
}

function createTemplateReference(
  filename: string,
  kind: string,
): string | null {
  if (kind === "image") {
    return `<img src="${filename}">`;
  }
  if (kind === "audio" || kind === "video") {
    return `[sound:${filename}]`;
  }
  if (kind === "font") {
    return `url("${filename}")`;
  }

  return null;
}
