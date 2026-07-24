import { createHash, randomUUID } from "node:crypto";
import { RuntimeFailure } from "@polymux/core";
import {
  fixtureProtocolVersion,
  type CompiledFixtureProvider,
  type FixtureResponse,
  type JsonValue,
} from "@polymux/protocol";
import type {
  BuiltinFixtureTransport,
  FixtureRequestInput,
} from "./builtin-providers.js";

type MailpitProvider = Extract<CompiledFixtureProvider, { kind: "mailpit" }>;
type JsonObject = Record<string, JsonValue>;

interface MailpitAddress {
  Address?: unknown;
}

interface MailpitSummary {
  ID?: unknown;
  Created?: unknown;
  From?: MailpitAddress;
  Subject?: unknown;
}

interface MailpitMessage {
  ID?: unknown;
  Date?: unknown;
  From?: MailpitAddress;
  Subject?: unknown;
  Text?: unknown;
  HTML?: unknown;
}

interface InboxState {
  address: string;
  createdAt: number;
  consumedIds: Set<string>;
}

function success(id: string, result?: {
  handle: string;
  values?: JsonObject;
  secrets?: JsonObject;
}): FixtureResponse {
  return {
    protocol: fixtureProtocolVersion,
    id,
    ok: true,
    ...(result ? { result } : {}),
  };
}

function failure(id: string, code: string, message: string): FixtureResponse {
  return {
    protocol: fixtureProtocolVersion,
    id,
    ok: false,
    error: { code, message },
  };
}

function configString(
  provider: MailpitProvider,
  key: string,
  fallback?: string,
): string | undefined {
  const value = provider.config[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeFailure(`Fixture provider "${provider.name}" config.${key} must be text`);
  }
  return value;
}

function configNumber(
  provider: MailpitProvider,
  key: string,
  fallback: number,
): number {
  const value = provider.config[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RuntimeFailure(
      `Fixture provider "${provider.name}" config.${key} must be a positive integer`,
    );
  }
  return value;
}

function inputObject(value: JsonValue | undefined): JsonObject {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeFailure("Mailpit inbox input must be an object");
  }
  return value;
}

function stringInput(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeFailure(`Mailpit inbox input.${key} must be text`);
  }
  return value;
}

function validAddress(address: string): boolean {
  return address.length <= 254
    && /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+$/i.test(address)
    && !address.includes("..");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export class MailpitTransport implements BuiltinFixtureTransport {
  private readonly inboxes = new Map<string, InboxState>();

  constructor(
    private readonly provider: MailpitProvider,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  private settings(): {
    url: string;
    headers: Record<string, string>;
    domain: string;
    pollIntervalMs: number;
    maxMessageBytes: number;
  } {
    const environmentName = configString(this.provider, "urlFromEnv", "MAILPIT_API_URL")!;
    const environmentUrl = this.environment[environmentName];
    if (this.provider.config.urlFromEnv !== undefined && !environmentUrl) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" needs environment variable ${environmentName}`,
      );
    }
    const rawUrl = configString(this.provider, "url")
      ?? environmentUrl
      ?? "http://127.0.0.1:8025";
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new RuntimeFailure(`Fixture provider "${this.provider.name}" has an invalid URL`);
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.username
      || url.password
      || url.search
      || url.hash
      || (url.protocol !== "https:" && (url.protocol !== "http:" || !local))
    ) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" URL must use HTTPS outside local development and must not contain credentials, a query, or a fragment`,
      );
    }
    const usernameName = configString(this.provider, "usernameFromEnv", "MAILPIT_USERNAME")!;
    const passwordName = configString(this.provider, "passwordFromEnv", "MAILPIT_PASSWORD")!;
    const username = this.environment[usernameName];
    const password = this.environment[passwordName];
    if ((username && !password) || (!username && password)) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" needs both ${usernameName} and ${passwordName}`,
      );
    }
    const domain = configString(this.provider, "emailDomain", "mailpit.test")!;
    if (domain.length > 253 || /[@\s/]/.test(domain)) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" config.emailDomain is invalid`,
      );
    }
    return {
      url: url.toString().replace(/\/$/, ""),
      headers: username && password
        ? { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
        : {},
      domain,
      pollIntervalMs: configNumber(this.provider, "pollIntervalMs", 200),
      maxMessageBytes: configNumber(this.provider, "maxMessageBytes", 1024 * 1024),
    };
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    accepted = [200],
  ): Promise<Response> {
    const settings = this.settings();
    let response: Response;
    try {
      response = await fetch(`${settings.url}${path}`, {
        ...init,
        headers: {
          ...settings.headers,
          ...init.headers,
        },
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
    } catch (error) {
      throw new RuntimeFailure(
        `Could not reach fixture provider "${this.provider.name}"`,
        { cause: error },
      );
    }
    if (!accepted.includes(response.status)) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" returned HTTP ${response.status}`,
      );
    }
    return response;
  }

  private async json(path: string, timeoutMs: number): Promise<unknown> {
    const response = await this.request(path, { method: "GET" }, timeoutMs);
    try {
      return await response.json();
    } catch (error) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" returned non-JSON HTTP ${response.status}`,
        { cause: error },
      );
    }
  }

  private create(request: Extract<FixtureRequestInput, { method: "create" }>) {
    if (request.fixtureType !== "inbox") {
      throw new RuntimeFailure(`Fixture provider "${this.provider.name}" only creates inbox fixtures`);
    }
    const input = inputObject(request.input);
    const unknown = Object.keys(input);
    if (unknown.length > 0) {
      throw new RuntimeFailure(`Unknown Mailpit inbox input: ${unknown.join(", ")}`);
    }
    const suffix = createHash("sha256")
      .update(`${request.context.seed}:${request.fixture}`)
      .digest("hex")
      .slice(0, 20);
    const address = `polymux-${suffix}@${this.settings().domain}`.toLowerCase();
    if (!validAddress(address)) {
      throw new RuntimeFailure("Mailpit inbox input.address is not a valid email address");
    }
    const handle = `mailpit:${randomUUID()}`;
    this.inboxes.set(handle, {
      address,
      createdAt: Date.now(),
      consumedIds: new Set(),
    });
    return { handle, values: { address } };
  }

  private state(handle: string): InboxState {
    const state = this.inboxes.get(handle);
    if (!state) throw new RuntimeFailure("Mailpit inbox handle is not active");
    return state;
  }

  private summaryMatches(
    summary: MailpitSummary,
    state: InboxState,
    match: JsonObject,
  ): summary is MailpitSummary & { ID: string } {
    if (typeof summary.ID !== "string" || state.consumedIds.has(summary.ID)) return false;
    if (
      typeof summary.Created !== "string"
      || Number.isNaN(Date.parse(summary.Created))
      || Date.parse(summary.Created) < state.createdAt
    ) {
      return false;
    }
    const expectedFrom = stringInput(match, "from")?.toLocaleLowerCase();
    const expectedSubject = stringInput(match, "subject")?.toLocaleLowerCase();
    const from = typeof summary.From?.Address === "string"
      ? summary.From.Address.toLocaleLowerCase()
      : "";
    const subject = typeof summary.Subject === "string"
      ? summary.Subject.toLocaleLowerCase()
      : "";
    return (!expectedFrom || from.includes(expectedFrom))
      && (!expectedSubject || subject.includes(expectedSubject));
  }

  private async receive(
    request: Extract<FixtureRequestInput, { method: "receive" }>,
  ): Promise<{ handle: string; values: JsonObject; secrets: JsonObject }> {
    if (request.fixtureType !== "inbox") {
      throw new RuntimeFailure(`Fixture provider "${this.provider.name}" only receives inbox fixtures`);
    }
    const state = this.state(request.handle);
    const input = inputObject(request.input);
    const unknown = Object.keys(input).filter((key) => !["extract", "match"].includes(key));
    if (unknown.length > 0) {
      throw new RuntimeFailure(`Unknown email receive input: ${unknown.join(", ")}`);
    }
    const matchValue = input.match;
    const match = matchValue === undefined
      ? {}
      : inputObject(matchValue);
    const unknownMatch = Object.keys(match).filter((key) => !["from", "subject"].includes(key));
    if (unknownMatch.length > 0) {
      throw new RuntimeFailure(`Unknown email match option: ${unknownMatch.join(", ")}`);
    }
    const settings = this.settings();
    const deadline = Date.now() + request.timeoutMs;
    const query = encodeURIComponent(`to:"${state.address}"`);
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const value = await this.json(
        `/api/v1/search?query=${query}&start=0&limit=50`,
        Math.min(this.provider.timeoutMs, remaining),
      ) as { messages?: unknown };
      if (!Array.isArray(value?.messages)) {
        throw new RuntimeFailure(`Fixture provider "${this.provider.name}" returned invalid search results`);
      }
      const summaries = value.messages as MailpitSummary[];
      const candidate = summaries
        .filter((summary) => this.summaryMatches(summary, state, match))
        .sort((left, right) =>
          Date.parse(String(left.Created)) - Date.parse(String(right.Created))
          || String(left.ID).localeCompare(String(right.ID))
        )[0];
      if (candidate) {
        const message = await this.json(
          `/api/v1/message/${encodeURIComponent(candidate.ID)}`,
          Math.min(this.provider.timeoutMs, remaining),
        ) as MailpitMessage;
        const text = typeof message.Text === "string" ? message.Text : "";
        const html = typeof message.HTML === "string" ? message.HTML : "";
        if (Buffer.byteLength(text) + Buffer.byteLength(html) > settings.maxMessageBytes) {
          throw new RuntimeFailure(
            `Fixture provider "${this.provider.name}" returned an email larger than its configured limit`,
          );
        }
        state.consumedIds.add(candidate.ID);
        return {
          handle: request.handle,
          values: {
            id: candidate.ID,
            ...(typeof message.From?.Address === "string"
              ? { from: message.From.Address }
              : {}),
            ...(typeof message.Subject === "string" ? { subject: message.Subject } : {}),
            ...(typeof message.Date === "string"
              ? { receivedAt: message.Date }
              : typeof candidate.Created === "string"
                ? { receivedAt: candidate.Created }
                : {}),
          },
          secrets: { text, html },
        };
      }
      await sleep(Math.min(settings.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    throw new RuntimeFailure("Timed out waiting for a matching email");
  }

  private async destroy(handle: string): Promise<void> {
    const state = this.inboxes.get(handle);
    if (!state) return;
    this.inboxes.delete(handle);
    if (state.consumedIds.size === 0) return;
    await this.request(
      "/api/v1/messages",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ IDs: [...state.consumedIds] }),
      },
      this.provider.timeoutMs,
    );
  }

  async call(request: FixtureRequestInput): Promise<FixtureResponse> {
    const id = randomUUID();
    try {
      if (request.method === "health") {
        await this.request("/api/v1/info", { method: "GET" }, this.provider.timeoutMs);
        return success(id);
      }
      if (request.method === "create") return success(id, this.create(request));
      if (request.method === "receive") return success(id, await this.receive(request));
      await this.destroy(request.handle);
      return success(id);
    } catch (error) {
      return failure(
        id,
        "mailpit_error",
        error instanceof Error ? error.message : "Unknown Mailpit provider error",
      );
    }
  }

  async close(): Promise<void> {}
}
