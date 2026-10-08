// Pure (no "obsidian" import): the one rule for how big an image becomes when
// it is shrunk to a maximum width. Shared by the optimizer, which uses it to
// estimate a result before decoding anything, and by the browser codec, which
// uses it to size the real canvas — so the estimate and the result can never
// follow different arithmetic.

export interface ImageSize {
  width: number;
  height: number;
}

// Shrinks to `maxWidth`, keeping the proportions. An image already within the
// width is returned as it is: this never scales up. Neither side is ever
// below one pixel, so a very flat image cannot become a zero-height canvas.
export function fitWidth(width: number, height: number, maxWidth: number): ImageSize {
  if (width <= maxWidth) return { width, height };

  const scaledHeight = Math.round((height * maxWidth) / width);
  return { width: maxWidth, height: Math.max(1, scaledHeight) };
}
