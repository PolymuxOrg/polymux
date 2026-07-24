import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  crawlWebApp,
  WebDriver,
  type CrawlBrowserName,
  type CrawlPageResult,
  type WebCrawlResult,
} from "@polymux/adapter-web";
import {
  compileSingleActorFlow,
  compileSingleActorFlowFile,
  discoverFlows,
  executableSteps,
} from "@polymux/core";
import type { CompiledSingleActorFlow, SingleActorFlowSource } from "@polymux/protocol";
import { parse, stringify } from "yaml";

export interface CrawlCommandOptions {
  projectDir: string;
  browser?: CrawlBrowserName;
  maxPages?: number;
  maxDepth?: number;
  replays?: number;
  timeoutMs?: number;
  json: boolean;
}

interface ProjectCrawlConfig {
  url?: string;
  browser?: CrawlBrowserName;
  maxPages?: number;
  maxDepth?: number;
  replays?: number;
  timeoutMs?: number;
}

interface ResolvedCrawlOptions {
  url: string;
  urlSource: "command" | "project-config" | "flow-base-url";
  browser?: CrawlBrowserName;
  maxPages: number;
  maxDepth: number;
  replays: number;
  timeoutMs: number;
  projectDir: string;
  json: boolean;
}

interface FlowCoverage {
  approvedFlows: number;
  invalidFlows: Array<{ path: string; error: string }>;
  byRoute: Map<string, string[]>;
}

interface ActorProfile {
  name: string;
  setupPath?: string;
  storageStatePath?: string;
  headers: Record<string, string>;
  variables: Record<string, string>;
  redactions: string[];
}

interface CrawlSession {
  actor: string;
  kind: "anonymous" | "actor";
  status: "completed" | "error";
  result?: WebCrawlResult;
  setup?: string;
  error?: string;
}

interface ReportPage extends Omit<CrawlPageResult, "flow"> {
  actor: string;
  routeCoverage: { status: "covered" | "uncovered"; flows: string[] };
  candidatePath?: string;
}

const actorNamePattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const actorConfigKeys = new Set([
  "enabled",
  "setup",
  "storageState",
  "variablesFromEnv",
  "headersFromEnv",
]);
const crawlConfigKeys = new Set([
  "browser",
  "maxPages",
  "maxDepth",
  "replays",
  "timeoutMs",
]);

function crawlId(seedUrl: string, startedAt: string): string {
  const stamp = startedAt.replaceAll(":", "").replaceAll(".", "-");
  const digest = createHash("sha256")
    .update(`${seedUrl}:${startedAt}`)
    .digest("hex")
    .slice(0, 8);
  return `${stamp}-${digest}`;
}

function routeKey(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  url.hash = "";
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}

function flowRoutes(plan: CompiledSingleActorFlow): string[] {
  if (!plan.baseUrl || !plan.platforms.includes("web")) return [];
  const baseUrl = plan.baseUrl.endsWith("/") ? plan.baseUrl : `${plan.baseUrl}/`;
  return [
    ...new Set(
      executableSteps(plan)
        .filter((step) => step.kind === "navigate" || step.kind === "deepLink")
        .map((step) => {
          const value = step.input.to;
          if (typeof value !== "string") return undefined;
          try {
            return routeKey(new URL(value, baseUrl).toString());
          } catch {
            return undefined;
          }
        })
        .filter((route): route is string => route !== undefined),
    ),
  ];
}

async function inspectCoverage(projectDir: string): Promise<FlowCoverage> {
  const files = await discoverFlows(projectDir);
  const byRoute = new Map<string, string[]>();
  const invalidFlows: FlowCoverage["invalidFlows"] = [];
  let approvedFlows = 0;
  await Promise.all(
    files.map(async (file) => {
      let plan: CompiledSingleActorFlow;
      try {
        plan = await compileSingleActorFlowFile(file);
      } catch (error) {
        invalidFlows.push({
          path: relative(projectDir, file),
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      approvedFlows += 1;
      for (const route of flowRoutes(plan)) {
        const entries = byRoute.get(route) ?? [];
        entries.push(relative(projectDir, file));
        byRoute.set(route, entries.sort());
      }
    }),
  );
  invalidFlows.sort((a, b) => a.path.localeCompare(b.path));
  return { approvedFlows, invalidFlows, byRoute };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function configuredInteger(
  value: unknown,
  label: string,
  allowZero = false,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (allowZero ? Number(value) < 0 : Number(value) < 1)) {
    throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return Number(value);
}

async function loadProjectCrawlConfig(projectDir: string): Promise<ProjectCrawlConfig> {
  const path = resolve(projectDir, "polymux.yaml");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
    if (code === "ENOENT") return {};
    throw error;
  }
  const source = object(parse(raw), "polymux.yaml");
  const unknownTopLevel = Object.keys(source).filter(
    (key) => key !== "version" && key !== "app" && key !== "crawl",
  );
  if (unknownTopLevel.length > 0) {
    throw new Error(`Unknown polymux.yaml options: ${unknownTopLevel.join(", ")}`);
  }
  if (source.version !== 1) throw new Error("polymux.yaml version must be 1");
  const app = source.app === undefined ? {} : object(source.app, "polymux.yaml app");
  const unknownApp = Object.keys(app).filter((key) => key !== "url");
  if (unknownApp.length > 0) throw new Error(`Unknown polymux.yaml app options: ${unknownApp.join(", ")}`);
  if (app.url !== undefined && typeof app.url !== "string") {
    throw new Error("polymux.yaml app.url must be text");
  }
  const crawl = source.crawl === undefined ? {} : object(source.crawl, "polymux.yaml crawl");
  const unknownCrawl = Object.keys(crawl).filter((key) => !crawlConfigKeys.has(key));
  if (unknownCrawl.length > 0) throw new Error(`Unknown polymux.yaml crawl options: ${unknownCrawl.join(", ")}`);
  if (
    crawl.browser !== undefined &&
    crawl.browser !== "chromium" &&
    crawl.browser !== "firefox" &&
    crawl.browser !== "webkit"
  ) {
    throw new Error("polymux.yaml crawl.browser must be chromium, firefox, or webkit");
  }
  return {
    ...(typeof app.url === "string" ? { url: app.url } : {}),
    ...(crawl.browser ? { browser: crawl.browser as CrawlBrowserName } : {}),
    ...(configuredInteger(crawl.maxPages, "polymux.yaml crawl.maxPages") !== undefined
      ? { maxPages: Number(crawl.maxPages) }
      : {}),
    ...(configuredInteger(crawl.maxDepth, "polymux.yaml crawl.maxDepth", true) !== undefined
      ? { maxDepth: Number(crawl.maxDepth) }
      : {}),
    ...(configuredInteger(crawl.replays, "polymux.yaml crawl.replays") !== undefined
      ? { replays: Number(crawl.replays) }
      : {}),
    ...(configuredInteger(crawl.timeoutMs, "polymux.yaml crawl.timeoutMs") !== undefined
      ? { timeoutMs: Number(crawl.timeoutMs) }
      : {}),
  };
}

async function inferFlowBaseUrl(projectDir: string): Promise<string | undefined> {
  const files = await discoverFlows(projectDir);
  const baseUrls = new Set<string>();
  for (const file of files) {
    try {
      const plan = await compileSingleActorFlowFile(file);
      if (plan.baseUrl) baseUrls.add(plan.baseUrl);
    } catch {
      // Coverage reporting records invalid flows later.
    }
  }
  if (baseUrls.size === 1) return [...baseUrls][0];
  if (baseUrls.size > 1) {
    throw new Error(
      `Multiple flow base URLs were found (${[...baseUrls].sort().join(", ")}). Set app.url in polymux.yaml or pass --url.`,
    );
  }
  return undefined;
}

async function resolveCrawlOptions(
  commandUrl: string | undefined,
  options: CrawlCommandOptions,
  projectDir: string,
): Promise<ResolvedCrawlOptions> {
  const config = await loadProjectCrawlConfig(projectDir);
  const inferred = commandUrl || config.url ? undefined : await inferFlowBaseUrl(projectDir);
  const url = commandUrl ?? config.url ?? inferred;
  if (!url) {
    throw new Error(
      "No crawl URL is configured. Add app.url to polymux.yaml, add one flow baseUrl, or pass --url.",
    );
  }
  return {
    url,
    urlSource: commandUrl ? "command" : config.url ? "project-config" : "flow-base-url",
    ...(options.browser ?? config.browser
      ? { browser: options.browser ?? config.browser }
      : {}),
    maxPages: options.maxPages ?? config.maxPages ?? 50,
    maxDepth: options.maxDepth ?? config.maxDepth ?? 4,
    replays: options.replays ?? config.replays ?? 3,
    timeoutMs: options.timeoutMs ?? config.timeoutMs ?? 10_000,
    projectDir,
    json: options.json,
  };
}

function environmentMap(
  value: unknown,
  label: string,
): { values: Record<string, string>; redactions: string[] } {
  if (value === undefined) return { values: {}, redactions: [] };
  const mapping = object(value, label);
  const values: Record<string, string> = {};
  const redactions: string[] = [];
  for (const [name, environmentName] of Object.entries(mapping)) {
    if (typeof environmentName !== "string" || environmentName.length === 0) {
      throw new Error(`${label}.${name} must name an environment variable`);
    }
    const resolved = process.env[environmentName];
    if (resolved === undefined) {
      throw new Error(`${label}.${name} requires ${environmentName}`);
    }
    values[name] = resolved;
    redactions.push(resolved);
  }
  return { values, redactions };
}

async function loadActors(projectDir: string): Promise<ActorProfile[]> {
  const configPath = resolve(projectDir, "polymux", "actors.yaml");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
  const source = object(parse(raw), "polymux/actors.yaml");
  const unknownTopLevel = Object.keys(source).filter(
    (key) => key !== "version" && key !== "actors",
  );
  if (unknownTopLevel.length > 0) {
    throw new Error(`Unknown polymux/actors.yaml options: ${unknownTopLevel.join(", ")}`);
  }
  if (source.version !== 1) throw new Error("polymux/actors.yaml version must be 1");
  const actorSources = object(source.actors, "polymux/actors.yaml actors");
  const actors: ActorProfile[] = [];
  for (const [name, value] of Object.entries(actorSources).sort(([a], [b]) => a.localeCompare(b))) {
    if (!actorNamePattern.test(name)) throw new Error(`Invalid crawl actor name "${name}"`);
    const actor = object(value, `Actor "${name}"`);
    const unknown = Object.keys(actor).filter((key) => !actorConfigKeys.has(key));
    if (unknown.length > 0) throw new Error(`Unknown Actor "${name}" options: ${unknown.join(", ")}`);
    if (actor.enabled !== undefined && typeof actor.enabled !== "boolean") {
      throw new Error(`Actor "${name}" enabled must be true or false`);
    }
    if (actor.enabled === false) continue;
    if (actor.setup !== undefined && typeof actor.setup !== "string") {
      throw new Error(`Actor "${name}" setup must be a path`);
    }
    if (actor.storageState !== undefined && typeof actor.storageState !== "string") {
      throw new Error(`Actor "${name}" storageState must be a path`);
    }
    if (actor.setup && actor.storageState) {
      throw new Error(`Actor "${name}" cannot use both setup and storageState`);
    }
    const variables = environmentMap(actor.variablesFromEnv, `Actor "${name}" variablesFromEnv`);
    const headerEnvironment = environmentMap(actor.headersFromEnv, `Actor "${name}" headersFromEnv`);
    if (!actor.setup && !actor.storageState && Object.keys(headerEnvironment.values).length === 0) {
      throw new Error(`Actor "${name}" needs setup, storageState, or headersFromEnv`);
    }
    actors.push({
      name,
      ...(typeof actor.setup === "string"
        ? { setupPath: resolve(dirname(configPath), actor.setup) }
        : {}),
      ...(typeof actor.storageState === "string"
        ? { storageStatePath: resolve(dirname(configPath), actor.storageState) }
        : {}),
      headers: headerEnvironment.values,
      variables: variables.values,
      redactions: [...new Set([...variables.redactions, ...headerEnvironment.redactions])],
    });
  }
  return actors;
}

function substituteActor(value: unknown, actor: ActorProfile): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\$\{actor\.([A-Za-z][A-Za-z0-9_-]*)\}$/);
    if (exact) {
      const resolved = actor.variables[exact[1]!];
      if (resolved === undefined) throw new Error(`Actor "${actor.name}" has no variable "${exact[1]}"`);
      return resolved;
    }
    return value.replace(/\$\{actor\.([A-Za-z][A-Za-z0-9_-]*)\}/g, (_match, name: string) => {
      const resolved = actor.variables[name];
      if (resolved === undefined) throw new Error(`Actor "${actor.name}" has no variable "${name}"`);
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substituteActor(entry, actor));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substituteActor(entry, actor)]),
    );
  }
  return value;
}

function redact(value: string, redactions: string[]): string {
  return redactions
    .filter((entry) => entry.length > 0)
    .reduce((result, entry) => result.replaceAll(entry, "[REDACTED]"), value);
}

async function prepareActorStorage(
  actor: ActorProfile,
  options: ResolvedCrawlOptions,
  projectDir: string,
  artifactsDir: string,
  seedUrl: string,
) {
  if (actor.storageStatePath) return actor.storageStatePath;
  if (!actor.setupPath) return undefined;
  if (!/\.setup\.ya?ml$/i.test(actor.setupPath)) {
    throw new Error(`Actor "${actor.name}" setup must use the .setup.yaml suffix`);
  }
  const setupSource = substituteActor(parse(await readFile(actor.setupPath, "utf8")), actor);
  const plan = compileSingleActorFlow(setupSource, actor.setupPath);
  if (!plan.platforms.includes("web")) {
    throw new Error(`Actor "${actor.name}" setup does not target web`);
  }
  const setupArtifacts = join(artifactsDir, "setups", actor.name);
  await mkdir(setupArtifacts, { recursive: true });
  return new WebDriver({
    headless: true,
    trace: false,
    ...(options.browser ? { browser: options.browser } : {}),
  }).prepareStorageState(plan, {
    runId: `crawl-setup-${actor.name}`,
    projectDir,
    artifactsDir: setupArtifacts,
    baseUrl: plan.baseUrl ?? new URL(seedUrl).origin,
    ...(Object.keys(actor.headers).length > 0 ? { headers: actor.headers } : {}),
    containsSecrets: Object.keys(actor.headers).length > 0,
  });
}

function crawlOptions(url: string, options: ResolvedCrawlOptions) {
  return {
    url,
    ...(options.browser ? { browser: options.browser } : {}),
    maxPages: options.maxPages,
    maxDepth: options.maxDepth,
    replays: options.replays,
    timeoutMs: options.timeoutMs,
  };
}

function coverageFor(coverage: FlowCoverage, url: string) {
  const flows = coverage.byRoute.get(routeKey(url) ?? url) ?? [];
  return {
    status: flows.length > 0 ? "covered" as const : "uncovered" as const,
    flows,
  };
}

function safeActorSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function stageAnonymousCandidate(path: string, flow: SingleActorFlowSource): Promise<void> {
  compileSingleActorFlow(flow, path);
  await writeFile(path, stringify(flow, { lineWidth: 100 }), { encoding: "utf8", flag: "wx" });
}

async function stageActorCandidate(
  path: string,
  actor: ActorProfile,
  page: CrawlPageResult,
): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({
      formatVersion: 1,
      kind: "polymux.crawl-candidate",
      actor: actor.name,
      setup: actor.setupPath ? relative(dirname(path), actor.setupPath) : undefined,
      requestedUrl: page.requestedUrl,
      observedUrl: page.url,
      title: page.title,
      accessSignals: page.accessSignals,
      flowDraft: page.flow,
      note: "Review this actor-dependent discovery and author an approved flow with explicit setup before moving it under polymux/.",
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

function sessionActor(name: string, actors: ActorProfile[]): ActorProfile | undefined {
  return actors.find((actor) => actor.name === name);
}

export async function runCrawl(url: string | undefined, commandOptions: CrawlCommandOptions): Promise<void> {
  const projectDir = resolve(commandOptions.projectDir);
  const options = await resolveCrawlOptions(url, commandOptions, projectDir);
  url = options.url;
  const startedAt = new Date().toISOString();
  const artifactsDir = resolve(projectDir, ".polymux", "crawls", crawlId(url, startedAt));
  const candidatesDir = join(artifactsDir, "candidates");
  await mkdir(candidatesDir, { recursive: true });
  const actors = await loadActors(projectDir);
  const coverage = await inspectCoverage(projectDir);
  const sessions: CrawlSession[] = [];

  sessions.push({
    actor: "anonymous",
    kind: "anonymous",
    status: "completed",
    result: await crawlWebApp(crawlOptions(url, options)),
  });

  for (const actor of actors) {
    try {
      const storageState = await prepareActorStorage(actor, options, projectDir, artifactsDir, url);
      sessions.push({
        actor: actor.name,
        kind: "actor",
        status: "completed",
        ...(actor.setupPath ? { setup: relative(projectDir, actor.setupPath) } : {}),
        result: await crawlWebApp({
          ...crawlOptions(url, options),
          ...(Object.keys(actor.headers).length > 0 ? { headers: actor.headers } : {}),
          ...(storageState ? { storageState } : {}),
        }),
      });
    } catch (error) {
      sessions.push({
        actor: actor.name,
        kind: "actor",
        status: "error",
        ...(actor.setupPath ? { setup: relative(projectDir, actor.setupPath) } : {}),
        error: redact(error instanceof Error ? error.message : String(error), actor.redactions),
      });
    }
  }

  const stagedPaths = new Map<string, string>();
  const anonymousByRoute = new Map(
    (sessions.find((session) => session.kind === "anonymous")?.result?.pages ?? [])
      .map((page) => [routeKey(page.requestedUrl), page] as const),
  );
  for (const session of sessions) {
    if (!session.result) continue;
    for (const page of session.result.pages) {
      if (!page.flow || !page.filename) continue;
      if (coverageFor(coverage, page.requestedUrl).status === "covered") continue;
      if (session.kind === "actor") {
        const anonymous = anonymousByRoute.get(routeKey(page.requestedUrl));
        if (
          anonymous?.candidateEligible &&
          anonymous.observationHash === page.observationHash
        ) {
          continue;
        }
      }
      const key = `${session.actor}:${page.filename}`;
      if (session.kind === "anonymous") {
        const path = join(candidatesDir, page.filename);
        await stageAnonymousCandidate(path, page.flow);
        stagedPaths.set(key, path);
      } else {
        const actor = sessionActor(session.actor, actors)!;
        const filename = `${safeActorSlug(actor.name)}-${page.filename.replace(/\.ya?ml$/i, "")}.candidate.json`;
        const path = join(candidatesDir, filename);
        await stageActorCandidate(path, actor, page);
        stagedPaths.set(key, path);
      }
    }
  }

  const pages: ReportPage[] = sessions.flatMap((session) =>
    (session.result?.pages ?? []).map((page) => {
      const { flow: _flow, ...safePage } = page;
      const candidatePath = page.filename
        ? stagedPaths.get(`${session.actor}:${page.filename}`)
        : undefined;
      return {
        ...safePage,
        actor: session.actor,
        routeCoverage: coverageFor(coverage, page.requestedUrl),
        ...(candidatePath ? { candidatePath } : {}),
      };
    }),
  );
  const routes = [...new Set(pages.map((page) => routeKey(page.requestedUrl)).filter(Boolean))];
  const coveredRoutes = routes.filter((route) => (coverage.byRoute.get(route!)?.length ?? 0) > 0).length;
  const accessMatrix = Object.fromEntries(
    routes.sort().map((route) => [
      route,
      Object.fromEntries(
        sessions.map((session) => {
          const page = pages.find(
            (entry) => entry.actor === session.actor && routeKey(entry.requestedUrl) === route,
          );
          return [
            session.actor,
            session.status === "error"
              ? "error"
              : !page
                ? "not-discovered"
                : page.accessSignals.length > 0 || page.reasons.includes("authentication-required")
                  ? "gated"
                  : "reached",
          ];
        }),
      ),
    ]),
  );
  const reportPath = join(artifactsDir, "results.json");
  const output = {
    formatVersion: 1,
    seedUrl: url,
    urlSource: options.urlSource,
    startedAt,
    finishedAt: new Date().toISOString(),
    sessions: sessions.map(({ result: _result, ...session }) => session),
    pages,
    accessMatrix,
    visited: pages.length,
    eligibleCandidates: pages.filter((page) => page.candidateEligible).length,
    accessWarnings: pages.filter((page) => page.accessSignals.length > 0).length,
    staged: stagedPaths.size,
    reportPath,
    coverage: {
      approvedFlows: coverage.approvedFlows,
      invalidFlows: coverage.invalidFlows,
      coveredRoutes,
      uncoveredRoutes: routes.length - coveredRoutes,
    },
  };
  await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  const completed = sessions.filter((session) => session.status === "completed").length;
  process.stdout.write(`Crawled ${completed} sessions (${pages.length} page observations).\n`);
  process.stdout.write(
    `${coveredRoutes} routes covered by approved flows; ${routes.length - coveredRoutes} uncovered.\n`,
  );
  process.stdout.write(
    output.staged > 0
      ? `Staged ${output.staged} candidates for developer or agent review.\n`
      : "No uncovered candidates were staged.\n",
  );
  const anonymousWarnings = pages.filter(
    (page) => page.actor === "anonymous" && page.accessSignals.length > 0,
  ).length;
  if (anonymousWarnings > 0) {
    process.stdout.write(
      `Warning: ${anonymousWarnings} anonymous routes show possible authentication barriers` +
        (actors.length === 0 ? "; configure polymux/actors.yaml for authenticated coverage.\n" : ".\n"),
    );
  }
  for (const session of sessions.filter((entry) => entry.status === "error")) {
    process.stdout.write(`Warning: actor ${session.actor} could not be crawled: ${session.error}\n`);
  }
  process.stdout.write(`Report: ${relative(projectDir, reportPath)}\n`);
}
