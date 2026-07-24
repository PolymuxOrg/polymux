import { describe, expect, it } from "vitest";
import { WebDriver } from "@polymux/adapter-web";
import { capabilities } from "@polymux/protocol";

describe("Playwright web driver manifest", () => {
  it("publishes its exact supported capabilities", () => {
    const driver = new WebDriver();

    expect(driver.capabilities.has(capabilities.activate)).toBe(true);
    expect(driver.capabilities.has(capabilities.focus)).toBe(true);
    expect(driver.capabilities.has(capabilities.stabilize)).toBe(true);
    expect(driver.capabilities.has(capabilities.clock)).toBe(true);
    expect(driver.capabilities.has(capabilities.visual)).toBe(true);
    expect(driver.capabilities.has(capabilities.multiTouch)).toBe(true);
    expect(
      new WebDriver({ browser: "firefox" }).capabilities.has(
        capabilities.multiTouch,
      ),
    ).toBe(false);
  });
});
