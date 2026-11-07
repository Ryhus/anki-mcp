import { z } from "zod";
import { ackSchema, type V1Route } from "./anki-v1-adapter-utils.js";
import { retrieveV1MediaFile } from "./anki-v1-media-client.js";
import { acceptV1Operation, waitForV1Operation } from "./anki-v1-operation.js";
import { invalidAnkiV1Response } from "./anki-v1-request.js";

const storeMethod = "media.store";
const storedSchema = z.object({ status: z.literal("stored"), filename: z.string().min(1) });

export const v1MediaRoutes = {
  retrieveMediaFile: ({ filename }, ctx) => retrieveV1MediaFile(filename as string, ctx.session, ctx.options),
  getMediaFilesNames: ({ pattern }, ctx) => ctx.request("media.list", { pattern }, z.array(z.string())),
  async deleteMediaFile({ filename }, ctx) {
    const method = "media.delete";
    if (!(await ctx.request(method, { filename }, ackSchema)).changed) throw invalidAnkiV1Response(method);
    return null;
  },
  async storeMediaFile({ filename, data, deleteExisting, rejectIfExists }, ctx) {
    const operationId = await acceptV1Operation(ctx, storeMethod, {
      filename, source: { data }, collision: deleteExisting === true ? "replace" : rejectIfExists === true ? "error" : "rename",
    });
    try {
      return (await waitForV1Operation(ctx, storeMethod, operationId, storedSchema)).filename;
    } catch (error) {
      throw new Error(
        `Anki accepted the media operation, but storage could not be confirmed. The file may exist or the operation may still complete; inspect Anki before retrying. ${error instanceof Error ? error.message : "Unknown operation failure."}`,
        { cause: error },
      );
    }
  },
} satisfies Record<string, V1Route>;
