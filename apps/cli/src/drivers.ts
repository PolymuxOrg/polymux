import { spawn } from "node:child_process";

export type ManagedDriverPlatform = "ios" | "android" | "macos" | "windows";
export type DriverAction = "install" | "uninstall";
export type DriverState = "installed" | "missing" | "unavailable" | "unknown";

interface DriverDefinition {
  platform: ManagedDriverPlatform;
  label: string;
  appiumName: string;
  installedNames: string[];
  hosts: NodeJS.Platform[];
}

export interface DriverSetupEntry {
  platform: ManagedDriverPlatform;
  label: string;
  appiumName: string;
  state: DriverState;
  installable: boolean;
  message: string;
  installCommand?: string;
  uninstallCommand?: string;
}

export interface DriverSetupReport {
  appiumInstalled: boolean;
  appiumVersion?: string;
  appiumInstallCommand: string;
  inspectionError?: string;
  drivers: DriverSetupEntry[];
  installAllCommand?: string;
  uninstallAllCommand?: string;
}

export interface DriverActionEntry {
  platform: ManagedDriverPlatform;
  label: string;
  appiumName: string;
  status: "changed" | "skipped";
  message: string;
}

export interface DriverActionReport {
  action: DriverAction;
  results: DriverActionEntry[];
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type DriverProcessRunner = (
  command: string,
  args: string[],
  options?: { passthrough?: boolean },
) => Promise<ProcessResult>;

export interface DriverInspectionOptions {
  host?: NodeJS.Platform;
  run?: DriverProcessRunner;
}

export interface DriverActionOptions extends DriverInspectionOptions {
  all?: boolean;
  passthrough?: boolean;
}

const appiumInstallCommand = "npm install --global appium";

const driverDefinitions: DriverDefinition[] = [
  {
    platform: "ios",
    label: "iOS and iPadOS (XCUITest)",
    appiumName: "xcuitest",
    installedNames: ["xcuitest", "appium-xcuitest-driver"],
    hosts: ["darwin"],
  },
  {
    platform: "android",
    label: "Android (UiAutomator2)",
    appiumName: "uiautomator2",
    installedNames: ["uiautomator2", "appium-uiautomator2-driver"],
    hosts: ["darwin", "linux", "win32"],
  },
  {
    platform: "macos",
    label: "macOS (Mac2)",
    appiumName: "mac2",
    installedNames: ["mac2", "appium-mac2-driver"],
    hosts: ["darwin"],
  },
  {
    platform: "windows",
    label: "Windows",
    appiumName: "windows",
    installedNames: [
      "windows",
      "novawindows",
      "appium-windows-driver",
      "appium-novawindows-driver",
    ],
    hosts: ["win32"],
  },
];

function hostLabel(host: NodeJS.Platform): string {
  if (host === "darwin") return "macOS";
  if (host === "win32") return "Windows";
  if (host === "linux") return "Linux";
  return host;
}

function appiumBinary(): string {
  return process.env.POLYMUX_APPIUM_BINARY?.trim() || "appium";
}

function runProcess(
  command: string,
  args: string[],
  options: { passthrough?: boolean } = {},
): Promise<ProcessResult> {
  return new Promise((resolveRun) => {
    const passthrough = options.passthrough === true;
    const child = spawn(command, args, {
      stdio: passthrough ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!passthrough) {
      child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    }
    child.once("error", (error) => {
      resolveRun({ code: 127, stdout, stderr: error.message });
    });
    child.once("close", (code) => {
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

function normalizedDriverName(value: string): string {
  return value.trim().toLowerCase().replace(/^@[^/]+\//, "");
}

function collectDriverNames(value: unknown, result: Set<string>): void {
  if (typeof value === "string") {
    result.add(normalizedDriverName(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectDriverNames(entry, result);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    result.add(normalizedDriverName(key));
    if (
      ["name", "shortName", "driverName", "packageName", "pkgName"].includes(
        key,
      )
    ) {
      collectDriverNames(entry, result);
    } else if (typeof entry === "object" && entry !== null) {
      collectDriverNames(entry, result);
    }
  }
}

export function parseInstalledAppiumDrivers(output: string): Set<string> {
  const objectStart = output.indexOf("{");
  const arrayStart = output.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (starts.length === 0) {
    throw new Error("Appium returned no JSON driver inventory");
  }
  const start = Math.min(...starts);
  const parsed = JSON.parse(output.slice(start)) as unknown;
  const names = new Set<string>();
  collectDriverNames(parsed, names);
  return names;
}

function installedName(
  definition: DriverDefinition,
  installed: ReadonlySet<string>,
): string | undefined {
  return definition.installedNames.find((name) =>
    installed.has(normalizedDriverName(name)),
  );
}

export function installableDriverPlatforms(
  host: NodeJS.Platform = process.platform,
): ManagedDriverPlatform[] {
  return driverDefinitions
    .filter((definition) => definition.hosts.includes(host))
    .map((definition) => definition.platform);
}

export async function inspectDriverSetup(
  options: DriverInspectionOptions = {},
): Promise<DriverSetupReport> {
  const host = options.host ?? process.platform;
  const run = options.run ?? runProcess;
  const versionResult = await run(appiumBinary(), ["--version"]);
  const appiumInstalled = versionResult.code === 0;
  let installed = new Set<string>();
  let inspectionError: string | undefined;

  if (appiumInstalled) {
    const listResult = await run(appiumBinary(), [
      "driver",
      "list",
      "--installed",
      "--json",
    ]);
    if (listResult.code === 0) {
      try {
        installed = parseInstalledAppiumDrivers(listResult.stdout);
      } catch (error) {
        inspectionError =
          error instanceof Error ? error.message : String(error);
      }
    } else {
      inspectionError =
        listResult.stderr.trim() ||
        listResult.stdout.trim() ||
        "Appium could not list installed drivers";
    }
  }

  const drivers = driverDefinitions.map((definition): DriverSetupEntry => {
    const installable = definition.hosts.includes(host);
    const currentName = installedName(definition, installed);
    if (!installable) {
      return {
        platform: definition.platform,
        label: definition.label,
        appiumName: definition.appiumName,
        state: "unavailable",
        installable: false,
        message: `Not installable on ${hostLabel(host)}`,
      };
    }
    if (!appiumInstalled) {
      return {
        platform: definition.platform,
        label: definition.label,
        appiumName: definition.appiumName,
        state: "missing",
        installable: true,
        message: "Appium is not installed",
        installCommand: `polymux driver install ${definition.platform}`,
      };
    }
    if (inspectionError) {
      return {
        platform: definition.platform,
        label: definition.label,
        appiumName: definition.appiumName,
        state: "unknown",
        installable: true,
        message: "Could not inspect installed Appium drivers",
        installCommand: `polymux driver install ${definition.platform}`,
      };
    }
    if (currentName) {
      return {
        platform: definition.platform,
        label: definition.label,
        appiumName: definition.appiumName,
        state: "installed",
        installable: true,
        message: `${currentName} is installed`,
        uninstallCommand: `polymux driver uninstall ${definition.platform}`,
      };
    }
    return {
      platform: definition.platform,
      label: definition.label,
      appiumName: definition.appiumName,
      state: "missing",
      installable: true,
      message: `${definition.appiumName} is not installed`,
      installCommand: `polymux driver install ${definition.platform}`,
    };
  });

  const installedCompatible = drivers.some(
    (driver) => driver.installable && driver.state === "installed",
  );
  return {
    appiumInstalled,
    ...(appiumInstalled && versionResult.stdout.trim()
      ? { appiumVersion: versionResult.stdout.trim() }
      : {}),
    appiumInstallCommand,
    ...(inspectionError ? { inspectionError } : {}),
    drivers,
    ...(drivers.some(
      (driver) => driver.installable && driver.state !== "installed",
    )
      ? { installAllCommand: "polymux driver install --all" }
      : {}),
    ...(installedCompatible
      ? { uninstallAllCommand: "polymux driver uninstall --all" }
      : {}),
  };
}

function definitionFor(value: string): DriverDefinition {
  const normalized = value.toLowerCase() === "ipados"
    ? "ios"
    : value.toLowerCase();
  const definition = driverDefinitions.find(
    (candidate) => candidate.platform === normalized,
  );
  if (definition) return definition;
  if (normalized === "web" || normalized === "linux") {
    throw new Error(
      `${normalized} uses a built-in Polymux adapter and has no Appium driver to manage`,
    );
  }
  throw new Error(
    `Unknown driver platform "${value}". Expected ios, android, macos, or windows`,
  );
}

export async function changeDrivers(
  action: DriverAction,
  values: string[],
  options: DriverActionOptions = {},
): Promise<DriverActionReport> {
  if (options.all && values.length > 0) {
    throw new Error("Pass platform names or --all, not both");
  }
  if (!options.all && values.length === 0) {
    throw new Error("Choose a platform or pass --all");
  }
  const host = options.host ?? process.platform;
  const run = options.run ?? runProcess;
  const requestedDefinitions = options.all
    ? undefined
    : values.map(definitionFor);
  const setup = await inspectDriverSetup({ host, run });
  if (!setup.appiumInstalled) {
    throw new Error(
      `Appium is not installed. Run \`${setup.appiumInstallCommand}\`, then retry.`,
    );
  }
  if (setup.inspectionError) {
    throw new Error(`Could not inspect Appium drivers: ${setup.inspectionError}`);
  }

  let definitions: DriverDefinition[];
  if (options.all) {
    definitions = action === "install"
      ? driverDefinitions.filter((definition) => definition.hosts.includes(host))
      : driverDefinitions.filter((definition) => {
          const entry = setup.drivers.find(
            (driver) => driver.platform === definition.platform,
          );
          return entry?.state === "installed";
        });
  } else {
    definitions = requestedDefinitions!;
  }

  definitions = definitions.filter(
    (definition, index, all) =>
      all.findIndex((candidate) => candidate.platform === definition.platform) ===
      index,
  );

  if (definitions.length === 0) {
    return {
      action,
      results: [],
    };
  }

  const results: DriverActionEntry[] = [];
  for (const definition of definitions) {
    const setupEntry = setup.drivers.find(
      (driver) => driver.platform === definition.platform,
    )!;
    if (action === "install" && !setupEntry.installable) {
      throw new Error(
        `${definition.label} is not installable on ${hostLabel(host)}`,
      );
    }
    if (
      (action === "install" && setupEntry.state === "installed") ||
      (action === "uninstall" && setupEntry.state !== "installed")
    ) {
      results.push({
        platform: definition.platform,
        label: definition.label,
        appiumName: definition.appiumName,
        status: "skipped",
        message:
          action === "install"
            ? `${definition.label} is already installed`
            : `${definition.label} is not installed`,
      });
      continue;
    }

    const installedDriver = definition.installedNames.find((name) =>
      setupEntry.message.toLowerCase() === `${name.toLowerCase()} is installed`,
    );
    const driverName =
      action === "uninstall" && installedDriver
        ? installedDriver
        : definition.appiumName;
    const result = await run(
      appiumBinary(),
      ["driver", action, driverName],
      { passthrough: options.passthrough ?? true },
    );
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          `${action} failed for ${definition.label} with exit code ${result.code}`,
      );
    }
    results.push({
      platform: definition.platform,
      label: definition.label,
      appiumName: driverName,
      status: "changed",
      message:
        action === "install"
          ? `Installed ${definition.label}`
          : `Uninstalled ${definition.label}`,
    });
  }

  return { action, results };
}
