// 006-thai-font: stand-in for the real bundled TTFs under vitest. The real
// fonts are inlined by `loader: { ".ttf": "base64" }` in the production bundle
// and the local-export harness bundle; unit tests only need non-empty bytes
// with the right module shape.
//
// 008-mobile-support: this exports a base64 STRING rather than a Uint8Array,
// because the production module shape changed with the loader — the fixture
// exists to mirror that shape, so it follows it. Decodes to [0,1,2,3,4], the
// same dummy bytes it always stood in for.
const base64 = "AAECAwQ=";
export default base64;
