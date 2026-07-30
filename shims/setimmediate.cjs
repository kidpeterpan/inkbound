// Replacement for the `setimmediate` polyfill required by jszip/lib/utils.js.
// The real one contains new Function("" + callback) and createElement("script")
// for ancient browsers. Chromium needs neither.
//
// setImmediate is macrotask-like (runs after the current task, not as a
// microtask), so we use setTimeout(..., 0) rather than queueMicrotask — a
// microtask here could starve rendering during a large zip.
if (typeof globalThis.setImmediate !== "function") {
  globalThis.setImmediate = function setImmediate(callback, ...args) {
    return setTimeout(() => callback(...args), 0);
  };
  globalThis.clearImmediate = function clearImmediate(handle) {
    clearTimeout(handle);
  };
}
module.exports = globalThis.setImmediate;
