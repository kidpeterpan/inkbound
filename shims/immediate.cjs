// Replacement for the `immediate` package, which JSZip pulls in via `lie`.
// All that is needed is "run this callback asynchronously, as soon as
// possible". The published package ships IE-era fallbacks that build functions
// from strings and inject <script> elements, which fails Obsidian's plugin
// review as dynamic code execution. Chromium always has queueMicrotask.
//
// CommonJS on purpose: `lie` consumes this as
// `var immediate = require('immediate'); immediate(fn)` — it expects the
// function itself, not an ESM-style `{ default: fn }` namespace object.
module.exports = function immediate(callback, ...args) {
  queueMicrotask(() => callback(...args));
};
