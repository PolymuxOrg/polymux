import { createServer } from "node:http";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppiumDriver, type AppiumPlatform } from "@polymux/adapter-appium";
import { compileSingleActorFlow, executeSingleActorFlow } from "@polymux/core";
import { capabilities } from "@polymux/protocol";
import { describe, expect, it } from "vitest";

const automationNames: Record<AppiumPlatform, string> = {
  ios: "XCUITest",
  ipados: "XCUITest",
  android: "UiAutomator2",
  macos: "Mac2",
  windows: "Windows",
  linux: "AtSpi2",
};

const platformNames: Record<AppiumPlatform, string> = {
  ios: "iOS",
  ipados: "iOS",
  android: "Android",
  macos: "Mac",
  windows: "Windows",
  linux: "linux",
};

const appCapabilityNames: Record<AppiumPlatform, string> = {
  ios: "appium:bundleId",
  ipados: "appium:bundleId",
  android: "appium:appPackage",
  macos: "appium:bundleId",
  windows: "appium:app",
  linux: "appium:appName",
};

describe("Appium native driver", () => {
  it("publishes exact Linux and mobile capability boundaries", () => {
    const linux = new AppiumDriver({ platform: "linux" });
    const android = new AppiumDriver({ platform: "android" });
    expect(linux.capabilities.has(capabilities.swipe)).toBe(true);
    expect(linux.capabilities.has(capabilities.pointer)).toBe(false);
    expect(linux.capabilities.has(capabilities.multiTouch)).toBe(false);
    expect(linux.capabilities.has(capabilities.navigate)).toBe(false);
    expect(linux.capabilities.has(capabilities.focus)).toBe(false);
    expect(android.capabilities.has(capabilities.pointer)).toBe(true);
    expect(android.capabilities.has(capabilities.multiTouch)).toBe(true);
    expect(android.capabilities.has(capabilities.focus)).toBe(false);
    expect(() => new AppiumDriver({ platform: "linux", video: true })).toThrow(
      "Video recording is not supported by the linux Appium backend",
    );
  });

  it.each(Object.entries(automationNames) as Array<[AppiumPlatform, string]>) (
    "runs a portable %s flow through the %s backend",
    async (platform, expectedAutomationName) => {
      const requests: Array<{ method: string; url: string; body: unknown }> = [];
      const server = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = raw ? JSON.parse(raw) : undefined;
        requests.push({ method: request.method ?? "", url: request.url ?? "", body });
        response.writeHead(200, { "content-type": "application/json" });
        if (request.url === "/session") {
          response.end(JSON.stringify({ value: { sessionId: "native-session", capabilities: {} } }));
        } else if (request.url?.endsWith("/element")) {
          response.end(JSON.stringify({ value: { "element-6066-11e4-a52e-4f735466cecf": "element-1" } }));
        } else if (request.url?.endsWith("/displayed")) {
          response.end(JSON.stringify({ value: true }));
        } else if (request.url?.endsWith("/attribute/states")) {
          response.end(JSON.stringify({ value: "[ENABLED,SENSITIVE,SHOWING,VISIBLE]" }));
        } else if (request.url?.endsWith("/screenshot")) {
          response.end(JSON.stringify({ value: Buffer.from("evidence").toString("base64") }));
        } else {
          response.end(JSON.stringify({ value: null }));
        }
      });
      await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No Appium test port");
      const projectDir = await mkdtemp(join(tmpdir(), `polymux-${platform}-`));
      try {
        const plan = compileSingleActorFlow(
          {
            version: 1,
            name: `${platform} checkout`,
            platforms: [platform],
            steps: [
              { launch: "com.example.checkout" },
              ...(platform === "linux" ? [] : [{ deepLink: "example://checkout" } as const]),
              { activate: { accessibilityId: "pay" } },
              { expect: { target: { accessibilityId: "confirmation" }, state: "visible" } },
              { platform: { on: platform, command: platform === "linux" ? "getDisplaySize" : "inspect", args: { ready: true } } },
              { screenshot: "native-result" },
            ],
          },
          join(projectDir, "polymux/native.flow.yaml"),
        );
        const result = await executeSingleActorFlow(
          plan,
          new AppiumDriver({
            platform,
            serverUrl: `http://127.0.0.1:${address.port}`,
          }),
          { projectDir },
        );

        expect(result.status).toBe("passed");
        expect(requests[0]?.body).toMatchObject({
          capabilities: {
            alwaysMatch: {
              platformName: platformNames[platform],
              "appium:automationName": expectedAutomationName,
              [appCapabilityNames[platform]]: "com.example.checkout",
            },
          },
        });
        expect(requests).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              url: "/session/native-session/element",
              body: { using: "accessibility id", value: "pay" },
            }),
            expect.objectContaining({
              method: "DELETE",
              url: "/session/native-session",
            }),
          ]),
        );
        const scripts = requests
          .filter((request) => request.url.endsWith("/execute/sync"))
          .map((request) => (request.body as { script: string }).script);
        const expectedExtension = platform === "macos"
          ? "macos: inspect"
          : platform === "ios" || platform === "ipados" || platform === "android"
            ? "mobile: inspect"
            : platform === "linux" ? "linux: getDisplaySize" : "inspect";
        expect(scripts).toContain(expectedExtension);
      } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
    },
  );

  it("maps the portable interaction, evidence, request, video, and extension surface", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8xLvwAAAABJRU5ErkJggg==";
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: request.method ?? "", url: request.url ?? "", body });
      response.writeHead(200, { "content-type": "application/json" });
      const url = request.url ?? "";
      if (url === "/api/state") response.end(JSON.stringify({ ready: true, nested: { count: 2 } }));
      else if (url === "/session") response.end(JSON.stringify({ value: { sessionId: "complete-session", capabilities: {} } }));
      else if (url.endsWith("/elements")) response.end(JSON.stringify({ value: [{ "element-6066-11e4-a52e-4f735466cecf": "element-1" }] }));
      else if (url.endsWith("/element")) response.end(JSON.stringify({ value: { "element-6066-11e4-a52e-4f735466cecf": "element-1" } }));
      else if (url.endsWith("/window/rect")) response.end(JSON.stringify({ value: { x: 0, y: 0, width: 800, height: 600 } }));
      else if (url.endsWith("/rect")) response.end(JSON.stringify({ value: { x: 100, y: 100, width: 80, height: 40 } }));
      else if (url.endsWith("/displayed") || url.endsWith("/enabled")) response.end(JSON.stringify({ value: true }));
      else if (url.endsWith("/text")) response.end(JSON.stringify({ value: "ready" }));
      else if (url.endsWith("/attribute/value")) response.end(JSON.stringify({ value: "42" }));
      else if (url.endsWith("/screenshot")) response.end(JSON.stringify({ value: png }));
      else if (url.endsWith("/appium/stop_recording_screen")) response.end(JSON.stringify({ value: Buffer.from("video").toString("base64") }));
      else response.end(JSON.stringify({ value: null }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No Appium test port");
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-appium-complete-"));
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const plan = compileSingleActorFlow({
        version: 1,
        name: "complete native surface",
        platforms: ["android"],
        baseUrl,
        steps: [
          { launch: { app: "example.app", clearState: true } },
          { navigate: "app://home" },
          { deepLink: "app://checkout" },
          { activate: { accessibilityId: "pay" } },
          { enter: { target: { accessibilityId: "name" }, value: "Ada" } },
          { select: { target: { accessibilityId: "country" }, value: "Singapore" } },
          { clear: { accessibilityId: "name" } },
          { key: "Enter" },
          { pointer: { x: 10, y: 20 } },
          { scroll: { target: { accessibilityId: "list" }, y: 200 } },
          { swipe: { direction: "left", distance: 100 } },
          { drag: { from: { accessibilityId: "card" }, to: { accessibilityId: "lane" } } },
          { multiTouch: { gesture: "pinch-in", points: [{ x: 10, y: 10 }, { x: 100, y: 100 }], durationMs: 1 } },
          { wait: { target: { accessibilityId: "result" }, state: "visible" } },
          { expect: { target: { accessibilityId: "result" }, state: "enabled", text: "ready", value: "42", count: 1 } },
          { screenshot: { name: "result", target: { accessibilityId: "result" } } },
          { request: { method: "GET", url: "/api/state", expect: { status: 200, json: { ready: true } } } },
          { stabilize: { timeoutMs: 500, intervalMs: 1 } },
          { visual: { name: "native-result" } },
          { platform: { on: "android", command: "example", args: { enabled: true } } },
          { terminate: "example.app" },
        ],
      }, join(projectDir, "polymux/native.flow.yaml"));
      const result = await executeSingleActorFlow(plan, new AppiumDriver({
        platform: "android",
        serverUrl: baseUrl,
        video: true,
      }), { projectDir, updateSnapshots: true });

      expect(result.status).toBe("passed");
      expect(result.artifacts).toContain("video.mp4");
      await expect(access(join(result.artifactsDir, "video.mp4"))).resolves.toBeUndefined();
      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ url: "/session/complete-session/actions" }),
        expect.objectContaining({ url: "/session/complete-session/execute/sync", body: { script: "mobile: example", args: [{ enabled: true }] } }),
        expect.objectContaining({ url: "/api/state" }),
      ]));
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
