import { describe, expect, it } from "vitest";
import {
  changeDrivers,
  inspectDriverSetup,
  parseInstalledAppiumDrivers,
  type DriverProcessRunner,
} from "../apps/cli/dist/drivers.js";

function runner(
  installed: Record<string, unknown> | undefined,
  commands: string[][] = [],
): DriverProcessRunner {
  return async (_command, args) => {
    commands.push(args);
    if (args[0] === "--version") {
      return installed === undefined
        ? { code: 127, stdout: "", stderr: "appium not found" }
        : { code: 0, stdout: "3.2.0\n", stderr: "" };
    }
    if (args.join(" ") === "driver list --installed --json") {
      return {
        code: 0,
        stdout: JSON.stringify(installed),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("Appium driver setup", () => {
  it("parses Appium JSON inventories by short and package name", () => {
    const parsed = parseInstalledAppiumDrivers(
      JSON.stringify({
        xcuitest: {
          pkgName: "appium-xcuitest-driver",
          version: "10.0.0",
        },
        android: {
          shortName: "uiautomator2",
          packageName: "appium-uiautomator2-driver",
        },
      }),
    );
    expect(parsed.has("xcuitest")).toBe(true);
    expect(parsed.has("appium-xcuitest-driver")).toBe(true);
    expect(parsed.has("uiautomator2")).toBe(true);
  });

  it("reports installed, missing, and unavailable drivers for the host", async () => {
    const report = await inspectDriverSetup({
      host: "darwin",
      run: runner({
        xcuitest: { pkgName: "appium-xcuitest-driver" },
        uiautomator2: { pkgName: "appium-uiautomator2-driver" },
      }),
    });

    expect(report).toMatchObject({
      appiumInstalled: true,
      appiumVersion: "3.2.0",
      installAllCommand: "polymux driver install --all",
      uninstallAllCommand: "polymux driver uninstall --all",
      drivers: [
        expect.objectContaining({ platform: "ios", state: "installed" }),
        expect.objectContaining({ platform: "android", state: "installed" }),
        expect.objectContaining({
          platform: "macos",
          state: "missing",
          installCommand: "polymux driver install macos",
        }),
        expect.objectContaining({
          platform: "windows",
          state: "unavailable",
        }),
      ],
    });
  });

  it("reports the Appium prerequisite without mutating the machine", async () => {
    const report = await inspectDriverSetup({
      host: "linux",
      run: runner(undefined),
    });

    expect(report).toMatchObject({
      appiumInstalled: false,
      appiumInstallCommand: "npm install --global appium",
      installAllCommand: "polymux driver install --all",
      drivers: expect.arrayContaining([
        expect.objectContaining({
          platform: "android",
          state: "missing",
          installable: true,
        }),
        expect.objectContaining({
          platform: "ios",
          state: "unavailable",
        }),
      ]),
    });
  });

  it("installs every missing driver compatible with the current host", async () => {
    const commands: string[][] = [];
    const report = await changeDrivers("install", [], {
      all: true,
      host: "darwin",
      run: runner(
        { xcuitest: { pkgName: "appium-xcuitest-driver" } },
        commands,
      ),
    });

    expect(report.results).toEqual([
      expect.objectContaining({ platform: "ios", status: "skipped" }),
      expect.objectContaining({ platform: "android", status: "changed" }),
      expect.objectContaining({ platform: "macos", status: "changed" }),
    ]);
    expect(commands).toContainEqual(["driver", "install", "uiautomator2"]);
    expect(commands).toContainEqual(["driver", "install", "mac2"]);
    expect(commands).not.toContainEqual(["driver", "install", "windows"]);
  });

  it("uninstalls the installed Windows backend by its actual name", async () => {
    const commands: string[][] = [];
    const report = await changeDrivers("uninstall", ["windows"], {
      host: "win32",
      run: runner(
        {
          novawindows: {
            pkgName: "appium-novawindows-driver",
          },
        },
        commands,
      ),
    });

    expect(report.results).toEqual([
      expect.objectContaining({
        platform: "windows",
        appiumName: "novawindows",
        status: "changed",
      }),
    ]);
    expect(commands).toContainEqual(["driver", "uninstall", "novawindows"]);
  });

  it("captures nested Appium output for machine-readable callers", async () => {
    const invocations: Array<{
      args: string[];
      options?: { passthrough?: boolean };
    }> = [];
    const run: DriverProcessRunner = async (_command, args, options) => {
      invocations.push({ args, options });
      if (args[0] === "--version") {
        return { code: 0, stdout: "3.2.0\n", stderr: "" };
      }
      if (args.join(" ") === "driver list --installed --json") {
        return { code: 0, stdout: "{}", stderr: "" };
      }
      return { code: 0, stdout: "Appium human output\n", stderr: "" };
    };

    await changeDrivers("install", ["android"], {
      host: "linux",
      run,
      passthrough: false,
    });

    expect(invocations).toContainEqual({
      args: ["driver", "install", "uiautomator2"],
      options: { passthrough: false },
    });
  });
});
