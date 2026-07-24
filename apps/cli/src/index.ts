#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { constants, readFileSync, watch, type FSWatcher } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import {
  inspectWebDriver,
  WebDriver,
  type WebBrowserName,
} from "@polymux/adapter-web";
import {
  AppiumDriver,
  type AppiumPlatform,
} from "@polymux/adapter-appium";
import { inspectLinuxDriver, LinuxDriver } from "@polymux/adapter-linux";
import {
  buildFlowFiles,
  compileFlowFile,
  discoverFlows,
  type Driver,
  FlowCompileError,
} from "@polymux/core";
import {
  platforms,
  type CompiledFlow,
  type JsonValue,
  type Platform,
  type RunEvent,
  type RunResult,
} from "@polymux/protocol";
import {
  effectiveRunStatus,
  runCoordinatedFlowInstances,
  runSingleActorFlowFiles,
} from "@polymux/runner";
import { Command } from "commander";
import { authStatus, login, logout } from "./auth.js";
import { maybeNotifyUpdate, updateCli } from "./update.js";
import { cleanRuns, diagnoseRun, listRuns, reportRun, showRun } from "./runs.js";
import { configDoctor, configValue, getConfig, listConfig, printConfigPath, setConfig, unsetConfig } from "./config.js";
import { completionStatus, installCompletion, printCompletion, uninstallCompletion } from "./completion.js";
import { runCrawl } from "./crawl.js";
import { initializeAccess, loadProjectAccessEnvironment, printAccessResult } from "./access.js";
import {
  discoverLocalDevices,
  printDevices,
  targetCapabilities,
} from "./devices.js";
import { writeJUnit } from "./junit.js";
import {
  changeDrivers,
  inspectDriverSetup,
  type DriverSetupReport,
} from "./drivers.js";
import { startTelemetry, type TelemetrySession } from "./telemetry.js";

interface SharedOptions {
  projectDir: string;
}

interface TagOptions {
  includeTags: string[];
  excludeTags: string[];
}

interface RunOptions extends SharedOptions, TagOptions {
  appiumUrl?: string;
  browser?: WebBrowserName;
  capabilities?: Record<string, JsonValue>;
  device?: string;
  url?: string;
  headed?: boolean;
  json?: boolean;
  quiet?: boolean;
  watch?: boolean;
  output?: string;
  platform: Platform;
  updateSnapshots?: boolean;
  video?: boolean;
  repeat?: number;
  junit?: string;
  target?: string;
}

interface DevOptions extends RunOptions {
  command?: string;
  start: boolean;
  debounceMs: number;
  waitMs: number;
}

interface DoctorOptions extends SharedOptions {
  appiumUrl?: string;
  json: boolean;
}

type DoctorStatus = "passed" | "warning" | "failed";

interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  remedy?: string;
}

interface ExecutionTarget {
  id: string;
  available: boolean;
  message: string;
}

interface DoctorReport {
  status: DoctorStatus;
  version: string;
  projectDir: string;
  checks: DoctorCheck[];
  driverSetup: DriverSetupReport;
  targets: ExecutionTarget[];
}

const cliPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
const cliVersion = typeof cliPackage.version === "string" ? cliPackage.version : "0.0.0";

const generatedDirectories = new Set([
  ".git",
  ".polymux",
  ".svelte-kit",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const sourceExtensions = new Set([
  ".astro",
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);

function icon(
  status: RunResult["status"],
  knownFailure?: RunResult["knownFailure"],
): string {
  if (knownFailure?.outcome === "expected-failure") return "~";
  if (knownFailure?.outcome === "unexpected-pass") return "!";
  if (status === "passed") return "✓";
  if (status === "failed") return "✗";
  return "!";
}

function stepIcon(status: string): string {
  if (status === "passed") return "✓";
  if (status === "skipped") return "–";
  if (status === "failed") return "✗";
  return "!";
}

function eventReporter(quiet: boolean): (event: RunEvent) => void {
  return (event) => {
    if (quiet) return;
    if (event.type === "run.started") {
      const label = event.actor ? `${event.actor}: ${event.flow}` : event.flow;
      process.stdout.write(`\n${label}${event.instance ? ` #${event.instance}` : ""}\n`);
    }
    if (event.type === "step.finished") {
      const result = event.result;
      const suffix = result.error?.message ?? result.message ?? "";
      process.stdout.write(
        `  ${event.actor ? `[${event.actor}] ` : ""}${stepIcon(result.status)} ${result.id.padEnd(22)} ${String(result.durationMs).padStart(5)} ms${suffix ? `  ${suffix}` : ""}\n`,
      );
    }
  };
}

function printSummary(runs: RunResult[], projectDir: string): void {
  process.stdout.write("\n");
  for (const run of runs) {
    const report = relative(projectDir, resolve(run.artifactsDir, "report.html"));
    process.stdout.write(
      `${icon(run.status, run.knownFailure)} ${run.flow}  ${run.durationMs} ms${run.knownFailure ? `  Known failure: ${run.knownFailure.outcome}` : ""}\n  Report: ${report}\n`,
    );
  }
  const conclusions = runs.map(effectiveRunStatus);
  const passed = conclusions.filter((status) => status === "passed").length;
  const failed = conclusions.filter((status) => status === "failed").length;
  const errors = conclusions.filter((status) => status === "error").length;
  const known = runs.filter(
    (run) => run.knownFailure?.outcome === "expected-failure",
  ).length;
  process.stdout.write(
    `\n${passed} passed, ${failed} failed, ${errors} errors${known ? `, ${known} known failures` : ""}\n`,
  );
}

async function selectFlowFiles(
  selectors: string[],
  options: SharedOptions,
): Promise<string[]> {
  const projectDir = resolve(options.projectDir);
  if (selectors.length === 0) return discoverFlows(projectDir);

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const selector of selectors) {
    for (const file of await discoverFlows(projectDir, selector)) {
      const absolute = resolve(file);
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      selected.push(absolute);
    }
  }
  return selected;
}

function matchesTags(flow: CompiledFlow, options: TagOptions): boolean {
  if (
    options.includeTags.length > 0 &&
    !options.includeTags.some((tag) => flow.tags.includes(tag))
  ) {
    return false;
  }
  return !options.excludeTags.some((tag) => flow.tags.includes(tag));
}

async function filterFlowFiles(
  files: string[],
  options: TagOptions,
): Promise<{ files: string[]; flows: CompiledFlow[] }> {
  const flows = await Promise.all(files.map((file) => compileFlowFile(file)));
  const selected = files
    .map((file, index) => ({ file, flow: flows[index]! }))
    .filter(({ flow }) => matchesTags(flow, options));
  if (
    selected.length === 0 &&
    (options.includeTags.length > 0 || options.excludeTags.length > 0)
  ) {
    throw new FlowCompileError(
      `No flows matched the requested tags`,
    );
  }
  return {
    files: selected.map(({ file }) => file),
    flows: selected.map(({ flow }) => flow),
  };
}

async function runOnce(
  selectors: string[],
  options: RunOptions,
): Promise<number> {
  const projectDir = resolve(options.projectDir);
  const discovered = await selectFlowFiles(selectors, options);
  if (discovered.length === 0) {
    throw new FlowCompileError(
      `No flows found under ${resolve(projectDir, "polymux")}`,
    );
  }
  const selected = await filterFlowFiles(discovered, options);
  const files = selected.files;
  const compiled = selected.flows;
  if (options.target) {
    if (options.platform === "web") {
      throw new Error("--target selects native hardware and cannot be used with --platform web");
    }
    const inventory = await discoverLocalDevices(options.platform);
    const target = inventory.devices.find((device) => device.id === options.target);
    if (!target) {
      throw new Error(
        `Local ${options.platform} target "${options.target}" was not found; run polymux devices --platform ${options.platform}`,
      );
    }
    if (!target.available) {
      throw new Error(
        `Local target "${options.target}" is not available (${target.state})`,
      );
    }
    options = {
      ...options,
      capabilities: {
        ...(options.capabilities ?? {}),
        ...targetCapabilities(target),
      },
    };
  }
  const driver = createDriver(options);
  const singleActorFiles = files.filter((_file, index) => !("actors" in compiled[index]!));
  const coordinatedFlows = compiled.filter((flow) => "actors" in flow);
  await loadProjectAccessEnvironment(
    projectDir,
    coordinatedFlows.flatMap((flow) =>
      flow.protections.flatMap((protection) => Object.values(protection.headersFromEnv)),
    ),
  );
  const shared = {
    projectDir,
    ...(options.url ? { baseUrl: options.url } : {}),
    ...(options.output ? { artifactsRoot: options.output } : {}),
    updateSnapshots: options.updateSnapshots ?? false,
    ...(!options.json ? { onEvent: eventReporter(options.quiet ?? false) } : {}),
  };
  const singleBatch = singleActorFiles.length > 0
    ? await runSingleActorFlowFiles(singleActorFiles, driver, {
        ...shared,
        repeat: options.repeat ?? 1,
      })
    : undefined;
  const coordinatedBatches = [];
  for (const flow of coordinatedFlows) {
    const batch = await runCoordinatedFlowInstances(flow, driver, {
      ...shared,
      instances: options.repeat ?? 1,
    });
    coordinatedBatches.push(batch);
  }
  const results = [
    ...(singleBatch?.runs ?? []),
    ...coordinatedBatches.flatMap((batch) => batch.runs),
  ];
  const statuses = [
    ...(singleBatch ? [singleBatch.status] : []),
    ...coordinatedBatches.map((batch) => batch.status),
  ];
  const status = statuses.includes("error")
    ? "error"
    : statuses.includes("failed")
      ? "failed"
      : "passed";
  const junitPath = options.junit
    ? await writeJUnit(results, options.junit, projectDir)
    : undefined;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        status,
        ...(junitPath ? { junit: junitPath } : {}),
        runs: results,
      }, null, 2)}\n`,
    );
  } else {
    if (singleBatch) printSummary(singleBatch.runs, projectDir);
    for (const batch of coordinatedBatches) {
      process.stdout.write("\n");
      for (const result of batch.runs) {
        const report = relative(projectDir, resolve(result.artifactsDir, "report.html"));
        process.stdout.write(
          `${icon(result.status, result.knownFailure)} ${result.flow} #${result.instance}  ${result.durationMs} ms${result.knownFailure ? `  Known failure: ${result.knownFailure.outcome}` : ""}\n  Report: ${report}\n`,
        );
        for (const { actor, run } of result.actors) {
          process.stdout.write(`  ${icon(run.status, run.knownFailure)} ${actor}: ${run.flow}  ${run.durationMs} ms\n`);
        }
      }
    }
    if (junitPath) {
      process.stdout.write(`\nJUnit: ${relative(projectDir, junitPath)}\n`);
    }
  }
  return status === "passed" ? 0 : status === "failed" ? 1 : 2;
}

async function runWithWatch(
  selectors: string[],
  options: RunOptions,
): Promise<void> {
  const projectDir = resolve(options.projectDir);
  let running = false;
  let queued = false;
  let selectionFailed = false;
  const execute = async (): Promise<void> => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      process.exitCode = await runOnce(selectors, options);
    } catch (error) {
      reportError(error);
      process.exitCode = 2;
      selectionFailed = true;
    } finally {
      running = false;
      if (queued) {
        queued = false;
        await execute();
      }
    }
  };

  await execute();
  if (selectionFailed) return;
  process.stdout.write("\nWatching Polymux flows…\n");
  let debounce: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  await new Promise<void>((resolveLoop) => {
    let finished = false;
    const finish = (exitCode: number) => {
      if (finished) return;
      finished = true;
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      process.exitCode = exitCode;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      resolveLoop();
    };
    const onInterrupt = () => finish(130);
    const onTerminate = () => finish(143);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);

    try {
      watcher = watch(projectDir, { recursive: true }, (_event, filename) => {
        const normalized = filename?.replaceAll("\\", "/");
        if (
          !normalized ||
          (normalized !== "polymux.yaml" && !normalized.startsWith("polymux/"))
        ) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void execute(), 100);
      });
    } catch (error) {
      reportError(error);
      finish(2);
      return;
    }
    watcher.once("error", (error) => {
      reportError(error);
      finish(2);
    });
  });
}

function numericOption(value: string): number {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Expected a non-negative number, received "${value}"`);
  }
  return number;
}

function positiveNumericOption(value: string): number {
  const number = numericOption(value);
  if (number < 1) throw new Error(`Expected a positive number, received "${value}"`);
  return number;
}

function tagListOption(value: string, previous: string[]): string[] {
  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  for (const tag of tags) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(tag)) {
      throw new Error(
        `Tags must use lowercase letters, numbers, and hyphens, received "${tag}"`,
      );
    }
  }
  return [...new Set([...previous, ...tags])];
}

function browserOption(value: string): WebBrowserName {
  if (value === "chromium" || value === "firefox" || value === "webkit") {
    return value;
  }
  throw new Error(
    `Expected chromium, firefox, or webkit, received "${value}"`,
  );
}

function platformOption(value: string): Platform {
  if ((platforms as readonly string[]).includes(value)) return value as Platform;
  throw new Error(`Expected ${platforms.join(", ")}, received "${value}"`);
}

function jsonObjectOption(value: string): Record<string, JsonValue> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Expected a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed as Record<string, JsonValue>;
}

function createDriver(options: RunOptions): Driver {
  if (options.platform === "web") {
    return new WebDriver({
      headless: !options.headed,
      ...(options.browser ? { browser: options.browser } : {}),
      ...(options.device ? { device: options.device } : {}),
      video: options.video ?? false,
    });
  }
  if (options.platform === "linux" && !options.appiumUrl) {
    return new LinuxDriver({ video: options.video ?? false });
  }
  return new AppiumDriver({
    platform: options.platform as AppiumPlatform,
    ...(options.appiumUrl ? { serverUrl: options.appiumUrl } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    video: options.video ?? false,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function doctorStatus(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "failed")) return "failed";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "passed";
}

async function inspectDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const projectDir = resolve(options.projectDir);
  const checks: DoctorCheck[] = [
    {
      id: "cli",
      label: "CLI",
      status: "passed",
      message: `Polymux ${cliVersion}`,
    },
  ];

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push(
    nodeMajor >= 22
      ? {
          id: "node",
          label: "Node.js",
          status: "passed",
          message: process.versions.node,
        }
      : {
          id: "node",
          label: "Node.js",
          status: "failed",
          message: `${process.versions.node} is unsupported`,
          remedy: "Install Node.js 22 or newer.",
        },
  );

  let projectReady = false;
  try {
    projectReady = (await stat(projectDir)).isDirectory();
  } catch {
    projectReady = false;
  }
  checks.push(
    projectReady
      ? {
          id: "project",
          label: "Project",
          status: "passed",
          message: projectDir,
        }
      : {
          id: "project",
          label: "Project",
          status: "failed",
          message: `${projectDir} is not a directory`,
          remedy: "Pass an existing directory with --project-dir.",
        },
  );

  if (projectReady) {
    const flows = await discoverFlows(projectDir);
    checks.push(
      flows.length > 0
        ? {
            id: "flows",
            label: "Flows",
            status: "passed",
            message: `${flows.length} found`,
          }
        : {
            id: "flows",
            label: "Flows",
            status: "warning",
            message: `None found under ${resolve(projectDir, "polymux")}`,
            remedy: "Run polymux init, then add a .flow.yaml file.",
          },
    );

    const stateDir = resolve(projectDir, ".polymux");
    const accessTarget = (await pathExists(stateDir)) ? stateDir : projectDir;
    try {
      await access(accessTarget, constants.R_OK | constants.W_OK);
      checks.push({
        id: "artifacts",
        label: "Artifacts",
        status: "passed",
        message: `${accessTarget} is writable`,
      });
    } catch {
      checks.push({
        id: "artifacts",
        label: "Artifacts",
        status: "failed",
        message: `${accessTarget} is not writable`,
        remedy: "Grant write access or choose a writable project directory.",
      });
    }
  } else {
    checks.push({
      id: "flows",
      label: "Flows",
      status: "warning",
      message: "Not checked because the project directory is unavailable",
    });
    checks.push({
      id: "artifacts",
      label: "Artifacts",
      status: "failed",
      message: "Not checked because the project directory is unavailable",
    });
  }

  const browserNames = ["chromium", "firefox", "webkit"] as const;
  const browserInspections = await Promise.all(
    browserNames.map(async (browser) => {
      try {
        const inspection = await inspectWebDriver(browser);
        return {
          available: inspection.installed,
          check: inspection.installed
            ? {
                id: `web-driver-${browser}`,
                label: `Web driver (${browser})`,
                status: "passed" as const,
                message: `Installed at ${inspection.executablePath}`,
              }
            : {
                id: `web-driver-${browser}`,
                label: `Web driver (${browser})`,
                status: "failed" as const,
                message: `${browser} is not installed`,
                remedy: `Run npx playwright install ${browser}.`,
              },
        };
      } catch (error) {
        return {
          available: false,
          check: {
            id: `web-driver-${browser}`,
            label: `Web driver (${browser})`,
            status: "failed" as const,
            message: error instanceof Error ? error.message : String(error),
            remedy: "Reinstall Polymux and its browser dependencies.",
          },
        };
      }
    }),
  );
  checks.push(...browserInspections.map((inspection) => inspection.check));
  const webAvailable = browserInspections.every((inspection) => inspection.available);

  const appiumUrl = options.appiumUrl ?? "http://127.0.0.1:4723";
  let appiumAvailable = false;
  try {
    const response = await fetch(new URL("status", `${appiumUrl.replace(/\/$/, "")}/`), {
      signal: AbortSignal.timeout(750),
    });
    appiumAvailable = response.ok;
  } catch {
    appiumAvailable = false;
  }

  let linuxAvailable = false;
  if (process.platform === "linux") {
    const inspection = await inspectLinuxDriver();
    linuxAvailable = inspection.available;
    checks.push({
      id: "linux-driver",
      label: "Linux driver",
      status: inspection.available ? "passed" : "failed",
      message: inspection.message,
      ...(inspection.remedy ? { remedy: inspection.remedy } : {}),
    });
  }

  const targets: ExecutionTarget[] = [
    {
      id: "web-local",
      available: webAvailable,
      message: webAvailable
        ? "Chromium, Firefox, and WebKit are ready"
        : "One or more browser engines are unavailable",
    },
    {
      id: "appium-native",
      available: appiumAvailable,
      message: appiumAvailable
        ? `Appium is reachable at ${appiumUrl}; the selected platform driver must also be installed`
        : `Appium is not reachable at ${appiumUrl}`,
    },
    {
      id: "linux-native",
      available: linuxAvailable,
      message:
        process.platform === "linux"
          ? linuxAvailable
            ? "The direct AT-SPI backend is ready"
            : "The direct AT-SPI backend is unavailable"
          : "Run Polymux on a Linux graphical desktop",
    },
    {
      id: "cloud",
      available: false,
      message: "Cloud execution is not implemented yet",
    },
  ];

  return {
    status: doctorStatus(checks),
    version: cliVersion,
    projectDir,
    checks,
    driverSetup: await inspectDriverSetup(),
    targets,
  };
}

function printDoctor(report: DoctorReport): void {
  process.stdout.write(`Polymux doctor\n\n`);
  for (const check of report.checks) {
    const marker =
      check.status === "passed" ? "✓" : check.status === "warning" ? "!" : "✗";
    process.stdout.write(`${marker} ${check.label}: ${check.message}\n`);
    if (check.remedy) process.stdout.write(`  ${check.remedy}\n`);
  }
  process.stdout.write("\nExecution targets\n");
  for (const target of report.targets) {
    process.stdout.write(
      `${target.available ? "✓" : "–"} ${target.id}: ${target.message}\n`,
    );
  }
  process.stdout.write("\nAppium driver setup\n");
  process.stdout.write(
    report.driverSetup.appiumInstalled
      ? `✓ Appium CLI: ${report.driverSetup.appiumVersion ?? "installed"}\n`
      : "– Appium CLI: not installed\n",
  );
  if (!report.driverSetup.appiumInstalled) {
    process.stdout.write(
      `  Install: ${report.driverSetup.appiumInstallCommand}\n`,
    );
  }
  if (report.driverSetup.inspectionError) {
    process.stdout.write(
      `! Driver inventory: ${report.driverSetup.inspectionError}\n`,
    );
  }
  for (const driver of report.driverSetup.drivers) {
    const marker =
      driver.state === "installed"
        ? "✓"
        : driver.state === "unavailable"
          ? "–"
          : driver.state === "unknown"
            ? "!"
            : "○";
    process.stdout.write(`${marker} ${driver.label}: ${driver.message}\n`);
    if (driver.installCommand) {
      process.stdout.write(`  Install: ${driver.installCommand}\n`);
    }
    if (driver.uninstallCommand) {
      process.stdout.write(`  Uninstall: ${driver.uninstallCommand}\n`);
    }
  }
  if (report.driverSetup.installAllCommand) {
    process.stdout.write(
      `\nInstall everything available: ${report.driverSetup.installAllCommand}\n`,
    );
  }
  if (report.driverSetup.uninstallAllCommand) {
    process.stdout.write(
      `Uninstall all installed drivers: ${report.driverSetup.uninstallAllCommand}\n`,
    );
  }
}

function printDriverAction(
  report: Awaited<ReturnType<typeof changeDrivers>>,
): void {
  if (report.results.length === 0) {
    process.stdout.write(
      report.action === "install"
        ? "No compatible drivers need to be installed.\n"
        : "No compatible installed drivers were found.\n",
    );
    return;
  }
  for (const result of report.results) {
    process.stdout.write(
      `${result.status === "changed" ? "✓" : "–"} ${result.message}\n`,
    );
  }
}

async function addPackageScripts(projectDir: string): Promise<string[]> {
  const packagePath = resolve(projectDir, "package.json");
  let raw: string;
  try {
    raw = await readFile(packagePath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }

  const packageJson = JSON.parse(raw) as {
    scripts?: Record<string, string>;
    [key: string]: unknown;
  };
  const scripts = packageJson.scripts ?? {};
  packageJson.scripts = scripts;
  const defaults = {
    "polymux:build": "polymux build",
    "polymux:dev": "polymux dev",
    "polymux:run": "polymux run",
  };
  const added: string[] = [];
  for (const [name, command] of Object.entries(defaults)) {
    if (scripts[name]) continue;
    scripts[name] = command;
    added.push(name);
  }
  if (added.length === 0) return [];

  const indentation = raw.match(/\n([\t ]+)"/)?.[1] ?? "  ";
  const newline = raw.endsWith("\n") ? "\n" : "";
  await writeFile(
    packagePath,
    `${JSON.stringify(packageJson, null, indentation)}${newline}`,
    "utf8",
  );
  return added;
}

async function ensureProjectConfig(projectDir: string): Promise<boolean> {
  const path = resolve(projectDir, "polymux.yaml");
  try {
    await writeFile(
      path,
      "# yaml-language-server: $schema=./.polymux/schema/config-v1.schema.json\nversion: 1\n",
      { encoding: "utf8", flag: "wx" },
    );
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "EEXIST") return false;
    throw error;
  }
}

async function installProjectSchema(projectDir: string): Promise<string> {
  const schemaDirectory = resolve(projectDir, ".polymux", "schema");
  const schemaPath = resolve(schemaDirectory, "config-v1.schema.json");
  const bundledSchema = new URL("../schema/config-v1.schema.json", import.meta.url);
  const fixtureSchemaPath = resolve(schemaDirectory, "fixture-v1.schema.json");
  const fixtureSchema = createRequire(import.meta.url).resolve(
    "@polymux/protocol/schemas/fixture-v1.schema.json",
  );
  await mkdir(schemaDirectory, { recursive: true });
  await Promise.all([
    writeFile(schemaPath, await readFile(bundledSchema, "utf8"), "utf8"),
    writeFile(
      fixtureSchemaPath,
      await readFile(fixtureSchema, "utf8"),
      "utf8",
    ),
  ]);
  return schemaPath;
}

async function packageManagerCommand(projectDir: string): Promise<string> {
  if (await pathExists(resolve(projectDir, "pnpm-lock.yaml"))) {
    return "pnpm dev";
  }
  if (await pathExists(resolve(projectDir, "yarn.lock"))) {
    return "yarn dev";
  }
  if (
    (await pathExists(resolve(projectDir, "bun.lock"))) ||
    (await pathExists(resolve(projectDir, "bun.lockb")))
  ) {
    return "bun run dev";
  }
  return "npm run dev";
}

async function devCommand(
  projectDir: string,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;
  const packagePath = resolve(projectDir, "package.json");
  let packageJson: { scripts?: Record<string, string> };
  try {
    packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  } catch {
    throw new Error(
      "No package.json was found. Pass --command or use --no-start.",
    );
  }
  if (!packageJson.scripts?.dev) {
    throw new Error(
      'No "dev" package script was found. Pass --command or use --no-start.',
    );
  }
  return packageManagerCommand(projectDir);
}

async function flowUrls(
  selectors: string[],
  options: DevOptions,
): Promise<string[]> {
  const projectDir = resolve(options.projectDir);
  const discovered = await selectFlowFiles(selectors, options);
  if (discovered.length === 0) {
    throw new FlowCompileError(
      `No flows found under ${resolve(projectDir, "polymux")}`,
    );
  }
  if (options.url) return [options.url];
  const { files } = await filterFlowFiles(discovered, options);
  const builds = await buildFlowFiles(files, projectDir);
  return [
    ...new Set(
      builds
        .flatMap(({ plan }) => "actors" in plan
          ? plan.actors.map((actor) => actor.flow.baseUrl)
          : [plan.baseUrl])
        .filter((url): url is string => Boolean(url)),
    ),
  ];
}

async function waitForUrl(
  url: string,
  waitMs: number,
  child?: ChildProcess,
): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt <= waitMs) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(
        `The development server exited with code ${child.exitCode} before ${url} became ready`,
      );
    }
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
  }
  throw new Error(
    `The development server did not become ready at ${url}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}

function shouldRerun(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/");
  if (normalized === "polymux.yaml") return true;
  const parts = normalized.split("/");
  if (parts.some((part) => generatedDirectories.has(part))) return false;
  if (normalized.startsWith("polymux/")) return true;
  const extension = normalized.slice(normalized.lastIndexOf("."));
  return sourceExtensions.has(extension);
}

function stopChild(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }
}

async function runDevelopmentLoop(
  selectors: string[],
  options: DevOptions,
): Promise<void> {
  const projectDir = resolve(options.projectDir);
  const urls = await flowUrls(selectors, options);
  if (urls.length === 0) {
    throw new Error(
      "Development mode needs a flow baseUrl or an explicit --url.",
    );
  }

  let appProcess: ChildProcess | undefined;
  if (options.start) {
    const command = await devCommand(projectDir, options.command);
    process.stdout.write(`Starting app: ${command}\n`);
    appProcess = spawn(command, {
      cwd: projectDir,
      env: process.env,
      detached: process.platform !== "win32",
      shell: true,
      stdio: "inherit",
    });
  }

  try {
    for (const url of urls) await waitForUrl(url, options.waitMs, appProcess);
  } catch (error) {
    stopChild(appProcess);
    throw error;
  }
  process.stdout.write(`Ready: ${urls.join(", ")}\n`);

  let running = false;
  let queued = false;
  let latestChange = "startup";
  const execute = async (): Promise<void> => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    process.stdout.write(`\nRegression check: ${latestChange}\n`);
    try {
      for (const url of urls) await waitForUrl(url, options.waitMs);
      process.exitCode = await runOnce(selectors, options);
    } catch (error) {
      reportError(error);
      process.exitCode = 2;
    } finally {
      running = false;
      if (queued) {
        queued = false;
        await execute();
      }
    }
  };

  await execute();
  process.stdout.write(
    "\nWatching application and flow changes. Press Ctrl+C to stop.\n",
  );

  let debounce: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  await new Promise<void>((resolveLoop) => {
    let finished = false;
    const finish = (exitCode?: number) => {
      if (finished) return;
      finished = true;
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      stopChild(appProcess);
      if (exitCode !== undefined) process.exitCode = exitCode;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      resolveLoop();
    };
    const onInterrupt = () => finish(130);
    const onTerminate = () => finish(143);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);

    appProcess?.once("exit", (code) => {
      if (code && code !== 0) {
        process.stderr.write(`Development server exited with code ${code}.\n`);
      }
      finish(code ?? 0);
    });
    appProcess?.once("error", (error) => {
      reportError(error);
      finish(2);
    });

    try {
      watcher = watch(projectDir, { recursive: true }, (_event, filename) => {
        if (!filename || !shouldRerun(filename)) return;
        latestChange = filename;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void execute(), options.debounceMs);
      });
    } catch (error) {
      reportError(error);
      finish(2);
      return;
    }
    watcher.once("error", (error) => {
      reportError(error);
      finish(2);
    });
    if (appProcess?.exitCode !== null && appProcess?.exitCode !== undefined) {
      finish(appProcess.exitCode);
    }
  });
}

function reportError(error: unknown): void {
  telemetrySession?.captureException(error);
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Polymux: ${message}\n`);
}

function jsonError(error: unknown): string {
  return JSON.stringify(
    {
      status: "error",
      runs: [],
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    },
    null,
    2,
  );
}

const program = new Command()
  .name("polymux")
  .description("Compile and run deterministic cross-platform flows")
  .option("--verbose", "write detailed operational information to stderr", false)
  .option("--no-color", "disable colored output")
  .version(cliVersion);

const auth = program
  .command("auth")
  .description("Authenticate with Polymux Cloud");

auth
  .command("login")
  .description("Authorize this machine with Polymux Cloud")
  .option("-u, --auth-url <url>", "authentication service URL")
  .option("-B, --no-browser", "print the authorization URL without opening a browser")
  .option("-j, --json", "write device authorization events as JSON Lines", false)
  .action(async (options: { authUrl?: string; browser: boolean; json: boolean }) => login(options));

auth
  .command("logout")
  .description("Revoke this machine's Polymux Cloud credentials")
  .option("-l, --local", "remove local credentials without contacting Polymux Cloud", false)
  .option("-j, --json", "write the result as JSON", false)
  .action(async (options: { local: boolean }) => logout(options));

auth
  .command("status")
  .description("Show the current Polymux Cloud authentication status")
  .option("-j, --json", "write authentication status as JSON", false)
  .action(authStatus);

const accessCommand = program
  .command("access")
  .description("Configure test-only access to protected environments");

accessCommand
  .command("init")
  .description("Interactively configure exact-origin test access")
  .option("-P, --project-dir <directory>", "project directory", ".")
  .option("-f, --flow <flow>", "coordinated flow name or path")
  .option("-u, --origin <url>", "exact staging or test origin")
  .option("-e, --environment <name>", "non-production environment name")
  .option("-n, --name <name>", "protection name")
  .option("-H, --header <name>", "test-access request header")
  .option("-E, --token-env <name>", "environment variable used for the secret token")
  .option("-j, --json", "write the setup result as JSON", false)
  .action(async (options) => {
    const result = await initializeAccess(options);
    printAccessResult(result, options.json === true);
  });

program
  .command("version")
  .description("Show the installed Polymux CLI version")
  .option("-j, --json", "write version information as JSON", false)
  .action((options: { json: boolean }) => {
    process.stdout.write(options.json ? `${JSON.stringify({ version: cliVersion }, null, 2)}\n` : `${cliVersion}\n`);
  });

const config = program
  .command("config")
  .description("Manage Polymux configuration")
  .option("-j, --json", "write configuration as JSON", false)
  .action(async function () {
    await listConfig(this.opts().json === true);
  });

config
  .command("list")
  .description("List effective configuration and sources")
  .option("-j, --json", "write configuration as JSON", false)
  .action(async function () {
    await listConfig(this.opts().json === true || this.parent?.opts().json === true);
  });

config
  .command("get")
  .description("Read one configuration value")
  .argument("<key>", "configuration key")
  .option("-j, --json", "write the value as JSON", false)
  .action(async function (key: string) {
    await getConfig(key, this.opts().json === true || this.parent?.opts().json === true);
  });

config
  .command("set")
  .description("Set one configuration value")
  .argument("<key>", "configuration key")
  .argument("<value>", "configuration value")
  .option("-j, --json", "write the result as JSON", false)
  .action(async function (key: string, value: string) {
    await setConfig(key, value, this.opts().json === true || this.parent?.opts().json === true);
  });

config
  .command("unset")
  .description("Remove one stored configuration value")
  .argument("<key>", "configuration key")
  .option("-j, --json", "write the result as JSON", false)
  .action(async function (key: string) {
    await unsetConfig(key, this.opts().json === true || this.parent?.opts().json === true);
  });

config
  .command("path")
  .description("Show the configuration file path")
  .option("-j, --json", "write the path as JSON", false)
  .action(function () {
    printConfigPath(this.opts().json === true || this.parent?.opts().json === true);
  });

config
  .command("doctor")
  .description("Validate configuration and credential storage support")
  .option("-j, --json", "write the report as JSON", false)
  .action(async function () {
    await configDoctor(this.opts().json === true || this.parent?.opts().json === true);
  });

const completion = program
  .command("completion")
  .description("Generate shell completion")
  .argument("[shell]", "bash, zsh, or fish")
  .action((shell?: string) => {
    if (!shell) throw new Error("Specify bash, zsh, fish, install, or uninstall");
    printCompletion(shell);
  });

completion
  .command("status")
  .description("Show whether shell completion is installed")
  .argument("[shell]", "bash, zsh, or fish")
  .option("-j, --json", "write completion status as JSON", false)
  .action(async (shell: string | undefined, options: { json: boolean }) => completionStatus(shell, options.json));

completion
  .command("install")
  .description("Install completion for the current or selected shell")
  .argument("[shell]", "bash, zsh, or fish")
  .option("-j, --json", "write the result as JSON", false)
  .action(async (shell: string | undefined, options: { json: boolean }) => installCompletion(shell, options.json));

completion
  .command("uninstall")
  .description("Uninstall Polymux-owned shell completion")
  .argument("[shell]", "bash, zsh, or fish")
  .option("-j, --json", "write the result as JSON", false)
  .action(async (shell: string | undefined, options: { json: boolean }) => uninstallCompletion(shell, options.json));

const runs = program
  .command("runs")
  .description("Inspect local and remote Polymux runs")
  .option("-P, --project-dir <directory>", "project directory", ".")
  .option("-r, --remote", "show remote runs only", false)
  .option("-a, --all", "combine local and remote runs", false)
  .option("-j, --json", "write run data as JSON", false)
  .option("-l, --limit <count>", "maximum runs to return", numericOption, 20)
  .action(listRuns);

runs
  .command("show")
  .description("Show one run")
  .argument("<run-id>", "run identifier")
  .option("-P, --project-dir <directory>", "project directory", ".")
  .option("-r, --remote", "read the run from Polymux Cloud", false)
  .option("-j, --json", "write the complete run as JSON", false)
  .action(async function (runId: string) {
    const own = this.opts();
    const parent = this.parent?.opts() ?? {};
    await showRun(runId, {
      projectDir: parent.projectDir !== "." ? parent.projectDir : own.projectDir ?? parent.projectDir ?? ".",
      remote: own.remote === true || parent.remote === true,
      json: own.json === true || parent.json === true,
    });
  });

runs
  .command("clean")
  .description("Remove old local run artifacts")
  .option("-P, --project-dir <directory>", "project directory", ".")
  .option("--older-than <days>", "remove runs older than this many days", numericOption, 30)
  .option("-y, --yes", "confirm deletion", false)
  .option("-j, --json", "write the result as JSON", false)
  .action(async function (options: { projectDir: string; olderThan: number; yes: boolean; json: boolean }) {
    const parent = this.parent?.opts() ?? {};
    await cleanRuns({
      projectDir: parent.projectDir !== "." ? parent.projectDir : options.projectDir ?? parent.projectDir ?? ".",
      olderThan: options.olderThan,
      yes: options.yes,
      json: options.json || parent.json === true,
    });
  });

program
  .command("diagnose")
  .description("Create a sanitized diagnostic for a run")
  .argument("<run-id>", "run identifier")
  .option("-P, --project-dir <directory>", "project directory", ".")
  .option("-r, --remote", "read the run from Polymux Cloud", false)
  .option("-o, --output <file>", "diagnostic output file")
  .option("-j, --json", "write the diagnostic result as JSON", false)
  .action(async (runId: string, options) => {
    await diagnoseRun(runId, cliVersion, options);
  });

program
  .command("report")
  .description("Prepare or explicitly submit a diagnostic report")
  .argument("<run-id>", "run identifier")
  .option("-P, --project-dir <directory>", "project directory", ".")
  .option("-r, --remote", "read the run from Polymux Cloud", false)
  .option("-o, --output <file>", "local report output file")
  .option("-m, --message <text>", "add context for the report")
  .option("-s, --submit", "submit the sanitized report to Polymux Cloud", false)
  .option("-j, --json", "write the report result as JSON", false)
  .action(async (runId: string, options) => reportRun(runId, cliVersion, options));

program
  .command("update")
  .alias("upgrade")
  .description("Check for and install Polymux CLI updates")
  .option("-y, --yes", "install the available update", false)
  .option("-p, --package-manager <manager>", "package manager: npm, pnpm, yarn, or bun")
  .option("-j, --json", "write update status as JSON", false)
  .action(async (options: { yes: boolean; packageManager?: string; json: boolean }) => updateCli(cliVersion, options));

program
  .command("init")
  .description("Initialize a Polymux project")
  .option("--project-dir <directory>", "project directory", ".")
  .option("-j, --json", "write the result as JSON", false)
  .action(async (options: SharedOptions & { json: boolean }) => {
    const projectDir = resolve(options.projectDir);
    const directory = resolve(projectDir, "polymux");
    await mkdir(directory, { recursive: true });
    const schemaPath = await installProjectSchema(projectDir);
    const configCreated = await ensureProjectConfig(projectDir);
    const scripts = await addPackageScripts(projectDir);
    if (options.json) process.stdout.write(`${JSON.stringify({ status: "ready", directory, schemaPath, configCreated, scriptsAdded: scripts }, null, 2)}\n`);
    else process.stdout.write(`Ready: ${relative(process.cwd(), directory) || "."}\n`);
    if (!options.json && configCreated) process.stdout.write("Created polymux.yaml\n");
    if (!options.json && scripts.length > 0) {
      process.stdout.write(`Added package scripts: ${scripts.join(", ")}\n`);
    }
  });

program
  .command("build")
  .description("Validate and compile flows")
  .argument("[selectors...]", "flow names, paths, or directory collections")
  .option("--project-dir <directory>", "project directory", ".")
  .option("--include-tags <tags>", "include flows with any comma-separated tag", tagListOption, [])
  .option("--exclude-tags <tags>", "exclude flows with any comma-separated tag", tagListOption, [])
  .option("-j, --json", "write build results as JSON", false)
  .action(async (
    selectors: string[],
    options: SharedOptions & TagOptions & { json: boolean },
  ) => {
    const projectDir = resolve(options.projectDir);
    const discovered = await selectFlowFiles(selectors, options);
    if (discovered.length === 0) {
      throw new FlowCompileError(
        `No flows found under ${resolve(projectDir, "polymux")}`,
      );
    }
    const { files } = await filterFlowFiles(discovered, options);
    const builds = await buildFlowFiles(files, projectDir);
    if (options.json) process.stdout.write(`${JSON.stringify({ builds: builds.map((build) => ({ flow: build.plan.name, outputPath: build.outputPath })) }, null, 2)}\n`);
    else for (const build of builds) {
      process.stdout.write(
        `✓ ${build.plan.name} → ${relative(projectDir, build.outputPath)}\n`,
      );
    }
  });

program
  .command("crawl")
  .description("Discover web test candidates and approved-flow coverage")
  .option("-u, --url <url>", "starting URL; defaults to project crawl configuration")
  .option("-P, --project-dir <directory>", "project directory", ".")
  .option(
    "-b, --browser <browser>",
    "browser engine: chromium, firefox, or webkit",
    browserOption,
  )
  .option("-m, --max-pages <count>", "maximum pages to inspect", positiveNumericOption)
  .option("-d, --max-depth <count>", "maximum link depth", numericOption)
  .option("-r, --replays <count>", "required identical probes per page", positiveNumericOption)
  .option("-t, --timeout-ms <milliseconds>", "timeout for each page probe", positiveNumericOption)
  .option("-j, --json", "write the complete crawl result as JSON", false)
  .action(async (options) => runCrawl(options.url, options));

program
  .command("doctor")
  .description("Check local setup health and execution targets")
  .option("--project-dir <directory>", "project directory", ".")
  .option("-a, --appium-url <url>", "Appium server URL")
  .option("-j, --json", "write the health report as JSON", false)
  .action(async (options: DoctorOptions) => {
    const report = await inspectDoctor(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printDoctor(report);
    }
    process.exitCode = report.status === "failed" ? 1 : 0;
  });

const driverCommand = program
  .command("driver")
  .description("Install and uninstall local Appium platform drivers");

driverCommand
  .command("install")
  .description("Install Appium drivers for selected platforms")
  .argument("[platforms...]", "ios, android, macos, or windows")
  .option("--all", "install every driver compatible with this machine", false)
  .option("-j, --json", "write the result as JSON", false)
  .action(async (
    platformValues: string[],
    options: { all: boolean; json: boolean },
  ) => {
    const result = await changeDrivers("install", platformValues, {
      ...options,
      passthrough: !options.json,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printDriverAction(result);
    }
  });

driverCommand
  .command("uninstall")
  .description("Uninstall Appium drivers for selected platforms")
  .argument("[platforms...]", "ios, android, macos, or windows")
  .option("--all", "uninstall every compatible installed driver", false)
  .option("-j, --json", "write the result as JSON", false)
  .action(async (
    platformValues: string[],
    options: { all: boolean; json: boolean },
  ) => {
    const result = await changeDrivers("uninstall", platformValues, {
      ...options,
      passthrough: !options.json,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printDriverAction(result);
    }
  });

program
  .command("devices")
  .description("Discover authorized local devices, simulators, and desktops")
  .option("-p, --platform <platform>", "filter by native platform", platformOption)
  .option("-j, --json", "write device inventory as JSON", false)
  .action(async (options: { platform?: Platform; json: boolean }) => {
    if (options.platform === "web") {
      throw new Error("Device discovery supports native platforms, not web");
    }
    const result = await discoverLocalDevices(options.platform);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printDevices(result);
    }
  });

program
  .command("dev")
  .description("Run continuous regression checks during development")
  .argument("[selectors...]", "flow names, paths, or directory collections")
  .option("--project-dir <directory>", "project directory", ".")
  .option("-p, --platform <platform>", "execution platform", platformOption, configValue<Platform>("defaults.platform"))
  .option("-a, --appium-url <url>", "Appium server URL")
  .option("-C, --capabilities <json>", "Appium capabilities JSON", jsonObjectOption)
  .option("--target <id>", "authorized local native device identifier")
  .option(
    "-b, --browser <browser>",
    "browser engine: chromium, firefox, or webkit",
    browserOption,
    configValue<WebBrowserName>("defaults.browser"),
  )
  .option("-d, --device <profile>", "Playwright device profile")
  .option("--include-tags <tags>", "include flows with any comma-separated tag", tagListOption, [])
  .option("--exclude-tags <tags>", "exclude flows with any comma-separated tag", tagListOption, [])
  .option("--url <url>", "override the flow base URL")
  .option("--command <command>", "development server command")
  .option("--no-start", "use an already-running development server")
  .option("--headed", "show the browser", false)
  .option("-q, --quiet", "hide step-by-step progress", false)
  .option("-o, --output <directory>", "run artifact directory")
  .option("--junit <file>", "write JUnit XML after each run")
  .option("-v, --video", "record a video artifact", false)
  .option(
    "--debounce-ms <milliseconds>",
    "wait for hot reload before rerunning",
    numericOption,
    450,
  )
  .option(
    "--wait-ms <milliseconds>",
    "development server readiness timeout",
    numericOption,
    30_000,
  )
  .action(async (selectors: string[], options: DevOptions) => {
    await runDevelopmentLoop(selectors, options);
  });

program
  .command("run")
  .description("Compile flows and run them")
  .argument("[selectors...]", "flow names, paths, or directory collections")
  .option("--project-dir <directory>", "project directory", ".")
  .option("-p, --platform <platform>", "execution platform", platformOption, configValue<Platform>("defaults.platform"))
  .option("-a, --appium-url <url>", "Appium server URL")
  .option("-C, --capabilities <json>", "Appium capabilities JSON", jsonObjectOption)
  .option("--target <id>", "authorized local native device identifier")
  .option(
    "-b, --browser <browser>",
    "browser engine: chromium, firefox, or webkit",
    browserOption,
    configValue<WebBrowserName>("defaults.browser"),
  )
  .option("-d, --device <profile>", "Playwright device profile")
  .option("--include-tags <tags>", "include flows with any comma-separated tag", tagListOption, [])
  .option("--exclude-tags <tags>", "exclude flows with any comma-separated tag", tagListOption, [])
  .option("--url <url>", "override flow base URLs")
  .option("--headed", "show the browser", false)
  .option("-j, --json", "write the complete result as JSON", false)
  .option("-q, --quiet", "hide step-by-step progress", false)
  .option("-w, --watch", "re-run when flows change", false)
  .option("-o, --output <directory>", "run artifact directory")
  .option("--junit <file>", "write JUnit XML")
  .option("-v, --video", "record a video artifact", false)
  .option("-n, --repeat <count>", "times to run each flow", positiveNumericOption, 1)
  .option(
    "--update-snapshots",
    "create or replace visual baselines",
    false,
  )
  .action(async (selectors: string[], options: RunOptions) => {
    try {
      if (options.watch) {
        await runWithWatch(selectors, options);
        return;
      }
      process.exitCode = await runOnce(selectors, options);
    } catch (error) {
      if (!options.json) throw error;
      telemetrySession?.captureException(error);
      process.stdout.write(`${jsonError(error)}\n`);
      process.exitCode = 2;
    }
  });

program.exitOverride();

let activeJson = false;
let telemetrySession: TelemetrySession | undefined;

function commandPath(command: Command): string {
  const parts: string[] = [];
  let current: Command | null = command;
  while (current) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts[0] === "polymux" ? parts.slice(1).join(" ") : parts.join(" ");
}

async function finishTelemetry(
  exitCode = typeof process.exitCode === "number" ? process.exitCode : 0,
): Promise<void> {
  const session = telemetrySession;
  telemetrySession = undefined;
  if (session) await session.finish(exitCode);
}

program.hook("preAction", async (_command, actionCommand) => {
  const options = actionCommand.optsWithGlobals() as { json?: boolean; verbose?: boolean; color?: boolean };
  activeJson = options.json === true;
  if (options.color === false) process.env.NO_COLOR = "1";
  if (options.verbose) {
    process.env.POLYMUX_VERBOSE = "1";
    process.stderr.write(`[polymux] command=${actionCommand.name()} node=${process.versions.node} platform=${process.platform}\n`);
  }
  telemetrySession = await startTelemetry({
    command: commandPath(actionCommand),
    version: cliVersion,
    json: activeJson,
  });
});

program.hook("postAction", async (_command, actionCommand) => {
  const options = actionCommand.opts() as { json?: boolean };
  if (actionCommand.name() !== "update" && !options.json) await maybeNotifyUpdate(cliVersion);
  await finishTelemetry();
});

const parsing =
  process.argv.length === 2
    ? Promise.resolve(program.outputHelp())
    : program.parseAsync();

await parsing.catch(async (error: unknown) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "commander.help" ||
      error.code === "commander.helpDisplayed" ||
      error.code === "commander.version")
  ) {
    return;
  }
  if (activeJson) {
    telemetrySession?.captureException(error);
    process.stdout.write(`${JSON.stringify({ status: "error", error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } }, null, 2)}\n`);
  } else reportError(error);
  process.exitCode = 2;
  await finishTelemetry(2);
});
