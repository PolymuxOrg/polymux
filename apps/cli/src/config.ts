import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { platforms } from "@polymux/protocol";
import { configDirectory, configPath } from "./paths.js";
import { normalizeServiceUrl } from "./service-url.js";

export const configKeys = [
  "auth.url",
  "api.url",
  "credentials.store",
  "defaults.platform",
  "defaults.browser",
  "telemetry.enabled",
  "updates.enabled",
  "updates.packageManager",
] as const;

export type ConfigKey = (typeof configKeys)[number];
type ConfigValue = string | boolean;

interface ConfigFile {
  formatVersion: 1;
  values: Partial<Record<ConfigKey, ConfigValue>>;
}

const defaults: Record<ConfigKey, ConfigValue> = {
  "auth.url": "https://polymux.com",
  "api.url": "https://api.polymux.co",
  "credentials.store": "auto",
  "defaults.platform": "web",
  "defaults.browser": "chromium",
  "telemetry.enabled": true,
  "updates.enabled": true,
  "updates.packageManager": "auto",
};

const browsers = ["chromium", "firefox", "webkit"] as const;

const environment: Partial<Record<ConfigKey, string | undefined>> = {
  "auth.url": process.env.POLYMUX_AUTH_URL,
  "api.url": process.env.POLYMUX_API_URL,
  "credentials.store": process.env.POLYMUX_CREDENTIAL_STORE,
  "defaults.platform": process.env.POLYMUX_DEFAULT_PLATFORM,
  "defaults.browser": process.env.POLYMUX_DEFAULT_BROWSER,
  "telemetry.enabled":
    process.env.POLYMUX_TELEMETRY_DISABLED === "1" || process.env.DO_NOT_TRACK === "1"
      ? "false"
      : undefined,
  "updates.enabled": process.env.POLYMUX_NO_UPDATE_CHECK === "1" ? "false" : undefined,
  "updates.packageManager": process.env.POLYMUX_PACKAGE_MANAGER,
};

function parseFile(raw: string): ConfigFile {
  const parsed = JSON.parse(raw) as Partial<ConfigFile> | null;
  if (!parsed || parsed.formatVersion !== 1 || !parsed.values || typeof parsed.values !== "object" || Array.isArray(parsed.values)) {
    throw new Error("Configuration must contain formatVersion 1 and a values object");
  }
  return {
    formatVersion: 1,
    values: parsed.values,
  };
}

function readConfigSync(): ConfigFile {
  try {
    return parseFile(readFileSync(configPath(), "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { formatVersion: 1, values: {} };
    }
    throw new Error(`Could not read ${configPath()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readConfig(): Promise<ConfigFile> {
  try {
    return parseFile(await readFile(configPath(), "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { formatVersion: 1, values: {} };
    }
    throw new Error(`Could not read ${configPath()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error('Expected "true" or "false"');
}

function parseUrl(value: string): string {
  return normalizeServiceUrl(value, "URL");
}

export function parseConfigValue(key: ConfigKey, value: string): ConfigValue {
  if (key === "telemetry.enabled" || key === "updates.enabled") return parseBoolean(value);
  if (key === "auth.url" || key === "api.url") return parseUrl(value);
  if (key === "credentials.store" && !["auto", "native", "file"].includes(value)) {
    throw new Error("credentials.store must be auto, native, or file");
  }
  if (key === "defaults.platform" && !platforms.includes(value as (typeof platforms)[number])) {
    throw new Error(`defaults.platform must be one of: ${platforms.join(", ")}`);
  }
  if (key === "defaults.browser" && !browsers.includes(value as (typeof browsers)[number])) {
    throw new Error(`defaults.browser must be one of: ${browsers.join(", ")}`);
  }
  if (key === "updates.packageManager" && !["auto", "npm", "pnpm", "yarn", "bun"].includes(value)) {
    throw new Error("updates.packageManager must be auto, npm, pnpm, yarn, or bun");
  }
  return value;
}

export function isConfigKey(value: string): value is ConfigKey {
  return configKeys.includes(value as ConfigKey);
}

export function configValue<T extends ConfigValue = ConfigValue>(key: ConfigKey): T {
  const env = environment[key];
  if (env !== undefined) return parseConfigValue(key, env) as T;
  const stored = readConfigSync().values[key];
  return (stored ?? defaults[key]) as T;
}

async function saveConfig(config: ConfigFile): Promise<void> {
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(configPath(), 0o600);
}

export async function listConfig(json: boolean): Promise<void> {
  const stored = (await readConfig()).values;
  const entries = Object.fromEntries(configKeys.map((key) => [key, {
    value: configValue(key),
    source: environment[key] !== undefined ? "environment" : stored[key] !== undefined ? "file" : "default",
  }]));
  if (json) process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  else for (const [key, entry] of Object.entries(entries)) process.stdout.write(`${key}=${String(entry.value)} (${entry.source})\n`);
}

export async function getConfig(key: string, json: boolean): Promise<void> {
  if (!isConfigKey(key)) throw new Error(`Unknown configuration key "${key}"`);
  const value = configValue(key);
  if (json) process.stdout.write(`${JSON.stringify({ key, value }, null, 2)}\n`);
  else process.stdout.write(`${String(value)}\n`);
}

export async function setConfig(key: string, raw: string, json = false): Promise<void> {
  if (!isConfigKey(key)) throw new Error(`Unknown configuration key "${key}"`);
  const config = await readConfig();
  const value = parseConfigValue(key, raw);
  config.values[key] = value;
  await saveConfig(config);
  if (json) process.stdout.write(`${JSON.stringify({ key, value, status: "set" }, null, 2)}\n`);
  else process.stdout.write(`Set ${key}=${String(value)}\n`);
}

export async function unsetConfig(key: string, json = false): Promise<void> {
  if (!isConfigKey(key)) throw new Error(`Unknown configuration key "${key}"`);
  const config = await readConfig();
  delete config.values[key];
  if (Object.keys(config.values).length === 0) await rm(configPath(), { force: true });
  else await saveConfig(config);
  if (json) process.stdout.write(`${JSON.stringify({ key, status: "unset" }, null, 2)}\n`);
  else process.stdout.write(`Unset ${key}\n`);
}

export function printConfigPath(json = false): void {
  process.stdout.write(json ? `${JSON.stringify({ path: configPath() }, null, 2)}\n` : `${configPath()}\n`);
}

export interface ConfigDoctorReport {
  status: "passed" | "warning" | "failed";
  path: string;
  checks: Array<{ id: string; status: "passed" | "warning" | "failed"; message: string }>;
}

export async function inspectConfig(): Promise<ConfigDoctorReport> {
  const checks: ConfigDoctorReport["checks"] = [];
  try {
    const file = await readConfig();
    for (const [key, value] of Object.entries(file.values)) {
      if (!isConfigKey(key)) throw new Error(`Unknown stored key "${key}"`);
      parseConfigValue(key, String(value));
    }
    checks.push({ id: "syntax", status: "passed", message: "Configuration is valid" });
  } catch (error) {
    checks.push({ id: "syntax", status: "failed", message: error instanceof Error ? error.message : String(error) });
  }
  try {
    const metadata = await stat(configPath());
    const permissions = metadata.mode & 0o777;
    checks.push(permissions & 0o077
      ? { id: "permissions", status: "warning", message: `Configuration permissions are ${permissions.toString(8)}; use 600` }
      : { id: "permissions", status: "passed", message: `Configuration permissions are ${permissions.toString(8)}` });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      checks.push({ id: "permissions", status: "passed", message: "No configuration file exists yet" });
    } else {
      checks.push({ id: "permissions", status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
  try {
    await import("@napi-rs/keyring");
    checks.push({ id: "credential-backend", status: "passed", message: "Native credential library is available" });
  } catch {
    checks.push({ id: "credential-backend", status: "warning", message: "Native credential library is unavailable; auto mode will use a protected file" });
  }
  const status = checks.some((check) => check.status === "failed") ? "failed"
    : checks.some((check) => check.status === "warning") ? "warning" : "passed";
  return { status, path: configPath(), checks };
}

export async function configDoctor(json: boolean): Promise<void> {
  const report = await inspectConfig();
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const check of report.checks) {
      const marker = check.status === "passed" ? "✓" : check.status === "warning" ? "!" : "✗";
      process.stdout.write(`${marker} ${check.id}: ${check.message}\n`);
    }
  }
  process.exitCode = report.status === "failed" ? 1 : 0;
}
