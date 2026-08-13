// 006-thai-font: stand-in for the real bundled TTFs under vitest. The real
// binaries are inlined by esbuild's `loader: { ".ttf": "binary" }` in the
// production bundle and the local-export harness bundle; unit tests only
// need non-empty bytes with the right module shape.
const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
export default bytes;
