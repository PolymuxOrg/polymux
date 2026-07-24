import { capabilities } from "@polymux/protocol";
import { inspectLinuxDriver, LinuxDriver } from "@polymux/adapter-linux";
import { describe, expect, it } from "vitest";

describe("native Linux driver", () => {
  it("publishes the direct desktop capability boundary", () => {
    const driver = new LinuxDriver();
    expect(driver.id).toBe("linux.atspi");
    expect(driver.capabilities.has(capabilities.launch)).toBe(true);
    expect(driver.capabilities.has(capabilities.pointer)).toBe(true);
    expect(driver.capabilities.has(capabilities.multiTouch)).toBe(false);
    expect(driver.capabilities.has(capabilities.navigate)).toBe(false);
    expect(() => new LinuxDriver({ video: true })).toThrow(
      "Video recording is not supported by the native Linux backend",
    );
  });

  it.runIf(process.platform !== "linux")("reports when Linux is not the current host", async () => {
    await expect(inspectLinuxDriver()).resolves.toMatchObject({
      available: false,
      message: "The native Linux backend must run on Linux",
    });
  });

  it.runIf(process.platform === "linux")("reports AT-SPI desktop availability", async () => {
    const inspection = await inspectLinuxDriver();
    expect(inspection.available).toEqual(expect.any(Boolean));
    if (inspection.available) {
      expect(inspection.message).toContain(
        "AT-SPI desktop accessibility is available",
      );
    } else {
      expect(inspection.message.length).toBeGreaterThan(0);
      expect(inspection.remedy).toContain("gir1.2-atspi-2.0");
    }
  });
});
