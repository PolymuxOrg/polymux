import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  capabilities,
  type Capability,
  type CompiledCoordinatedFlow,
  type CompiledFlow,
  type CompiledFixtureProvider,
  type CompiledFlowItem,
  type CompiledStep,
  type CompiledTarget,
  type CompiledSingleActorFlow,
  type LocatorStrategy,
  type FlowStepSource,
  type TargetSource,
  type SingleActorFlowSource,
  coordinatedFlowSourceSchema,
  singleActorFlowSourceSchema,
} from "@polymux/protocol";
import { parse } from "yaml";
import { FlowCompileError } from "./errors.js";

function requireFlowPath(sourcePath: string): void {
  if (!/\.flow\.ya?ml$/i.test(sourcePath)) {
    throw new FlowCompileError(
      `Flow files must use the .flow.yaml or .flow.yml suffix`,
      resolve(sourcePath),
    );
  }
}

function compileTarget(source: TargetSource): CompiledTarget {
  if (typeof source === "string") {
    return { strategies: [{ kind: "text", value: source }] };
  }

  const strategies: LocatorStrategy[] = [];
  if (source.role) {
    strategies.push({
      kind: "role",
      role: source.role,
      ...(source.name ? { name: source.name } : {}),
      ...(source.exact === undefined ? {} : { exact: source.exact }),
    });
  }
  if (source.label) {
    strategies.push({
      kind: "label",
      value: source.label,
      ...(source.exact === undefined ? {} : { exact: source.exact }),
    });
  }
  if (source.testId) strategies.push({ kind: "testId", value: source.testId });
  if (source.text) {
    strategies.push({
      kind: "text",
      value: source.text,
      ...(source.exact === undefined ? {} : { exact: source.exact }),
    });
  }
  if (source.id) strategies.push({ kind: "id", value: source.id });
  if (source.css) strategies.push({ kind: "css", value: source.css });
  if (source.accessibilityId) {
    strategies.push({
      kind: "accessibilityId",
      value: source.accessibilityId,
    });
  }
  if (source.image) strategies.push({ kind: "image", value: source.image });
  for (const alternative of source.alternatives ?? []) {
    strategies.push(...compileTarget(alternative).strategies);
  }

  const unique = strategies.filter(
    (strategy, index, all) =>
      all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(strategy)) ===
      index,
  );
  return { strategies: unique };
}

function unwrapTarget(
  value: TargetSource | { target: TargetSource },
): CompiledTarget {
  return compileTarget(
    typeof value === "object" && "target" in value ? value.target : value,
  );
}

function step(
  index: number,
  kind: CompiledStep["kind"],
  capability: Capability,
  timeoutMs: number,
  input: Record<string, unknown>,
): CompiledStep {
  return {
    id: `${String(index + 1).padStart(3, "0")}-${kind}`,
    kind,
    capability,
    timeoutMs,
    input,
  };
}

function compileStep(
  raw: SingleActorFlowSource["steps"][number],
  index: number,
  defaultTimeoutMs: number,
): CompiledStep {
  if ("launch" in raw) {
    return step(index, "launch", capabilities.launch, defaultTimeoutMs, {
      ...(typeof raw.launch === "string"
        ? { app: raw.launch }
        : raw.launch),
    });
  }
  if ("terminate" in raw) {
    return step(index, "terminate", capabilities.terminate, defaultTimeoutMs,
      typeof raw.terminate === "string" ? { app: raw.terminate } : {});
  }
  if ("reset" in raw) {
    return step(index, "reset", capabilities.reset, defaultTimeoutMs,
      typeof raw.reset === "string" ? { app: raw.reset } : {});
  }
  if ("navigate" in raw || "deepLink" in raw) {
    const kind = "navigate" in raw ? "navigate" : "deepLink";
    const value = "navigate" in raw ? raw.navigate : raw.deepLink;
    const to = typeof value === "string" ? value : value.to;
    return step(index, kind, capabilities[kind], defaultTimeoutMs, { to });
  }
  if ("activate" in raw) {
    return step(index, "activate", capabilities.activate, defaultTimeoutMs, {
      target: unwrapTarget(raw.activate),
    });
  }
  if ("focus" in raw) {
    return step(index, "focus", capabilities.focus, defaultTimeoutMs, {
      target: unwrapTarget(raw.focus),
    });
  }
  if ("enter" in raw) {
    return step(index, "enter", capabilities.enter, defaultTimeoutMs, {
      target: compileTarget(raw.enter.target),
      value: String(raw.enter.value),
    });
  }
  if ("select" in raw) {
    return step(index, "select", capabilities.select, defaultTimeoutMs, {
      target: compileTarget(raw.select.target),
      value: raw.select.value,
    });
  }
  if ("clear" in raw) {
    return step(index, "clear", capabilities.clear, defaultTimeoutMs, {
      target: unwrapTarget(raw.clear),
    });
  }
  if ("key" in raw) {
    return step(index, "key", capabilities.key, defaultTimeoutMs, {
      value: typeof raw.key === "string" ? raw.key : raw.key.value,
    });
  }
  if ("pointer" in raw) {
    return step(index, "pointer", capabilities.pointer, defaultTimeoutMs, raw.pointer);
  }
  if ("scroll" in raw) {
    return step(index, "scroll", capabilities.scroll, defaultTimeoutMs, {
      ...(raw.scroll.target ? { target: compileTarget(raw.scroll.target) } : {}),
      ...(raw.scroll.x !== undefined ? { x: raw.scroll.x } : {}),
      ...(raw.scroll.y !== undefined ? { y: raw.scroll.y } : {}),
    });
  }
  if ("swipe" in raw) {
    return step(index, "swipe", capabilities.swipe, defaultTimeoutMs, {
      direction: raw.swipe.direction,
      ...(raw.swipe.distance !== undefined
        ? { distance: raw.swipe.distance }
        : {}),
      ...(raw.swipe.target
        ? { target: compileTarget(raw.swipe.target) }
        : {}),
    });
  }
  if ("drag" in raw) {
    return step(index, "drag", capabilities.drag, defaultTimeoutMs, {
      from: compileTarget(raw.drag.from),
      to: compileTarget(raw.drag.to),
    });
  }
  if ("multiTouch" in raw) {
    return step(
      index,
      "multiTouch",
      capabilities.multiTouch,
      defaultTimeoutMs,
      raw.multiTouch,
    );
  }
  if ("wait" in raw) {
    if (typeof raw.wait === "number") {
      return step(index, "wait", capabilities.wait, defaultTimeoutMs, {
        durationMs: raw.wait,
      });
    }
    return step(
      index,
      "wait",
      capabilities.wait,
      raw.wait.timeoutMs ?? defaultTimeoutMs,
      {
        ...(raw.wait.target
          ? { target: compileTarget(raw.wait.target) }
          : {}),
        state: raw.wait.state ?? "visible",
      },
    );
  }
  if ("expect" in raw) {
    const implicitTextTarget =
      raw.expect.target === undefined && raw.expect.text !== undefined;
    const targetSource = raw.expect.target ?? raw.expect.text;
    return step(
      index,
      "expect",
      capabilities.expect,
      raw.expect.timeoutMs ?? defaultTimeoutMs,
      {
        ...(targetSource !== undefined
          ? { target: compileTarget(targetSource) }
          : {}),
        state: raw.expect.state ?? "visible",
        ...(!implicitTextTarget && raw.expect.text !== undefined
          ? { text: raw.expect.text }
          : {}),
        ...(raw.expect.value !== undefined
          ? { value: String(raw.expect.value) }
          : {}),
        ...(raw.expect.count !== undefined ? { count: raw.expect.count } : {}),
      },
    );
  }
  if ("screenshot" in raw) {
    return step(
      index,
      "screenshot",
      capabilities.screenshot,
      defaultTimeoutMs,
      typeof raw.screenshot === "string"
        ? { name: raw.screenshot }
        : {
            name: raw.screenshot.name,
            ...(raw.screenshot.target
              ? { target: compileTarget(raw.screenshot.target) }
              : {}),
          },
    );
  }
  if ("request" in raw) {
    return step(index, "request", capabilities.request, defaultTimeoutMs, {
      method: raw.request.method,
      url: raw.request.url,
      ...(raw.request.headers ? { headers: raw.request.headers } : {}),
      ...(raw.request.body !== undefined ? { body: raw.request.body } : {}),
      ...(raw.request.expect ? { expect: raw.request.expect } : {}),
    });
  }
  if ("mock" in raw) {
    return step(index, "mock", capabilities.mock, defaultTimeoutMs, raw.mock);
  }
  if ("unmock" in raw) {
    return step(index, "unmock", capabilities.unmock, defaultTimeoutMs, {
      url: typeof raw.unmock === "string" ? raw.unmock : raw.unmock.url,
    });
  }
  if ("stabilize" in raw) {
    return step(
      index,
      "stabilize",
      capabilities.stabilize,
      raw.stabilize.timeoutMs ?? defaultTimeoutMs,
      {
        intervalMs: raw.stabilize.intervalMs ?? 100,
      },
    );
  }
  if ("clock" in raw) {
    return step(index, "clock", capabilities.clock, defaultTimeoutMs, raw.clock);
  }
  if ("visual" in raw) {
    return step(index, "visual", capabilities.visual, defaultTimeoutMs, {
      name: raw.visual.name,
      threshold: raw.visual.threshold ?? 0.0001,
      ...(raw.visual.target
        ? { target: compileTarget(raw.visual.target) }
        : {}),
    });
  }
  if ("signal" in raw) {
    const name = typeof raw.signal === "string" ? raw.signal : raw.signal.name;
    return step(index, "signal", capabilities.signal, defaultTimeoutMs, { name });
  }
  if ("waitForSignal" in raw) {
    const value = raw.waitForSignal;
    const name = typeof value === "string" ? value : value.name;
    return step(
      index,
      "waitForSignal",
      capabilities.waitForSignal,
      typeof value === "string" ? defaultTimeoutMs : value.timeoutMs ?? defaultTimeoutMs,
      { name },
    );
  }
  if ("receiveEmail" in raw) {
    const extraction = Array.isArray(raw.receiveEmail.extract)
      ? raw.receiveEmail.extract
      : [raw.receiveEmail.extract];
    return step(
      index,
      "receiveEmail",
      capabilities.receiveEmail,
      raw.receiveEmail.timeoutMs ?? defaultTimeoutMs,
      {
        fixture: raw.receiveEmail.fixture,
        saveAs: raw.receiveEmail.saveAs,
        extract: [...new Set(extraction)],
        ...(raw.receiveEmail.match ? { match: raw.receiveEmail.match } : {}),
      },
    );
  }
  if ("receiveSms" in raw) {
    const extraction = Array.isArray(raw.receiveSms.extract)
      ? raw.receiveSms.extract
      : [raw.receiveSms.extract];
    return step(
      index,
      "receiveSms",
      capabilities.receiveSms,
      raw.receiveSms.timeoutMs ?? defaultTimeoutMs,
      {
        fixture: raw.receiveSms.fixture,
        saveAs: raw.receiveSms.saveAs,
        extract: [...new Set(extraction)],
        ...(raw.receiveSms.match ? { match: raw.receiveSms.match } : {}),
      },
    );
  }
  if ("platform" in raw) {
    const capability = `extension.${raw.platform.on}.${raw.platform.command}` as const;
    return step(index, "platform", capability, defaultTimeoutMs, {
      on: raw.platform.on,
      command: raw.platform.command,
      ...(raw.platform.args ? { args: raw.platform.args } : {}),
    });
  }

  throw new FlowCompileError(`Unknown flow step at index ${index}`);
}

function formatValidationError(error: {
  issues: Array<{ path: Array<string | number>; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "flow";
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}

function validateKnownFailure(
  knownFailure: { reason: string; expires: string } | undefined,
  sourcePath: string,
): void {
  if (!knownFailure) return;
  const today = new Date().toISOString().slice(0, 10);
  if (knownFailure.expires < today) {
    throw new FlowCompileError(
      `Known failure expired on ${knownFailure.expires}: ${knownFailure.reason}`,
      sourcePath,
    );
  }
}

function concreteSteps(items: CompiledFlowItem[]): CompiledStep[] {
  return items.flatMap((item) =>
    item.kind === "flow"
      ? [
          ...concreteSteps(item.flow.setup),
          ...concreteSteps(item.flow.steps),
          ...concreteSteps(item.flow.teardown),
        ]
      : [item],
  );
}

function compileLocalItems(
  items: FlowStepSource[],
  defaultTimeoutMs: number,
  sourcePath: string,
): CompiledFlowItem[] {
  return items.map((raw, index) => {
    if ("flow" in raw) {
      throw new FlowCompileError(
        "Referenced flows require a .flow.yaml file so paths can be resolved",
        sourcePath,
      );
    }
    return compileStep(raw, index, defaultTimeoutMs);
  });
}

function assembleSingleActorFlow(
  source: SingleActorFlowSource,
  sourcePath: string,
  setup: CompiledFlowItem[],
  steps: CompiledFlowItem[],
  teardown: CompiledFlowItem[],
): CompiledSingleActorFlow {
  validateKnownFailure(source.knownFailure, sourcePath);
  const executable = [
    ...concreteSteps(setup),
    ...concreteSteps(steps),
    ...concreteSteps(teardown),
  ];
  const messageNames = new Set<string>();
  for (const entry of executable) {
    if (entry.kind !== "receiveEmail" && entry.kind !== "receiveSms") continue;
    const name = String(entry.input.saveAs);
    if (messageNames.has(name)) {
      throw new FlowCompileError(
        `Message result name "${name}" is used more than once`,
        sourcePath,
      );
    }
    messageNames.add(name);
  }
  const requiredCapabilities = executable
    .map((entry) => entry.capability)
    .filter((capability, index, all) => all.indexOf(capability) === index);
  const hashInput = {
    formatVersion: 1,
    name: source.name,
    tags: source.tags,
    knownFailure: source.knownFailure,
    platforms: source.platforms,
    timeoutMs: source.timeoutMs,
    setup,
    steps,
    teardown,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(hashInput))
    .digest("hex");

  return {
    formatVersion: 1,
    name: source.name,
    ...(source.description ? { description: source.description } : {}),
    tags: source.tags,
    ...(source.knownFailure ? { knownFailure: source.knownFailure } : {}),
    sourcePath,
    platforms: source.platforms,
    ...(source.baseUrl ? { baseUrl: source.baseUrl } : {}),
    timeoutMs: source.timeoutMs,
    requiredCapabilities,
    hash,
    setup,
    steps,
    teardown,
  };
}

export function compileSingleActorFlow(
  value: unknown,
  sourcePath = "<memory>",
): CompiledSingleActorFlow {
  const parsed = singleActorFlowSourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new FlowCompileError(
      `Invalid flow:\n${formatValidationError(parsed.error)}`,
      sourcePath,
    );
  }

  const source = parsed.data;
  return assembleSingleActorFlow(
    source,
    sourcePath,
    compileLocalItems(source.setup, source.timeoutMs, sourcePath),
    compileLocalItems(source.steps, source.timeoutMs, sourcePath),
    compileLocalItems(source.teardown, source.timeoutMs, sourcePath),
  );
}

async function readFlowValue(sourcePath: string): Promise<unknown> {
  requireFlowPath(sourcePath);
  const absolutePath = resolve(sourcePath);
  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new FlowCompileError(
      `Could not read flow: ${error instanceof Error ? error.message : String(error)}`,
      absolutePath,
    );
  }

  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    throw new FlowCompileError(
      `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      absolutePath,
    );
  }
  return value;
}

async function compileSingleActorFlowFileInternal(
  sourcePath: string,
  stack: string[],
): Promise<CompiledSingleActorFlow> {
  const absolutePath = resolve(sourcePath);
  if (stack.includes(absolutePath)) {
    throw new FlowCompileError(
      `Circular flow reference: ${[...stack, absolutePath].join(" -> ")}`,
      absolutePath,
    );
  }
  const value = await readFlowValue(absolutePath);
  const parsed = singleActorFlowSourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new FlowCompileError(
      `Invalid flow:\n${formatValidationError(parsed.error)}`,
      absolutePath,
    );
  }
  const source = parsed.data;
  const nextStack = [...stack, absolutePath];
  const compileItems = async (
    items: FlowStepSource[],
  ): Promise<CompiledFlowItem[]> =>
    Promise.all(items.map(async (raw, index) => {
      if (!("flow" in raw)) {
        return compileStep(raw, index, source.timeoutMs);
      }
      const childPath = resolve(dirname(absolutePath), raw.flow);
      const child = await compileSingleActorFlowFileInternal(childPath, nextStack);
      if (child.knownFailure) {
        throw new FlowCompileError(
          `Referenced flow "${child.name}" cannot declare knownFailure; declare it on the root flow`,
          childPath,
        );
      }
      const unsupportedPlatforms = source.platforms.filter(
        (platform) => !child.platforms.includes(platform),
      );
      if (unsupportedPlatforms.length > 0) {
        throw new FlowCompileError(
          `Referenced flow "${child.name}" does not support: ${unsupportedPlatforms.join(", ")}`,
          childPath,
        );
      }
      return {
        id: `${String(index + 1).padStart(3, "0")}-flow`,
        kind: "flow" as const,
        sourcePath: childPath,
        flow: child,
      };
    }));

  return assembleSingleActorFlow(
    source,
    absolutePath,
    await compileItems(source.setup),
    await compileItems(source.steps),
    await compileItems(source.teardown),
  );
}

export async function compileSingleActorFlowFile(
  sourcePath: string,
): Promise<CompiledSingleActorFlow> {
  return compileSingleActorFlowFileInternal(sourcePath, []);
}

export async function compileCoordinatedFlowFile(
  sourcePath: string,
): Promise<CompiledCoordinatedFlow> {
  requireFlowPath(sourcePath);
  const absolutePath = resolve(sourcePath);
  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new FlowCompileError(
      `Could not read flow: ${error instanceof Error ? error.message : String(error)}`,
      absolutePath,
    );
  }
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    throw new FlowCompileError(
      `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      absolutePath,
    );
  }

  const parsed = coordinatedFlowSourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new FlowCompileError(
      `Invalid coordinated flow:\n${formatValidationError(parsed.error)}`,
      absolutePath,
    );
  }

  const source = parsed.data;
  validateKnownFailure(source.knownFailure, absolutePath);
  const flowDirectory = dirname(absolutePath);
  const providers: CompiledFixtureProvider[] = Object.entries(source.providers ?? {}).map(
    ([name, provider]) => {
      if ("command" in provider) {
        return {
          name,
          kind: "command" as const,
          command: provider.command,
          cwd: resolve(flowDirectory, provider.cwd ?? "."),
          timeoutMs: provider.timeoutMs ?? 30_000,
        };
      }
      if ("http" in provider) {
        return {
          name,
          kind: "http" as const,
          url: provider.http.url,
          headersFromEnv: provider.http.headersFromEnv ?? {},
          timeoutMs: provider.timeoutMs ?? 30_000,
        };
      }
      return {
        name,
        kind: provider.builtin,
        config: provider.config ?? {},
        timeoutMs: provider.timeoutMs ?? (provider.builtin === "challenge" ? 5_000 : 30_000),
      };
    },
  );
  const providerNames = new Set(providers.map((provider) => provider.name));
  const protections = Object.entries(source.protections ?? {}).map(
    ([name, protection]) => ({ name, ...protection }),
  );
  const fixtures = Object.entries(source.fixtures ?? {}).map(([name, fixture]) => {
    if (!providerNames.has(fixture.provider)) {
      throw new FlowCompileError(
        `Fixture "${name}" references unknown provider "${fixture.provider}"`,
        absolutePath,
      );
    }
    return {
      name,
      provider: fixture.provider,
      type: fixture.type,
      ...(fixture.input !== undefined ? { input: fixture.input } : {}),
    };
  });
  const fixtureNames = new Set(fixtures.map((fixture) => fixture.name));
  const fixtureByName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
  const actors = await Promise.all(
    Object.entries(source.actors).map(async ([name, actor]) => {
      const fixtureBindings = typeof actor === "string" ? {} : actor.fixtures ?? {};
      for (const [alias, fixture] of Object.entries(fixtureBindings)) {
        if (!fixtureNames.has(fixture)) {
          throw new FlowCompileError(
            `Actor "${name}" fixture alias "${alias}" references unknown fixture "${fixture}"`,
            absolutePath,
          );
        }
      }
      const actorFlow = await compileSingleActorFlowFile(
        resolve(flowDirectory, typeof actor === "string" ? actor : actor.flow),
      );
      if (actorFlow.knownFailure) {
        throw new FlowCompileError(
          `Actor "${name}" cannot declare knownFailure; declare it on the coordinated parent flow`,
          absolutePath,
        );
      }
      for (const entry of concreteSteps([
        ...actorFlow.setup,
        ...actorFlow.steps,
        ...actorFlow.teardown,
      ])) {
        if (entry.kind !== "receiveEmail" && entry.kind !== "receiveSms") continue;
        const fixtureType = entry.kind === "receiveEmail" ? "inbox" : "phone";
        const alias = String(entry.input.fixture);
        const fixtureName = fixtureBindings[alias];
        if (!fixtureName) {
          throw new FlowCompileError(
            `Actor "${name}" ${entry.kind} references unbound fixture alias "${alias}"`,
            absolutePath,
          );
        }
        if (fixtureByName.get(fixtureName)?.type !== fixtureType) {
          throw new FlowCompileError(
            `Actor "${name}" ${entry.kind} fixture alias "${alias}" must reference ${fixtureType === "inbox" ? "an" : "a"} ${fixtureType}`,
            absolutePath,
          );
        }
      }
      return {
        name,
        flow: actorFlow,
        fixtures: fixtureBindings,
        headers: typeof actor === "string" ? {} : actor.headers ?? {},
      };
    }),
  );
  const hash = createHash("sha256")
    .update(JSON.stringify({
      formatVersion: 1,
      name: source.name,
      tags: source.tags,
      knownFailure: source.knownFailure,
      providers,
      protections,
      fixtures,
      actors: actors.map((actor) => ({
        name: actor.name,
        hash: actor.flow.hash,
        fixtures: actor.fixtures,
        headers: actor.headers,
      })),
    }))
    .digest("hex");

  return {
    formatVersion: 1,
    name: source.name,
    ...(source.description ? { description: source.description } : {}),
    tags: source.tags,
    ...(source.knownFailure ? { knownFailure: source.knownFailure } : {}),
    sourcePath: absolutePath,
    hash,
    providers,
    protections,
    fixtures,
    actors,
  };
}

export async function compileFlowFile(sourcePath: string): Promise<CompiledFlow> {
  const absolutePath = resolve(sourcePath);
  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new FlowCompileError(
      `Could not read flow: ${error instanceof Error ? error.message : String(error)}`,
      absolutePath,
    );
  }

  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    throw new FlowCompileError(
      `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      absolutePath,
    );
  }

  if (typeof value === "object" && value !== null && "actors" in value) {
    return compileCoordinatedFlowFile(absolutePath);
  }
  return compileSingleActorFlowFile(absolutePath);
}
