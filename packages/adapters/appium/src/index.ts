import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  RuntimeFailure,
  FlowFailure,
  executableSteps,
  type Driver,
  type DriverExecutionResult,
  type DriverSession,
  type DriverSessionContext,
} from "@polymux/core";
import {
  capabilities,
  type Capability,
  type CompiledStep,
  type CompiledTarget,
  type JsonValue,
  type LocatorStrategy,
  type Platform,
} from "@polymux/protocol";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export type AppiumPlatform = Exclude<Platform, "web">;

export interface AppiumDriverOptions {
  platform: AppiumPlatform;
  serverUrl?: string;
  capabilities?: Record<string, JsonValue>;
  video?: boolean;
}

interface FoundElement {
  id: string;
  strategy: LocatorStrategy;
}

interface Point {
  x: number;
  y: number;
}

const elementKey = "element-6066-11e4-a52e-4f735466cecf";

class AppiumCommandFailure extends RuntimeFailure {
  constructor(readonly code: string | undefined, message: string) {
    super(message);
  }
}

function input<T>(step: CompiledStep, key: string): T {
  return step.input[key] as T;
}

function automationName(platform: AppiumPlatform): string {
  if (platform === "ios" || platform === "ipados") return "XCUITest";
  if (platform === "android") return "UiAutomator2";
  if (platform === "macos") return "Mac2";
  if (platform === "windows") return "Windows";
  return "AtSpi2";
}

function appiumPlatformName(platform: AppiumPlatform): string {
  if (platform === "ios" || platform === "ipados") return "iOS";
  if (platform === "android") return "Android";
  if (platform === "macos") return "Mac";
  if (platform === "windows") return "Windows";
  return "linux";
}

function looksLikeAppPath(app: string, extensions: string[]): boolean {
  return /^(?:[a-z]+:\/\/|\.?[\\/]|[A-Za-z]:[\\/])/.test(app) || extensions.some((extension) => app.toLowerCase().endsWith(`.${extension}`));
}

function appCapabilities(platform: AppiumPlatform, app?: string): Record<string, string> {
  if (!app) return {};
  if (platform === "linux") return { "appium:appName": app };
  if (platform === "macos") return looksLikeAppPath(app, ["app"]) ? { "appium:appPath": app } : { "appium:bundleId": app };
  if (platform === "ios" || platform === "ipados") return looksLikeAppPath(app, ["app", "ipa", "zip"]) ? { "appium:app": app } : { "appium:bundleId": app };
  if (platform === "android") return looksLikeAppPath(app, ["apk", "zip"]) ? { "appium:app": app } : { "appium:appPackage": app };
  return { "appium:app": app };
}

function extensionScript(platform: AppiumPlatform, command: string): string {
  if (platform === "ios" || platform === "ipados" || platform === "android") return `mobile: ${command}`;
  if (platform === "macos") return `macos: ${command}`;
  if (platform === "linux") return `linux: ${command}`;
  return command;
}

function linuxKey(value: string): { keycode: number; metastate: number } {
  const modifiers: Record<string, number> = { shift: 1, control: 4, alt: 8, meta: 64 };
  const codes: Record<string, number> = {
    backspace: 65288,
    tab: 65289,
    enter: 65293,
    return: 65293,
    escape: 65307,
    home: 65360,
    left: 65361,
    up: 65362,
    right: 65363,
    down: 65364,
    pageup: 65365,
    pagedown: 65366,
    end: 65367,
    delete: 65535,
  };
  const parts = value.split("+");
  const key = parts.pop()?.toLowerCase() ?? "";
  const metastate = parts.reduce((total, modifier) => total | (modifiers[modifier.toLowerCase()] ?? 0), 0);
  if (key.length === 1) return { keycode: -key.charCodeAt(0), metastate };
  if (/^f(?:[1-9]|1[0-3])$/.test(key)) return { keycode: 65469 + Number(key.slice(1)), metastate };
  const keycode = codes[key];
  if (keycode === undefined) throw new FlowFailure(`Linux does not recognize key "${value}"`);
  return { keycode, metastate };
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "artifact";
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map((part, index) => `${index ? `,"'",` : ""}'${part}'`).join("")})`;
}

function resolveUrl(value: string, baseUrl?: string): string {
  try {
    return new URL(value).toString();
  } catch {
    if (!baseUrl) throw new FlowFailure(`Relative URL requires a base URL: ${value}`);
    return new URL(value, baseUrl).toString();
  }
}

function matchesSubset(actual: unknown, expected: JsonValue): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((item, index) => matchesSubset(actual[index], item));
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => matchesSubset((actual as Record<string, unknown>)[key], value));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function pause(durationMs: number): Promise<void> {
  await new Promise((resolvePause) => setTimeout(resolvePause, durationMs));
}

class AppiumSession implements DriverSession {
  private constructor(
    private readonly context: DriverSessionContext,
    private readonly options: AppiumDriverOptions,
    private readonly serverUrl: string,
    private readonly sessionId: string,
  ) {}

  static async create(context: DriverSessionContext, options: AppiumDriverOptions): Promise<AppiumSession> {
    const serverUrl = (options.serverUrl ?? "http://127.0.0.1:4723").replace(/\/$/, "");
    const launch = executableSteps(context.plan).find((step) => step.kind === "launch");
    const app = launch?.input.app as string | undefined;
    const clearState = launch?.input.clearState as boolean | undefined;
    const alwaysMatch = {
      platformName: appiumPlatformName(options.platform),
      "appium:automationName": automationName(options.platform),
      ...appCapabilities(options.platform, app),
      ...(clearState ? { "appium:noReset": false, "appium:fullReset": true } : {}),
      ...options.capabilities,
    };
    const response = await AppiumSession.send(serverUrl, "POST", "/session", {
      capabilities: { alwaysMatch, firstMatch: [{}] },
    });
    const value = response.value as Record<string, unknown> | undefined;
    const sessionId = (value?.sessionId as string | undefined) ?? (response.sessionId as string | undefined);
    if (!sessionId) throw new RuntimeFailure("Appium did not return a session ID");
    const session = new AppiumSession(context, options, serverUrl, sessionId);
    if (options.video) {
      if (options.platform === "macos") {
        await session.send("POST", "/execute/sync", { script: "macos: startRecordingScreen", args: [{}] });
      } else {
        await session.send("POST", "/appium/start_recording_screen", {});
      }
    }
    return session;
  }

  private static async send(serverUrl: string, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${serverUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new RuntimeFailure(`Could not connect to Appium at ${serverUrl}`, { cause: error });
    }
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new RuntimeFailure(`Appium returned invalid JSON for ${method} ${path}`);
    }
    if (!response.ok || (payload.value as { error?: string } | undefined)?.error) {
      const value = payload.value as { error?: string; message?: string } | undefined;
      throw new AppiumCommandFailure(value?.error, value?.message ?? `Appium ${method} ${path} failed`);
    }
    return payload;
  }

  private send(method: string, path: string, body?: unknown) {
    return AppiumSession.send(this.serverUrl, method, `/session/${this.sessionId}${path}`, body);
  }

  private async locator(strategy: LocatorStrategy): Promise<{ using: string; value: string } | undefined> {
    if (strategy.kind === "accessibilityId" || strategy.kind === "testId") {
      return { using: "accessibility id", value: strategy.value };
    }
    if (strategy.kind === "id") return { using: "id", value: strategy.value };
    if (strategy.kind === "image") {
      const path = resolve(dirname(this.context.plan.sourcePath), strategy.value);
      return { using: "-image", value: (await readFile(path)).toString("base64") };
    }
    if (strategy.kind === "role") {
      const name = strategy.name ? ` and (@name=${xpathLiteral(strategy.name)} or @label=${xpathLiteral(strategy.name)})` : "";
      return { using: "xpath", value: `//*[@type=${xpathLiteral(strategy.role)}${name}]` };
    }
    if (strategy.kind === "label" || strategy.kind === "text") {
      return { using: "xpath", value: `//*[@name=${xpathLiteral(strategy.value)} or @label=${xpathLiteral(strategy.value)} or @text=${xpathLiteral(strategy.value)}]` };
    }
    return undefined;
  }

  private elementId(value: unknown): string | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, string>;
    return record[elementKey] ?? record.ELEMENT;
  }

  private async find(target: CompiledTarget, optional = false): Promise<FoundElement | undefined> {
    const attempted: LocatorStrategy[] = [];
    for (const strategy of target.strategies) {
      const locator = await this.locator(strategy);
      if (!locator) continue;
      attempted.push(strategy);
      try {
        const response = await this.send("POST", "/element", locator);
        const id = this.elementId(response.value);
        if (id) return { id, strategy };
      } catch (error) {
        if (
          error instanceof AppiumCommandFailure &&
          ["no such element", "invalid selector", "invalid argument"].includes(error.code ?? "")
        ) {
          continue;
        }
        throw error;
      }
    }
    if (optional) return undefined;
    throw new FlowFailure(`Appium target was not found using ${attempted.map((item) => item.kind).join(", ")}`);
  }

  private async findAll(target: CompiledTarget): Promise<{ elements: FoundElement[]; strategy?: LocatorStrategy }> {
    for (const strategy of target.strategies) {
      const locator = await this.locator(strategy);
      if (!locator) continue;
      const response = await this.send("POST", "/elements", locator);
      const values = Array.isArray(response.value) ? response.value : [];
      const elements = values.map((value) => this.elementId(value)).filter((id): id is string => Boolean(id)).map((id) => ({ id, strategy }));
      if (elements.length > 0) return { elements, strategy };
    }
    return { elements: [] };
  }

  private async poll<T>(operation: () => Promise<T | undefined | false>, timeoutMs: number, message: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    do {
      const result = await operation();
      if (result) return result;
      await pause(Math.min(100, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new FlowFailure(message);
  }

  private async rect(id?: string): Promise<{ x: number; y: number; width: number; height: number }> {
    const response = await this.send("GET", id ? `/element/${id}/rect` : "/window/rect");
    const value = response.value as { x?: number; y?: number; width?: number; height?: number };
    return { x: value.x ?? 0, y: value.y ?? 0, width: value.width ?? 0, height: value.height ?? 0 };
  }

  private async center(id: string): Promise<Point> {
    const bounds = await this.rect(id);
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }

  private async executeExtension(script: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return (await this.send("POST", "/execute/sync", { script, args: [args] })).value;
  }

  private async displayed(id: string): Promise<boolean> {
    if (this.options.platform === "linux") {
      const states = String((await this.send("GET", `/element/${id}/attribute/states`)).value ?? "");
      return states.includes("VISIBLE") && states.includes("SHOWING");
    }
    return Boolean((await this.send("GET", `/element/${id}/displayed`)).value);
  }

  private async enabled(id: string): Promise<boolean> {
    if (this.options.platform === "linux") {
      const states = String((await this.send("GET", `/element/${id}/attribute/states`)).value ?? "");
      return states.includes("ENABLED") && states.includes("SENSITIVE");
    }
    return Boolean((await this.send("GET", `/element/${id}/enabled`)).value);
  }

  private pointerType(): "touch" | "mouse" {
    return this.options.platform === "ios" || this.options.platform === "ipados" || this.options.platform === "android" ? "touch" : "mouse";
  }

  private async actions(actions: unknown[]): Promise<void> {
    await this.send("POST", "/actions", { actions });
    await this.send("DELETE", "/actions");
  }

  private pointerSequence(id: string, points: Point[], durationMs = 250): Record<string, unknown> {
    const first = points[0]!;
    return {
      type: "pointer",
      id,
      parameters: { pointerType: this.pointerType() },
      actions: [
        { type: "pointerMove", duration: 0, origin: "viewport", x: first.x, y: first.y },
        { type: "pointerDown", button: 0 },
        ...points.slice(1).map((point) => ({ type: "pointerMove", duration: durationMs, origin: "viewport", x: point.x, y: point.y })),
        { type: "pointerUp", button: 0 },
      ],
    };
  }

  private async screenshot(name: string, target?: CompiledTarget): Promise<string> {
    const directory = join(this.context.artifactsDir, "screenshots");
    await mkdir(directory, { recursive: true });
    let response: Record<string, unknown>;
    if (target) {
      const found = await this.find(target);
      response = await this.send("GET", `/element/${found!.id}/screenshot`);
    } else {
      response = await this.send("GET", "/screenshot");
    }
    const path = join(directory, `${safeName(name)}.png`);
    await writeFile(path, Buffer.from(String(response.value), "base64"));
    return path;
  }

  private async executeExpect(step: CompiledStep): Promise<DriverExecutionResult> {
    const target = input<CompiledTarget | undefined>(step, "target");
    if (!target) throw new FlowFailure("Expectation has no target");
    const state = input<string | undefined>(step, "state");
    if (state === "hidden" || state === "detached") {
      await this.poll(async () => {
        const found = await this.find(target, true);
        if (!found) return true;
        return state === "hidden" ? !(await this.displayed(found.id)) : false;
      }, step.timeoutMs, `Expected target to be ${state}`);
      return {};
    }
    let countStrategy: LocatorStrategy | undefined;
    if (input<number | undefined>(step, "count") !== undefined) {
      const count = input<number>(step, "count");
      const matches = await this.poll(async () => {
        const result = await this.findAll(target);
        return result.elements.length === count ? result : false;
      }, step.timeoutMs, `Expected ${count} matching targets`);
      countStrategy = matches.strategy;
    }
    const found = await this.poll(() => this.find(target, true), step.timeoutMs, "Expected target to exist");
    if (state === "visible" || state === "attached") {
      if (state === "visible") await this.poll(() => this.displayed(found.id), step.timeoutMs, "Expected target to be visible");
    } else if (state === "enabled" || state === "disabled") {
      await this.poll(async () => (await this.enabled(found.id)) === (state === "enabled"), step.timeoutMs, `Expected target to be ${state}`);
    }
    if ("text" in step.input) {
      const actual = String((await this.send("GET", `/element/${found.id}/text`)).value ?? "");
      if (!actual.includes(input<string>(step, "text"))) throw new FlowFailure(`Expected target text to include "${input<string>(step, "text")}"`);
    }
    if ("value" in step.input) {
      const actual = (await this.send("GET", `/element/${found.id}/attribute/value`)).value;
      if (String(actual ?? "") !== input<string>(step, "value")) throw new FlowFailure(`Expected target value to equal "${input<string>(step, "value")}"`);
    }
    return { selectedStrategy: countStrategy ?? found.strategy };
  }

  private async executeRequest(step: CompiledStep): Promise<DriverExecutionResult> {
    const url = resolveUrl(input<string>(step, "url"), this.context.baseUrl);
    const method = input<string>(step, "method");
    const headers = { ...input<Record<string, string> | undefined>(step, "headers") };
    const body = input<JsonValue | undefined>(step, "body");
    if (body !== undefined && !("content-type" in headers)) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(step.timeoutMs),
      });
    } catch (error) {
      throw new RuntimeFailure(`Request to ${url} failed`, { cause: error });
    }
    const text = await response.text();
    const expectation = input<{ status?: number; json?: JsonValue; text?: string } | undefined>(step, "expect");
    if (expectation?.status !== undefined && response.status !== expectation.status) throw new FlowFailure(`Expected ${method} ${url} to return ${expectation.status}, received ${response.status}`);
    if (expectation?.text !== undefined && !text.includes(expectation.text)) throw new FlowFailure(`Expected ${method} ${url} response to include "${expectation.text}"`);
    if (expectation?.json !== undefined) {
      let actual: unknown;
      try { actual = JSON.parse(text); } catch { throw new FlowFailure(`Expected ${method} ${url} to return JSON`); }
      if (!matchesSubset(actual, expectation.json)) throw new FlowFailure(`JSON response from ${method} ${url} did not match the expected subset`);
    }
    return { message: `${method} ${url} → ${response.status}` };
  }

  private async executeStabilize(step: CompiledStep): Promise<void> {
    const deadline = Date.now() + step.timeoutMs;
    const intervalMs = input<number>(step, "intervalMs");
    let previous: string | undefined;
    let stable = 0;
    do {
      const image = String((await this.send("GET", "/screenshot")).value);
      const hash = createHash("sha256").update(image).digest("hex");
      stable = hash === previous ? stable + 1 : 0;
      if (stable >= 2) return;
      previous = hash;
      await pause(intervalMs);
    } while (Date.now() < deadline);
    throw new FlowFailure(`The screen did not become stable within ${step.timeoutMs} ms`);
  }

  private async executeVisual(step: CompiledStep): Promise<DriverExecutionResult> {
    const name = safeName(input<string>(step, "name"));
    const actualPath = await this.screenshot(`visual-${name}`, input<CompiledTarget | undefined>(step, "target"));
    const baselineDir = join(dirname(this.context.plan.sourcePath), "__snapshots__", safeName(this.context.plan.name));
    const baselinePath = join(baselineDir, `${name}.png`);
    if (this.context.updateSnapshots) {
      await mkdir(baselineDir, { recursive: true });
      await copyFile(actualPath, baselinePath);
      return { message: `Updated visual baseline ${baselinePath}`, artifacts: [actualPath] };
    }
    if (!(await fileExists(baselinePath))) throw new FlowFailure(`Visual baseline is missing: ${baselinePath}. Run with --update-snapshots to create it.`);
    const [actual, baseline] = await Promise.all([readFile(actualPath).then(PNG.sync.read), readFile(baselinePath).then(PNG.sync.read)]);
    if (actual.width !== baseline.width || actual.height !== baseline.height) throw new FlowFailure(`Visual dimensions changed from ${baseline.width}×${baseline.height} to ${actual.width}×${actual.height}`);
    const diff = new PNG({ width: actual.width, height: actual.height });
    const changed = pixelmatch(baseline.data, actual.data, diff.data, actual.width, actual.height, { threshold: 0.1 });
    const ratio = changed / (actual.width * actual.height);
    if (ratio > input<number>(step, "threshold")) {
      const diffPath = join(this.context.artifactsDir, "screenshots", `visual-${name}.diff.png`);
      await writeFile(diffPath, PNG.sync.write(diff));
      throw new FlowFailure(`Visual difference ${(ratio * 100).toFixed(2)}% exceeded ${(input<number>(step, "threshold") * 100).toFixed(2)}%`);
    }
    return { message: `Visual difference ${(ratio * 100).toFixed(2)}%`, artifacts: [actualPath] };
  }

  async execute(step: CompiledStep): Promise<DriverExecutionResult | void> {
    if (step.kind === "launch") return;
    if (step.kind === "terminate") {
      await this.send("POST", "/appium/app/terminate", { appId: input<string | undefined>(step, "app") });
      return;
    }
    if (step.kind === "reset") { await this.send("POST", "/appium/app/reset", {}); return; }
    if (step.kind === "navigate") { await this.send("POST", "/url", { url: input<string>(step, "to") }); return; }
    if (step.kind === "deepLink") {
      if (this.options.platform === "ios" || this.options.platform === "ipados" || this.options.platform === "android") {
        await this.send("POST", "/execute/sync", { script: "mobile: deepLink", args: [{ url: input<string>(step, "to") }] });
      } else if (this.options.platform === "macos") {
        await this.send("POST", "/execute/sync", { script: "macos: deepLink", args: [{ url: input<string>(step, "to") }] });
      } else {
        await this.send("POST", "/url", { url: input<string>(step, "to") });
      }
      return;
    }
    if (step.kind === "activate" || step.kind === "enter" || step.kind === "clear") {
      const found = (await this.find(input<CompiledTarget>(step, "target")))!;
      const path = `/element/${found.id}`;
      if (step.kind === "activate") await this.send("POST", `${path}/click`, {});
      if (step.kind === "clear") await this.send("POST", `${path}/clear`, {});
      if (step.kind === "enter") {
        const value = input<string>(step, "value");
        await this.send("POST", `${path}/value`, { text: value });
      }
      return { selectedStrategy: found.strategy };
    }
    if (step.kind === "select") {
      const target = (await this.find(input<CompiledTarget>(step, "target")))!;
      await this.send("POST", `/element/${target.id}/click`, {});
      for (const value of [input<string | string[]>(step, "value")].flat()) {
        const option = (await this.find({ strategies: [{ kind: "text", value }] }))!;
        await this.send("POST", `/element/${option.id}/click`, {});
      }
      return { selectedStrategy: target.strategy };
    }
    if (step.kind === "key") {
      if (this.options.platform === "linux") await this.send("POST", "/appium/device/press_keycode", linuxKey(input<string>(step, "value")));
      else await this.send("POST", "/keys", { value: [input<string>(step, "value")] });
      return;
    }
    if (step.kind === "pointer") {
      const point = { x: input<number>(step, "x"), y: input<number>(step, "y") };
      await this.actions([this.pointerSequence("pointer", [point])]);
      return;
    }
    if (step.kind === "scroll" || step.kind === "swipe") {
      let start: Point;
      const target = input<CompiledTarget | undefined>(step, "target");
      if (target) start = await this.center((await this.find(target))!.id);
      else {
        const bounds = await this.rect();
        start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      }
      let delta: Point;
      if (step.kind === "scroll") delta = { x: input<number | undefined>(step, "x") ?? 0, y: input<number | undefined>(step, "y") ?? 500 };
      else {
        const distance = input<number | undefined>(step, "distance") ?? 300;
        const direction = input<"up" | "down" | "left" | "right">(step, "direction");
        delta = { x: direction === "left" ? -distance : direction === "right" ? distance : 0, y: direction === "up" ? -distance : direction === "down" ? distance : 0 };
      }
      if (this.options.platform === "linux") {
        if (step.kind === "scroll") {
          await this.executeExtension("linux: mouseMove", { ...start });
          await this.executeExtension("linux: mouseScroll", {
            moveLeftSteps: -Math.sign(delta.x),
            moveUpSteps: -Math.sign(delta.y),
          });
        } else {
          await this.executeExtension("linux: mouseSwipe", {
            sx: start.x,
            sy: start.y,
            ex: start.x + delta.x,
            ey: start.y + delta.y,
          });
        }
      } else {
        await this.actions([this.pointerSequence("gesture", [start, { x: start.x + delta.x, y: start.y + delta.y }])]);
      }
      return;
    }
    if (step.kind === "drag") {
      const from = (await this.find(input<CompiledTarget>(step, "from")))!;
      const to = (await this.find(input<CompiledTarget>(step, "to")))!;
      const fromPoint = await this.center(from.id);
      const toPoint = await this.center(to.id);
      if (this.options.platform === "linux") {
        await this.executeExtension("linux: mouseSwipe", { sx: fromPoint.x, sy: fromPoint.y, ex: toPoint.x, ey: toPoint.y });
      } else {
        await this.actions([this.pointerSequence("drag", [fromPoint, toPoint], 500)]);
      }
      return { selectedStrategy: from.strategy };
    }
    if (step.kind === "multiTouch") {
      const points = input<Point[]>(step, "points");
      const gesture = input<"tap" | "pinch-in" | "pinch-out">(step, "gesture");
      const midpoint = points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
      const factor = gesture === "pinch-in" ? 0.5 : gesture === "pinch-out" ? 1.5 : 1;
      await this.actions(points.map((point, index) => this.pointerSequence(`finger-${index}`, gesture === "tap" ? [point] : [point, { x: midpoint.x + (point.x - midpoint.x) * factor, y: midpoint.y + (point.y - midpoint.y) * factor }], input<number>(step, "durationMs"))));
      return;
    }
    if (step.kind === "wait") {
      const durationMs = input<number | undefined>(step, "durationMs");
      if (durationMs !== undefined) { await pause(durationMs); return; }
      const target = input<CompiledTarget>(step, "target");
      const state = input<string>(step, "state");
      if (state === "hidden" || state === "detached") {
        await this.poll(async () => {
          const found = await this.find(target, true);
          if (!found) return true;
          return state === "hidden" ? !(await this.displayed(found.id)) : false;
        }, step.timeoutMs, `Expected target to be ${state}`);
        return;
      }
      const found = await this.poll(() => this.find(target, true), step.timeoutMs, `Expected target to be ${state}`);
      if (state === "visible") await this.poll(() => this.displayed(found.id), step.timeoutMs, "Expected target to be visible");
      return { selectedStrategy: found.strategy };
    }
    if (step.kind === "expect") return this.executeExpect(step);
    if (step.kind === "screenshot") return { artifacts: [await this.screenshot(input<string>(step, "name"), input<CompiledTarget | undefined>(step, "target"))] };
    if (step.kind === "request") return this.executeRequest(step);
    if (step.kind === "stabilize") return this.executeStabilize(step);
    if (step.kind === "visual") return this.executeVisual(step);
    if (step.kind === "platform") {
      await this.executeExtension(extensionScript(this.options.platform, input<string>(step, "command")), input<Record<string, JsonValue> | undefined>(step, "args") ?? {});
      return;
    }
    throw new RuntimeFailure(`Appium driver cannot execute ${step.kind}`);
  }

  async captureFailure(step: CompiledStep): Promise<string[]> {
    return [await this.screenshot(`failure-${step.id}`)];
  }

  async close(): Promise<string[]> {
    const artifacts: string[] = [];
    try {
      if (this.options.video) {
        const response = this.options.platform === "macos"
          ? await this.send("POST", "/execute/sync", { script: "macos: stopRecordingScreen", args: [{}] })
          : await this.send("POST", "/appium/stop_recording_screen", {});
        const path = join(this.context.artifactsDir, "video.mp4");
        await writeFile(path, Buffer.from(String(response.value), "base64"));
        artifacts.push(path);
      }
    } finally {
      await this.send("DELETE", "");
    }
    return artifacts;
  }
}

export class AppiumDriver implements Driver {
  readonly id: string;
  readonly platform: AppiumPlatform;
  readonly capabilities: ReadonlySet<Capability>;

  constructor(private readonly options: AppiumDriverOptions) {
    if (options.video && (options.platform === "windows" || options.platform === "linux")) {
      throw new RuntimeFailure(`Video recording is not supported by the ${options.platform} Appium backend`);
    }
    this.platform = options.platform;
    this.id = `${options.platform}.appium`;
    this.capabilities = new Set<Capability>([
      capabilities.launch,
      ...(options.platform === "linux" ? [] : [
        capabilities.terminate,
        capabilities.reset,
        capabilities.navigate,
        capabilities.deepLink,
      ]),
      capabilities.activate,
      capabilities.enter,
      capabilities.select,
      capabilities.clear,
      capabilities.key,
      ...(options.platform === "linux" ? [] : [capabilities.pointer]),
      capabilities.scroll,
      capabilities.swipe,
      capabilities.drag,
      ...(options.platform === "ios" || options.platform === "ipados" || options.platform === "android"
        ? [capabilities.multiTouch]
        : []),
      capabilities.wait,
      capabilities.expect,
      capabilities.screenshot,
      capabilities.request,
      capabilities.stabilize,
      capabilities.visual,
      `extension.${options.platform}.*`,
    ]);
  }

  createSession(context: DriverSessionContext): Promise<DriverSession> {
    return AppiumSession.create(context, this.options);
  }
}
