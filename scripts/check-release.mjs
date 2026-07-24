import { access, readFile } from "node:fs/promises";

const paths = [
  "apps/cli/package.json", "apps/runner/package.json", "packages/core/package.json",
  "packages/protocol/package.json", "packages/adapters/web/package.json",
  "packages/adapters/linux/package.json", "packages/adapters/appium/package.json",
  "packages/test-gates/package.json"
];
const packages = await Promise.all(paths.map(async (path) => ({ path, value: JSON.parse(await readFile(path, "utf8")) })));
const versions = new Set(packages.map(({ value }) => value.version));
if (versions.size !== 1) throw new Error(`Public package versions differ: ${[...versions].join(", ")}`);
for (const { path, value } of packages) {
  if (value.private) throw new Error(`${path} is private`);
  if (!value.files?.includes("LICENSE") || !value.files?.includes("NOTICE")) {
    throw new Error(`${path} must package LICENSE and NOTICE`);
  }
  if (
    !value.scripts?.prepack?.includes("package-legal.mjs prepare")
    || !value.scripts?.postpack?.includes("package-legal.mjs clean")
  ) {
    throw new Error(`${path} must prepare and clean package legal files`);
  }
  for (const [name, version] of Object.entries(value.dependencies ?? {})) {
    if (packages.some(({ value: candidate }) => candidate.name === name) && version !== value.version) {
      throw new Error(`${path} depends on ${name}@${version}, expected ${value.version}`);
    }
  }
  await access(path.replace(/package\.json$/, "dist/index.js"));
}
const cli = packages.find(({ value }) => value.name === "polymux")?.value;
if (cli?.bin?.polymux !== "./dist/index.js") throw new Error("The polymux executable is not packaged correctly");
process.stdout.write(`Release package graph is valid at ${[...versions][0]}.\n`);
