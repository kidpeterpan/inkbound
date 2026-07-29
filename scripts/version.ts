import { readFileSync, writeFileSync } from "node:fs";

const pkgPath = "package.json";
const manifestPath = "manifest.json";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const write = (p: string, o: unknown) => writeFileSync(p, JSON.stringify(o, null, 2) + "\n");

const mode = process.argv[2];

if (mode === "check") {
  const pkg = read(pkgPath), manifest = read(manifestPath);
  if (pkg.version !== manifest.version) {
    console.error(`version mismatch: package.json ${pkg.version} != manifest.json ${manifest.version}`);
    process.exit(1);
  }
  console.log(`versions match: ${pkg.version}`);
} else if (mode === "bump") {
  const next = process.argv[3];
  if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
    console.error("usage: npm run version:bump -- <major.minor.patch>");
    process.exit(1);
  }
  const pkg = read(pkgPath), manifest = read(manifestPath);
  pkg.version = next;
  manifest.version = next;
  write(pkgPath, pkg);
  write(manifestPath, manifest);
  console.log(`bumped to ${next} in package.json and manifest.json`);
} else {
  console.error("usage: version.ts check | bump <semver>");
  process.exit(1);
}
