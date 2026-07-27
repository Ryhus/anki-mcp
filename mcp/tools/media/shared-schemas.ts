import { z } from "zod";

export const MEDIA_FILE_SIZE_LIMIT = 25 * 1024 * 1024;
export const MEDIA_CONTENT_PREVIEW_LIMIT = 5 * 1024 * 1024;
export const MEDIA_SEARCH_LIMIT = 100;
export const MEDIA_MUTATION_BATCH_LIMIT = 50;
export const MEDIA_REFERENCE_SAMPLE_LIMIT = 100;
export const MEDIA_REFERENCE_SCAN_NOTE_LIMIT = 50_000;

export const mediaFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim(), {
    message: "Media filename cannot start or end with whitespace",
  })
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !/[<>:"/\\|?*\u0000-\u001F]/u.test(value) &&
      !value.includes("[") &&
      !value.includes("]"),
    {
      message:
        "Media filename must be a portable basename without path separators, glob characters, or control characters",
    },
  )
  .transform((value) => value.normalize("NFC"))
  .describe(
    "Portable filename inside Anki's flat collection.media folder",
  );

export const mediaSearchPatternSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !/[\u0000-\u001F]/u.test(value),
    {
      message:
        "Media search pattern cannot contain paths or control characters",
    },
  )
  .default("*");

export const mediaKindSchema = z.enum([
  "image",
  "audio",
  "video",
  "font",
  "other",
]);

export const attachableMediaKindSchema = z.enum([
  "image",
  "audio",
  "video",
]);

export const mediaSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .describe("SHA-256 hash of the exact media bytes");

export const mediaFileDescriptorSchema = z.object({
  filename: z.string(),
  kind: mediaKindSchema,
  mimeType: z.string(),
  extension: z.string(),
  byteLength: z.number().int().nonnegative(),
  sha256: mediaSha256Schema,
  contentDetected: z.boolean(),
});

export const mediaFileSummarySchema = z.object({
  filename: z.string(),
  kind: mediaKindSchema,
  inferredMimeType: z.string(),
});

export const mediaSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("base64"),
    data: z
      .string()
      .min(1)
      .max(Math.ceil((MEDIA_FILE_SIZE_LIMIT * 4) / 3) + 16)
      .describe("Base64-encoded media bytes"),
  }),
  z.object({
    type: z.literal("url"),
    url: z
      .url()
      .max(4_096)
      .describe("Public HTTPS URL downloaded by the MCP server"),
  }),
  z.object({
    type: z.literal("localPath"),
    path: z
      .string()
      .min(1)
      .max(4_096)
      .describe(
        "Local file inside a directory explicitly allowed through ANKI_MEDIA_IMPORT_DIRS",
      ),
  }),
]);

export const mediaReferencePlacementSchema = z
  .enum(["append", "prepend"])
  .default("append");

export const noteMediaReferenceSchema = z.object({
  fieldName: z.string().trim().min(1).max(500),
  filename: mediaFilenameSchema,
  placement: mediaReferencePlacementSchema,
  altText: z
    .string()
    .max(1_000)
    .optional()
    .describe("Optional accessible text used only for image references"),
});

export const expectedFieldHashSchema = mediaSha256Schema.describe(
  "SHA-256 hash of the complete field value returned by the dry run",
);

export const mediaUsageSchema = z.object({
  filename: z.string(),
  totalReferenceCount: z.number().int().nonnegative(),
  noteReferenceCount: z.number().int().nonnegative(),
  templateReferenceCount: z.number().int().nonnegative(),
  cssReferenceCount: z.number().int().nonnegative(),
  noteReferences: z.array(
    z.object({
      noteId: z.number().int().positive(),
      modelName: z.string(),
      fieldName: z.string(),
      occurrenceCount: z.number().int().positive(),
    }),
  ),
  templateReferences: z.array(
    z.object({
      modelName: z.string(),
      templateName: z.string(),
      side: z.enum(["front", "back"]),
      occurrenceCount: z.number().int().positive(),
    }),
  ),
  cssReferences: z.array(
    z.object({
      modelName: z.string(),
      occurrenceCount: z.number().int().positive(),
    }),
  ),
  referencesTruncated: z.boolean(),
  totalNoteCount: z.number().int().nonnegative(),
  scannedNoteCount: z.number().int().nonnegative(),
  scannedNoteTypeCount: z.number().int().nonnegative(),
  scanComplete: z.boolean(),
});

export const mediaFieldMutationErrorSchema = z.object({
  index: z.number().int().nonnegative(),
  noteId: z.number().int().positive(),
  fieldName: z.string(),
  filename: z.string(),
  error: z.string(),
});
