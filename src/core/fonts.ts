// ── Thai font embedding (006-thai-font) ──────────────────────────────────
//
// Pure module: zero "obsidian" imports (constitution IV). The font BYTES
// live in src/fonts/*.ttf and are inlined by esbuild's binary loader
// (esbuild.config.mjs + scripts/local-export.ts both set
// `loader: { ".ttf": "binary" }`); vitest aliases those exact paths to
// tests/fixtures/font-bytes.ts instead. The OFL license text is inlined as
// a constant so no text-loader is needed — it must travel with the font
// (SIL OFL 1.1 requirement) and is shipped inside every font-bearing book.
//
// Provenance (reproducible): static wght 400/700 instances instantiated
// from the official Noto Sans Thai variable font
// (google/fonts ofl/notosansthai/NotoSansThai[wdth,wght].ttf) via
//   fonttools varLib.instancer.instantiateVariableFont(f, {"wght": w, "wdth": 100})
// 467 glyphs each, ~47.8 KB — see plan.md Research. The font BYTES and the
// injectable loader seam live in src/font-assets.ts (which owns the .ttf
// binary imports), so this module stays loadable by tsx-based scripts that
// have no .ttf loader.

export const THAI_FONT_FAMILY = "Noto Sans Thai";

// Unicode Thai block U+0E00–U+0E7F: consonants, vowels, tone marks, digits.
const THAI_RE = /[\u0E00-\u0E7F]/;

export function containsThai(text: string): boolean {
  return THAI_RE.test(text);
}

export interface ThaiFontFileMeta {
  href: string;
  mediaType: string;
  weight: number;
  manifestId: string;
}

export const THAI_FONT_META: ThaiFontFileMeta[] = [
  {
    href: "fonts/NotoSansThai-Regular.ttf",
    mediaType: "font/ttf",
    weight: 400,
    manifestId: "font-regular",
  },
  {
    href: "fonts/NotoSansThai-Bold.ttf",
    mediaType: "font/ttf",
    weight: 700,
    manifestId: "font-bold",
  },
];

export const OFL_LICENSE_HREF = "fonts/OFL.txt";

export const OFL_LICENSE_TEXT = `Copyright 2022 The Noto Project Authors (https://github.com/notofonts/thai)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.`;

// @font-face pair + body chain. The css file lives at OEBPS/style/epub.css,
// so font urls are ../fonts/... Noto Sans Thai has no Latin glyphs — the
// serif fallback keeps Latin in the reader's normal reading font (FR-007).
export function thaiFontCss(): string {
  const faces = THAI_FONT_META.map(
    (f) =>
      `@font-face { font-family: "${THAI_FONT_FAMILY}"; src: url("../${f.href}") format("truetype"); font-weight: ${f.weight}; font-style: normal; }`
  ).join("\n");
  return `${faces}\nbody { font-family: "${THAI_FONT_FAMILY}", serif; }`;
}

export interface ThaiFontAsset {
  regular: Uint8Array;
  bold: Uint8Array;
  license: string;
}
