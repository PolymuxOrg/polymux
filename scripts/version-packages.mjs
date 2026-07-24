import { readFile, writeFile } from "node:fs/promises";

const version = (process.argv[2] ?? process.env.RELEASE_VERSION ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Pass a semantic version, for example: npm run release:version -- 0.1.0");
}

const paths = [
  "apps/cli/package.json", "apps/runner/package.json", "packages/core/package.json",
  "packages/protocol/package.json", "packages/adapters/web/package.json",
  "packages/adapters/linux/package.json", "packages/adapters/appium/package.json",
  "packages/test-gates/package.json"
];
const publicNames = new Set();
for (const path of paths) {
  const value = JSON.parse(await readFile(path, "utf8"));
  publicNames.add(value.name);
}
for (const path of paths) {
  const value = JSON.parse(await readFile(path, "utf8"));
  value.version = version;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const name of Object.keys(value[field] ?? {})) if (publicNames.has(name)) value[field][name] = version;
  }
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
process.stdout.write(`Versioned ${paths.length} public packages at ${version}.\n`);
