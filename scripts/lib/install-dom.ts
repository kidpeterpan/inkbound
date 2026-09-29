// Side-effect import: gives a script that runs under plain tsx (no vitest, no
// Obsidian) the jsdom globals the pure DOM modules expect. It must be imported
// BEFORE anything that touches `document` or `Node` at load time — the
// Obsidian stub in tests/fixtures installs its createEl/createDiv shims the
// moment it loads, and only if a DOM already exists. Import order is the
// contract; keep this first.
import { installJsdomGlobals } from "./harness";

installJsdomGlobals();
