import assert from "node:assert/strict";
import test from "node:test";
import { attachMediaToNotesConfig } from "../mcp/tools/media/attach-media-to-notes.js";
import { deleteMediaFileConfig } from "../mcp/tools/media/delete-media-file.js";
import { detachMediaFromNotesConfig } from "../mcp/tools/media/detach-media-from-notes.js";
import { isPrivateIpAddress } from "../mcp/tools/media/media-source-loader.js";
import { buildMediaReferenceCandidateQuery } from "../mcp/tools/media/media-reference-search.js";
import {
  attachMediaReferenceToField,
  buildMediaFieldReference,
  calculateFieldHash,
  countMediaReferencesInCss,
  findMediaReferencesInHtml,
  removeMediaReferencesFromField,
} from "../mcp/tools/media/media-reference-utils.js";
import {
  decodeBase64,
  describeMediaFile,
  inferMediaFileSummary,
  validateStorableMediaFile,
} from "../mcp/tools/media/media-utils.js";
import { storeMediaFileConfig } from "../mcp/tools/media/store-media-file.js";
import { noteDraftSchema } from "../mcp/tools/notes/shared-schemas.js";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("media bytes are strictly decoded, detected, and hashed", async () => {
  const bytes = decodeBase64(ONE_PIXEL_PNG);
  const descriptor = await describeMediaFile("pixel.png", bytes);

  assert.equal(descriptor.kind, "image");
  assert.equal(descriptor.mimeType, "image/png");
  assert.equal(descriptor.extension, ".png");
  assert.equal(descriptor.contentDetected, true);
  assert.equal(descriptor.byteLength, bytes.byteLength);
  assert.match(descriptor.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(validateStorableMediaFile(descriptor), []);

  const misleading = await describeMediaFile("pixel.mp3", bytes);
  assert.match(
    validateStorableMediaFile(misleading).join(" "),
    /extension \.mp3 indicates audio/u,
  );
  assert.throws(() => decodeBase64("not base64!?"));
});

test("media summaries stay bounded and extension based", () => {
  assert.deepEqual(inferMediaFileSummary("voice.mp3"), {
    kind: "audio",
    inferredMimeType: "audio/mpeg",
  });
  assert.deepEqual(inferMediaFileSummary("unknown.bin"), {
    kind: "other",
    inferredMimeType: "application/octet-stream",
  });
});

test("media field references preserve unrelated HTML", () => {
  const existing =
    '<div>Before<img alt="old" src="photo.png">After[sound:voice.mp3]</div>';
  const imageMatches = findMediaReferencesInHtml(
    existing,
    "photo.png",
  );
  const soundMatches = findMediaReferencesInHtml(
    existing,
    "voice.mp3",
  );

  assert.equal(imageMatches.length, 1);
  assert.equal(
    imageMatches[0]?.markup,
    '<img alt="old" src="photo.png">',
  );
  assert.equal(soundMatches.length, 1);
  assert.equal(soundMatches[0]?.markup, "[sound:voice.mp3]");

  const removedImage = removeMediaReferencesFromField(
    existing,
    "photo.png",
  );
  assert.equal(removedImage.removedReferenceCount, 1);
  assert.equal(
    removedImage.value,
    "<div>BeforeAfter[sound:voice.mp3]</div>",
  );

  const attached = attachMediaReferenceToField(
    removedImage.value,
    "new&photo.png",
    "image",
    "prepend",
    'A "quoted" image',
  );
  assert.equal(attached.changed, true);
  assert.equal(
    attached.reference,
    '<img src="new&amp;photo.png" alt="A &quot;quoted&quot; image">',
  );
  assert.ok(attached.value.endsWith(removedImage.value));

  const duplicate = attachMediaReferenceToField(
    attached.value,
    "new&photo.png",
    "image",
    "append",
  );
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.value, attached.value);
  assert.equal(
    buildMediaFieldReference("voice.mp3", "audio"),
    "[sound:voice.mp3]",
  );

  const overlapping = removeMediaReferencesFromField(
    '<video src="movie.mp4"><source src="movie.mp4"></video>',
    "movie.mp4",
  );
  assert.equal(overlapping.removedReferenceCount, 2);
  assert.equal(overlapping.value, "");
});

test("media references are found in CSS and fields have stable hashes", () => {
  assert.equal(
    countMediaReferencesInCss(
      '@font-face { src: url("_font.woff2"); } .x { background: url(other.png) }',
      "_font.woff2",
    ),
    1,
  );
  assert.equal(calculateFieldHash("<b>Hello</b>").length, 64);
});

test("media candidate queries escape filenames and include HTML entity candidates", () => {
  const query = buildMediaReferenceCandidateQuery(
    "broadcast (1)+copy.mp3",
  );

  assert.match(
    query,
    /broadcast \\\(1\\\)\\\+copy\\\.mp3/u,
  );
  assert.match(query, /audio\|img\|source\|video/u);
  assert.match(query, /src/u);
  assert.match(query, /&/u);
});

test("private and local network destinations are rejected", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.2",
    "169.254.1.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ]) {
    assert.equal(isPrivateIpAddress(address), true, address);
  }

  assert.equal(isPrivateIpAddress("8.8.8.8"), false);
  assert.equal(isPrivateIpAddress("2606:4700:4700::1111"), false);
});

test("media mutation schemas require reviewed hashes and confirmations", () => {
  const hash = "a".repeat(64);
  const attachWithoutHash =
    attachMediaToNotesConfig.inputSchema.safeParse({
      attachments: [
        {
          noteId: 1,
          fieldName: "Audio",
          filename: "voice.mp3",
        },
      ],
      dryRun: false,
    });
  const attachConfirmed =
    attachMediaToNotesConfig.inputSchema.safeParse({
      attachments: [
        {
          noteId: 1,
          fieldName: "Audio",
          filename: "voice.mp3",
          expectedFieldHash: hash,
        },
      ],
      dryRun: false,
    });
  const detachWithoutHash =
    detachMediaFromNotesConfig.inputSchema.safeParse({
      detachments: [
        {
          noteId: 1,
          fieldName: "Audio",
          filename: "voice.mp3",
        },
      ],
      dryRun: false,
    });
  const deleteWithoutImpact =
    deleteMediaFileConfig.inputSchema.safeParse({
      filename: "voice.mp3",
      dryRun: false,
      confirmDeletion: true,
    });
  const deleteConfirmed =
    deleteMediaFileConfig.inputSchema.safeParse({
      filename: "voice.mp3",
      dryRun: false,
      expectedSha256: hash,
      expectedReferenceCount: 0,
      confirmDeletion: true,
    });
  const staticWithoutUnderscore =
    storeMediaFileConfig.inputSchema.safeParse({
      filename: "logo.png",
      source: { type: "base64", data: ONE_PIXEL_PNG },
      usage: "template-static",
    });

  assert.equal(attachWithoutHash.success, false);
  assert.equal(attachConfirmed.success, true);
  assert.equal(detachWithoutHash.success, false);
  assert.equal(deleteWithoutImpact.success, false);
  assert.equal(deleteConfirmed.success, true);
  assert.equal(staticWithoutUnderscore.success, false);
});

test("note drafts support safe references to existing media", () => {
  const parsed = noteDraftSchema.safeParse({
    deckName: "German",
    modelName: "German Verb",
    fields: { Verb: "gehen", Translation: "идти" },
    mediaReferences: [
      {
        fieldName: "Audio",
        filename: "gehen.mp3",
        placement: "append",
      },
    ],
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.mediaReferences.length, 1);
    assert.deepEqual(parsed.data.tags, []);
  }
});
