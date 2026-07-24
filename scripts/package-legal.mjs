import { access, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const action = process.argv[2];
if (action !== "prepare" && action !== "clean") {
  throw new Error("package-legal expects prepare or clean");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(process.cwd());
if (
  packageRoot === repositoryRoot
  || !packageRoot.startsWith(`${repositoryRoot}${sep}`)
) {
  throw new Error("Package legal files may only be prepared inside this repository");
}

const markerPath = join(packageRoot, ".polymux-package-legal.generated");
const legalFiles = ["LICENSE", "NOTICE"];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (action === "prepare") {
  const generated = [];
  for (const name of legalFiles) {
    const source = join(repositoryRoot, name);
    const destination = join(packageRoot, name);
    if (await exists(destination)) {
      if ((await readFile(destination, "utf8")) !== (await readFile(source, "utf8"))) {
        throw new Error(`${relative(repositoryRoot, destination)} differs from the repository ${name}`);
      }
      continue;
    }
    await copyFile(source, destination);
    generated.push(name);
  }
  await writeFile(markerPath, `${JSON.stringify(generated)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
} else if (await exists(markerPath)) {
  const generated = JSON.parse(await readFile(markerPath, "utf8"));
  if (!Array.isArray(generated) || generated.some((name) => !legalFiles.includes(name))) {
    throw new Error("Package legal cleanup marker is invalid");
  }
  for (const name of generated) {
    const source = join(repositoryRoot, name);
    const destination = join(packageRoot, name);
    if (
      await exists(destination)
      && (await readFile(destination, "utf8")) === (await readFile(source, "utf8"))
    ) {
      await rm(destination);
    }
  }
  await rm(markerPath);
}
