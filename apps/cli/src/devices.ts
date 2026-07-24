import { execFile } from "node:child_process";
import { hostname } from "node:os";
import type { JsonValue, Platform } from "@polymux/protocol";

export interface LocalDevice {
  id: string;
  name: string;
  platform: Exclude<Platform, "web">;
  kind: "physical" | "simulator" | "emulator" | "desktop";
  state: string;
  available: boolean;
  backend: string;
  osVersion?: string;
}

export interface DeviceDiscovery {
  devices: LocalDevice[];
  warnings: string[];
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) rejectOutput(error);
        else resolveOutput(stdout);
      },
    );
  });
}

function runtimeVersion(runtime: string): string | undefined {
  const match = runtime.match(/SimRuntime\.[A-Za-z]+-(.+)$/);
  return match?.[1]?.replaceAll("-", ".");
}

export function parseSimctlDevices(value: unknown): LocalDevice[] {
  if (!value || typeof value !== "object" || !("devices" in value)) return [];
  const groups = (value as { devices?: unknown }).devices;
  if (!groups || typeof groups !== "object") return [];
  const devices: LocalDevice[] = [];
  for (const [runtime, entries] of Object.entries(groups)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.udid !== "string" ||
        typeof candidate.name !== "string"
      ) continue;
      const available = candidate.isAvailable !== false;
      const osVersion = runtimeVersion(runtime);
      devices.push({
        id: candidate.udid,
        name: candidate.name,
        platform: candidate.name.toLowerCase().includes("ipad")
          ? "ipados"
          : "ios",
        kind: "simulator",
        state:
          typeof candidate.state === "string"
            ? candidate.state.toLowerCase()
            : "unknown",
        available,
        backend: "appium-xcuitest",
        ...(osVersion ? { osVersion } : {}),
      });
    }
  }
  return devices;
}

export function parseXctraceDevices(output: string): LocalDevice[] {
  const devices: LocalDevice[] = [];
  let physical = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "== Devices ==") {
      physical = true;
      continue;
    }
    if (line.startsWith("== ")) {
      physical = false;
      continue;
    }
    if (!physical || !line || /\bMac/i.test(line)) continue;
    const match = line.match(/^(.+?) \(([^()]+)\) \(([A-Fa-f0-9-]{8,})\)$/);
    if (!match) continue;
    const [, name, osVersion, id] = match;
    if (!name || !osVersion || !id) continue;
    devices.push({
      id,
      name,
      platform: name.toLowerCase().includes("ipad") ? "ipados" : "ios",
      kind: "physical",
      state: "connected",
      available: true,
      backend: "appium-xcuitest",
      osVersion,
    });
  }
  return devices;
}

export function parseAdbDevices(output: string): LocalDevice[] {
  const devices: LocalDevice[] = [];
  for (const raw of output.split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const [id, state, ...details] = line.split(/\s+/);
    if (!id || !state) continue;
    const model = details
      .find((part) => part.startsWith("model:"))
      ?.slice("model:".length)
      .replaceAll("_", " ");
    devices.push({
      id,
      name: model || id,
      platform: "android",
      kind: id.startsWith("emulator-") ? "emulator" : "physical",
      state,
      available: state === "device",
      backend: "appium-uiautomator2",
    });
  }
  return devices;
}

function desktopDevice(): LocalDevice | undefined {
  if (process.platform === "darwin") {
    return {
      id: "local-macos",
      name: hostname(),
      platform: "macos",
      kind: "desktop",
      state: "available",
      available: true,
      backend: "appium-mac2",
    };
  }
  if (process.platform === "win32") {
    return {
      id: "local-windows",
      name: hostname(),
      platform: "windows",
      kind: "desktop",
      state: "available",
      available: true,
      backend: "appium-windows",
    };
  }
  if (process.platform === "linux") {
    return {
      id: "local-linux",
      name: hostname(),
      platform: "linux",
      kind: "desktop",
      state: process.env.DISPLAY || process.env.WAYLAND_DISPLAY
        ? "available"
        : "no-display",
      available: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
      backend: "direct-at-spi",
    };
  }
  return undefined;
}

export async function discoverLocalDevices(
  platform?: Exclude<Platform, "web">,
): Promise<DeviceDiscovery> {
  const devices: LocalDevice[] = [];
  const warnings: string[] = [];
  const desktop = desktopDevice();
  if (desktop && (!platform || platform === desktop.platform)) {
    devices.push(desktop);
  }

  if (
    process.platform === "darwin" &&
    (!platform || platform === "ios" || platform === "ipados")
  ) {
    try {
      const raw = await capture("xcrun", [
        "simctl",
        "list",
        "devices",
        "available",
        "--json",
      ]);
      devices.push(...parseSimctlDevices(JSON.parse(raw)));
    } catch {
      warnings.push("Xcode simulator discovery is unavailable");
    }
    try {
      devices.push(
        ...parseXctraceDevices(
          await capture("xcrun", ["xctrace", "list", "devices"]),
        ),
      );
    } catch {
      warnings.push("Xcode physical-device discovery is unavailable");
    }
  }

  if (!platform || platform === "android") {
    try {
      devices.push(...parseAdbDevices(await capture("adb", ["devices", "-l"])));
    } catch {
      warnings.push("Android device discovery is unavailable; install ADB");
    }
  }

  const unique = devices.filter(
    (device, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.id === device.id && candidate.platform === device.platform,
      ) === index,
  );
  return {
    devices: unique
      .filter((device) => !platform || device.platform === platform)
      .sort((left, right) =>
        `${left.platform}:${left.name}`.localeCompare(
          `${right.platform}:${right.name}`,
        ),
      ),
    warnings: [...new Set(warnings)],
  };
}

export function targetCapabilities(
  device: LocalDevice,
): Record<string, JsonValue> {
  return device.kind === "desktop" ? {} : { "appium:udid": device.id };
}

export function printDevices(result: DeviceDiscovery): void {
  if (result.devices.length === 0) {
    process.stdout.write("No local devices found.\n");
  } else {
    for (const device of result.devices) {
      process.stdout.write(
        `${device.id}  ${device.platform.padEnd(8)}  ${device.kind.padEnd(9)}  ${device.state.padEnd(12)}  ${device.name}${device.osVersion ? ` (${device.osVersion})` : ""}\n`,
      );
    }
  }
  for (const warning of result.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }
}
