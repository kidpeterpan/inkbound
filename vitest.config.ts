import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // VITEST ONLY. The npm "obsidian" package ships .d.ts with no runtime JS,
      // so anything importing it is otherwise unloadable in tests. esbuild keeps
      // it external — never add an alias there: a second transpiled copy of the
      // stub would give main.ts a different TFile identity and break instanceof.
      obsidian: fileURLToPath(new URL("./tests/fixtures/obsidian-stub.ts", import.meta.url)),
      // Same rationale as esbuild.config.mjs: JSZip drags in `setimmediate`
      // and `lie`'s `immediate`, both IE-era setImmediate polyfills with
      // <script>-injection/new-Function fallbacks that Obsidian's review
      // flags as dynamic code execution. Alias them here too so all 185 unit
      // tests — including every EpubBuilder test that actually zips/unzips
      // bytes — run against the same shims the production build uses,
      // instead of the real (dead-weight) polyfills.
      immediate: fileURLToPath(new URL("./shims/immediate.cjs", import.meta.url)),
      setimmediate: fileURLToPath(new URL("./shims/setimmediate.cjs", import.meta.url)),
    },
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
