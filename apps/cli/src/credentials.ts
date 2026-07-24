import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { configValue } from "./config.js";
import { configDirectory, credentialsPath } from "./paths.js";
import { normalizeServiceUrl } from "./service-url.js";

const service = "co.polymux.cli";
const account = "default";

export interface StoredCredentials {
  formatVersion: 1;
  authUrl: string;
  apiUrl?: string;
  accessToken: string;
  tokenType: "Bearer";
  userId: string;
  createdAt: string;
}

type CredentialStore = "auto" | "native" | "file";

function parseCredentials(value: unknown, label: string): StoredCredentials {
  if (!value || typeof value !== "object") throw new Error(`${label} are invalid`);
  const item = value as Partial<StoredCredentials>;
  if (
    item.formatVersion !== 1
    || typeof item.authUrl !== "string"
    || (item.apiUrl !== undefined && typeof item.apiUrl !== "string")
    || typeof item.accessToken !== "string"
    || !item.accessToken.startsWith("pmx_")
    || item.accessToken.length > 512
    || item.tokenType !== "Bearer"
    || typeof item.userId !== "string"
    || item.userId.length < 1
    || item.userId.length > 256
    || typeof item.createdAt !== "string"
    || Number.isNaN(Date.parse(item.createdAt))
  ) {
    throw new Error(`${label} are invalid`);
  }
  return {
    formatVersion: 1,
    authUrl: normalizeServiceUrl(item.authUrl, "The stored Polymux authentication URL"),
    ...(item.apiUrl === undefined
      ? {}
      : { apiUrl: normalizeServiceUrl(item.apiUrl, "The stored Polymux API URL") }),
    accessToken: item.accessToken,
    tokenType: "Bearer",
    userId: item.userId,
    createdAt: item.createdAt,
  };
}

async function keyringEntry() {
  const keyring = await import("@napi-rs/keyring");
  return new keyring.AsyncEntry(service, account);
}

async function loadNative(): Promise<StoredCredentials | undefined> {
  const raw = await (await keyringEntry()).getPassword();
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  return parseCredentials(parsed, "Native Polymux credentials");
}

async function saveNative(credentials: StoredCredentials): Promise<void> {
  await (await keyringEntry()).setPassword(JSON.stringify(credentials));
}

async function deleteNative(): Promise<void> {
  try {
    await (await keyringEntry()).deletePassword();
  } catch {
    // A missing or unavailable keyring entry is already effectively deleted.
  }
}

async function loadFile(): Promise<StoredCredentials | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(credentialsPath(), "utf8"));
    return parseCredentials(parsed, "Stored Polymux credentials");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveFile(credentials: StoredCredentials): Promise<void> {
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(credentialsPath(), `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(credentialsPath(), 0o600);
}

function configuredStore(): CredentialStore {
  return configValue<string>("credentials.store") as CredentialStore;
}

export async function saveCredentials(credentials: StoredCredentials): Promise<"native" | "file"> {
  const validated = parseCredentials(credentials, "Polymux credentials");
  const store = configuredStore();
  if (store !== "file") {
    try {
      await saveNative(validated);
      await rm(credentialsPath(), { force: true });
      return "native";
    } catch (error) {
      if (store === "native") throw new Error(`Native credential storage is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await saveFile(validated);
  return "file";
}

export async function loadCredentials(): Promise<StoredCredentials | undefined> {
  if (process.env.POLYMUX_TOKEN) {
    const accessToken = process.env.POLYMUX_TOKEN;
    if (!accessToken.startsWith("pmx_") || accessToken.length > 512) {
      throw new Error("POLYMUX_TOKEN is invalid");
    }
    return {
      formatVersion: 1,
      authUrl: normalizeServiceUrl(
        configValue<string>("auth.url"),
        "The Polymux authentication URL",
      ),
      apiUrl: normalizeServiceUrl(
        configValue<string>("api.url"),
        "The Polymux API URL",
      ),
      accessToken,
      tokenType: "Bearer",
      userId: process.env.POLYMUX_USER_ID ?? "environment",
      createdAt: "environment",
    };
  }
  const store = configuredStore();
  if (store !== "file") {
    try {
      const native = await loadNative();
      if (native) return native;
    } catch (error) {
      if (store === "native") throw new Error(`Native credential storage is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return store === "native" ? undefined : loadFile();
}

export async function deleteCredentials(): Promise<void> {
  if (process.env.POLYMUX_TOKEN) throw new Error("Credentials come from POLYMUX_TOKEN; unset that environment variable to log out");
  const store = configuredStore();
  if (store !== "file") await deleteNative();
  if (store !== "native") await rm(credentialsPath(), { force: true });
}
