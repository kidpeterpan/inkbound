import esbuild from "esbuild";
const prod = process.argv[2] === "production";

const buildOptions = {
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  target: "es2020",
  platform: "node",
  external: ["obsidian", "electron"],
  sourcemap: prod ? false : "inline",
  logLevel: "info",
};

if (prod) {
  await esbuild.build(buildOptions);
} else {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("[esbuild] watching for changes... (Ctrl-C to stop)");
}
