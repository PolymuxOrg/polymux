import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { discoverFlows } from "@polymux/core";
import { coordinatedFlowSourceSchema, type CoordinatedFlowSource } from "@polymux/protocol";
import { assertPolymuxTestEnvironment } from "@polymux/test-gates";
import { parseDocument, type Document } from "yaml";

const defaultProtectionName = "access";
const defaultHeader = "x-polymux-test-access";
const defaultTokenEnvironment = "POLYMUX_TEST_ACCESS_TOKEN";
const defaultTestEnvironment = "staging";

interface ProjectAccessStore {
  formatVersion: 1;
  environment: string;
  secrets: Record<string, string>;
}

export interface AccessInitOptions {
  projectDir: string;
  flow?: string;
  origin?: string;
  environment?: string;
  name?: string;
  header?: string;
  tokenEnv?: string;
  json?: boolean;
  interactive?: boolean;
}

export interface AccessInitResult {
  status: "configured" | "unchanged";
  flow: string;
  protection: string;
  origin: string;
  environment: string;
  header: string;
  tokenEnv: string;
  token: string;
  secretPath: string;
  flowChanged: boolean;
  tokenCreated: boolean;
  gitignoreUpdated: boolean;
}

export interface AccessPrompter {
  ask(question: string): Promise<string>;
  write(message: string): void;
}

interface FlowDocument {
  document: Document.Parsed;
  raw: string;
  source: CoordinatedFlowSource;
}

function accessStorePath(projectDir: string): string {
  return resolve(projectDir, ".polymux", "access.json");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function validationMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "flow"}: ${issue.message}`)
    .join("\n");
}

async function readFlowDocument(path: string): Promise<FlowDocument> {
  const raw = await readFile(path, "utf8");
  const document = parseDocument(raw);
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML in ${path}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const value: unknown = document.toJS();
  if (typeof value !== "object" || value === null || !("actors" in value)) {
    throw new Error(
      `Test access must be configured on a coordinated flow with actors: ${path}`,
    );
  }
  const parsed = coordinatedFlowSourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid coordinated flow ${path}:\n${validationMessage(parsed.error)}`);
  }
  return { document, raw, source: parsed.data };
}

async function isCoordinatedFlow(path: string): Promise<boolean> {
  try {
    const document = parseDocument(await readFile(path, "utf8"));
    if (document.errors.length > 0) return false;
    const value: unknown = document.toJS();
    return typeof value === "object" && value !== null && "actors" in value;
  } catch {
    return false;
  }
}

function flowLabel(path: string): string {
  return basename(path).replace(/\.flow\.ya?ml$/i, "");
}

async function chooseFlow(
  projectDir: string,
  selector: string | undefined,
  interactive: boolean,
  prompt: AccessPrompter | undefined,
): Promise<string> {
  if (selector) {
    const matches = await discoverFlows(projectDir, selector);
    const selected = matches[0];
    if (!selected) throw new Error(`No flow named "${selector}" was found`);
    await readFlowDocument(selected);
    return selected;
  }

  const roots = await discoverFlows(projectDir);
  const candidates = (await Promise.all(
    roots.map(async (path) => ({ path, coordinated: await isCoordinatedFlow(path) })),
  )).filter((candidate) => candidate.coordinated).map((candidate) => candidate.path);
  if (candidates.length === 0) {
    throw new Error(
      `No coordinated flows were found under ${resolve(projectDir, "polymux")}. Add a flow with actors first.`,
    );
  }
  if (!interactive || !prompt) {
    if (candidates.length === 1) return candidates[0]!;
    throw new Error(
      `More than one coordinated flow was found. Select one with --flow:\n${candidates.map((path) => `  ${flowLabel(path)}`).join("\n")}`,
    );
  }

  if (candidates.length > 1) {
    prompt.write("Coordinated flows:\n");
    candidates.forEach((path, index) => {
      prompt.write(`  ${index + 1}) ${flowLabel(path)} (${relative(projectDir, path)})\n`);
    });
  }
  while (true) {
    const only = candidates.length === 1 ? flowLabel(candidates[0]!) : undefined;
    const answer = (await prompt.ask(only ? `Flow [${only}]: ` : "Flow number or name: ")).trim();
    if (!answer && only) return candidates[0]!;
    const number = Number.parseInt(answer, 10);
    if (/^\d+$/.test(answer) && number >= 1 && number <= candidates.length) {
      return candidates[number - 1]!;
    }
    try {
      const matches = await discoverFlows(projectDir, answer);
      const selected = matches[0];
      if (!selected) throw new Error("Flow not found");
      await readFlowDocument(selected);
      return selected;
    } catch (error) {
      prompt.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

async function answer(
  explicit: string | undefined,
  label: string,
  fallback: string | undefined,
  interactive: boolean,
  prompt: AccessPrompter | undefined,
  validate: (value: string) => string,
): Promise<string> {
  if (explicit !== undefined) return validate(explicit);
  if (!interactive || !prompt) {
    if (fallback !== undefined) return validate(fallback);
    throw new Error(`${label} is required in a non-interactive shell`);
  }
  while (true) {
    const raw = await prompt.ask(`${label}${fallback === undefined ? "" : ` [${fallback}]`}: `);
    try {
      return validate(raw.trim() || fallback || "");
    } catch (error) {
      prompt.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

function testEnvironment(value: string): string {
  return assertPolymuxTestEnvironment(value);
}

function protectionName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error("Protection name may contain letters, numbers, _ and - and must start with a letter");
  }
  return name;
}

function headerName(value: string): string {
  const header = value.trim().toLowerCase();
  if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(header)) {
    throw new Error("Header name is not a valid HTTP header name");
  }
  return header;
}

function environmentVariable(value: string): string {
  const name = value.trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error("Token environment variable must use uppercase letters, numbers, and underscores");
  }
  return name;
}

function exactOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Test URL must be a valid HTTP or HTTPS origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Test URL must be an exact HTTP origin without credentials, a path, query, or fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("Test URL requires HTTPS except on local loopback");
  }
  return url.origin;
}

function isProjectAccessStore(value: unknown): value is ProjectAccessStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const store = value as Partial<ProjectAccessStore>;
  if (store.formatVersion !== 1 || typeof store.environment !== "string") return false;
  if (typeof store.secrets !== "object" || store.secrets === null || Array.isArray(store.secrets)) return false;
  return Object.entries(store.secrets).every(
    ([name, secret]) => /^[A-Z_][A-Z0-9_]*$/.test(name) && typeof secret === "string" && secret.length >= 32,
  );
}

async function readAccessStore(projectDir: string): Promise<ProjectAccessStore | undefined> {
  const raw = await readOptional(accessStorePath(projectDir));
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Local test-access secrets are invalid: ${accessStorePath(projectDir)}`);
  }
  if (!isProjectAccessStore(value)) {
    throw new Error(`Local test-access secrets are invalid: ${accessStorePath(projectDir)}`);
  }
  testEnvironment(value.environment);
  return value;
}

async function saveAccessStore(projectDir: string, store: ProjectAccessStore): Promise<void> {
  const path = accessStorePath(projectDir);
  await mkdir(resolve(projectDir, ".polymux"), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

async function ensureAccessIgnored(projectDir: string): Promise<boolean> {
  const path = resolve(projectDir, ".gitignore");
  const current = await readOptional(path) ?? "";
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => [".polymux/", "/.polymux/", ".polymux/access.json", "/.polymux/access.json"].includes(line))) {
    return false;
  }
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await writeFile(path, `${current}${separator}/.polymux/access.json\n`, "utf8");
  return true;
}

function existingHeaderDefaults(
  source: CoordinatedFlowSource,
  name: string,
): { origin?: string; header?: string; tokenEnv?: string } {
  const existing = source.protections?.[name];
  if (!existing) return {};
  const entry = Object.entries(existing.headersFromEnv)[0];
  return {
    ...(typeof existing === "object" && "origin" in existing ? { origin: existing.origin } : {}),
    ...(entry ? { header: entry[0], tokenEnv: entry[1] } : {}),
  };
}

function hasMatchingProtection(
  source: CoordinatedFlowSource,
  name: string,
  origin: string,
  header: string,
  tokenEnv: string,
): boolean {
  const existing = source.protections?.[name];
  if (!existing || !("origin" in existing) || existing.origin !== origin) return false;
  const entries = Object.entries(existing.headersFromEnv);
  return entries.length === 1 && headerName(entries[0]![0]) === header && entries[0]![1] === tokenEnv;
}

function updatedFlowText(
  flow: FlowDocument,
  name: string,
  origin: string,
  header: string,
  tokenEnv: string,
): string {
  flow.document.setIn(["protections", name], {
    origin,
    headersFromEnv: { [header]: tokenEnv },
  });
  const validated = coordinatedFlowSourceSchema.safeParse(flow.document.toJS());
  if (!validated.success) {
    throw new Error(`Could not create a valid access configuration:\n${validationMessage(validated.error)}`);
  }
  const yaml = String(flow.document);
  return flow.raw.includes("\r\n") ? yaml.replace(/\n/g, "\r\n") : yaml;
}

export async function initializeAccess(
  options: AccessInitOptions,
  suppliedPrompt?: AccessPrompter,
): Promise<AccessInitResult> {
  const projectDir = resolve(options.projectDir);
  const interactive = options.interactive ?? (
    options.json !== true && process.stdin.isTTY === true && process.stdout.isTTY === true
  );
  let terminal: ReturnType<typeof createInterface> | undefined;
  const prompt = suppliedPrompt ?? (interactive ? (() => {
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    return {
      ask: (question: string) => terminal!.question(question),
      write: (message: string) => process.stdout.write(message),
    } satisfies AccessPrompter;
  })() : undefined);

  try {
    const flowPath = await chooseFlow(projectDir, options.flow, interactive, prompt);
    const flow = await readFlowDocument(flowPath);
    const store = await readAccessStore(projectDir);
    const name = await answer(
      options.name,
      "Protection name",
      defaultProtectionName,
      interactive,
      prompt,
      protectionName,
    );
    const existingDefaults = existingHeaderDefaults(flow.source, name);
    const origin = await answer(
      options.origin,
      "Staging/test URL",
      existingDefaults.origin,
      interactive,
      prompt,
      exactOrigin,
    );
    const environment = await answer(
      options.environment,
      "Test environment",
      store?.environment ?? defaultTestEnvironment,
      interactive,
      prompt,
      testEnvironment,
    );
    const header = await answer(
      options.header,
      "Access header",
      existingDefaults.header ?? defaultHeader,
      interactive,
      prompt,
      headerName,
    );
    const tokenEnv = await answer(
      options.tokenEnv,
      "Token environment variable",
      existingDefaults.tokenEnv ?? defaultTokenEnvironment,
      interactive,
      prompt,
      environmentVariable,
    );

    const existingProtection = flow.source.protections?.[name];
    const matchingProtection = hasMatchingProtection(flow.source, name, origin, header, tokenEnv);
    if (existingProtection && !matchingProtection) {
      throw new Error(
        `Protection "${name}" already exists with different settings in ${flowPath}. Choose another name or edit it explicitly.`,
      );
    }
    if (store && store.environment !== environment) {
      throw new Error(
        `Local test access already uses environment "${store.environment}". Use that environment or remove ${accessStorePath(projectDir)} first.`,
      );
    }

    const existingToken = store?.secrets[tokenEnv];
    const token = existingToken ?? randomBytes(32).toString("base64url");
    const tokenCreated = existingToken === undefined;
    const flowChanged = !matchingProtection;
    const nextStore: ProjectAccessStore = {
      formatVersion: 1,
      environment,
      secrets: { ...(store?.secrets ?? {}), [tokenEnv]: token },
    };
    const nextFlow = flowChanged
      ? updatedFlowText(flow, name, origin, header, tokenEnv)
      : undefined;

    const gitignoreUpdated = await ensureAccessIgnored(projectDir);
    if (tokenCreated || !store) await saveAccessStore(projectDir, nextStore);
    if (nextFlow !== undefined) await writeFile(flowPath, nextFlow, "utf8");

    return {
      status: flowChanged || tokenCreated ? "configured" : "unchanged",
      flow: flowPath,
      protection: name,
      origin,
      environment,
      header,
      tokenEnv,
      token,
      secretPath: accessStorePath(projectDir),
      flowChanged,
      tokenCreated,
      gitignoreUpdated,
    };
  } finally {
    terminal?.close();
  }
}

export function printAccessResult(result: AccessInitResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const flow = relative(process.cwd(), result.flow) || result.flow;
  const secretPath = relative(process.cwd(), result.secretPath) || result.secretPath;
  process.stdout.write(
    `${result.status === "configured" ? "Configured" : "Already configured"}: ${flow}\n\n` +
    `One-time staging setup\n` +
    `  Origin: ${result.origin}\n` +
    `  Header: ${result.header}\n` +
    `  Value: ${result.token}\n\n` +
    `Local reruns will load the token from ${secretPath}.\n` +
    `For CI, set POLYMUX_TEST_ENVIRONMENT=${result.environment} and ${result.tokenEnv} to the value above.\n` +
    `Only trust this header in a non-production application or edge configuration.\n`,
  );
}

export async function loadProjectAccessEnvironment(
  projectDir: string,
  requiredSecrets?: Iterable<string>,
): Promise<string[]> {
  const names = requiredSecrets === undefined ? undefined : [...new Set(requiredSecrets)];
  if (names?.length === 0) return [];
  const store = await readAccessStore(resolve(projectDir));
  if (!store) return [];
  const loaded: string[] = [];
  if (process.env.POLYMUX_TEST_ENVIRONMENT === undefined) {
    process.env.POLYMUX_TEST_ENVIRONMENT = store.environment;
    loaded.push("POLYMUX_TEST_ENVIRONMENT");
  }
  for (const name of names ?? Object.keys(store.secrets)) {
    const secret = store.secrets[name];
    if (secret !== undefined && process.env[name] === undefined) {
      process.env[name] = secret;
      loaded.push(name);
    }
  }
  return loaded;
}
