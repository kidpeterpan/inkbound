import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: [
      // VITEST ONLY. The npm "obsidian" package ships .d.ts with no runtime JS,
      // so anything importing it is otherwise unloadable in tests. esbuild keeps
      // it external — never add an alias there: a second transpiled copy of the
      // stub would give main.ts a different TFile identity and break instanceof.
      {
        find: "obsidian",
        replacement: fileURLToPath(new URL("./tests/fixtures/obsidian-stub.ts", import.meta.url)),
      },
      // Same rationale as esbuild.config.mjs: JSZip drags in `setimmediate`
      // and `lie`'s `immediate`, both IE-era setImmediate polyfills with
      // <script>-injection/new-Function fallbacks that Obsidian's review
      // flags as dynamic code execution. Alias them here too so all 185 unit
      // tests — including every EpubBuilder test that actually zips/unzips
      // bytes — run against the same shims the production build uses,
      // instead of the real (dead-weight) polyfills.
      {
        find: "immediate",
        replacement: fileURLToPath(new URL("./shims/immediate.cjs", import.meta.url)),
      },
      {
        find: "setimmediate",
        replacement: fileURLToPath(new URL("./shims/setimmediate.cjs", import.meta.url)),
      },
      // 006-thai-font: vitest treats .ttf imports as URL assets, not bytes —
      // the production bundles (esbuild.config.mjs + local-export harness)
      // inline the real fonts via the base64 loader. Alias them to a fixture so
      // unit tests exercise the same module shape with tiny dummy bytes
      // (mirrors the obsidian-alias discipline).
      //
      // 008-mobile-support — this MUST be a regex, and the whole alias block is
      // an array so that it can be. Vite matches aliases against the raw import
      // SPECIFIER ("./fonts/NotoSansThai-Regular.ttf"), not the resolved
      // absolute path, so the previous absolute-path keys never matched: font
      // imports silently resolved to Vite's asset URL string instead of the
      // fixture, and `loadThaiFontAsset()` returned a URL string where every
      // caller expected bytes. It went unnoticed because the only assertion on
      // it was `.length > 0`, which a URL string satisfies.
      {
        // Anchored to the WHOLE specifier: Vite substitutes only the matched
        // substring, so an unanchored pattern would leave the "./fonts/" prefix
        // glued in front of the fixture's absolute path.
        find: /^.*NotoSansThai-(?:Regular|Bold)\.ttf$/,
        replacement: fileURLToPath(new URL("./tests/fixtures/font-bytes.ts", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup/no-network.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Interfaces only — emits no JS, so v8 reports 0/0 and would fail any threshold.
      exclude: ["src/types.ts"],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        perFile: true,
        statements: 85,
        lines: 85,
        functions: 85,
        branches: 85,
      },
    },
  },
});
