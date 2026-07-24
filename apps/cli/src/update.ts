import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, normalize, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { configValue } from "./config.js";

const packageName = "polymux";
const defaultRegistryUrl = "https://registry.npmjs.org";
const checkIntervalMs = 24 * 60 * 60 * 1_000;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

interface UpdateOptions {
  yes: boolean;
  packageManager?: string;
  json?: boolean;
}

export type InstallationKind = "global" | "local" | "ephemeral" | "homebrew" | "unknown";

export interface Installation {
  kind: InstallationKind;
  packageManager?: PackageManager;
  projectDir?: string;
  executable: string;
  reason: string;
}

interface UpdateCache {
  checkedAt: string;
  latestVersion?: string;
}

function cacheDirectory(): string {
  if (process.env.POLYMUX_CACHE_DIR) return process.env.POLYMUX_CACHE_DIR;
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Polymux", "Cache");
  }
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, "polymux");
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "polymux");
  return join(homedir(), ".cache", "polymux");
}

function cachePath(): string {
  return join(cacheDirectory(), "update.json");
}

function registryUrl(value?: string): string {
  const url = new URL(value ?? process.env.POLYMUX_UPDATE_REGISTRY_URL ?? defaultRegistryUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("The package registry URL must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function parseVersion(version: string): [number, number, number, string | undefined] {
  const match = semverPattern.exec(version);
  if (!match) throw new Error(`Invalid package version "${version}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]];
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  for (let index = 0; index < 3; index += 1) {
    if (next[index]! > installed[index]!) return true;
    if (next[index]! < installed[index]!) return false;
  }
  if (installed[3] && !next[3]) return true;
  if (!installed[3] || !next[3]) return false;
  return next[3].localeCompare(installed[3], undefined, { numeric: true }) > 0;
}

function packageManager(value?: string): PackageManager {
  const configured = configValue<string>("updates.packageManager");
  const requested = value ?? (configured === "auto" ? undefined : configured) ?? process.env.npm_config_user_agent?.split("/")[0] ?? "npm";
  if (requested === "npm" || requested === "pnpm" || requested === "yarn" || requested === "bun") return requested;
  if (value) throw new Error(`Unsupported package manager "${value}". Use npm, pnpm, yarn, or bun.`);
  return "npm";
}

export function detectInstallation(
  executable = process.argv[1] ?? "",
  environment: NodeJS.ProcessEnv = process.env,
): Installation {
  const path = normalize(resolve(executable)).replaceAll("\\", "/");
  const lowerPath = path.toLowerCase();
  const userAgent = environment.npm_config_user_agent?.split("/")[0];
  const manager = userAgent === "npm" || userAgent === "pnpm" || userAgent === "yarn" || userAgent === "bun"
    ? userAgent
    : lowerPath.includes("/.pnpm/") || lowerPath.includes("/pnpm/") ? "pnpm"
      : lowerPath.includes("/.yarn/") || lowerPath.includes("/yarn/") ? "yarn"
        : lowerPath.includes("/.bun/") ? "bun" : "npm";

  if (lowerPath.includes("/cellar/polymux/") || lowerPath.includes("/homebrew/cellar/polymux/")) {
    return { kind: "homebrew", executable: path, reason: "executable is inside a Homebrew Cellar" };
  }
  if (lowerPath.includes("/_npx/") || lowerPath.includes("/.npm/_npx/")) {
    return { kind: "ephemeral", packageManager: "npm", executable: path, reason: "running from an npx cache" };
  }
  if (path.includes("/node_modules/")) {
    const prefix = environment.npm_config_prefix?.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
    const globalPath = Boolean(
      (prefix && lowerPath.startsWith(`${prefix}/`)) ||
      lowerPath.includes("/lib/node_modules/") ||
      lowerPath.includes("/appdata/roaming/npm/node_modules/") ||
      lowerPath.includes("/appdata/local/pnpm/global/") ||
      lowerPath.includes("/pnpm/global/") ||
      lowerPath.includes("/yarn/global/") ||
      lowerPath.includes("/bun/install/global/"),
    );
    return {
      kind: globalPath ? "global" : "local",
      packageManager: manager,
      ...(!globalPath ? { projectDir: path.slice(0, path.indexOf("/node_modules/")) } : {}),
      executable: path,
      reason: globalPath ? "executable is in a global package directory" : "executable is in a project node_modules directory",
    };
  }
  return { kind: "unknown", packageManager: manager, executable: path, reason: "installation layout is not recognized" };
}

export function installInvocation(manager: PackageManager, version: string): { command: string; args: string[] } {
  parseVersion(version);
  const target = `${packageName}@${version}`;
  if (manager === "pnpm") return { command: "pnpm", args: ["add", "--global", target] };
  if (manager === "yarn") return { command: "yarn", args: ["global", "add", target] };
  if (manager === "bun") return { command: "bun", args: ["add", "--global", target] };
  return { command: "npm", args: ["install", "--global", target] };
}

export function updateInvocation(installation: Installation, version: string): { command: string; args: string[] } | undefined {
  parseVersion(version);
  if (installation.kind === "homebrew") return { command: "brew", args: ["upgrade", "polymux"] };
  if (installation.kind === "ephemeral" || installation.kind === "unknown") return undefined;
  const manager = installation.packageManager ?? "npm";
  if (installation.kind === "global") return installInvocation(manager, version);
  const target = `${packageName}@${version}`;
  if (manager === "pnpm") return { command: "pnpm", args: ["add", "--save-dev", target] };
  if (manager === "yarn") return { command: "yarn", args: ["add", "--dev", target] };
  if (manager === "bun") return { command: "bun", args: ["add", "--dev", target] };
  return { command: "npm", args: ["install", "--save-dev", target] };
}

async function latestVersion(registry: string, timeoutMs = 5_000): Promise<string> {
  const response = await fetch(`${registry}/${encodeURIComponent(packageName)}/latest`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) throw new Error(`${packageName} has not been published to this registry yet`);
  if (!response.ok) throw new Error(`Could not check for updates (${response.status})`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string") throw new Error("The package registry returned an invalid version");
  parseVersion(body.version);
  return body.version;
}

function displayInvocation(invocation: { command: string; args: string[] }): string {
  return [invocation.command, ...invocation.args].join(" ");
}

async function execute(invocation: { command: string; args: string[] }, cwd?: string): Promise<void> {
  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    const child = spawn(invocation.command, invocation.args, { stdio: "inherit", ...(cwd ? { cwd } : {}) });
    child.once("error", rejectExit);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`The package manager exited with code ${exitCode}`);
}

async function confirmUpdate(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question("Install this update? (y/N) ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

export async function updateCli(currentVersion: string, options: UpdateOptions): Promise<void> {
  const latest = await latestVersion(registryUrl());
  const installation = detectInstallation();
  if (process.env.POLYMUX_VERBOSE === "1") {
    process.stderr.write(`[polymux] install=${installation.kind} manager=${installation.packageManager ?? "none"} reason=${installation.reason}\n`);
  }
  if (!isNewerVersion(latest, currentVersion)) {
    if (options.json) process.stdout.write(`${JSON.stringify({ status: "up-to-date", currentVersion, latestVersion: latest, installation }, null, 2)}\n`);
    else process.stdout.write(`Polymux ${currentVersion} is up to date.\n`);
    return;
  }
  if (options.packageManager) installation.packageManager = packageManager(options.packageManager);
  const invocation = updateInvocation(installation, latest);
  if (!invocation) {
    const guidance = installation.kind === "ephemeral"
      ? `This is an ephemeral invocation. Run npx polymux@${latest} instead.`
      : `Polymux could not safely identify this installation. Reinstall it with your package manager.`;
    if (options.json) process.stdout.write(`${JSON.stringify({ status: "manual-update-required", currentVersion, latestVersion: latest, installation, guidance }, null, 2)}\n`);
    else process.stdout.write(`Polymux ${latest} is available (installed: ${currentVersion}).\n${guidance}\n`);
    return;
  }
  if (options.json) {
    if (!options.yes) {
      process.stdout.write(`${JSON.stringify({ status: "update-available", currentVersion, latestVersion: latest, installation, command: displayInvocation(invocation) }, null, 2)}\n`);
      return;
    }
  }
  if (!options.json) {
    process.stdout.write(`Polymux ${latest} is available (installed: ${currentVersion}).\n`);
    process.stdout.write(`Update command: ${displayInvocation(invocation)}\n`);
  }
  if (!options.yes && !(await confirmUpdate())) {
    process.stdout.write(
      process.stdin.isTTY && process.stdout.isTTY
        ? "Update cancelled.\n"
        : "Run again with --yes to update non-interactively.\n",
    );
    return;
  }
  if (!options.json) process.stdout.write(`Updating with ${displayInvocation(invocation)}…\n`);
  await execute(invocation, installation.kind === "local" ? installation.projectDir : undefined);
  if (options.json) process.stdout.write(`${JSON.stringify({ status: "updated", previousVersion: currentVersion, version: latest, installation }, null, 2)}\n`);
  else process.stdout.write(`Updated Polymux to ${latest}.\n`);
}

async function readCache(): Promise<UpdateCache | undefined> {
  try {
    return JSON.parse(await readFile(cachePath(), "utf8")) as UpdateCache;
  } catch {
    return undefined;
  }
}

async function writeCache(cache: UpdateCache): Promise<void> {
  await mkdir(cacheDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(cachePath(), `${JSON.stringify(cache)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function maybeNotifyUpdate(currentVersion: string): Promise<void> {
  if (!configValue<boolean>("updates.enabled") || process.env.CI) return;
  try {
    const cached = await readCache();
    const checkedAt = cached ? Date.parse(cached.checkedAt) : Number.NaN;
    let latest = cached?.latestVersion;
    if (!Number.isFinite(checkedAt) || Date.now() - checkedAt >= checkIntervalMs) {
      try {
        latest = await latestVersion(registryUrl(), 1_500);
        await writeCache({ checkedAt: new Date().toISOString(), latestVersion: latest });
      } catch {
        await writeCache({ checkedAt: new Date().toISOString() });
        return;
      }
    }
    if (latest && isNewerVersion(latest, currentVersion)) {
      process.stderr.write(`Update available: Polymux ${currentVersion} → ${latest}. Run \`polymux update\`.\n`);
    }
  } catch {
    // Update checks must never make ordinary CLI commands fail.
  }
}
