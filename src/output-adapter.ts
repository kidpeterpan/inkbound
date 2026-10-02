// Writing the finished book to wherever it belongs, and the one platform
// decision that chooses between the two destinations.
//
// Split out of main.ts (008-mobile-support's platform seam): the file-writing
// half is pure adapter code with no plugin state, and the two lazy imports
// below are load-bearing enough that they deserve to sit together with the
// comment that explains them.
import { Platform, type Vault } from "obsidian";
import type { ExportDestination, PlatformKind } from "./output";

// 008-mobile-support: the ONLY place this plugin decides what platform it is
// on. Everything downstream takes the resulting PlatformKind as a plain
// value, which keeps `obsidian` out of the pure modules (constitution IV) and
// makes every placement rule unit-testable with no stub at all.
export function platformKind(): PlatformKind {
  // Platform.isDesktop, not isDesktopApp: one flag decides both the
  // destination shape and the write mechanism, so they cannot drift — and it
  // is the property Obsidian's own guidance and lint recognize as the
  // node-availability guard.
  return Platform.isDesktop ? "desktop" : "mobile";
}

// 008-mobile-support — INVARIANT, do not "tidy" these imports to the top of
// the file. esbuild.config.mjs sets platform: "node", so a static
// `import { promises as fs } from "fs"` compiles to a require("fs") at the
// TOP LEVEL of the bundle, which executes the moment Obsidian loads main.js.
// Obsidian mobile has no require(), so a top-level one does not degrade the
// plugin — it stops the plugin from loading at all, before onload() runs and
// before any Platform check could guard anything. Inside a function body the
// same import compiles to a require() that only executes if this function is
// called, which on mobile it never is.
//
// That last sentence is true ONLY because esbuild.config.mjs sets
// `supported: { "dynamic-import": false }`. Without it esbuild emits these
// `await import("os")` calls verbatim, Obsidian hands them to the browser's
// ESM loader, and export dies with "Failed to resolve module specifier 'os'"
// — on desktop, where the require-scan had nothing to find. Read that flag's
// comment before touching either import below.
// `npm run check-mobile-safe` fails the build if this ever regresses.
// See specs/008-mobile-support/contracts/platform-seam.md.
export async function desktopHomedir(): Promise<string> {
  // The guard is lexical, not just at the call site: it is what proves — to a
  // reader and to Obsidian's plugin-review lint — that this import cannot run
  // on mobile. "" is the right answer there, since mobile resolution never
  // consults a home directory (see resolveDestination in output.ts).
  if (!Platform.isDesktop) {
    return "";
  }
  const { homedir } = await import("os");
  return homedir();
}

// One write, of a byte array that is already complete in memory
// (EpubBuilder.build() returns the whole book before this is called). There
// is no streaming write to interrupt, which is the whole of FR-011's
// "never leave a partial or corrupt book behind" — no temp-file dance needed.
export async function writeBook(dest: ExportDestination, bytes: Uint8Array, vault: Vault): Promise<void> {
  // Branches on Platform rather than dest.kind so the node import sits
  // lexically inside its guard. The two cannot disagree: dest.kind comes from
  // platformKind(), which reads this same flag — so the write mechanism and
  // the shape of the path resolveDestination produced always match.
  if (Platform.isDesktop) {
    const { promises: fs } = await import("fs"); // lazy — see the invariant above
    await fs.mkdir(dest.path.slice(0, dest.path.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(dest.path, bytes);
    return;
  }
  // Mobile: the vault adapter is the only write surface that exists, and it
  // takes vault-relative paths — which is what resolveDestination guarantees.
  const adapter = vault.adapter;
  const folder = dest.path.slice(0, dest.path.lastIndexOf("/"));
  if (folder) {
    // Created segment by segment rather than in one call: Obsidian's
    // DataAdapter.mkdir is NOT documented to create intermediate parents, so
    // a nested output folder ("Books/EPUB") could fail on a device even
    // though a recursive test stub would happily accept it.
    let sofar = "";
    for (const segment of folder.split("/")) {
      sofar = sofar === "" ? segment : `${sofar}/${segment}`;
      if (!(await adapter.exists(sofar))) await adapter.mkdir(sofar);
    }
  }
  // Copy through a standalone ArrayBuffer: `bytes.buffer` can be a larger
  // pooled buffer with a non-zero byteOffset, which would write garbage.
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await adapter.writeBinary(dest.path, buffer);
}
