import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  { ignores: ["main.js", "coverage/**", "local-out/**", "node_modules/**", ".local-export-bundle.cjs"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "smart"],
      "no-console": "off",
    },
  },
  {
    files: ["tests/**/*.ts", "scripts/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },

  // ── Obsidian plugin-review rules ────────────────────────────────────────
  //
  // These are the rules Obsidian's reviewers run against a submitted plugin.
  // Running them here means a review finding is a failed build rather than a
  // surprise after a release has already shipped — which is exactly how 1.7.0
  // went out carrying three of them.
  //
  // SCOPED TO src/ DELIBERATELY. Only src/ is bundled into main.js and seen by
  // the reviewer. tests/ and scripts/ are dev-only Node code that legitimately
  // imports `fs`, touches `globalThis`, and assigns innerHTML in fixtures;
  // linting them under mobile-safety rules would produce ~200 findings that
  // are all correct-as-written, and the noise would bury the real ones.
  //
  // Note this config is type-aware (obsidianmd's recommended set pulls in
  // typescript-eslint's type-checked rules), which is what catches things the
  // syntax-only pass above structurally cannot — e.g. a redundant `as string`
  // on an already-string expression.
  // Narrowed by ADDING ignores, never by rewriting `files`: one entry in this
  // set is `{ files: ["package.json"], language: "json/json" }`, and forcing a
  // blanket `files: ["src/**/*.ts"]` onto it applies the JSON language to every
  // TypeScript file — every src file then fails to parse at the first `//`.
  ...obsidianmd.configs.recommended.map((config) => ({
    ...config,
    ignores: [
      ...(config.ignores ?? []),
      "tests/**",
      "scripts/**",
      "shims/**",
      "*.config.ts",
      "**/*.mjs",
      "**/*.cjs",
    ],
  })),
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      // The type-checked rules above need a program; without projectService
      // they throw rather than skip. Scoped to src/ so root-level config files
      // and dev-only dirs (ignored above) never need to be in the tsconfig.
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // OFF, not merely downgraded: this rule lowercases everything after the
      // first word, which is wrong for every acronym and proper noun this
      // plugin's UI legitimately contains. It wants "Export note to epub"
      // (EPUB), "Toc heading depth" (TOC), "Embed thai font" (Thai),
      // "Booxdrop" (BooxDrop), and it rewrites the example URL
      // "http://192.168.1.42:8085" to "HTTP://...". Of its 17 findings here,
      // 15 were false and the 2 real ones (Markdown capitalization) are fixed.
      // Re-check it if the rule ever learns an exception list.
      "obsidianmd/ui/sentence-case": "off",

      // Promoted from warning to ERROR. This is the one review finding whose
      // failure mode is total: a top-level node import does not degrade the
      // plugin on mobile, it stops it loading at all. Left at "warning" it
      // would not fail `npm run lint`, so CI would go green on a plugin that
      // cannot start — which is precisely how it reached a release.
      // scripts/check-mobile-safe.mjs catches the same class in the built
      // bundle; this catches it in the source, before a build even runs.
      "obsidianmd/no-nodejs-modules": "error",
    },
  }
);
