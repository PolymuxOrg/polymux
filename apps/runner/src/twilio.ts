import { randomUUID } from "node:crypto";
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

type TwilioProvider = Extract<CompiledFixtureProvider, { kind: "twilio" }>;
type JsonObject = Record<string, JsonValue>;

interface TwilioSettings {
  apiUrl: string;
  accountSid: string;
  phoneNumber: string;
  authorization: string;
  pollIntervalMs: number;
  maxMessageBytes: number;
}

interface TwilioMessage {
  sid?: unknown;
  body?: unknown;
  from?: unknown;
  to?: unknown;
  direction?: unknown;
  date_sent?: unknown;
  date_created?: unknown;
}

interface PhoneState {
  number: string;
  createdAt: number;
  baselineIds: Set<string>;
  consumedIds: Set<string>;
  leaseKey: string;
}

const maximumResponseBytes = 4 * 1024 * 1024;
const phoneLeases = new Map<string, string>();

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
  provider: TwilioProvider,
  key: string,
  fallback?: string,
): string | undefined {
  const value = provider.config[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeFailure(
      `Fixture provider "${provider.name}" config.${key} must be text`,
    );
  }
  return value;
}

function configNumber(
  provider: TwilioProvider,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const value = provider.config[key] ?? fallback;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < 1
    || value > maximum
  ) {
    throw new RuntimeFailure(
      `Fixture provider "${provider.name}" config.${key} must be an integer from 1 to ${maximum}`,
    );
  }
  return value;
}

function environment(
  provider: TwilioProvider,
  source: NodeJS.ProcessEnv,
  configKey: string,
  defaultName: string,
): { name: string; value?: string } {
  const name = configString(provider, configKey, defaultName)!;
  const value = source[name];
  return value === undefined ? { name } : { name, value };
}

function requiredEnvironment(
  provider: TwilioProvider,
  source: NodeJS.ProcessEnv,
  configKey: string,
  defaultName: string,
): string {
  const entry = environment(provider, source, configKey, defaultName);
  if (!entry.value) {
    throw new RuntimeFailure(
      `Fixture provider "${provider.name}" needs environment variable ${entry.name}`,
    );
  }
  return entry.value;
}

function inputObject(value: JsonValue | undefined, context: string): JsonObject {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeFailure(`${context} must be an object`);
  }
  return value;
}

function stringInput(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeFailure(`SMS match.${key} must be text`);
  }
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function timestamp(message: TwilioMessage): number | undefined {
  const raw = typeof message.date_sent === "string"
    ? message.date_sent
    : message.date_created;
  if (typeof raw !== "string") return undefined;
  const value = Date.parse(raw);
  return Number.isNaN(value) ? undefined : value;
}

export class TwilioTransport implements BuiltinFixtureTransport {
  private readonly phones = new Map<string, PhoneState>();
  private cachedSettings: TwilioSettings | undefined;
  private verified = false;

  constructor(
    private readonly provider: TwilioProvider,
    private readonly environmentSource: NodeJS.ProcessEnv = process.env,
  ) {}

  private settings(): TwilioSettings {
    if (this.cachedSettings) return this.cachedSettings;
    const rawUrl = configString(
      this.provider,
      "apiUrl",
      "https://api.twilio.com",
    )!;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" has an invalid API URL`,
      );
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const twilioApiHost =
      /^api(?:\.[a-z0-9-]+){0,2}\.twilio\.com$/i.test(url.hostname);
    if (
      url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
      || (!loopback && !twilioApiHost)
      || (url.protocol !== "https:" && (url.protocol !== "http:" || !loopback))
    ) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" API URL must be a Twilio HTTPS API origin, except for local loopback testing`,
      );
    }

    const accountSid = requiredEnvironment(
      this.provider,
      this.environmentSource,
      "accountSidFromEnv",
      "TWILIO_ACCOUNT_SID",
    );
    if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" received an invalid Twilio Account SID`,
      );
    }
    const phoneNumber = requiredEnvironment(
      this.provider,
      this.environmentSource,
      "phoneNumberFromEnv",
      "TWILIO_PHONE_NUMBER",
    );
    if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" phone number must use E.164 format`,
      );
    }

    const apiKey = environment(
      this.provider,
      this.environmentSource,
      "apiKeyFromEnv",
      "TWILIO_API_KEY",
    );
    const apiKeySecret = environment(
      this.provider,
      this.environmentSource,
      "apiKeySecretFromEnv",
      "TWILIO_API_KEY_SECRET",
    );
    const configuredApiKey = this.provider.config.apiKeyFromEnv !== undefined
      || this.provider.config.apiKeySecretFromEnv !== undefined;
    if (
      configuredApiKey
      || apiKey.value !== undefined
      || apiKeySecret.value !== undefined
    ) {
      if (!apiKey.value || !apiKeySecret.value) {
        throw new RuntimeFailure(
          `Fixture provider "${this.provider.name}" needs both ${apiKey.name} and ${apiKeySecret.name}`,
        );
      }
      if (!/^SK[0-9a-f]{32}$/i.test(apiKey.value)) {
        throw new RuntimeFailure(
          `Fixture provider "${this.provider.name}" received an invalid Twilio API key SID`,
        );
      }
    }
    const username = apiKey.value ?? accountSid;
    const password = apiKey.value
      ? apiKeySecret.value!
      : requiredEnvironment(
          this.provider,
          this.environmentSource,
          "authTokenFromEnv",
          "TWILIO_AUTH_TOKEN",
        );

    this.cachedSettings = {
      apiUrl: url.origin,
      accountSid,
      phoneNumber,
      authorization:
        `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      pollIntervalMs: configNumber(
        this.provider,
        "pollIntervalMs",
        500,
        60_000,
      ),
      maxMessageBytes: configNumber(
        this.provider,
        "maxMessageBytes",
        16 * 1024,
        64 * 1024,
      ),
    };
    return this.cachedSettings;
  }

  private async json(path: string, timeoutMs: number): Promise<unknown> {
    const settings = this.settings();
    let response: Response;
    try {
      response = await fetch(`${settings.apiUrl}${path}`, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: settings.authorization,
        },
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
      });
    } catch (error) {
      throw new RuntimeFailure(
        `Could not reach fixture provider "${this.provider.name}"`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" returned HTTP ${response.status}`,
      );
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumResponseBytes) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" returned an oversized response`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" returned an empty response`,
      );
    }
    const decoder = new TextDecoder();
    let text = "";
    let receivedBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > maximumResponseBytes) {
          await reader.cancel();
          throw new RuntimeFailure(
            `Fixture provider "${this.provider.name}" returned an oversized response`,
          );
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error;
      throw new RuntimeFailure(
        `Could not read fixture provider "${this.provider.name}" response`,
        { cause: error },
      );
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" returned non-JSON HTTP ${response.status}`,
        { cause: error },
      );
    }
  }

  private accountPath(resource: string): string {
    const accountSid = encodeURIComponent(this.settings().accountSid);
    return `/2010-04-01/Accounts/${accountSid}/${resource}`;
  }

  private async health(): Promise<void> {
    if (this.verified) return;
    const settings = this.settings();
    const query = new URLSearchParams({
      PhoneNumber: settings.phoneNumber,
      PageSize: "2",
    });
    const value = await this.json(
      `${this.accountPath("IncomingPhoneNumbers.json")}?${query}`,
      this.provider.timeoutMs,
    );
    if (
      typeof value !== "object"
      || value === null
      || !("incoming_phone_numbers" in value)
      || !Array.isArray(value.incoming_phone_numbers)
    ) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" returned invalid phone-number results`,
      );
    }
    const number = value.incoming_phone_numbers.find((entry) =>
      typeof entry === "object"
      && entry !== null
      && "phone_number" in entry
      && entry.phone_number === settings.phoneNumber
    );
    if (!number || typeof number !== "object") {
      throw new RuntimeFailure(
        "The configured Twilio number is not provisioned in the configured account",
      );
    }
    const capabilities = "capabilities" in number ? number.capabilities : undefined;
    if (
      typeof capabilities !== "object"
      || capabilities === null
      || !("sms" in capabilities)
      || capabilities.sms !== true
    ) {
      throw new RuntimeFailure(
        "The configured Twilio number is not SMS-capable",
      );
    }
    this.verified = true;
  }

  private async listMessages(timeoutMs: number): Promise<TwilioMessage[]> {
    const query = new URLSearchParams({
      To: this.settings().phoneNumber,
      PageSize: "1000",
    });
    const value = await this.json(
      `${this.accountPath("Messages.json")}?${query}`,
      timeoutMs,
    );
    if (
      typeof value !== "object"
      || value === null
      || !("messages" in value)
      || !Array.isArray(value.messages)
    ) {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" returned invalid message results`,
      );
    }
    return value.messages as TwilioMessage[];
  }

  private async create(
    request: Extract<FixtureRequestInput, { method: "create" }>,
  ): Promise<{ handle: string; values: JsonObject }> {
    if (request.fixtureType !== "phone") {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" only creates phone fixtures`,
      );
    }
    const input = inputObject(request.input, "Twilio phone input");
    if (Object.keys(input).length > 0) {
      throw new RuntimeFailure(
        `Unknown Twilio phone input: ${Object.keys(input).join(", ")}`,
      );
    }
    const settings = this.settings();
    await this.health();
    const handle = `twilio:${randomUUID()}`;
    const leaseKey =
      `${settings.apiUrl}|${settings.accountSid}|${settings.phoneNumber}`;
    if (phoneLeases.has(leaseKey)) {
      throw new RuntimeFailure(
        "The configured Twilio number is already leased by another active run",
      );
    }
    phoneLeases.set(leaseKey, handle);
    try {
      const createdAt = Math.floor(Date.now() / 1000) * 1000;
      const messages = await this.listMessages(this.provider.timeoutMs);
      const baselineIds = new Set(
        messages.flatMap((message) =>
          typeof message.sid === "string" ? [message.sid] : []
        ),
      );
      this.phones.set(handle, {
        number: settings.phoneNumber,
        createdAt,
        baselineIds,
        consumedIds: new Set(),
        leaseKey,
      });
      return { handle, values: { number: settings.phoneNumber } };
    } catch (error) {
      if (phoneLeases.get(leaseKey) === handle) phoneLeases.delete(leaseKey);
      throw error;
    }
  }

  private state(handle: string): PhoneState {
    const state = this.phones.get(handle);
    if (!state) throw new RuntimeFailure("Twilio phone handle is not active");
    return state;
  }

  private candidate(
    message: TwilioMessage,
    state: PhoneState,
    match: JsonObject,
  ): {
    id: string;
    body: string;
    from: string;
    to: string;
    receivedAt: string;
    timestamp: number;
  } | undefined {
    if (
      typeof message.sid !== "string"
      || !/^(?:SM|MM)[0-9a-f]{32}$/i.test(message.sid)
      || state.baselineIds.has(message.sid)
      || state.consumedIds.has(message.sid)
      || message.direction !== "inbound"
      || typeof message.body !== "string"
      || typeof message.from !== "string"
      || message.to !== state.number
    ) {
      return undefined;
    }
    const receivedAt = typeof message.date_sent === "string"
      ? message.date_sent
      : message.date_created;
    const receivedTimestamp = timestamp(message);
    if (
      typeof receivedAt !== "string"
      || receivedTimestamp === undefined
      || receivedTimestamp < state.createdAt
    ) {
      return undefined;
    }
    const expectedFrom = stringInput(match, "from");
    const expectedBody = stringInput(match, "body");
    if (
      expectedFrom
      && !message.from.toLocaleLowerCase().includes(
        expectedFrom.toLocaleLowerCase(),
      )
    ) {
      return undefined;
    }
    if (
      expectedBody
      && !message.body.toLocaleLowerCase().includes(
        expectedBody.toLocaleLowerCase(),
      )
    ) {
      return undefined;
    }
    return {
      id: message.sid,
      body: message.body,
      from: message.from,
      to: state.number,
      receivedAt,
      timestamp: receivedTimestamp,
    };
  }

  private async receive(
    request: Extract<FixtureRequestInput, { method: "receive" }>,
  ): Promise<{ handle: string; values: JsonObject; secrets: JsonObject }> {
    if (request.fixtureType !== "phone") {
      throw new RuntimeFailure(
        `Fixture provider "${this.provider.name}" only receives phone fixtures`,
      );
    }
    const state = this.state(request.handle);
    const input = inputObject(request.input, "SMS receive input");
    const unknown = Object.keys(input).filter(
      (key) => !["extract", "match"].includes(key),
    );
    if (unknown.length > 0) {
      throw new RuntimeFailure(
        `Unknown SMS receive input: ${unknown.join(", ")}`,
      );
    }
    const match = input.match === undefined
      ? {}
      : inputObject(input.match, "SMS match");
    const unknownMatch = Object.keys(match).filter(
      (key) => !["from", "body"].includes(key),
    );
    if (unknownMatch.length > 0) {
      throw new RuntimeFailure(
        `Unknown SMS match option: ${unknownMatch.join(", ")}`,
      );
    }
    const settings = this.settings();
    const deadline = Date.now() + request.timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const messages = await this.listMessages(
        Math.min(this.provider.timeoutMs, remaining),
      );
      const candidate = messages
        .flatMap((message) => {
          const value = this.candidate(message, state, match);
          return value ? [value] : [];
        })
        .sort((left, right) =>
          left.timestamp - right.timestamp || left.id.localeCompare(right.id)
        )[0];
      if (candidate) {
        if (Buffer.byteLength(candidate.body) > settings.maxMessageBytes) {
          throw new RuntimeFailure(
            `Fixture provider "${this.provider.name}" returned an SMS larger than its configured limit`,
          );
        }
        state.consumedIds.add(candidate.id);
        return {
          handle: request.handle,
          values: {
            id: candidate.id,
            from: candidate.from,
            to: candidate.to,
            receivedAt: candidate.receivedAt,
          },
          secrets: { body: candidate.body },
        };
      }
      await sleep(
        Math.min(
          settings.pollIntervalMs,
          Math.max(1, deadline - Date.now()),
        ),
      );
    }
    throw new RuntimeFailure("Timed out waiting for a matching SMS");
  }

  private destroy(handle: string): void {
    const state = this.phones.get(handle);
    if (!state) return;
    this.phones.delete(handle);
    if (phoneLeases.get(state.leaseKey) === handle) {
      phoneLeases.delete(state.leaseKey);
    }
  }

  async call(request: FixtureRequestInput): Promise<FixtureResponse> {
    const id = randomUUID();
    try {
      if (request.method === "health") {
        await this.health();
        return success(id);
      }
      if (request.method === "create") {
        return success(id, await this.create(request));
      }
      if (request.method === "receive") {
        return success(id, await this.receive(request));
      }
      this.destroy(request.handle);
      return success(id);
    } catch (error) {
      return failure(
        id,
        "twilio_error",
        error instanceof Error
          ? error.message
          : "Unknown Twilio provider error",
      );
    }
  }

  async close(): Promise<void> {
    for (const handle of [...this.phones.keys()]) this.destroy(handle);
    this.cachedSettings = undefined;
    this.verified = false;
  }
}
