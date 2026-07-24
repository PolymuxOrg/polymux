import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  CompiledFixtureProvider,
  FixtureRequest,
  FixtureResponse,
  JsonValue,
} from "@polymux/protocol";
import { fixtureProtocolVersion } from "@polymux/protocol";
import { RuntimeFailure } from "@polymux/core";

export type FixtureRequestInput = FixtureRequest extends infer Request
  ? Request extends FixtureRequest
    ? Omit<Request, "protocol" | "id">
    : never
  : never;

type FixtureCreateRequestInput = Extract<
  FixtureRequestInput,
  { method: "create" }
>;

export interface BuiltinFixtureTransport {
  call(request: FixtureRequestInput): Promise<FixtureResponse>;
  close(): Promise<void>;
}

type ServiceProvider = Extract<
  CompiledFixtureProvider,
  { kind: "supabase" | "firebase" | "auth0" | "clerk" }
>;

type ConfiguredProvider = Extract<
  CompiledFixtureProvider,
  { config: Record<string, JsonValue> }
>;

type JsonObject = Record<string, JsonValue>;

function responseId(): string {
  return randomUUID();
}

function success(id: string, result?: {
  handle: string;
  values?: JsonObject;
  secrets?: JsonObject;
  auth?: JsonValue;
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

function inputObject(value: JsonValue | undefined): JsonObject {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeFailure("Built-in account fixture input must be an object");
  }
  return value;
}

function configString(
  provider: ConfiguredProvider,
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

function configBoolean(
  provider: ConfiguredProvider,
  key: string,
  fallback: boolean,
): boolean {
  const value = provider.config[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new RuntimeFailure(`Fixture provider "${provider.name}" config.${key} must be true or false`);
  }
  return value;
}

function requiredEnvironment(
  provider: ConfiguredProvider,
  configKey: string,
  defaultName: string,
  environment: NodeJS.ProcessEnv,
): string {
  const environmentName = configString(provider, configKey, defaultName)!;
  const value = environment[environmentName];
  if (!value) {
    throw new RuntimeFailure(
      `Fixture provider "${provider.name}" needs environment variable ${environmentName}`,
    );
  }
  return value;
}

function optionalEnvironment(
  provider: ConfiguredProvider,
  configKey: string,
  defaultName: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const environmentName = configString(provider, configKey, defaultName)!;
  return environment[environmentName];
}

function stringInput(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeFailure(`Account fixture input.${key} must be text`);
  }
  return value;
}

function booleanInput(input: JsonObject, key: string, fallback?: boolean): boolean | undefined {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new RuntimeFailure(`Account fixture input.${key} must be true or false`);
  }
  return value;
}

function objectInput(input: JsonObject, key: string): JsonObject | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeFailure(`Account fixture input.${key} must be an object`);
  }
  return value;
}

function stringArrayInput(input: JsonObject, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new RuntimeFailure(`Account fixture input.${key} must be a non-empty list of text values`);
  }
  return value as string[];
}

function assertInputKeys(input: JsonObject, allowed: readonly string[]): void {
  const allowedKeys = new Set(["email", "password", ...allowed]);
  const unknown = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new RuntimeFailure(`Unknown account fixture input: ${unknown.join(", ")}`);
  }
}

function normalizedUrl(provider: ConfiguredProvider, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeFailure(`Fixture provider "${provider.name}" has an invalid URL`);
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
      `Fixture provider "${provider.name}" URL must use HTTPS outside local development and must not contain credentials, a query, or a fragment`,
    );
  }
  return url.toString().replace(/\/$/, "");
}

function accountDetails(provider: ServiceProvider, request: FixtureRequestInput): {
  input: JsonObject;
  email: string;
  password: string;
  idSuffix: string;
} {
  if (request.method !== "create" || request.fixtureType !== "account" || !request.context) {
    throw new RuntimeFailure(`Fixture provider "${provider.name}" only creates account fixtures`);
  }
  const input = inputObject(request.input);
  const domain = configString(provider, "emailDomain", "example.test")!;
  if (domain.length > 253 || /[@\s/]/.test(domain)) {
    throw new RuntimeFailure(`Fixture provider "${provider.name}" config.emailDomain is invalid`);
  }
  const suffix = createHash("sha256")
    .update(`${request.context.seed}:${request.fixture}`)
    .digest("hex")
    .slice(0, 20);
  return {
    input,
    email: stringInput(input, "email") ?? `polymux-${suffix}@${domain}`.toLowerCase(),
    password: stringInput(input, "password") ?? `Pmx!${randomBytes(18).toString("base64url")}`,
    idSuffix: suffix,
  };
}

function isFirebaseUserNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "auth/user-not-found";
}

async function rollbackFirebaseUser(
  admin: FirebaseAccountClient,
  uid: string,
  originalError: unknown,
): Promise<never> {
  try {
    await admin.deleteUser(uid);
  } catch (rollbackError) {
    if (!isFirebaseUserNotFound(rollbackError)) {
      throw new RuntimeFailure(
        `Firebase setup failed and rollback could not delete user ${uid}`,
        { cause: new AggregateError([originalError, rollbackError]) },
      );
    }
  }
  throw originalError;
}

async function fetchJson(
  provider: ServiceProvider,
  url: string,
  init: RequestInit,
  accepted: readonly number[],
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(provider.timeoutMs),
    });
  } catch (error) {
    throw new RuntimeFailure(`Could not reach fixture provider "${provider.name}"`, { cause: error });
  }
  if (!accepted.includes(response.status)) {
    throw new RuntimeFailure(
      `Fixture provider "${provider.name}" returned HTTP ${response.status}`,
    );
  }
  if (response.status === 204) return undefined;
  try {
    return await response.json();
  } catch (error) {
    throw new RuntimeFailure(
      `Fixture provider "${provider.name}" returned non-JSON HTTP ${response.status}`,
      { cause: error },
    );
  }
}

abstract class AccountTransport implements BuiltinFixtureTransport {
  constructor(
    protected readonly provider: ServiceProvider,
    protected readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async call(request: FixtureRequestInput): Promise<FixtureResponse> {
    const id = responseId();
    try {
      if (request.method === "health") {
        await this.health();
        return success(id);
      }
      if (request.method === "destroy") {
        await this.destroy(request.handle);
        return success(id);
      }
      const resource = await this.create(request);
      return success(id, resource);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown provider error";
      return failure(id, `${this.provider.kind}_error`, message);
    }
  }

  protected abstract health(): Promise<void>;
  protected abstract create(request: FixtureRequestInput): Promise<{
    handle: string;
    values?: JsonObject;
    secrets?: JsonObject;
    auth?: JsonValue;
  }>;
  protected abstract destroy(handle: string): Promise<void>;
  async close(): Promise<void> {}
}

export class SupabaseTransport extends AccountTransport {
  private credentials(): { url: string; key: string } {
    const configuredUrl = configString(this.provider, "url");
    const url = configuredUrl
      ?? requiredEnvironment(this.provider, "urlFromEnv", "SUPABASE_URL", this.environment);
    return {
      url: normalizedUrl(this.provider, url),
      key: requiredEnvironment(
        this.provider,
        "serviceRoleKeyFromEnv",
        "SUPABASE_SERVICE_ROLE_KEY",
        this.environment,
      ),
    };
  }

  protected async health(): Promise<void> {
    this.credentials();
  }

  protected async create(request: FixtureRequestInput) {
    const { input, email, password } = accountDetails(this.provider, request);
    assertInputKeys(input, [
      "emailConfirmed",
      "phone",
      "phoneConfirmed",
      "userMetadata",
      "appMetadata",
    ]);
    const { url, key } = this.credentials();
    const value = await fetchJson(this.provider, `${url}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        email_confirm: booleanInput(input, "emailConfirmed", true),
        ...(stringInput(input, "phone") ? { phone: stringInput(input, "phone") } : {}),
        ...(input.phoneConfirmed !== undefined
          ? { phone_confirm: booleanInput(input, "phoneConfirmed") }
          : {}),
        ...(objectInput(input, "userMetadata") ? { user_metadata: objectInput(input, "userMetadata") } : {}),
        ...(objectInput(input, "appMetadata") ? { app_metadata: objectInput(input, "appMetadata") } : {}),
      }),
    }, [200, 201]) as { id?: unknown };
    if (typeof value?.id !== "string") {
      throw new RuntimeFailure(`Fixture provider "${this.provider.name}" returned no user id`);
    }
    return {
      handle: value.id,
      values: { id: value.id, email },
      secrets: { password },
      auth: { provider: "supabase", email, password },
    };
  }

  protected async destroy(handle: string): Promise<void> {
    const { url, key } = this.credentials();
    await fetchJson(this.provider, `${url}/auth/v1/admin/users/${encodeURIComponent(handle)}`, {
      method: "DELETE",
      headers: { apikey: key, authorization: `Bearer ${key}` },
    }, [200, 204, 404]);
  }
}

export interface FirebaseAccountClient {
  createUser(input: {
    uid?: string;
    email: string;
    password: string;
    emailVerified?: boolean;
    phoneNumber?: string;
    displayName?: string;
    photoURL?: string;
    disabled?: boolean;
  }): Promise<{ uid: string }>;
  setCustomUserClaims(uid: string, claims: JsonObject): Promise<void>;
  createCustomToken(uid: string, claims?: JsonObject): Promise<string>;
  deleteUser(uid: string): Promise<void>;
  close(): Promise<void>;
}

export type FirebaseClientLoader = (
  provider: Extract<CompiledFixtureProvider, { kind: "firebase" }>,
  environment?: NodeJS.ProcessEnv,
) => Promise<FirebaseAccountClient>;

export const loadFirebaseClient: FirebaseClientLoader = async (
  provider,
  environment = process.env,
) => {
  const appModule = await import("firebase-admin/app");
  const authModule = await import("firebase-admin/auth");
  const projectId = configString(provider, "projectId")
    ?? optionalEnvironment(
      provider,
      "projectIdFromEnv",
      "FIREBASE_PROJECT_ID",
      environment,
    );
  const rawServiceAccount = optionalEnvironment(
    provider,
    "serviceAccountJsonFromEnv",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    environment,
  );
  const credential = rawServiceAccount
    ? appModule.cert(JSON.parse(rawServiceAccount) as Parameters<typeof appModule.cert>[0])
    : appModule.applicationDefault();
  const app = appModule.initializeApp(
    { credential, ...(projectId ? { projectId } : {}) },
    `polymux-${provider.name}-${randomUUID()}`,
  );
  const auth = authModule.getAuth(app);
  return {
    createUser: (input) => auth.createUser(input),
    setCustomUserClaims: (uid, claims) => auth.setCustomUserClaims(uid, claims),
    createCustomToken: (uid, claims) => auth.createCustomToken(uid, claims),
    deleteUser: (uid) => auth.deleteUser(uid),
    close: () => appModule.deleteApp(app),
  };
};

export class FirebaseTransport extends AccountTransport {
  private client?: FirebaseAccountClient;

  constructor(
    provider: Extract<CompiledFixtureProvider, { kind: "firebase" }>,
    private readonly loader: FirebaseClientLoader = loadFirebaseClient,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    super(provider, environment);
  }

  private async admin(): Promise<FirebaseAccountClient> {
    this.client ??= await this.loader(
      this.provider as Extract<CompiledFixtureProvider, { kind: "firebase" }>,
      this.environment,
    );
    return this.client;
  }

  protected async health(): Promise<void> {
    await this.admin();
  }

  protected async create(request: FixtureRequestInput) {
    const { input, email, password, idSuffix } = accountDetails(this.provider, request);
    assertInputKeys(input, [
      "uid",
      "emailVerified",
      "phoneNumber",
      "displayName",
      "photoURL",
      "disabled",
      "customClaims",
    ]);
    const admin = await this.admin();
    const uid = stringInput(input, "uid") ?? `polymux_${idSuffix}`;
    const phoneNumber = stringInput(input, "phoneNumber");
    const displayName = stringInput(input, "displayName");
    const photoURL = stringInput(input, "photoURL");
    const disabled = input.disabled === undefined ? undefined : booleanInput(input, "disabled");
    let user: { uid: string };
    try {
      user = await admin.createUser({
        uid,
        email,
        password,
        emailVerified: booleanInput(input, "emailVerified", true)!,
        ...(phoneNumber ? { phoneNumber } : {}),
        ...(displayName ? { displayName } : {}),
        ...(photoURL ? { photoURL } : {}),
        ...(disabled !== undefined ? { disabled } : {}),
      });
    } catch (error) {
      return rollbackFirebaseUser(admin, uid, error);
    }
    try {
      const customClaims = objectInput(input, "customClaims");
      if (customClaims) await admin.setCustomUserClaims(user.uid, customClaims);
      const createCustomToken = configBoolean(this.provider, "createCustomToken", false);
      const customToken = createCustomToken
        ? await admin.createCustomToken(user.uid, customClaims)
        : undefined;
      return {
        handle: user.uid,
        values: { uid: user.uid, email },
        secrets: { password, ...(customToken ? { customToken } : {}) },
        auth: { provider: "firebase", email, password, ...(customToken ? { customToken } : {}) },
      };
    } catch (error) {
      return rollbackFirebaseUser(admin, user.uid, error);
    }
  }

  protected async destroy(handle: string): Promise<void> {
    try {
      await (await this.admin()).deleteUser(handle);
    } catch (error) {
      if (isFirebaseUserNotFound(error)) return;
      throw error;
    }
  }

  override async close(): Promise<void> {
    await this.client?.close();
  }
}

export class Auth0Transport extends AccountTransport {
  private token?: string;

  private domain(): string {
    const domain = configString(this.provider, "domain")
      ?? requiredEnvironment(
        this.provider,
        "domainFromEnv",
        "AUTH0_DOMAIN",
        this.environment,
      );
    if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(domain)) {
      throw new RuntimeFailure(`Fixture provider "${this.provider.name}" has an invalid Auth0 domain`);
    }
    return domain;
  }

  private baseUrl(): string {
    return normalizedUrl(
      this.provider,
      configString(this.provider, "apiBaseUrl") ?? `https://${this.domain()}`,
    );
  }

  private async managementToken(): Promise<string> {
    if (this.token) return this.token;
    const configured = optionalEnvironment(
      this.provider,
      "managementTokenFromEnv",
      "AUTH0_MANAGEMENT_TOKEN",
      this.environment,
    );
    if (configured) return (this.token = configured);
    const clientId = requiredEnvironment(
      this.provider,
      "clientIdFromEnv",
      "AUTH0_CLIENT_ID",
      this.environment,
    );
    const clientSecret = requiredEnvironment(
      this.provider,
      "clientSecretFromEnv",
      "AUTH0_CLIENT_SECRET",
      this.environment,
    );
    const value = await fetchJson(this.provider, `${this.baseUrl()}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        audience: `https://${this.domain()}/api/v2/`,
      }),
    }, [200]) as { access_token?: unknown };
    if (typeof value?.access_token !== "string") {
      throw new RuntimeFailure(`Fixture provider "${this.provider.name}" returned no access token`);
    }
    return (this.token = value.access_token);
  }

  protected async health(): Promise<void> {
    this.domain();
    await this.managementToken();
  }

  protected async create(request: FixtureRequestInput) {
    const { input, email, password } = accountDetails(this.provider, request);
    assertInputKeys(input, [
      "connection",
      "emailVerified",
      "phoneNumber",
      "phoneVerified",
      "blocked",
      "verifyEmail",
      "name",
      "givenName",
      "familyName",
      "nickname",
      "picture",
      "username",
      "userId",
      "userMetadata",
      "appMetadata",
    ]);
    const connection = stringInput(input, "connection") ?? configString(this.provider, "connection");
    if (!connection) {
      throw new RuntimeFailure(`Fixture provider "${this.provider.name}" needs config.connection`);
    }
    const token = await this.managementToken();
    const value = await fetchJson(this.provider, `${this.baseUrl()}/api/v2/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        connection,
        email_verified: booleanInput(input, "emailVerified", true),
        ...(stringInput(input, "phoneNumber") ? { phone_number: stringInput(input, "phoneNumber") } : {}),
        ...(input.phoneVerified !== undefined ? { phone_verified: booleanInput(input, "phoneVerified") } : {}),
        ...(input.blocked !== undefined ? { blocked: booleanInput(input, "blocked") } : {}),
        ...(input.verifyEmail !== undefined ? { verify_email: booleanInput(input, "verifyEmail") } : {}),
        ...(stringInput(input, "name") ? { name: stringInput(input, "name") } : {}),
        ...(stringInput(input, "givenName") ? { given_name: stringInput(input, "givenName") } : {}),
        ...(stringInput(input, "familyName") ? { family_name: stringInput(input, "familyName") } : {}),
        ...(stringInput(input, "nickname") ? { nickname: stringInput(input, "nickname") } : {}),
        ...(stringInput(input, "picture") ? { picture: stringInput(input, "picture") } : {}),
        ...(stringInput(input, "username") ? { username: stringInput(input, "username") } : {}),
        ...(stringInput(input, "userId") ? { user_id: stringInput(input, "userId") } : {}),
        ...(objectInput(input, "userMetadata") ? { user_metadata: objectInput(input, "userMetadata") } : {}),
        ...(objectInput(input, "appMetadata") ? { app_metadata: objectInput(input, "appMetadata") } : {}),
      }),
    }, [201]) as { user_id?: unknown };
    if (typeof value?.user_id !== "string") {
      throw new RuntimeFailure(`Fixture provider "${this.provider.name}" returned no user id`);
    }
    return {
      handle: value.user_id,
      values: { id: value.user_id, email },
      secrets: { password },
      auth: { provider: "auth0", email, password },
    };
  }

  protected async destroy(handle: string): Promise<void> {
    const token = await this.managementToken();
    await fetchJson(this.provider, `${this.baseUrl()}/api/v2/users/${encodeURIComponent(handle)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }, [204, 404]);
  }
}

export class ClerkTransport extends AccountTransport {
  private credentials(): { apiUrl: string; secretKey: string } {
    return {
      apiUrl: normalizedUrl(
        this.provider,
        configString(this.provider, "apiUrl", "https://api.clerk.com/v1")!,
      ),
      secretKey: requiredEnvironment(
        this.provider,
        "secretKeyFromEnv",
        "CLERK_SECRET_KEY",
        this.environment,
      ),
    };
  }

  protected async health(): Promise<void> {
    this.credentials();
  }

  protected async create(request: FixtureRequestInput) {
    const { input, email, password } = accountDetails(this.provider, request);
    assertInputKeys(input, [
      "firstName",
      "lastName",
      "username",
      "phoneNumbers",
      "externalId",
      "locale",
      "legalAcceptedAt",
      "locked",
      "banned",
      "publicMetadata",
      "privateMetadata",
      "unsafeMetadata",
    ]);
    const { apiUrl, secretKey } = this.credentials();
    const value = await fetchJson(this.provider, `${apiUrl}/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        email_address: [email],
        password,
        ...(stringInput(input, "firstName") ? { first_name: stringInput(input, "firstName") } : {}),
        ...(stringInput(input, "lastName") ? { last_name: stringInput(input, "lastName") } : {}),
        ...(stringInput(input, "username") ? { username: stringInput(input, "username") } : {}),
        ...(stringArrayInput(input, "phoneNumbers") ? { phone_number: stringArrayInput(input, "phoneNumbers") } : {}),
        ...(stringInput(input, "externalId") ? { external_id: stringInput(input, "externalId") } : {}),
        ...(stringInput(input, "locale") ? { locale: stringInput(input, "locale") } : {}),
        ...(stringInput(input, "legalAcceptedAt") ? { legal_accepted_at: stringInput(input, "legalAcceptedAt") } : {}),
        ...(input.locked !== undefined ? { locked: booleanInput(input, "locked") } : {}),
        ...(input.banned !== undefined ? { banned: booleanInput(input, "banned") } : {}),
        ...(objectInput(input, "publicMetadata") ? { public_metadata: objectInput(input, "publicMetadata") } : {}),
        ...(objectInput(input, "privateMetadata") ? { private_metadata: objectInput(input, "privateMetadata") } : {}),
        ...(objectInput(input, "unsafeMetadata") ? { unsafe_metadata: objectInput(input, "unsafeMetadata") } : {}),
      }),
    }, [200, 201]) as { id?: unknown };
    if (typeof value?.id !== "string") {
      throw new RuntimeFailure(`Fixture provider "${this.provider.name}" returned no user id`);
    }
    return {
      handle: value.id,
      values: { id: value.id, email },
      secrets: { password },
      auth: { provider: "clerk", email, password },
    };
  }

  protected async destroy(handle: string): Promise<void> {
    const { apiUrl, secretKey } = this.credentials();
    await fetchJson(this.provider, `${apiUrl}/users/${encodeURIComponent(handle)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${secretKey}` },
    }, [200, 204, 404]);
  }
}

export function createServiceTransport(
  provider: ServiceProvider,
  environment: NodeJS.ProcessEnv = process.env,
): BuiltinFixtureTransport {
  if (provider.kind === "supabase") return new SupabaseTransport(provider, environment);
  if (provider.kind === "firebase") {
    return new FirebaseTransport(provider, loadFirebaseClient, environment);
  }
  if (provider.kind === "auth0") return new Auth0Transport(provider, environment);
  return new ClerkTransport(provider, environment);
}
