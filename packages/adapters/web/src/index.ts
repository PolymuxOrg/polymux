import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type Driver,
  type DriverExecutionResult,
  type DriverSession,
  type DriverSessionContext,
  flattenCompiledItems,
  RuntimeFailure,
  FlowFailure,
} from "@polymux/core";
import {
  capabilities,
  type Capability,
  type CompiledStep,
  type CompiledTarget,
  type JsonValue,
  type LocatorStrategy,
} from "@polymux/protocol";
import {
  chromium,
  devices,
  firefox,
  webkit,
  type APIResponse,
  type Browser,
  type BrowserContextOptions,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export * from "./crawl.js";

export interface WebDriverOptions {
  headless?: boolean;
  browser?: WebBrowserName;
  device?: string;
  video?: boolean;
  trace?: boolean;
}

export type WebBrowserName = "chromium" | "firefox" | "webkit";

export interface WebDriverInspection {
  executablePath: string;
  installed: boolean;
}

const browserTypes = { chromium, firefox, webkit } as const;

export async function inspectWebDriver(
  browser: WebBrowserName = "chromium",
): Promise<WebDriverInspection> {
  const executablePath = browserTypes[browser].executablePath();
  return {
    executablePath,
    installed: await fileExists(executablePath),
  };
}

interface LocatedElement {
  locator: Locator;
  strategy: LocatorStrategy;
}

interface LocatedImage {
  match: { x: number; y: number; width: number; height: number };
  strategy: Extract<LocatorStrategy, { kind: "image" }>;
}

type Located = LocatedElement | LocatedImage;

function isElement(located: Located): located is LocatedElement {
  return "locator" in located;
}

function input<T>(step: CompiledStep, key: string): T {
  return step.input[key] as T;
}

function safeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function resolveUrl(value: string, baseUrl?: string): string {
  try {
    return new URL(value).toString();
  } catch {
    if (!baseUrl) {
      throw new RuntimeFailure(
        `Relative URL "${value}" needs baseUrl in the flow or --url`,
      );
    }
    return new URL(value, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  }
}

function matchesSubset(actual: unknown, expected: JsonValue): boolean {
  if (
    expected === null ||
    typeof expected === "string" ||
    typeof expected === "number" ||
    typeof expected === "boolean"
  ) {
    return Object.is(actual, expected);
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length <= actual.length &&
      expected.every((entry, index) => matchesSubset(actual[index], entry))
    );
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    return false;
  }
  return Object.entries(expected).every(([key, value]) =>
    matchesSubset((actual as Record<string, unknown>)[key], value),
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function poll(
  check: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  } while (Date.now() < deadline);
  throw new FlowFailure(message);
}

class WebSession implements DriverSession {
  private browser!: Browser;
  private browserContext!: BrowserContext;
  private page!: Page;
  private clockInstalled = false;
  private readonly tracePath: string;
  private videoPath: Promise<string> | undefined;

  private constructor(
    private readonly context: DriverSessionContext,
    private readonly options: WebDriverOptions,
  ) {
    this.tracePath = join(context.artifactsDir, "trace.zip");
  }

  static async create(
    context: DriverSessionContext,
    options: WebDriverOptions,
  ): Promise<WebSession> {
    const session = new WebSession(context, options);
    try {
      const browserName = options.browser ?? "chromium";
      session.browser = await browserTypes[browserName].launch({
        headless: options.headless ?? true,
      });
      let contextOptions: BrowserContextOptions = {};
      if (options.device) {
        const descriptor = devices[options.device];
        if (!descriptor) {
          throw new RuntimeFailure(
            `Unknown Playwright device profile "${options.device}"`,
          );
        }
        const { defaultBrowserType: _defaultBrowserType, ...deviceOptions } =
          descriptor;
        contextOptions = deviceOptions;
      }
      if (options.video) {
        contextOptions.recordVideo = {
          dir: join(context.artifactsDir, "videos"),
        };
      }
      if (context.headers) {
        contextOptions.extraHTTPHeaders = context.headers;
      }
      if (context.plan.requiredCapabilities.includes(capabilities.multiTouch)) {
        contextOptions.hasTouch = true;
      }
      session.browserContext = await session.browser.newContext(contextOptions);
      if (context.scopedHeaders && context.scopedHeaders.length > 0) {
        await session.browserContext.route("**/*", async (route) => {
          let origin: string;
          try {
            origin = new URL(route.request().url()).origin;
          } catch {
            await route.continue();
            return;
          }
          const headers = context.scopedHeaders!
            .filter((rule) => rule.origins.includes(origin))
            .reduce(
              (combined, rule) => ({ ...combined, ...rule.headers }),
              {} as Record<string, string>,
            );
          if (Object.keys(headers).length === 0) {
            await route.continue();
            return;
          }
          await route.continue({
            headers: { ...route.request().headers(), ...headers },
          });
        });
      }
      if (options.trace !== false && !context.containsSecrets) {
        await session.browserContext.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
        });
      }
      session.page = await session.browserContext.newPage();
      session.videoPath = session.page.video()?.path();
      return session;
    } catch (error) {
      await session.browser?.close().catch(() => undefined);
      throw new RuntimeFailure("Could not start the web driver", {
        cause: error,
      });
    }
  }

  private locatorFor(strategy: LocatorStrategy): Locator | undefined {
    if (strategy.kind === "role") {
      return this.page.getByRole(
        strategy.role as Parameters<Page["getByRole"]>[0],
        strategy.name
          ? {
              name: strategy.name,
              ...(strategy.exact === undefined ? {} : { exact: strategy.exact }),
            }
          : {},
      );
    }
    if (strategy.kind === "label") {
      return this.page.getByLabel(
        strategy.value,
        strategy.exact === undefined ? {} : { exact: strategy.exact },
      );
    }
    if (strategy.kind === "testId") return this.page.getByTestId(strategy.value);
    if (strategy.kind === "text") {
      return this.page.getByText(
        strategy.value,
        strategy.exact === undefined ? {} : { exact: strategy.exact },
      );
    }
    if (strategy.kind === "id") {
      return this.page.locator(`[id=${JSON.stringify(strategy.value)}]`);
    }
    if (strategy.kind === "css") return this.page.locator(strategy.value);
    if (strategy.kind === "accessibilityId") {
      return this.page.locator(
        `[data-accessibility-id=${JSON.stringify(strategy.value)}]`,
      );
    }
    return undefined;
  }

  private async matchImage(value: string): Promise<LocatedImage["match"] | undefined> {
    const templatePath = resolve(dirname(this.context.plan.sourcePath), value);
    let template: PNG;
    try {
      template = PNG.sync.read(await readFile(templatePath));
    } catch {
      throw new FlowFailure(`Could not read image target ${templatePath}`);
    }
    const screenshot = PNG.sync.read(
      await this.page.screenshot({ animations: "disabled" }),
    );
    if (template.width > screenshot.width || template.height > screenshot.height) {
      return undefined;
    }
    const anchors = [
      [0, 0],
      [template.width - 1, 0],
      [0, template.height - 1],
      [template.width - 1, template.height - 1],
      [Math.floor(template.width / 2), Math.floor(template.height / 2)],
    ];
    const similar = (sourceOffset: number, templateOffset: number) => {
      if (template.data[templateOffset + 3]! < 16) return true;
      return (
        Math.abs(screenshot.data[sourceOffset]! - template.data[templateOffset]!) <= 20 &&
        Math.abs(screenshot.data[sourceOffset + 1]! - template.data[templateOffset + 1]!) <= 20 &&
        Math.abs(screenshot.data[sourceOffset + 2]! - template.data[templateOffset + 2]!) <= 20
      );
    };
    for (let y = 0; y <= screenshot.height - template.height; y += 1) {
      for (let x = 0; x <= screenshot.width - template.width; x += 1) {
        if (
          !anchors.every(([anchorX, anchorY]) =>
            similar(
              ((y + anchorY!) * screenshot.width + x + anchorX!) * 4,
              (anchorY! * template.width + anchorX!) * 4,
            ),
          )
        ) {
          continue;
        }
        let compared = 0;
        let mismatches = 0;
        for (let templateY = 0; templateY < template.height; templateY += 1) {
          for (let templateX = 0; templateX < template.width; templateX += 1) {
            const templateOffset = (templateY * template.width + templateX) * 4;
            if (template.data[templateOffset + 3]! < 16) continue;
            compared += 1;
            const sourceOffset =
              ((y + templateY) * screenshot.width + x + templateX) * 4;
            if (!similar(sourceOffset, templateOffset)) mismatches += 1;
            if (mismatches > Math.max(1, compared * 0.02)) break;
          }
          if (mismatches > Math.max(1, compared * 0.02)) break;
        }
        if (compared > 0 && mismatches / compared <= 0.02) {
          const viewport = this.page.viewportSize();
          const scale = viewport ? screenshot.width / viewport.width : 1;
          return {
            x: x / scale,
            y: y / scale,
            width: template.width / scale,
            height: template.height / scale,
          };
        }
      }
    }
    return undefined;
  }

  private async locate(
    target: CompiledTarget,
    timeoutMs: number,
    allowAbsent = false,
    requiredState: "visible" | "attached" = "visible",
  ): Promise<Located> {
    const supported = target.strategies
      .map((strategy) => ({
        strategy,
        locator: this.locatorFor(strategy),
      }))
      .filter((candidate) => candidate.locator !== undefined || candidate.strategy.kind === "image");
    if (supported.length === 0) {
      throw new FlowFailure(
        `No web-compatible locator was provided (${target.strategies.map((item) => item.kind).join(", ")})`,
      );
    }

    if (allowAbsent && supported[0]?.locator) {
      return supported[0] as LocatedElement;
    }

    const perStrategyTimeout = Math.max(
      100,
      Math.floor(timeoutMs / supported.length),
    );
    const failures: string[] = [];
    for (const candidate of supported) {
      try {
        if (candidate.strategy.kind === "image") {
          const imageStrategy = candidate.strategy;
          let match: LocatedImage["match"] | undefined;
          await poll(
            async () => {
              match = await this.matchImage(imageStrategy.value);
              return match !== undefined;
            },
            perStrategyTimeout,
            "Image target was not found",
          );
          return { strategy: imageStrategy, match: match! };
        }
        await candidate.locator!.first().waitFor({
          state: requiredState,
          timeout: perStrategyTimeout,
        });
        return { strategy: candidate.strategy, locator: candidate.locator! };
      } catch {
        failures.push(JSON.stringify(candidate.strategy));
      }
    }
    throw new FlowFailure(
      `Target was not found using ${failures.join(", ")}`,
    );
  }

  private imageCenter(located: LocatedImage): { x: number; y: number } {
    return {
      x: located.match.x + located.match.width / 2,
      y: located.match.y + located.match.height / 2,
    };
  }

  private async activateElement(
    locator: Locator,
    timeoutMs: number,
  ): Promise<void> {
    const type = (await locator.getAttribute("type"))?.toLowerCase();
    if (type === "checkbox" || type === "radio") {
      const id = await locator.getAttribute("id");
      if (id) {
        const label = this.page
          .locator(`label[for=${JSON.stringify(id)}]`)
          .first();
        if (
          (await locator.isEnabled()) &&
          (await label.count()) > 0 &&
          (await label.isVisible())
        ) {
          await label.click({ timeout: timeoutMs });
          return;
        }
      }
    }
    await locator.click({ timeout: timeoutMs });
  }

  private async waitForImageAbsence(
    target: CompiledTarget,
    timeoutMs: number,
  ): Promise<LocatorStrategy> {
    const images = target.strategies.filter(
      (strategy): strategy is Extract<LocatorStrategy, { kind: "image" }> =>
        strategy.kind === "image",
    );
    if (images.length !== target.strategies.length || images.length === 0) {
      throw new FlowFailure(
        "Hidden image assertions cannot be mixed with element locator alternatives",
      );
    }
    await poll(
      async () => {
        for (const image of images) {
          if (await this.matchImage(image.value)) return false;
        }
        return true;
      },
      timeoutMs,
      "Expected image target to be hidden",
    );
    return images[0]!;
  }

  private async screenshot(
    name: string,
    target?: CompiledTarget,
  ): Promise<string> {
    const directory = join(this.context.artifactsDir, "screenshots");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${safeName(name)}.png`);
    if (target) {
      const located = await this.locate(target, this.context.plan.timeoutMs);
      if (isElement(located)) {
        await located.locator.screenshot({ path, animations: "allow" });
      } else {
        await this.page.screenshot({ path, clip: located.match, animations: "allow" });
      }
    } else {
      await this.page.screenshot({
        path,
        fullPage: true,
        animations: "allow",
      });
    }
    return path;
  }

  private async executeExpect(
    step: CompiledStep,
  ): Promise<DriverExecutionResult> {
    const target = input<CompiledTarget | undefined>(step, "target");
    if (!target) {
      throw new FlowFailure("Expectation has no target");
    }
    const state = input<string>(step, "state");
    const allowAbsent = state === "hidden" || state === "detached";
    if (
      allowAbsent &&
      target.strategies.every((strategy) => strategy.kind === "image")
    ) {
      return {
        selectedStrategy: await this.waitForImageAbsence(target, step.timeoutMs),
      };
    }
    const located = await this.locate(
      target,
      step.timeoutMs,
      allowAbsent,
      state === "attached" || "count" in step.input ? "attached" : "visible",
    );
    if (!isElement(located)) {
      if (
        "text" in step.input ||
        "value" in step.input ||
        "count" in step.input ||
        state === "enabled" ||
        state === "disabled"
      ) {
        throw new FlowFailure(
          "Image targets support presence assertions, not element properties",
        );
      }
      return { selectedStrategy: located.strategy };
    }
    const locator = located.locator.first();

    if (state === "visible" || state === "attached") {
      await locator
        .waitFor({ state, timeout: step.timeoutMs })
        .catch(() => {
          throw new FlowFailure(`Expected target to be ${state}`);
        });
    } else if (state === "hidden" || state === "detached") {
      await locator
        .waitFor({ state, timeout: step.timeoutMs })
        .catch(() => {
          throw new FlowFailure(`Expected target to be ${state}`);
        });
    } else if (state === "enabled" || state === "disabled") {
      await poll(
        async () =>
          state === "enabled"
            ? await locator.isEnabled()
            : await locator.isDisabled(),
        step.timeoutMs,
        `Expected target to be ${state}`,
      );
    }

    if ("text" in step.input) {
      const expected = input<string>(step, "text");
      await poll(
        async () => (await locator.textContent())?.includes(expected) ?? false,
        step.timeoutMs,
        `Expected target text to include "${expected}"`,
      );
    }
    if ("value" in step.input) {
      const expected = input<string>(step, "value");
      await poll(
        async () => (await locator.inputValue()) === expected,
        step.timeoutMs,
        `Expected target value to equal "${expected}"`,
      );
    }
    if ("count" in step.input) {
      const expected = input<number>(step, "count");
      await poll(
        async () => (await located.locator.count()) === expected,
        step.timeoutMs,
        `Expected ${expected} matching targets`,
      );
    }
    return { selectedStrategy: located.strategy };
  }

  private async executeRequest(
    step: CompiledStep,
  ): Promise<DriverExecutionResult> {
    const url = resolveUrl(input<string>(step, "url"), this.context.baseUrl);
    const method = input<string>(step, "method");
    const headers = {
      ...input<Record<string, string> | undefined>(step, "headers"),
    };
    const body = input<JsonValue | undefined>(step, "body");
    if (body !== undefined && !("content-type" in headers)) {
      headers["content-type"] = "application/json";
    }
    let response: APIResponse;
    try {
      response = await this.browserContext.request.fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { data: body } : {}),
        timeout: step.timeoutMs,
      });
    } catch (error) {
      throw new RuntimeFailure(`Request to ${url} failed`, { cause: error });
    }

    const expectation = input<
      { status?: number; json?: JsonValue; text?: string } | undefined
    >(step, "expect");
    const responseText = await response.text();
    const responseStatus = response.status();
    if (expectation?.status !== undefined && responseStatus !== expectation.status) {
      throw new FlowFailure(
        `Expected ${method} ${url} to return ${expectation.status}, received ${responseStatus}`,
      );
    }
    if (expectation?.text !== undefined && !responseText.includes(expectation.text)) {
      throw new FlowFailure(
        `Expected ${method} ${url} response to include "${expectation.text}"`,
      );
    }
    if (expectation?.json !== undefined) {
      let actual: unknown;
      try {
        actual = JSON.parse(responseText);
      } catch {
        throw new FlowFailure(
          `Expected ${method} ${url} to return JSON`,
        );
      }
      if (!matchesSubset(actual, expectation.json)) {
        throw new FlowFailure(
          `JSON response from ${method} ${url} did not match the expected subset`,
        );
      }
    }
    return { message: `${method} ${url} → ${responseStatus}` };
  }

  private async executeMock(step: CompiledStep): Promise<void> {
    const url = input<string>(step, "url");
    const method = input<string | undefined>(step, "method");
    const response = input<{
      status: number;
      headers?: Record<string, string>;
      json?: JsonValue;
      text?: string;
    }>(step, "response");
    await this.browserContext.route(url, async (route: Route) => {
      if (method && route.request().method() !== method) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: response.status,
        ...(response.headers ? { headers: response.headers } : {}),
        ...(response.json !== undefined
          ? { json: response.json }
          : { body: response.text ?? "" }),
      });
    });
  }

  private async executeStabilize(step: CompiledStep): Promise<void> {
    const intervalMs = input<number>(step, "intervalMs");
    const deadline = Date.now() + step.timeoutMs;
    let previousHash: string | undefined;
    let stableFrames = 0;
    do {
      const buffer = await this.page.screenshot({ animations: "allow" });
      const hash = createHash("sha256").update(buffer).digest("hex");
      if (hash === previousHash) {
        stableFrames += 1;
        if (stableFrames >= 2) return;
      } else {
        stableFrames = 0;
        previousHash = hash;
      }
      await this.page.waitForTimeout(intervalMs);
    } while (Date.now() < deadline);
    throw new FlowFailure(
      `The screen did not become stable within ${step.timeoutMs} ms`,
    );
  }

  private async executeClock(step: CompiledStep): Promise<void> {
    const action = input<"install" | "pause" | "advance" | "resume">(
      step,
      "action",
    );
    const ms = input<number | undefined>(step, "ms");
    if (action === "install") {
      if (!this.clockInstalled) {
        await this.page.clock.install();
        this.clockInstalled = true;
      }
      return;
    }
    if (!this.clockInstalled) {
      await this.page.clock.install();
      this.clockInstalled = true;
    }
    if (action === "pause") {
      await this.page.clock.pauseAt(ms ?? Date.now());
    } else if (action === "advance") {
      await this.page.clock.runFor(ms ?? 0);
    } else {
      await this.page.clock.resume();
    }
  }

  private async executeVisual(
    step: CompiledStep,
  ): Promise<DriverExecutionResult> {
    const name = safeName(input<string>(step, "name"));
    const target = input<CompiledTarget | undefined>(step, "target");
    const threshold = input<number>(step, "threshold");
    const actualPath = await this.screenshot(`visual-${name}`, target);
    const flowName = safeName(this.context.plan.name);
    const baselineDir = join(
      dirname(this.context.plan.sourcePath),
      "__snapshots__",
      flowName,
    );
    const baselinePath = join(baselineDir, `${name}.png`);
    if (this.context.updateSnapshots) {
      await mkdir(baselineDir, { recursive: true });
      await copyFile(actualPath, baselinePath);
      return {
        message: `Updated visual baseline ${baselinePath}`,
        artifacts: [actualPath],
      };
    }
    if (!(await fileExists(baselinePath))) {
      throw new FlowFailure(
        `Visual baseline is missing: ${baselinePath}. Run with --update-snapshots to create it.`,
      );
    }

    const [actualBuffer, baselineBuffer] = await Promise.all([
      readFile(actualPath),
      readFile(baselinePath),
    ]);
    const actual = PNG.sync.read(actualBuffer);
    const baseline = PNG.sync.read(baselineBuffer);
    if (actual.width !== baseline.width || actual.height !== baseline.height) {
      throw new FlowFailure(
        `Visual dimensions changed from ${baseline.width}×${baseline.height} to ${actual.width}×${actual.height}`,
      );
    }
    const diff = new PNG({ width: actual.width, height: actual.height });
    const differentPixels = pixelmatch(
      baseline.data,
      actual.data,
      diff.data,
      actual.width,
      actual.height,
      { threshold: 0.1 },
    );
    const ratio = differentPixels / (actual.width * actual.height);
    if (ratio > threshold) {
      const diffPath = join(
        this.context.artifactsDir,
        "screenshots",
        `visual-${name}.diff.png`,
      );
      await writeFile(diffPath, PNG.sync.write(diff));
      throw new FlowFailure(
        `Visual difference ${(ratio * 100).toFixed(2)}% exceeded ${(threshold * 100).toFixed(2)}%`,
      );
    }
    return {
      message: `Visual difference ${(ratio * 100).toFixed(2)}%`,
      artifacts: [actualPath],
    };
  }

  private async executeMultiTouch(step: CompiledStep): Promise<void> {
    if ((this.options.browser ?? "chromium") !== "chromium") {
      throw new RuntimeFailure(
        "Web multi-touch currently requires the Chromium engine",
      );
    }
    const gesture = input<"tap" | "pinch-in" | "pinch-out">(
      step,
      "gesture",
    );
    const points = input<Array<{ x: number; y: number }>>(step, "points");
    const durationMs = input<number>(step, "durationMs");
    const client = await this.browserContext.newCDPSession(this.page);
    const touchPoints = points.map((point) => ({ ...point, radiusX: 1, radiusY: 1 }));
    try {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints,
      });
      if (gesture !== "tap") {
        const center = points.reduce(
          (value, point) => ({ value: { x: value.value.x + point.x, y: value.value.y + point.y }, count: value.count + 1 }),
          { value: { x: 0, y: 0 }, count: 0 },
        );
        const midpoint = {
          x: center.value.x / center.count,
          y: center.value.y / center.count,
        };
        const factor = gesture === "pinch-in" ? 0.5 : 1.5;
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: points.map((point) => ({
            x: midpoint.x + (point.x - midpoint.x) * factor,
            y: midpoint.y + (point.y - midpoint.y) * factor,
            radiusX: 1,
            radiusY: 1,
          })),
        });
      }
      if (durationMs > 0) await this.page.waitForTimeout(durationMs);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    } finally {
      await client.detach();
    }
  }

  async execute(step: CompiledStep): Promise<DriverExecutionResult | void> {
    if (step.kind === "launch") {
      if (input<boolean | undefined>(step, "clearState")) {
        await this.browserContext.clearCookies();
      }
      return;
    }
    if (step.kind === "terminate") {
      await this.page.close();
      return;
    }
    if (step.kind === "reset") {
      await this.browserContext.clearCookies();
      if (!this.page.isClosed()) {
        await this.page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
      }
      return;
    }
    if (step.kind === "navigate" || step.kind === "deepLink") {
      const url = resolveUrl(input<string>(step, "to"), this.context.baseUrl);
      await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: step.timeoutMs,
      });
      return { message: url };
    }
    if (step.kind === "activate") {
      const located = await this.locate(
        input<CompiledTarget>(step, "target"),
        step.timeoutMs,
      );
      if (isElement(located)) {
        await this.activateElement(located.locator, step.timeoutMs);
      } else {
        const point = this.imageCenter(located);
        await this.page.mouse.click(point.x, point.y);
      }
      return { selectedStrategy: located.strategy };
    }
    if (step.kind === "focus") {
      const located = await this.locate(
        input<CompiledTarget>(step, "target"),
        step.timeoutMs,
      );
      if (!isElement(located)) {
        throw new FlowFailure("Image targets cannot receive keyboard focus");
      }
      await located.locator.focus({ timeout: step.timeoutMs });
      return { selectedStrategy: located.strategy };
    }
    if (step.kind === "enter") {
      const located = await this.locate(
        input<CompiledTarget>(step, "target"),
        step.timeoutMs,
      );
      if (isElement(located)) {
        await located.locator.fill(input<string>(step, "value"));
      } else {
        const point = this.imageCenter(located);
        await this.page.mouse.click(point.x, point.y);
        await this.page.keyboard.insertText(input<string>(step, "value"));
      }
      return { selectedStrategy: located.strategy };
    }
    if (step.kind === "select") {
      const located = await this.locate(
        input<CompiledTarget>(step, "target"),
        step.timeoutMs,
      );
      if (!isElement(located)) {
        throw new FlowFailure("Image targets cannot select options");
      }
      await located.locator.selectOption(input<string | string[]>(step, "value"));
      return { selectedStrategy: located.strategy };
    }
    if (step.kind === "clear") {
      const located = await this.locate(
        input<CompiledTarget>(step, "target"),
        step.timeoutMs,
      );
      if (isElement(located)) {
        await located.locator.fill("");
      } else {
        const point = this.imageCenter(located);
        await this.page.mouse.click(point.x, point.y);
        await this.page.keyboard.press("ControlOrMeta+A");
        await this.page.keyboard.press("Backspace");
      }
      return { selectedStrategy: located.strategy };
    }
    if (step.kind === "key") {
      await this.page.keyboard.press(input<string>(step, "value"));
      return;
    }
    if (step.kind === "pointer") {
      const button = input<"left" | "right" | "middle" | undefined>(
        step,
        "button",
      );
      await this.page.mouse.click(
        input<number>(step, "x"),
        input<number>(step, "y"),
        button ? { button } : {},
      );
      return;
    }
    if (step.kind === "scroll") {
      const target = input<CompiledTarget | undefined>(step, "target");
      const x = input<number | undefined>(step, "x") ?? 0;
      const y = input<number | undefined>(step, "y") ?? 500;
      if (target) {
        const located = await this.locate(target, step.timeoutMs);
        if (isElement(located)) {
          await located.locator.evaluate(
            (element, delta) => element.scrollBy(delta.x, delta.y),
            { x, y },
          );
        } else {
          const point = this.imageCenter(located);
          await this.page.mouse.move(point.x, point.y);
          await this.page.mouse.wheel(x, y);
        }
        return { selectedStrategy: located.strategy };
      }
      await this.page.mouse.wheel(x, y);
      return;
    }
    if (step.kind === "swipe") {
      const viewport = this.page.viewportSize() ?? { width: 1280, height: 720 };
      const distance = input<number | undefined>(step, "distance") ?? 300;
      const direction = input<"up" | "down" | "left" | "right">(
        step,
        "direction",
      );
      let start = { x: viewport.width / 2, y: viewport.height / 2 };
      const swipeTarget = input<CompiledTarget | undefined>(step, "target");
      if (swipeTarget) {
        const located = await this.locate(swipeTarget, step.timeoutMs);
        if (isElement(located)) {
          await located.locator.scrollIntoViewIfNeeded({ timeout: step.timeoutMs });
          const bounds = await located.locator.boundingBox();
          if (bounds) {
            start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
          }
        } else {
          start = this.imageCenter(located);
        }
      }
      const delta = {
        x: direction === "left" ? -distance : direction === "right" ? distance : 0,
        y: direction === "up" ? -distance : direction === "down" ? distance : 0,
      };
      await this.page.mouse.move(start.x, start.y);
      await this.page.mouse.down();
      await this.page.mouse.move(start.x + delta.x, start.y + delta.y, {
        steps: 8,
      });
      await this.page.mouse.up();
      return;
    }
    if (step.kind === "drag") {
      const from = await this.locate(
        input<CompiledTarget>(step, "from"),
        step.timeoutMs,
      );
      const to = await this.locate(
        input<CompiledTarget>(step, "to"),
        step.timeoutMs,
      );
      if (isElement(from) && isElement(to)) {
        await from.locator.dragTo(to.locator, { timeout: step.timeoutMs });
      } else {
        const fromPoint = isElement(from)
          ? await from.locator.boundingBox().then((bounds) =>
              bounds
                ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
                : undefined,
            )
          : this.imageCenter(from);
        const toPoint = isElement(to)
          ? await to.locator.boundingBox().then((bounds) =>
              bounds
                ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
                : undefined,
            )
          : this.imageCenter(to);
        if (!fromPoint || !toPoint) throw new FlowFailure("Drag target is not visible");
        await this.page.mouse.move(fromPoint.x, fromPoint.y);
        await this.page.mouse.down();
        await this.page.mouse.move(toPoint.x, toPoint.y, { steps: 8 });
        await this.page.mouse.up();
      }
      return { selectedStrategy: from.strategy };
    }
    if (step.kind === "multiTouch") return this.executeMultiTouch(step);
    if (step.kind === "wait") {
      const durationMs = input<number | undefined>(step, "durationMs");
      if (durationMs !== undefined) {
        await this.page.waitForTimeout(durationMs);
        return;
      }
      const target = input<CompiledTarget>(step, "target");
      const state = input<"visible" | "hidden" | "attached" | "detached">(
        step,
        "state",
      );
      if (
        (state === "hidden" || state === "detached") &&
        target.strategies.every((strategy) => strategy.kind === "image")
      ) {
        return {
          selectedStrategy: await this.waitForImageAbsence(target, step.timeoutMs),
        };
      }
      const located = await this.locate(
        target,
        step.timeoutMs,
        state === "hidden" || state === "detached",
        state === "attached" ? "attached" : "visible",
      );
      if (isElement(located)) {
        await located.locator.waitFor({ state, timeout: step.timeoutMs });
      }
      return { selectedStrategy: located.strategy };
    }
    if (step.kind === "expect") return this.executeExpect(step);
    if (step.kind === "screenshot") {
      const path = await this.screenshot(
        input<string>(step, "name"),
        input<CompiledTarget | undefined>(step, "target"),
      );
      return { artifacts: [path] };
    }
    if (step.kind === "request") return this.executeRequest(step);
    if (step.kind === "mock") return this.executeMock(step);
    if (step.kind === "unmock") {
      await this.browserContext.unroute(input<string>(step, "url"));
      return;
    }
    if (step.kind === "stabilize") return this.executeStabilize(step);
    if (step.kind === "clock") return this.executeClock(step);
    if (step.kind === "visual") return this.executeVisual(step);
    throw new RuntimeFailure(`Web driver cannot execute ${step.kind}`);
  }

  async captureFailure(step: CompiledStep): Promise<string[]> {
    if (this.page.isClosed()) return [];
    const path = await this.screenshot(`failure-${step.id}`);
    return [path];
  }

  storageState(): Promise<NonNullable<BrowserContextOptions["storageState"]>> {
    return this.browserContext.storageState();
  }

  async close(): Promise<string[]> {
    const artifacts: string[] = [];
    try {
      if (this.options.trace !== false && !this.context.containsSecrets) {
        await this.browserContext.tracing.stop({ path: this.tracePath });
        artifacts.push(this.tracePath);
      }
    } finally {
      await this.browserContext?.close();
      if (this.videoPath) artifacts.push(await this.videoPath);
      await this.browser?.close();
    }
    return artifacts;
  }
}

export class WebDriver implements Driver {
  readonly id = "web.playwright";
  readonly platform = "web" as const;
  readonly supportsScopedHeaders = true;
  readonly capabilities: ReadonlySet<Capability>;

  constructor(private readonly options: WebDriverOptions = {}) {
    this.capabilities = new Set([
      capabilities.launch,
      capabilities.terminate,
      capabilities.reset,
      capabilities.navigate,
      capabilities.deepLink,
      capabilities.activate,
      capabilities.focus,
      capabilities.enter,
      capabilities.select,
      capabilities.clear,
      capabilities.key,
      capabilities.pointer,
      capabilities.scroll,
      capabilities.swipe,
      capabilities.drag,
      ...((options.browser ?? "chromium") === "chromium"
        ? [capabilities.multiTouch]
        : []),
      capabilities.wait,
      capabilities.expect,
      capabilities.screenshot,
      capabilities.request,
      capabilities.mock,
      capabilities.unmock,
      capabilities.stabilize,
      capabilities.clock,
      capabilities.visual,
    ]);
  }

  createSession(context: DriverSessionContext): Promise<DriverSession> {
    return WebSession.create(context, this.options);
  }

  async prepareStorageState(
    plan: import("@polymux/protocol").CompiledSingleActorFlow,
    context: Omit<DriverSessionContext, "plan" | "updateSnapshots">,
  ): Promise<NonNullable<BrowserContextOptions["storageState"]>> {
    const session = await WebSession.create(
      { ...context, plan, updateSnapshots: false },
      this.options,
    );
    try {
      for (const step of flattenCompiledItems([...plan.setup, ...plan.steps])) {
        await session.execute(step);
      }
      return await session.storageState();
    } finally {
      try {
        for (const step of flattenCompiledItems(plan.teardown)) {
          await session.execute(step);
        }
      } finally {
        await session.close();
      }
    }
  }
}
