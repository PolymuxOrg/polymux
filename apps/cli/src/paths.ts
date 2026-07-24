import { homedir, platform } from "node:os";
import { join } from "node:path";

export function configDirectory(): string {
  if (process.env.POLYMUX_CONFIG_DIR) return process.env.POLYMUX_CONFIG_DIR;
  if (platform() === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "Polymux");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "polymux");
}

export function configPath(): string {
  return join(configDirectory(), "config.json");
}

export function credentialsPath(): string {
  return join(configDirectory(), "credentials.json");
}

