/**
 * Images a step gives its agent as input: the `images` param of an `agent`
 * step names files and their media types; the worker reads them and sends
 * them with the prompt. A harness that cannot take an image never gets the param.
 */

import { readFile } from "node:fs/promises";
import { isRecord } from "@operad-io/engine";

/** The media types an image input may have. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** One image: where the file is, and its media type. */
export interface ImageInput {
  readonly path: string;
  readonly mediaType: (typeof IMAGE_MEDIA_TYPES)[number];
}

/** The images in a value, or the reason it is not a list of them; an absent value is an empty list. */
export function parseImageInputs(value: unknown): readonly ImageInput[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "images must be an array of { path, mediaType }";
  const found: ImageInput[] = [];
  for (const item of value) {
    const type = isRecord(item) ? IMAGE_MEDIA_TYPES.find((known) => known === item.mediaType) : undefined;
    if (!isRecord(item) || typeof item.path !== "string" || item.path.length === 0 || type === undefined) {
      return `images must be an array of { path, mediaType } with a media type of ${IMAGE_MEDIA_TYPES.join(", ")}`;
    }
    found.push({ path: item.path, mediaType: type });
  }
  return found;
}

/** The images of a step's params; a value that is not a list of images gives none. */
export function imageInputsOf(value: unknown): readonly ImageInput[] {
  const parsed = parseImageInputs(value);
  return typeof parsed === "string" ? [] : parsed;
}

/** One image read as base64, the form both agents take. */
export async function readImage(image: ImageInput): Promise<{ readonly mediaType: ImageInput["mediaType"]; readonly data: string }> {
  return { mediaType: image.mediaType, data: Buffer.from(await readFile(image.path)).toString("base64") };
}
