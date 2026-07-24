import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  CompiledFixtureProvider,
  CompiledCoordinatedFlow,
  CompiledFlowActor,
  CompiledSingleActorFlow,
  FixtureRequest,
  FixtureResource,
  FixtureResponse,
  JsonValue,
  CoordinatedFlowRunResult,
} from "@polymux/protocol";
import {
  fixtureProtocolVersion,
  fixtureResponseSchema,
} from "@polymux/protocol";
import {
  RuntimeFailure,
  type EmailCoordination,
  type ReceiveEmailRequest,
  type ReceiveSmsRequest,
  type ScopedHeaderRule,
  type SmsCoordination,
} from "@polymux/core";
import {
  assertPolymuxTestEnvironment,
  signPolymuxTestChallenge,
} from "@polymux/test-gates";
import {
  createServiceTransport,
} from "./builtin-providers.js";
import { extractReceivedEmail } from "./email.js";
import { MailpitTransport } from "./mailpit.js";
import { extractReceivedSms } from "./sms.js";
import { TwilioTransport } from "./twilio.js";

type RequestInput = FixtureRequest extends infer Request
  ? Request extends FixtureRequest
    ? Omit<Request, "protocol" | "id">
    : never
  : never;

interface FixtureTransport {
  call(request: RequestInput, timeoutMs?: number): Promise<FixtureResponse>;
  close(): Promise<void>;
}

type CloudBuiltinProvider = Exclude<
  CompiledFixtureProvider,
  { kind: "command" | "http" | "twilio" }
>;

const cloudProviderConfigKeys = {
  challenge: [],
  supabase: ["emailDomain"],
  firebase: ["projectId", "createCustomToken", "emailDomain"],
  auth0: ["connection", "emailDomain"],
  clerk: ["emailDomain"],
  mailpit: ["emailDomain", "pollIntervalMs", "maxMessageBytes"],
} as const satisfies Record<CloudBuiltinProvider["kind"], readonly string[]>;

function assertCloudProviderConfiguration(
  provider: CloudBuiltinProvider,
  environment: NodeJS.ProcessEnv,
): void {
  const allowed = new Set<string>(cloudProviderConfigKeys[provider.kind]);
  const unsafe = Object.keys(provider.config).filter((key) => !allowed.has(key));
  if (unsafe.length > 0) {
    throw new RuntimeFailure(
      `Cloud execution does not allow config.${unsafe.sort().join(` or config.`)} on ${provider.kind} fixture provider "${provider.name}"`,
    );
  }
  if (
    provider.kind === "firebase"
    && !environment.FIREBASE_SERVICE_ACCOUNT_JSON
  ) {
    throw new RuntimeFailure(
      `Cloud execution requires an explicit per-run Firebase service account for fixture provider "${provider.name}"`,
    );
  }
}

function providerFailure(provider: string, response: FixtureResponse): never {
  if (response.ok) throw new Error("Expected fixture provider failure");
  throw new RuntimeFailure(
    `Fixture provider "${provider}" failed (${response.error.code}): ${response.error.message}`,
  );
}

class CommandTransport implements FixtureTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, {
    resolve: (response: FixtureResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly provider: Extract<CompiledFixtureProvider, { kind: "command" }>,
    private readonly environment: NodeJS.ProcessEnv,
  ) {
    const [command, ...args] = provider.command;
    if (!command) throw new RuntimeFailure(`Fixture provider "${provider.name}" has no command`);
    this.child = spawn(command, args, {
      cwd: provider.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.receive(line));
    this.child.once("error", (error) => this.rejectAll(
      new RuntimeFailure(`Could not start fixture provider "${provider.name}"`, { cause: error }),
    ));
    this.child.once("exit", (code, signal) => this.rejectAll(
      new RuntimeFailure(
        `Fixture provider "${provider.name}" exited unexpectedly (${signal ?? code ?? "unknown"})`,
      ),
    ));
    // Provider logs belong on stderr. Keep them out of result artifacts and protocol parsing.
    this.child.stderr.resume();
  }

  private receive(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.rejectAll(new RuntimeFailure(
        `Fixture provider "${this.provider.name}" wrote non-JSON data to stdout`,
      ));
      return;
    }
    const parsed = fixtureResponseSchema.safeParse(value);
    if (!parsed.success) {
      this.rejectAll(new RuntimeFailure(
        `Fixture provider "${this.provider.name}" returned an invalid protocol response`,
      ));
      return;
    }
    const pending = this.pending.get(parsed.data.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(parsed.data.id);
    pending.resolve(parsed.data);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  call(input: RequestInput, timeoutMs?: number): Promise<FixtureResponse> {
    const id = randomUUID();
    const request: FixtureRequest = { protocol: fixtureProtocolVersion, id, ...input };
    return new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new RuntimeFailure(
          `Fixture provider "${this.provider.name}" timed out during ${input.method}`,
        ));
      }, timeoutMs ?? this.provider.timeoutMs);
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        rejectResponse(new RuntimeFailure(
          `Could not write to fixture provider "${this.provider.name}"`,
          { cause: error },
        ));
      });
    });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    const exited = new Promise<void>((resolveExit) => this.child.once("exit", () => resolveExit()));
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 1_000);
    await exited;
    clearTimeout(timer);
  }
}

class HttpTransport implements FixtureTransport {
  constructor(
    private readonly provider: Extract<CompiledFixtureProvider, { kind: "http" }>,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  async call(input: RequestInput, timeoutMs?: number): Promise<FixtureResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const [header, environmentName] of Object.entries(this.provider.headersFromEnv)) {
      const value = this.environment[environmentName];
      if (!value) {
        throw new RuntimeFailure(
          `Fixture provider "${this.provider.name}" needs environment variable ${environmentName}`,
        );
      }
      headers[header] = value;
    }
    const request: FixtureRequest = {
      protocol: fixtureProtocolVersion,
      id: randomUUID(),
      ...input,
    };
    let response: Response;
    try {
      response = await fetch(this.provider.url, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs ?? this.provider.timeoutMs),
      });
    } catch (error) {
      throw new RuntimeFailure(`Could not reach fixture provider "${this.provider.name}"`, {
        cause: error,
      });
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" returned non-JSON HTTP ${response.status}`,
        { cause: error },
      );
    }
    const parsed = fixtureResponseSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== request.id) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" returned an invalid protocol response`,
      );
    }
    return parsed.data;
  }

  async close(): Promise<void> {}
}

function challengeConfiguration(
  values: NodeJS.ProcessEnv,
): { environment: string; secret: string } {
  let environment: string;
  try {
    environment = assertPolymuxTestEnvironment(
      values.POLYMUX_TEST_ENVIRONMENT ?? "",
    );
  } catch (error) {
    throw new RuntimeFailure(
      error instanceof Error ? error.message : "Invalid Polymux test environment",
    );
  }
  const secret = values.POLYMUX_TEST_CHALLENGE_SECRET;
  if (!secret || secret.length < 32) {
    throw new RuntimeFailure(
      "POLYMUX_TEST_CHALLENGE_SECRET must contain at least 32 characters",
    );
  }
  return { environment, secret };
}

class ChallengeTransport implements FixtureTransport {
  constructor(
    private readonly provider: Extract<CompiledFixtureProvider, { kind: "challenge" }>,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  async call(input: RequestInput): Promise<FixtureResponse> {
    const id = randomUUID();
    if (input.method !== "create") {
      return { protocol: fixtureProtocolVersion, id, ok: true };
    }
    if (input.fixtureType !== "challenge" || !input.context) {
      return {
        protocol: fixtureProtocolVersion,
        id,
        ok: false,
        error: { code: "invalid_challenge", message: "Challenge fixtures require context and type challenge" },
      };
    }
    const raw = input.input;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {
        protocol: fixtureProtocolVersion,
        id,
        ok: false,
        error: { code: "invalid_challenge", message: "Challenge input must be an object" },
      };
    }
    const audience = typeof raw.audience === "string" ? raw.audience : undefined;
    const action = typeof raw.action === "string" ? raw.action : undefined;
    const ttlSeconds = typeof raw.ttlSeconds === "number" ? raw.ttlSeconds : 120;
    if (!audience || !action || ttlSeconds < 1 || ttlSeconds > 300) {
      return {
        protocol: fixtureProtocolVersion,
        id,
        ok: false,
        error: { code: "invalid_challenge", message: "Challenge needs audience, action, and ttlSeconds from 1 to 300" },
      };
    }
    const now = Math.floor(Date.now() / 1_000);
    const jti = randomUUID();
    const challenge = challengeConfiguration(this.environment);
    const claims = {
      iss: "polymux:test-gates",
      aud: audience,
      sub: input.context.actors.length === 1 ? input.context.actors[0]! : "shared",
      action,
      flowRunId: input.context.flowRunId,
      instance: input.context.instance,
      environment: challenge.environment,
      iat: now,
      exp: now + ttlSeconds,
      jti,
    } as const;
    const assertion = signPolymuxTestChallenge(claims, challenge.secret);
    return {
      protocol: fixtureProtocolVersion,
      id,
      ok: true,
      result: {
        handle: `challenge:${jti}`,
        values: { action, audience, expiresAt: claims.exp },
        secrets: { assertion },
      },
    };
  }

  async close(): Promise<void> {}
}

function createTransport(
  provider: CompiledFixtureProvider,
  environment: NodeJS.ProcessEnv,
  executionMode: "local" | "cloud",
): FixtureTransport {
  if (
    executionMode === "cloud" &&
    (
      provider.kind === "command"
      || provider.kind === "http"
      || provider.kind === "twilio"
    )
  ) {
    throw new RuntimeFailure(
      `Cloud execution does not allow ${provider.kind} fixture provider "${provider.name}"`,
    );
  }
  if (executionMode === "cloud") {
    assertCloudProviderConfiguration(provider as CloudBuiltinProvider, environment);
  }
  if (provider.kind === "command") return new CommandTransport(provider, environment);
  if (provider.kind === "http") return new HttpTransport(provider, environment);
  if (provider.kind === "challenge") return new ChallengeTransport(provider, environment);
  if (provider.kind === "mailpit") return new MailpitTransport(provider, environment);
  if (provider.kind === "twilio") return new TwilioTransport(provider, environment);
  return createServiceTransport(provider, environment);
}

function getPath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw new RuntimeFailure(`Fixture variable "${path}" does not exist`);
    }
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) throw new RuntimeFailure(`Fixture variable "${path}" does not exist`);
  }
  return current;
}

function substituteString(value: string, variables: unknown): unknown {
  const exact = /^\$\{([^}]+)\}$/.exec(value);
  if (exact) {
    if (exact[1]!.startsWith("messages.")) return value;
    return getPath(variables, exact[1]!);
  }
  return value.replace(/\$\{([^}]+)\}/g, (match, path: string) => {
    if (path.startsWith("messages.")) return match;
    const replacement = getPath(variables, path);
    if (["string", "number", "boolean"].includes(typeof replacement)) return String(replacement);
    throw new RuntimeFailure(`Fixture variable "${path}" cannot be embedded in text`);
  });
}

function substitute(value: unknown, variables: unknown): unknown {
  if (typeof value === "string") return substituteString(value, variables);
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, variables));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substitute(entry, variables)]),
    );
  }
  return value;
}

function secretStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(secretStrings);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(secretStrings);
  }
  return [];
}

interface ResourceDefinition {
  name: string;
  provider: string;
  type: string;
  actors: string[];
  input?: JsonValue;
}

interface AcquiredResource {
  definition: ResourceDefinition;
  resource: FixtureResource;
}

interface PreparedProtection {
  origin: string;
  headers: Record<string, string>;
}

function exposedResource(resource: FixtureResource): {
  values: Record<string, JsonValue>;
  secrets: Record<string, JsonValue>;
  auth?: JsonValue;
} {
  return {
    values: resource.values ?? {},
    secrets: resource.secrets ?? {},
    ...(resource.auth !== undefined ? { auth: resource.auth } : {}),
  };
}

function protectionOrigin(name: string, rawOrigin: string): string {
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new RuntimeFailure(`Protection "${name}" has an invalid origin`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new RuntimeFailure(
      `Protection "${name}" needs an exact HTTP origin without credentials, a path, query, or fragment`,
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new RuntimeFailure(
      `Protection "${name}" requires HTTPS except on local loopback`,
    );
  }
  return url.origin;
}

function assertTestEnvironment(environment: NodeJS.ProcessEnv): void {
  try {
    assertPolymuxTestEnvironment(
      environment.POLYMUX_TEST_ENVIRONMENT ?? "",
    );
  } catch (error) {
    throw new RuntimeFailure(
      error instanceof Error ? error.message : "Invalid Polymux test environment",
    );
  }
}

function mergeScopedHeaders(rules: ScopedHeaderRule[]): ScopedHeaderRule[] {
  const byOrigin = new Map<string, Record<string, string>>();
  for (const rule of rules) {
    for (const origin of rule.origins) {
      const headers = byOrigin.get(origin) ?? {};
      for (const [name, value] of Object.entries(rule.headers)) {
        if (headers[name] !== undefined && headers[name] !== value) {
          throw new RuntimeFailure(
            `Protections returned conflicting values for header "${name}" at ${origin}`,
          );
        }
        headers[name] = value;
      }
      byOrigin.set(origin, headers);
    }
  }
  return [...byOrigin.entries()].map(([origin, headers]) => ({
    origins: [origin],
    headers,
  }));
}

export class FlowFixtures {
  private readonly transports = new Map<string, FixtureTransport>();
  private readonly healthy = new Set<string>();
  private readonly acquired = new Map<string, AcquiredResource>();
  private readonly preparedProtections = new Map<string, PreparedProtection>();
  private readonly cleanupFailures = new Set<string>();

  constructor(
    private readonly flow: CompiledCoordinatedFlow,
    private readonly context: {
      flowRunId: string;
      instance: number;
      seed: string;
    },
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly executionMode: "local" | "cloud" = "local",
  ) {}

  private transport(name: string): FixtureTransport {
    const existing = this.transports.get(name);
    if (existing) return existing;
    const provider = this.flow.providers.find((entry) => entry.name === name);
    if (!provider) throw new RuntimeFailure(`Unknown fixture provider "${name}"`);
    const created = createTransport(
      provider,
      this.environment,
      this.executionMode,
    );
    this.transports.set(name, created);
    return created;
  }

  private async ensureHealthy(name: string): Promise<void> {
    if (this.healthy.has(name)) return;
    const response = await this.transport(name).call({ method: "health" });
    if (!response.ok) providerFailure(name, response);
    this.healthy.add(name);
  }

  private definitions(): ResourceDefinition[] {
    return this.flow.fixtures.map((fixture) => ({
      name: fixture.name,
      provider: fixture.provider,
      type: fixture.type,
      actors: this.flow.actors
        .filter((actor) => Object.values(actor.fixtures).includes(fixture.name))
        .map((actor) => actor.name),
      ...(fixture.input !== undefined ? { input: fixture.input } : {}),
    }));
  }

  private prepareProtections(): void {
    if (this.flow.protections.length === 0) return;
    assertTestEnvironment(this.environment);
    for (const protection of this.flow.protections) {
      const originValue = protection.origin
        ?? this.environment[protection.originFromEnv!];
      if (!originValue) {
        throw new RuntimeFailure(
          `Protection "${protection.name}" needs environment variable ${protection.originFromEnv}`,
        );
      }
      const headers: Record<string, string> = {};
      for (const [rawName, environmentName] of Object.entries(
        protection.headersFromEnv,
      )) {
        if (!/^[A-Za-z0-9-]+$/.test(rawName)) {
          throw new RuntimeFailure(
            `Protection "${protection.name}" has an invalid header name`,
          );
        }
        const name = rawName.toLowerCase();
        if (headers[name] !== undefined) {
          throw new RuntimeFailure(
            `Protection "${protection.name}" declares header "${name}" more than once`,
          );
        }
        const value = this.environment[environmentName];
        if (!value) {
          throw new RuntimeFailure(
            `Protection "${protection.name}" needs environment variable ${environmentName}`,
          );
        }
        headers[name] = value;
      }
      this.preparedProtections.set(protection.name, {
        origin: protectionOrigin(protection.name, originValue),
        headers,
      });
    }
  }

  async createAll(): Promise<void> {
    this.prepareProtections();
    for (const definition of this.definitions()) {
      await this.ensureHealthy(definition.provider);
      const response = await this.transport(definition.provider).call({
        method: "create",
        fixture: definition.name,
        fixtureType: definition.type,
        context: {
          flow: this.flow.name,
          flowRunId: this.context.flowRunId,
          instance: this.context.instance,
          seed: this.context.seed,
          actors: definition.actors,
        },
        ...(definition.input !== undefined ? { input: definition.input } : {}),
      });
      if (!response.ok) providerFailure(definition.provider, response);
      if (!response.result) {
        throw new RuntimeFailure(
          `Fixture provider "${definition.provider}" did not return a resource for "${definition.name}"`,
        );
      }
      this.acquired.set(definition.name, { definition, resource: response.result });
    }
  }

  actor(actor: CompiledFlowActor): {
    flow: CompiledSingleActorFlow;
    headers: Record<string, string>;
    scopedHeaders: ScopedHeaderRule[];
    redactions: string[];
    email: EmailCoordination;
    sms: SmsCoordination;
  } {
    const fixtures = Object.fromEntries(
      Object.entries(actor.fixtures).map(([alias, name]) => {
        const acquired = this.acquired.get(name);
        if (!acquired) throw new RuntimeFailure(`Fixture "${name}" is not ready`);
        return [alias, exposedResource(acquired.resource)];
      }),
    );
    const protections = Object.fromEntries(
      [...this.preparedProtections.entries()].map(([name, protection]) => [
        name,
        {
          values: { origin: protection.origin },
          secrets: { headers: protection.headers },
        },
      ]),
    );
    const variables = {
      fixtures,
      protections,
      polymux: {
        flowRunId: this.context.flowRunId,
        instance: this.context.instance,
        seed: this.context.seed,
        actor: actor.name,
      },
    };
    const flow = substitute(actor.flow, variables) as CompiledSingleActorFlow;
    const headers = substitute(actor.headers, variables) as Record<string, string>;
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== "string") throw new RuntimeFailure(`Actor header "${name}" must resolve to text`);
    }
    const scopedHeaders = mergeScopedHeaders(
      [...this.preparedProtections.values()].map((protection) => ({
        origins: [protection.origin],
        headers: protection.headers,
      })),
    );
    const globalHeaderNames = new Set(
      Object.keys(headers).map((name) => name.toLowerCase()),
    );
    for (const rule of scopedHeaders) {
      for (const name of Object.keys(rule.headers)) {
        if (globalHeaderNames.has(name)) {
          throw new RuntimeFailure(
            `Actor header "${name}" conflicts with a scoped protection header`,
          );
        }
      }
    }
    const redactions = Object.values(actor.fixtures).flatMap((name) => {
      const resource = this.acquired.get(name)?.resource;
      return resource ? secretStrings([resource.secrets ?? {}, resource.auth ?? {}]) : [];
    });
    for (const protection of this.preparedProtections.values()) {
      redactions.push(...Object.values(protection.headers));
    }
    const email: EmailCoordination = {
      receive: (request) => this.receiveEmail(actor, request),
    };
    const sms: SmsCoordination = {
      receive: (request) => this.receiveSms(actor, request),
    };
    return { flow, headers, scopedHeaders, redactions, email, sms };
  }

  private async receiveEmail(
    actor: CompiledFlowActor,
    request: ReceiveEmailRequest,
  ) {
    const fixtureName = actor.fixtures[request.fixture];
    if (!fixtureName) {
      throw new RuntimeFailure(
        `Actor "${actor.name}" has no fixture alias "${request.fixture}"`,
      );
    }
    const acquired = this.acquired.get(fixtureName);
    if (!acquired) throw new RuntimeFailure(`Fixture "${fixtureName}" is not ready`);
    if (acquired.definition.type !== "inbox") {
      throw new RuntimeFailure(
        `Actor fixture alias "${request.fixture}" must reference an inbox fixture`,
      );
    }
    const response = await this.transport(acquired.definition.provider).call({
      method: "receive",
      fixture: acquired.definition.name,
      fixtureType: acquired.definition.type,
      handle: acquired.resource.handle,
      context: {
        flow: this.flow.name,
        flowRunId: this.context.flowRunId,
        instance: this.context.instance,
        seed: this.context.seed,
        actors: acquired.definition.actors,
      },
      timeoutMs: request.timeoutMs,
      input: {
        ...(request.match ? { match: request.match } : {}),
        extract: request.extract,
      },
    }, request.timeoutMs + 1_000);
    if (!response.ok) providerFailure(acquired.definition.provider, response);
    if (!response.result) {
      throw new RuntimeFailure(
        `Fixture provider "${acquired.definition.provider}" returned no email`,
      );
    }
    if (response.result.handle !== acquired.resource.handle) {
      throw new RuntimeFailure(
        `Fixture provider "${acquired.definition.provider}" returned an email for the wrong inbox`,
      );
    }
    return extractReceivedEmail(response.result, request);
  }

  private async receiveSms(
    actor: CompiledFlowActor,
    request: ReceiveSmsRequest,
  ) {
    const fixtureName = actor.fixtures[request.fixture];
    if (!fixtureName) {
      throw new RuntimeFailure(
        `Actor "${actor.name}" has no fixture alias "${request.fixture}"`,
      );
    }
    const acquired = this.acquired.get(fixtureName);
    if (!acquired) throw new RuntimeFailure(`Fixture "${fixtureName}" is not ready`);
    if (acquired.definition.type !== "phone") {
      throw new RuntimeFailure(
        `Actor fixture alias "${request.fixture}" must reference a phone fixture`,
      );
    }
    const response = await this.transport(acquired.definition.provider).call({
      method: "receive",
      fixture: acquired.definition.name,
      fixtureType: acquired.definition.type,
      handle: acquired.resource.handle,
      context: {
        flow: this.flow.name,
        flowRunId: this.context.flowRunId,
        instance: this.context.instance,
        seed: this.context.seed,
        actors: acquired.definition.actors,
      },
      timeoutMs: request.timeoutMs,
      input: {
        ...(request.match ? { match: request.match } : {}),
        extract: request.extract,
      },
    }, request.timeoutMs + 1_000);
    if (!response.ok) providerFailure(acquired.definition.provider, response);
    if (!response.result) {
      throw new RuntimeFailure(
        `Fixture provider "${acquired.definition.provider}" returned no SMS`,
      );
    }
    if (response.result.handle !== acquired.resource.handle) {
      throw new RuntimeFailure(
        `Fixture provider "${acquired.definition.provider}" returned an SMS for the wrong phone`,
      );
    }
    return extractReceivedSms(response.result, request);
  }

  async cleanup(): Promise<void> {
    for (const [key, acquired] of [...this.acquired.entries()].reverse()) {
      try {
        const response = await this.transport(acquired.definition.provider).call({
          method: "destroy",
          fixture: acquired.definition.name,
          fixtureType: acquired.definition.type,
          handle: acquired.resource.handle,
          context: {
            flow: this.flow.name,
            flowRunId: this.context.flowRunId,
            instance: this.context.instance,
            seed: this.context.seed,
            actors: acquired.definition.actors,
          },
        });
        if (!response.ok) providerFailure(acquired.definition.provider, response);
      } catch {
        this.cleanupFailures.add(key);
      }
    }
    await Promise.allSettled([...this.transports.values()].map((transport) => transport.close()));
  }

  summaries(): CoordinatedFlowRunResult["fixtures"] {
    return [...this.acquired.entries()]
      .map(([key, acquired]) => ({
        name: acquired.definition.name,
        provider: acquired.definition.provider,
        type: acquired.definition.type,
        status: this.cleanupFailures.has(key) ? "cleanup-error" as const : "cleaned" as const,
      }));
  }

  protectionSummaries(): CoordinatedFlowRunResult["protections"] {
    return [...this.preparedProtections.keys()].map((name) => ({
      name,
      status: "configured" as const,
    }));
  }

  hasCleanupFailures(): boolean {
    return this.cleanupFailures.size > 0;
  }
}
