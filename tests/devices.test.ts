import { describe, expect, it } from "vitest";
import {
  parseAdbDevices,
  parseSimctlDevices,
  parseXctraceDevices,
  targetCapabilities,
} from "../apps/cli/src/devices.js";

describe("local device discovery", () => {
  it("parses Android hardware and emulator state", () => {
    const devices = parseAdbDevices([
      "List of devices attached",
      "emulator-5554 device product:sdk model:Pixel_9 transport_id:1",
      "R58M123 unauthorized usb:1-1 model:Galaxy_S24 transport_id:2",
      "",
    ].join("\n"));
    expect(devices).toMatchObject([
      {
        id: "emulator-5554",
        name: "Pixel 9",
        kind: "emulator",
        available: true,
      },
      {
        id: "R58M123",
        name: "Galaxy S24",
        kind: "physical",
        available: false,
      },
    ]);
  });

  it("parses available Apple simulators and physical devices", () => {
    const simulators = parseSimctlDevices({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [{
          udid: "SIM-1",
          name: "iPhone 16 Pro",
          state: "Shutdown",
          isAvailable: true,
        }],
      },
    });
    expect(simulators[0]).toMatchObject({
      id: "SIM-1",
      platform: "ios",
      kind: "simulator",
      osVersion: "18.2",
    });

    const physical = parseXctraceDevices([
      "== Devices ==",
      "Test iPhone (18.2) (00008120-001234567890001E)",
      "Test MacBook Pro (15.5) (ABCDEF12-1234-1234-1234-ABCDEF123456)",
      "== Simulators ==",
      "iPhone 16 Pro Simulator (18.2) (SIM-1)",
    ].join("\n"));
    expect(physical).toHaveLength(1);
    expect(physical[0]).toMatchObject({
      id: "00008120-001234567890001E",
      kind: "physical",
      available: true,
    });
    expect(targetCapabilities(physical[0]!)).toEqual({
      "appium:udid": "00008120-001234567890001E",
    });
  });
});
