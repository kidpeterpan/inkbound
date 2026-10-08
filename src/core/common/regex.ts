// Regex-source escaping, shared by the modules that build patterns from
// user-authored text: mermaid SVG style ids (render/svg.ts) and scoped-embed
// block markers (render/md.ts).
//
// A leaf module on purpose, mirroring xml.ts: before this file existed the two
// call sites each needed the same escape and had nowhere neutral to put it.
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
