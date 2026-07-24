import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
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
} from "@polymux/protocol";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface LinuxDriverOptions {
  pythonPath?: string;
  video?: boolean;
}

export interface LinuxDriverInspection {
  available: boolean;
  message: string;
  remedy?: string;
}

interface BridgeResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface BridgeElement {
  id: number;
  name: string;
  text: string;
  role: string;
  states: string[];
  rect: { x: number; y: number; width: number; height: number };
}

interface FoundElement {
  element: BridgeElement;
  strategy: LocatorStrategy;
}

const bridgeSource = String.raw`
import base64, json, os, shlex, signal, subprocess, sys, time
import gi
gi.require_version("Atspi", "2.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Atspi, Gdk

desktop = Atspi.get_desktop(0)
process = None
handles = {}
next_handle = 1

def children(node):
    try:
        return [node.get_child_at_index(i) for i in range(node.get_child_count())]
    except Exception:
        return []

def walk():
    roots = children(desktop)
    stack = list(reversed(roots))
    count = 0
    while stack and count < 20000:
        node = stack.pop()
        count += 1
        yield node
        stack.extend(reversed(children(node)))

def attrs(node):
    try:
        return dict(node.get_attributes())
    except Exception:
        return {}

def text(node):
    try:
        return node.get_text(0, -1) or ""
    except Exception:
        return ""

def states(node):
    result = []
    checks = {
        "VISIBLE": Atspi.StateType.VISIBLE,
        "SHOWING": Atspi.StateType.SHOWING,
        "ENABLED": Atspi.StateType.ENABLED,
        "SENSITIVE": Atspi.StateType.SENSITIVE,
        "FOCUSED": Atspi.StateType.FOCUSED,
        "SELECTED": Atspi.StateType.SELECTED,
        "CHECKED": Atspi.StateType.CHECKED,
        "EDITABLE": Atspi.StateType.EDITABLE,
    }
    try:
        state_set = node.get_state_set()
        for name, state in checks.items():
            if state_set.contains(state):
                result.append(name)
    except Exception:
        pass
    return result

def rect(node):
    try:
        value = node.get_extents(Atspi.CoordType.SCREEN)
        return {"x": value.x, "y": value.y, "width": value.width, "height": value.height}
    except Exception:
        return {"x": 0, "y": 0, "width": 0, "height": 0}

def serialize(node):
    global next_handle
    handle = next_handle
    next_handle += 1
    handles[handle] = node
    try:
        name = node.get_name() or ""
    except Exception:
        name = ""
    try:
        role = node.get_role_name() or ""
    except Exception:
        role = ""
    return {"id": handle, "name": name, "text": text(node), "role": role, "states": states(node), "rect": rect(node)}

def matches(node, strategy):
    kind = strategy.get("kind")
    value = str(strategy.get("value", ""))
    try:
        name = node.get_name() or ""
        role = node.get_role_name() or ""
    except Exception:
        return False
    properties = attrs(node)
    node_text = text(node)
    if kind == "role":
        wanted = str(strategy.get("role", "")).lower().replace("_", "-").replace(" ", "-")
        actual = role.lower().replace("_", "-").replace(" ", "-")
        aliases = {
            "button": {"push-button", "toggle-button"},
            "checkbox": {"check-box"},
            "combobox": {"combo-box"},
            "textbox": {"text", "entry", "password-text"},
        }
        expected_name = strategy.get("name")
        return (actual == wanted or actual in aliases.get(wanted, set())) and (expected_name is None or name == expected_name)
    if kind in ("label", "text"):
        return name == value or node_text == value or value in node_text
    if kind in ("id", "testId", "accessibilityId"):
        candidates = [name]
        for key in ("id", "accessible-id", "accessibility-id", "automation-id", "test-id"):
            if key in properties:
                candidates.append(str(properties[key]))
        return value in candidates
    return False

def find_all(strategy):
    return [node for node in walk() if matches(node, strategy)]

def action(node):
    try:
        count = node.get_n_actions()
        names = [node.get_action_name(i).lower() for i in range(count)]
        for wanted in ("click", "press", "activate", "open", "toggle"):
            if wanted in names:
                return bool(node.do_action(names.index(wanted)))
        if count:
            return bool(node.do_action(0))
    except Exception:
        pass
    bounds = rect(node)
    x = int(bounds["x"] + bounds["width"] / 2)
    y = int(bounds["y"] + bounds["height"] / 2)
    return bool(Atspi.generate_mouse_event(x, y, "b1c"))

def screenshot(bounds=None):
    window = Gdk.get_default_root_window()
    if window is None:
        raise RuntimeError("No graphical desktop is available")
    if bounds is None:
        x, y, width, height = 0, 0, window.get_width(), window.get_height()
    else:
        x, y = int(bounds["x"]), int(bounds["y"])
        width, height = max(1, int(bounds["width"])), max(1, int(bounds["height"]))
    pixbuf = Gdk.pixbuf_get_from_window(window, x, y, width, height)
    if pixbuf is None:
        raise RuntimeError("Could not capture the graphical desktop")
    data = pixbuf.save_to_bufferv("png", [], [])[1]
    return base64.b64encode(data).decode("ascii")

def source():
    import xml.etree.ElementTree as ET
    root = ET.Element("desktop")
    def append(parent, node, depth=0):
        if depth > 60:
            return
        try:
            element = ET.SubElement(parent, (node.get_role_name() or "unknown").replace(" ", "-"))
            element.set("name", node.get_name() or "")
            value = text(node)
            if value:
                element.set("text", value)
            for key, item in attrs(node).items():
                element.set(str(key), str(item))
            for child in children(node):
                append(element, child, depth + 1)
        except Exception:
            return
    for item in children(desktop):
        append(root, item)
    return ET.tostring(root, encoding="unicode")

def command(name, args):
    global process
    if name == "probe":
        window = Gdk.get_default_root_window()
        return {
            "backend": "AT-SPI",
            "desktop": desktop.get_name(),
            "applications": desktop.get_child_count(),
            "width": window.get_width() if window is not None else 0,
            "height": window.get_height() if window is not None else 0,
        }
    if name == "launch":
        app = args.get("app")
        if not app:
            raise RuntimeError("Linux launch requires an executable name or path")
        process = subprocess.Popen(shlex.split(app), start_new_session=True)
        return {"pid": process.pid}
    if name == "terminate":
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
        process = None
        return True
    if name == "find":
        found = find_all(args["strategy"])
        return serialize(found[0]) if found else None
    if name == "findAll":
        return [serialize(node) for node in find_all(args["strategy"])]
    if name == "inspect":
        node = handles.get(int(args["id"]))
        return serialize(node) if node is not None else None
    if name == "activate":
        node = handles[int(args["id"])]
        if not action(node):
            raise RuntimeError("The target has no usable activation action")
        return True
    if name == "enter":
        node = handles[int(args["id"])]
        if not node.set_text_contents(str(args.get("value", ""))):
            action(node)
            Atspi.generate_keyboard_event(0, str(args.get("value", "")), Atspi.KeySynthType.STRING)
        return True
    if name == "clear":
        node = handles[int(args["id"])]
        if not node.set_text_contents(""):
            raise RuntimeError("The target is not editable")
        return True
    if name == "key":
        value = str(args["value"])
        special = {"Enter": 65293, "Return": 65293, "Tab": 65289, "Escape": 65307, "Backspace": 65288, "Delete": 65535, "Up": 65362, "Down": 65364, "Left": 65361, "Right": 65363}
        if value in special:
            Atspi.generate_keyboard_event(special[value], None, Atspi.KeySynthType.SYM)
        else:
            Atspi.generate_keyboard_event(0, value, Atspi.KeySynthType.STRING)
        return True
    if name == "pointer":
        buttons = {"left": "b1c", "middle": "b2c", "right": "b3c"}
        return bool(Atspi.generate_mouse_event(int(args["x"]), int(args["y"]), buttons.get(args.get("button", "left"), "b1c")))
    if name == "mouseMove":
        return bool(Atspi.generate_mouse_event(int(args["x"]), int(args["y"]), "abs"))
    if name == "scroll":
        Atspi.generate_mouse_event(int(args["x"]), int(args["y"]), "abs")
        vertical = int(args.get("vertical", 0))
        horizontal = int(args.get("horizontal", 0))
        for _ in range(abs(vertical)):
            Atspi.generate_mouse_event(0, 0, "b5c" if vertical > 0 else "b4c")
        for _ in range(abs(horizontal)):
            Atspi.generate_mouse_event(0, 0, "b7c" if horizontal > 0 else "b6c")
        return True
    if name == "swipe":
        Atspi.generate_mouse_event(int(args["sx"]), int(args["sy"]), "abs")
        Atspi.generate_mouse_event(int(args["sx"]), int(args["sy"]), "b1p")
        Atspi.generate_mouse_event(int(args["ex"]), int(args["ey"]), "abs")
        Atspi.generate_mouse_event(int(args["ex"]), int(args["ey"]), "b1r")
        return True
    if name == "screenshot":
        bounds = None
        if args.get("id") is not None:
            bounds = rect(handles[int(args["id"])])
        return screenshot(bounds)
    if name == "source":
        return source()
    if name == "displaySize":
        window = Gdk.get_default_root_window()
        return {"width": window.get_width(), "height": window.get_height()}
    raise RuntimeError("Unsupported Linux command: " + name)

for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        value = command(request["command"], request.get("args", {}))
        response = {"id": request["id"], "ok": True, "value": value}
    except Exception as error:
        response = {"id": request.get("id", -1) if request else -1, "ok": False, "error": str(error)}
    print(json.dumps(response, separators=(",", ":")), flush=True)
`;

function input<T>(step: CompiledStep, key: string): T {
  return step.input[key] as T;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "artifact";
}

function pause(durationMs: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, durationMs));
}

function matchesSubset(actual: unknown, expected: JsonValue): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((item, index) => matchesSubset(actual[index], item));
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => matchesSubset((actual as Record<string, unknown>)[key], value));
}

class LinuxBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private stderr = "";

  constructor(pythonPath = "python3") {
    this.child = spawn(pythonPath, ["-u", "-c", bridgeSource], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let response: BridgeResponse;
      try {
        response = JSON.parse(line) as BridgeResponse;
      } catch {
        this.failAll(new RuntimeFailure(`Linux bridge returned invalid JSON: ${line}`));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new RuntimeFailure(response.error ?? "Linux bridge command failed"));
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-4000);
    });
    this.child.once("error", (error) => this.failAll(new RuntimeFailure(`Could not start Linux AT-SPI bridge`, { cause: error })));
    this.child.once("exit", (code, signal) => {
      this.failAll(new RuntimeFailure(`Linux AT-SPI bridge exited (${signal ?? code})${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  send<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify({ id, command, args })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(new RuntimeFailure("Could not write to Linux AT-SPI bridge", { cause: error }));
      });
    });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return;
    this.child.stdin.end();
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolveClose();
      }, 1000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }
}

export async function inspectLinuxDriver(options: LinuxDriverOptions = {}): Promise<LinuxDriverInspection> {
  if (process.platform !== "linux") {
    return { available: false, message: "The native Linux backend must run on Linux" };
  }
  const bridge = new LinuxBridge(options.pythonPath);
  try {
    const probe = await bridge.send<{ backend: string; width: number; height: number }>("probe");
    if (probe.width < 640 || probe.height < 480) {
      return {
        available: false,
        message: `${probe.backend} is available, but the desktop is only ${probe.width}×${probe.height}`,
        remedy: "Connect a display or run Polymux inside dbus-run-session and Xvfb.",
      };
    }
    return { available: true, message: `${probe.backend} desktop accessibility is available at ${probe.width}×${probe.height}` };
  } catch (error) {
    return {
      available: false,
      message: error instanceof Error ? error.message : String(error),
      remedy: "Install python3, python3-gi, gir1.2-atspi-2.0, and gir1.2-gtk-3.0, then run inside an active graphical desktop session.",
    };
  } finally {
    await bridge.close();
  }
}

class LinuxSession implements DriverSession {
  private constructor(private readonly context: DriverSessionContext, private readonly bridge: LinuxBridge) {}

  static async create(context: DriverSessionContext, options: LinuxDriverOptions): Promise<LinuxSession> {
    if (process.platform !== "linux") throw new RuntimeFailure("The native Linux backend must run on Linux");
    const launch = executableSteps(context.plan).find((step) => step.kind === "launch");
    if (launch?.input.clearState) throw new FlowFailure("Linux applications do not have a portable clearState operation");
    const bridge = new LinuxBridge(options.pythonPath);
    try {
      await bridge.send("probe");
      await bridge.send("launch", { app: launch?.input.app });
      return new LinuxSession(context, bridge);
    } catch (error) {
      await bridge.close();
      throw error;
    }
  }

  private async find(target: CompiledTarget, optional = false): Promise<FoundElement | undefined> {
    const attempted: LocatorStrategy[] = [];
    for (const strategy of target.strategies) {
      if (strategy.kind === "css" || strategy.kind === "image") continue;
      attempted.push(strategy);
      const element = await this.bridge.send<BridgeElement | null>("find", { strategy });
      if (element) return { element, strategy };
    }
    if (optional) return undefined;
    throw new FlowFailure(`Linux target was not found using ${attempted.map((item) => item.kind).join(", ")}`);
  }

  private async findAll(target: CompiledTarget): Promise<{ elements: BridgeElement[]; strategy?: LocatorStrategy }> {
    for (const strategy of target.strategies) {
      if (strategy.kind === "css" || strategy.kind === "image") continue;
      const elements = await this.bridge.send<BridgeElement[]>("findAll", { strategy });
      if (elements.length) return { elements, strategy };
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

  private displayed(element: BridgeElement): boolean {
    return element.states.includes("VISIBLE") && element.states.includes("SHOWING");
  }

  private enabled(element: BridgeElement): boolean {
    return element.states.includes("ENABLED") && element.states.includes("SENSITIVE");
  }

  private async refresh(id: number): Promise<BridgeElement | undefined> {
    return (await this.bridge.send<BridgeElement | null>("inspect", { id })) ?? undefined;
  }

  private async screenshot(name: string, target?: CompiledTarget): Promise<string> {
    const directory = join(this.context.artifactsDir, "screenshots");
    await mkdir(directory, { recursive: true });
    const found = target ? await this.find(target) : undefined;
    const encoded = await this.bridge.send<string>("screenshot", found ? { id: found.element.id } : {});
    const path = join(directory, `${safeName(name)}.png`);
    await writeFile(path, Buffer.from(encoded, "base64"));
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
        const current = await this.refresh(found.element.id);
        return state === "hidden" ? !current || !this.displayed(current) : !current;
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
    const current = (await this.refresh(found.element.id)) ?? found.element;
    if (state === "visible" && !this.displayed(current)) throw new FlowFailure("Expected target to be visible");
    if (state === "enabled" && !this.enabled(current)) throw new FlowFailure("Expected target to be enabled");
    if (state === "disabled" && this.enabled(current)) throw new FlowFailure("Expected target to be disabled");
    if ("text" in step.input && !current.text.includes(input<string>(step, "text"))) throw new FlowFailure(`Expected target text to include "${input<string>(step, "text")}"`);
    if ("value" in step.input && current.text !== String(input<unknown>(step, "value"))) throw new FlowFailure(`Expected target value to equal "${String(input<unknown>(step, "value"))}"`);
    return { selectedStrategy: countStrategy ?? found.strategy };
  }

  private async executeRequest(step: CompiledStep): Promise<DriverExecutionResult> {
    const rawUrl = input<string>(step, "url");
    let url: string;
    try { url = new URL(rawUrl, this.context.baseUrl).toString(); }
    catch { throw new FlowFailure(`Relative URL requires a base URL: ${rawUrl}`); }
    const method = input<string>(step, "method");
    const headers = { ...input<Record<string, string> | undefined>(step, "headers") };
    const body = input<JsonValue | undefined>(step, "body");
    if (body !== undefined && !("content-type" in headers)) headers["content-type"] = "application/json";
    const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(step.timeoutMs) });
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
    let baseline: PNG;
    try { baseline = PNG.sync.read(await readFile(baselinePath)); }
    catch { throw new FlowFailure(`Visual baseline is missing: ${baselinePath}. Run with --update-snapshots to create it.`); }
    const actual = PNG.sync.read(await readFile(actualPath));
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
    if (step.kind === "terminate") { await this.bridge.send("terminate"); return; }
    if (step.kind === "activate" || step.kind === "enter" || step.kind === "clear") {
      const found = (await this.find(input<CompiledTarget>(step, "target")))!;
      await this.bridge.send(step.kind, { id: found.element.id, ...(step.kind === "enter" ? { value: input<string>(step, "value") } : {}) });
      return { selectedStrategy: found.strategy };
    }
    if (step.kind === "select") {
      const target = (await this.find(input<CompiledTarget>(step, "target")))!;
      await this.bridge.send("activate", { id: target.element.id });
      for (const value of [input<string | string[]>(step, "value")].flat()) {
        const option = (await this.find({ strategies: [{ kind: "text", value }] }))!;
        await this.bridge.send("activate", { id: option.element.id });
      }
      return { selectedStrategy: target.strategy };
    }
    if (step.kind === "key") { await this.bridge.send("key", { value: input<string>(step, "value") }); return; }
    if (step.kind === "pointer") { await this.bridge.send("pointer", { x: input<number>(step, "x"), y: input<number>(step, "y"), button: input<string | undefined>(step, "button") }); return; }
    if (step.kind === "scroll" || step.kind === "swipe") {
      const target = input<CompiledTarget | undefined>(step, "target");
      const bounds: { x: number; y: number; width: number; height: number } = target
        ? (await this.find(target))!.element.rect
        : { x: 0, y: 0, ...(await this.bridge.send<{ width: number; height: number }>("displaySize")) };
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      if (step.kind === "scroll") {
        await this.bridge.send("scroll", { x, y, horizontal: Math.sign(input<number | undefined>(step, "x") ?? 0), vertical: Math.sign(input<number | undefined>(step, "y") ?? 500) });
      } else {
        const distance = input<number | undefined>(step, "distance") ?? 300;
        const direction = input<"up" | "down" | "left" | "right">(step, "direction");
        const dx = direction === "left" ? -distance : direction === "right" ? distance : 0;
        const dy = direction === "up" ? -distance : direction === "down" ? distance : 0;
        await this.bridge.send("swipe", { sx: x, sy: y, ex: x + dx, ey: y + dy });
      }
      return;
    }
    if (step.kind === "drag") {
      const from = (await this.find(input<CompiledTarget>(step, "from")))!;
      const to = (await this.find(input<CompiledTarget>(step, "to")))!;
      const a = from.element.rect; const b = to.element.rect;
      await this.bridge.send("swipe", { sx: a.x + a.width / 2, sy: a.y + a.height / 2, ex: b.x + b.width / 2, ey: b.y + b.height / 2 });
      return { selectedStrategy: from.strategy };
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
          const current = await this.refresh(found.element.id);
          return state === "hidden" ? !current || !this.displayed(current) : !current;
        }, step.timeoutMs, `Expected target to be ${state}`);
        return;
      }
      const found = await this.poll(() => this.find(target, true), step.timeoutMs, `Expected target to be ${state}`);
      if (state === "visible") await this.poll(async () => this.displayed((await this.refresh(found.element.id)) ?? found.element), step.timeoutMs, "Expected target to be visible");
      return { selectedStrategy: found.strategy };
    }
    if (step.kind === "expect") return this.executeExpect(step);
    if (step.kind === "screenshot") return { artifacts: [await this.screenshot(input<string>(step, "name"), input<CompiledTarget | undefined>(step, "target"))] };
    if (step.kind === "request") return this.executeRequest(step);
    if (step.kind === "stabilize") {
      const deadline = Date.now() + step.timeoutMs;
      let previous: string | undefined; let stable = 0;
      do {
        const image = await this.bridge.send<string>("screenshot");
        const hash = createHash("sha256").update(image).digest("hex");
        stable = hash === previous ? stable + 1 : 0;
        if (stable >= 2) return;
        previous = hash;
        await pause(input<number>(step, "intervalMs"));
      } while (Date.now() < deadline);
      throw new FlowFailure(`The screen did not become stable within ${step.timeoutMs} ms`);
    }
    if (step.kind === "visual") return this.executeVisual(step);
    if (step.kind === "platform") {
      const command = input<string>(step, "command");
      const args = input<Record<string, JsonValue> | undefined>(step, "args") ?? {};
      if (command === "mouseScroll") {
        const display = await this.bridge.send<{ width: number; height: number }>("displaySize");
        await this.bridge.send("scroll", {
          x: display.width / 2,
          y: display.height / 2,
          horizontal: -Number(args.moveLeftSteps ?? 0),
          vertical: -Number(args.moveUpSteps ?? 0),
        });
      } else {
        const names: Record<string, string> = { getDisplaySize: "displaySize", source: "source", mouseMove: "mouseMove", mouseSwipe: "swipe" };
        await this.bridge.send(names[command] ?? command, args);
      }
      return;
    }
    throw new RuntimeFailure(`Linux driver cannot execute ${step.kind}`);
  }

  async captureFailure(step: CompiledStep): Promise<string[]> {
    return [await this.screenshot(`failure-${step.id}`)];
  }

  async close(): Promise<void> {
    try { await this.bridge.send("terminate"); }
    finally { await this.bridge.close(); }
  }
}

export class LinuxDriver implements Driver {
  readonly id = "linux.atspi";
  readonly platform = "linux" as const;
  readonly capabilities: ReadonlySet<Capability>;

  constructor(private readonly options: LinuxDriverOptions = {}) {
    if (options.video) throw new RuntimeFailure("Video recording is not supported by the native Linux backend");
    this.capabilities = new Set<Capability>([
      capabilities.launch,
      capabilities.terminate,
      capabilities.activate,
      capabilities.enter,
      capabilities.select,
      capabilities.clear,
      capabilities.key,
      capabilities.pointer,
      capabilities.scroll,
      capabilities.swipe,
      capabilities.drag,
      capabilities.wait,
      capabilities.expect,
      capabilities.screenshot,
      capabilities.request,
      capabilities.stabilize,
      capabilities.visual,
      "extension.linux.*",
    ]);
  }

  createSession(context: DriverSessionContext): Promise<DriverSession> {
    return LinuxSession.create(context, this.options);
  }
}
