/** Raster images a browser draws; SVGs are text and get a text diff. */
const IMAGE_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** The media type of an image file the review can show, from its extension; undefined for anything else. */
export const imageType = (file: string): string | undefined => {
  const dot = file.lastIndexOf(".");
  return dot === -1
    ? undefined
    : IMAGE_TYPES[file.slice(dot + 1).toLowerCase()];
};

/** The largest image the review loads. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** `old`: the version the diff compares with. `new`: the changed one. */
export type ImageSide = "old" | "new";
