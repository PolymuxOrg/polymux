import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { FlowCompileError } from "./errors.js";

function isFlow(path: string): boolean {
  return /\.flow\.ya?ml$/i.test(path);
}

async function collect(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (entry.isFile() && isFlow(entry.name)) files.push(path);
  }
  return files;
}

async function referencedFlows(files: string[]): Promise<Set<string>> {
  const referenced = new Set<string>();
  await Promise.all(files.map(async (file) => {
    let value: unknown;
    try {
      value = parse(await readFile(file, "utf8"));
    } catch {
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if ("actors" in value) {
      const actors = (value as { actors?: unknown }).actors;
      if (typeof actors === "object" && actors !== null && !Array.isArray(actors)) {
        for (const actor of Object.values(actors)) {
          const reference = typeof actor === "string"
            ? actor
            : typeof actor === "object" && actor !== null && "flow" in actor
              ? (actor as { flow?: unknown }).flow
              : undefined;
          if (typeof reference === "string") {
            referenced.add(resolve(dirname(file), reference));
          }
        }
      }
    }
    const source = value as Record<string, unknown>;
    for (const phase of ["setup", "steps", "teardown"]) {
      const items = source[phase];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (typeof item === "object" && item !== null && "flow" in item) {
          const reference = (item as { flow?: unknown }).flow;
          if (typeof reference === "string") {
            referenced.add(resolve(dirname(file), reference));
          }
        }
      }
    }
  }));
  return referenced;
}

async function rootFlows(files: string[]): Promise<string[]> {
  const referenced = await referencedFlows(files);
  const roots = files.filter((file) => !referenced.has(resolve(file)));
  if (files.length > 0 && roots.length === 0) {
    throw new FlowCompileError(
      "No root flow was found; coordinated flow references may contain a cycle",
    );
  }
  return roots;
}

function isWithin(directory: string, path: string): boolean {
  const fromDirectory = relative(directory, path);
  return fromDirectory === "" || (
    !isAbsolute(fromDirectory) &&
    fromDirectory !== ".." &&
    !fromDirectory.startsWith(`..${sep}`)
  );
}

async function directoryCandidates(
  projectDir: string,
  flowDir: string,
  selector: string,
): Promise<string[]> {
  const candidates = new Set([
    resolve(projectDir, selector),
    resolve(flowDir, selector),
  ]);
  const directories: string[] = [];
  for (const candidate of candidates) {
    if (!isWithin(flowDir, candidate)) continue;
    try {
      if ((await stat(candidate)).isDirectory()) directories.push(candidate);
    } catch {
      // Ignore missing candidates.
    }
  }
  return directories.sort();
}

export async function discoverFlows(
  projectDir: string,
  selector?: string,
): Promise<string[]> {
  const flowDir = join(resolve(projectDir), "polymux");
  if (!selector) return rootFlows((await collect(flowDir)).sort());

  const direct = resolve(projectDir, selector);
  try {
    if ((await stat(direct)).isFile() && isFlow(direct)) return [direct];
  } catch {
    // Fall through to flow-name lookup.
  }

  const directories = await directoryCandidates(projectDir, flowDir, selector);
  const normalized = selector.replace(/\.flow\.ya?ml$/i, "");
  const allFiles = (await collect(flowDir)).sort();
  const matches = allFiles.filter(
    (file) => basename(file).replace(/\.flow\.ya?ml$/i, "") === normalized,
  );
  if (directories.length > 0 && matches.length > 0) {
    throw new FlowCompileError(
      `Flow selector "${selector}" is ambiguous between a flow and a directory collection`,
    );
  }
  if (directories.length > 1) {
    throw new FlowCompileError(
      `Directory collection "${selector}" is ambiguous:\n${directories.join("\n")}`,
    );
  }
  if (directories.length === 1) {
    const collectionFiles = (await collect(directories[0]!)).sort();
    if (collectionFiles.length === 0) {
      throw new FlowCompileError(
        `No flows found in directory collection "${selector}"`,
      );
    }
    const referenced = await referencedFlows(allFiles);
    const roots = collectionFiles.filter((file) => !referenced.has(resolve(file)));
    if (roots.length === 0) {
      throw new FlowCompileError(
        `No root flows found in directory collection "${selector}"`,
      );
    }
    return roots;
  }
  if (matches.length === 0) {
    throw new FlowCompileError(
      `No flow named "${selector}" was found under ${flowDir}`,
    );
  }
  if (matches.length > 1) {
    throw new FlowCompileError(
      `Flow name "${selector}" is ambiguous:\n${matches.join("\n")}`,
    );
  }
  return matches;
}
