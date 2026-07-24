import { describe, expect, it } from "vitest";
import { detectInstallation, installInvocation, isNewerVersion, updateInvocation } from "../apps/cli/src/update.js";

describe("CLI updates", () => {
  it("compares stable and prerelease semantic versions", () => {
    expect(isNewerVersion("1.2.4", "1.2.3")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
    expect(isNewerVersion("1.2.3", "1.2.3-rc.1")).toBe(true);
    expect(isNewerVersion("1.2.3-rc.2", "1.2.3-rc.1")).toBe(true);
  });

  it("builds global install commands without a shell", () => {
    expect(installInvocation("npm", "1.2.3")).toEqual({
      command: "npm",
      args: ["install", "--global", "polymux@1.2.3"],
    });
    expect(installInvocation("pnpm", "1.2.3").command).toBe("pnpm");
    expect(installInvocation("yarn", "1.2.3").args).toEqual(["global", "add", "polymux@1.2.3"]);
    expect(installInvocation("bun", "1.2.3").command).toBe("bun");
  });

  it("distinguishes global, local, ephemeral, and Homebrew installations", () => {
    expect(detectInstallation("/usr/local/lib/node_modules/polymux/dist/index.js").kind).toBe("global");
    expect(detectInstallation("/work/app/node_modules/polymux/dist/index.js").kind).toBe("local");
    expect(detectInstallation("C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\polymux\\dist\\index.js").kind).toBe("global");
    expect(detectInstallation("/home/user/.npm/_npx/abc/node_modules/polymux/dist/index.js").kind).toBe("ephemeral");
    expect(detectInstallation("/opt/homebrew/Cellar/polymux/1.2.3/bin/polymux").kind).toBe("homebrew");
  });

  it("updates the detected installation in place", () => {
    expect(updateInvocation({ kind: "local", packageManager: "pnpm", executable: "x", reason: "test" }, "1.2.3")).toEqual({
      command: "pnpm", args: ["add", "--save-dev", "polymux@1.2.3"],
    });
    expect(updateInvocation({ kind: "homebrew", executable: "x", reason: "test" }, "1.2.3")).toEqual({ command: "brew", args: ["upgrade", "polymux"] });
    expect(updateInvocation({ kind: "ephemeral", executable: "x", reason: "test" }, "1.2.3")).toBeUndefined();
  });
});
