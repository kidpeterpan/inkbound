import esbuild from "esbuild";
const prod = process.argv[2] === "production";
await esbuild.build({
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  target: "es2020",
  platform: "node",
  external: ["obsidian", "electron"],
  sourcemap: prod ? false : "inline",
  logLevel: "info",
});
