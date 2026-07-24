import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileCoordinatedFlowFile,
  type Driver,
  type DriverSession,
  type DriverSessionContext,
} from "@polymux/core";
import {
  capabilities,
  coordinatedFlowSourceSchema,
  type Capability,
  type CompiledFixtureProvider,
  type CompiledStep,
  type JsonValue,
} from "@polymux/protocol";
import {
  Auth0Transport,
  ClerkTransport,
  FirebaseTransport,
  SupabaseTransport,
  loadFirebaseClient,
  type FirebaseAccountClient,
  type FixtureRequestInput,
} from "../apps/runner/src/builtin-providers.js";
import { runCoordinatedFlowInstances } from "@polymux/runner";

interface RecordedRequest {
  method: string;
  path: string;
  authorization?: string;
  apikey?: string;
  body?: Record<string, unknown>;
}

const requests: RecordedRequest[] = [];
let baseUrl = "";
const server = createServer(async (request, response) => {
  const body = await readBody(request);
  requests.push({
    method: request.method ?? "",
    path: request.url ?? "",
    ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
    ...(typeof request.headers.apikey === "string" ? { apikey: request.headers.apikey } : {}),
    ...(body ? { body } : {}),
  });
  response.setHeader("content-type", "application/json");
  if (request.method === "POST" && request.url === "/identitytoolkit.googleapis.com/v1/projects/polymux-test/accounts") {
    response.end(JSON.stringify({ localId: "firebase-wire-user" }));
    return;
  }
  if (request.method === "POST" && request.url === "/identitytoolkit.googleapis.com/v1/projects/polymux-test/accounts:lookup") {
    response.end(JSON.stringify({ users: [{
      localId: "firebase-wire-user",
      email: "wire@example.test",
      emailVerified: true,
      validSince: "0",
      createdAt: "1700000000000",
      lastLoginAt: "0",
      providerUserInfo: [],
    }] }));
    return;
  }
  if (request.method === "POST" && request.url === "/identitytoolkit.googleapis.com/v1/projects/polymux-test/accounts:update") {
    response.end(JSON.stringify({ localId: "firebase-wire-user" }));
    return;
  }
  if (request.method === "POST" && request.url === "/identitytoolkit.googleapis.com/v1/projects/polymux-test/accounts:delete") {
    response.end(JSON.stringify({}));
    return;
  }
  if (request.method === "POST" && request.url === "/auth/v1/admin/users") {
    response.statusCode = 201;
    response.end(JSON.stringify({ id: "supabase-user" }));
    return;
  }
  if (request.method === "POST" && request.url === "/oauth/token") {
    response.end(JSON.stringify({ access_token: "auth0-management-token" }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/v2/users") {
    response.statusCode = 201;
    response.end(JSON.stringify({ user_id: "auth0|user" }));
    return;
  }
  if (request.method === "POST" && request.url === "/v1/users") {
    response.statusCode = 201;
    response.end(JSON.stringify({ id: "clerk-user" }));
    return;
  }
  if (request.method === "GET" && request.url === "/api/v1/info") {
    response.end(JSON.stringify({ Version: "test" }));
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/api/v1/search?")) {
    response.end(JSON.stringify({
      messages: [{
        ID: "mailpit-message",
        Created: new Date().toISOString(),
        From: { Address: "no-reply@example.test" },
        Subject: "Your login code",
      }, {
        ID: "older-mailpit-message",
        Created: new Date(0).toISOString(),
        From: { Address: "no-reply@example.test" },
        Subject: "An older login code",
      }],
    }));
    return;
  }
  if (request.method === "GET" && request.url === "/api/v1/message/mailpit-message") {
    response.end(JSON.stringify({
      ID: "mailpit-message",
      Date: new Date().toISOString(),
      From: { Address: "no-reply@example.test" },
      Subject: "Your login code",
      Text: "Your one-time login code is 731904.",
      HTML: "<p>Your one-time login code is <strong>731904</strong>.</p>",
    }));
    return;
  }
  if (request.method === "DELETE") {
    response.statusCode = request.url?.startsWith("/api/v2/") ? 204 : 200;
    response.end(request.url?.startsWith("/api/v2/") ? undefined : JSON.stringify({ deleted: true }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
}

function createRequest(input: Record<string, JsonValue> = {}): FixtureRequestInput {
  return {
    method: "create",
    fixture: "buyerAccount",
    fixtureType: "account",
    input,
    context: {
      flow: "Checkout",
      flowRunId: "flow-run",
      instance: 1,
      seed: "0123456789abcdef01234567",
      actors: ["buyer"],
    },
  };
}

class BuiltinFlowDriver implements Driver {
  readonly id = "builtin-flow.web";
  readonly platform = "web" as const;
  readonly capabilities: ReadonlySet<Capability> = new Set([
    capabilities.enter,
    capabilities.navigate,
  ]);
  readonly steps: CompiledStep[] = [];

  async createSession(_context: DriverSessionContext): Promise<DriverSession> {
    return {
      execute: async (step) => { this.steps.push(step); },
      close: async () => [],
    };
  }
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("built-in account fixture providers", () => {
  it("creates and removes Supabase Auth users with service-role credentials", async () => {
    const previous = process.env.TEST_SUPABASE_SERVICE_KEY;
    process.env.TEST_SUPABASE_SERVICE_KEY = "service-role-key";
    try {
      const provider: Extract<CompiledFixtureProvider, { kind: "supabase" }> = {
        name: "auth",
        kind: "supabase",
        config: { url: baseUrl, serviceRoleKeyFromEnv: "TEST_SUPABASE_SERVICE_KEY" },
        timeoutMs: 1_000,
      };
      const transport = new SupabaseTransport(provider);
      expect((await transport.call({ method: "health" })).ok).toBe(true);
      const created = await transport.call(createRequest({ userMetadata: { plan: "test" } }));
      expect(created.ok && created.result?.values).toEqual({ id: "supabase-user", email: expect.any(String) });
      expect(created.ok && created.result?.secrets?.password).toMatch(/^Pmx!/);
      if (!created.ok || !created.result) throw new Error("Account was not created");
      await transport.call({ method: "destroy", fixture: "buyerAccount", fixtureType: "account", handle: created.result.handle });
      const createCall = requests.find(({ path, method }) => path === "/auth/v1/admin/users" && method === "POST");
      expect(createCall?.apikey).toBe("service-role-key");
      expect(createCall?.body).toMatchObject({ email_confirm: true, user_metadata: { plan: "test" } });
      expect(requests.some(({ path }) => path === "/auth/v1/admin/users/supabase-user")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TEST_SUPABASE_SERVICE_KEY;
      else process.env.TEST_SUPABASE_SERVICE_KEY = previous;
    }
  });

  it("runs a built-in provider through compilation, actor injection, redaction, and cleanup", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-builtin-flow-"));
    const flowDir = join(projectDir, "polymux");
    await mkdir(flowDir);
    await writeFile(join(flowDir, "buyer.flow.yaml"), [
      "version: 1",
      "name: Built-in buyer",
      "steps:",
      "  - enter:",
      "      target: { label: Email }",
      "      value: ${fixtures.account.values.email}",
      "  - enter:",
      "      target: { label: Password }",
      "      value: ${fixtures.account.secrets.password}",
      "",
    ].join("\n"));
    await writeFile(join(flowDir, "observer.flow.yaml"), [
      "version: 1",
      "name: Built-in observer",
      "steps:",
      "  - navigate: https://example.com",
      "",
    ].join("\n"));
    await writeFile(join(flowDir, "accounts.flow.yaml"), [
      "version: 1",
      "name: Built-in account lifecycle",
      "providers:",
      "  auth:",
      "    builtin: supabase",
      "    config:",
      `      url: ${baseUrl}`,
      "      serviceRoleKeyFromEnv: TEST_SCENARIO_SUPABASE_KEY",
      "fixtures:",
      "  buyerAccount: { provider: auth, type: account }",
      "actors:",
      "  buyer:",
      "    flow: buyer.flow.yaml",
      "    fixtures: { account: buyerAccount }",
      "  observer: observer.flow.yaml",
      "",
    ].join("\n"));
    process.env.TEST_SCENARIO_SUPABASE_KEY = "flow-service-role";
    try {
      const driver = new BuiltinFlowDriver();
      const result = await runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(join(flowDir, "accounts.flow.yaml")),
        driver,
        { projectDir },
      );
      expect(result.status).toBe("passed");
      expect(result.runs[0]?.fixtures).toEqual([
        { name: "buyerAccount", provider: "auth", type: "account", status: "cleaned" },
      ]);
      const entered = driver.steps.filter(({ kind }) => kind === "enter").map(({ input }) => input.value);
      expect(entered[0]).toMatch(/^polymux-[a-f0-9]{20}@example\.test$/);
      expect(entered[1]).toMatch(/^Pmx!/);
      expect(JSON.stringify(result)).not.toContain(String(entered[1]));
    } finally {
      delete process.env.TEST_SCENARIO_SUPABASE_KEY;
    }
  });

  it("runs email verification end to end through the built-in Mailpit provider", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-mailpit-flow-"));
    const flowDir = join(projectDir, "polymux");
    await mkdir(flowDir);
    await writeFile(join(flowDir, "signup.flow.yaml"), [
      "version: 1",
      "name: Mailpit signup",
      "steps:",
      "  - enter:",
      "      target: { label: Email }",
      "      value: ${fixtures.inbox.values.address}",
      "  - receiveEmail:",
      "      fixture: inbox",
      "      saveAs: verification",
      "      timeoutMs: 2000",
      "      match: { from: no-reply@example.test, subject: login code }",
      "      extract: otp",
      "  - enter:",
      "      target: { label: Code }",
      "      value: ${messages.verification.secrets.otp}",
      "",
    ].join("\n"));
    await writeFile(join(flowDir, "mailpit.flow.yaml"), [
      "version: 1",
      "name: Mailpit verification",
      "providers:",
      "  mail:",
      "    builtin: mailpit",
      "    config:",
      `      url: ${baseUrl}`,
      "      emailDomain: example.test",
      "      pollIntervalMs: 10",
      "fixtures:",
      "  signupInbox: { provider: mail, type: inbox }",
      "actors:",
      "  user:",
      "    flow: signup.flow.yaml",
      "    fixtures: { inbox: signupInbox }",
      "",
    ].join("\n"));

    const driver = new BuiltinFlowDriver();
    const result = await runCoordinatedFlowInstances(
      await compileCoordinatedFlowFile(join(flowDir, "mailpit.flow.yaml")),
      driver,
      { projectDir },
    );

    expect(result.status).toBe("passed");
    const entered = driver.steps
      .filter(({ kind }) => kind === "enter")
      .map(({ input }) => input.value);
    expect(entered[0]).toMatch(/^polymux-[a-f0-9]{20}@example\.test$/);
    expect(entered[1]).toBe("731904");
    expect(JSON.stringify(result)).not.toContain("731904");
    expect(requests.some(({ path }) =>
      path.startsWith("/api/v1/search?query=to%3A%22polymux-")
    )).toBe(true);
    expect(requests.some(({ method, path }) =>
      method === "DELETE" && path === "/api/v1/messages"
    )).toBe(true);
    expect(requests.findLast(({ method, path }) =>
      method === "DELETE" && path === "/api/v1/messages"
    )?.body).toEqual({ IDs: ["mailpit-message"] });
  });

  it("uses Firebase Admin semantics and returns a custom sign-in token", async () => {
    const calls: string[] = [];
    const client: FirebaseAccountClient = {
      createUser: async (input) => {
        calls.push(`create:${input.email}:${input.emailVerified}`);
        return { uid: "firebase-user" };
      },
      setCustomUserClaims: async (uid, claims) => { calls.push(`claims:${uid}:${String(claims.role)}`); },
      createCustomToken: async (uid) => { calls.push(`token:${uid}`); return "firebase-custom-token"; },
      deleteUser: async (uid) => { calls.push(`delete:${uid}`); },
      close: async () => { calls.push("close"); },
    };
    const provider: Extract<CompiledFixtureProvider, { kind: "firebase" }> = {
      name: "auth",
      kind: "firebase",
      config: { createCustomToken: true },
      timeoutMs: 1_000,
    };
    const transport = new FirebaseTransport(provider, async () => client);
    const created = await transport.call(createRequest({ customClaims: { role: "buyer" } }));
    expect(created.ok && created.result?.auth).toMatchObject({
      provider: "firebase",
      customToken: "firebase-custom-token",
    });
    if (!created.ok || !created.result) throw new Error("Account was not created");
    await transport.call({ method: "destroy", fixture: "buyerAccount", fixtureType: "account", handle: created.result.handle });
    await transport.close();
    expect(calls).toEqual([
      expect.stringMatching(/^create:polymux-.*@example\.test:true$/),
      "claims:firebase-user:buyer",
      "token:firebase-user",
      "delete:firebase-user",
      "close",
    ]);
  });

  it("rolls back a Firebase user if token creation fails", async () => {
    const calls: string[] = [];
    const client: FirebaseAccountClient = {
      createUser: async () => ({ uid: "partial-user" }),
      setCustomUserClaims: async () => {},
      createCustomToken: async () => { throw new Error("token signing unavailable"); },
      deleteUser: async (uid) => { calls.push(`delete:${uid}`); },
      close: async () => {},
    };
    const provider: Extract<CompiledFixtureProvider, { kind: "firebase" }> = {
      name: "auth",
      kind: "firebase",
      config: { createCustomToken: true },
      timeoutMs: 1_000,
    };
    const response = await new FirebaseTransport(provider, async () => client).call(createRequest());
    expect(response.ok).toBe(false);
    expect(calls).toEqual(["delete:partial-user"]);
  });

  it("rolls back the known Firebase uid when the Admin SDK create call rejects", async () => {
    const calls: string[] = [];
    const client: FirebaseAccountClient = {
      createUser: async (input) => {
        calls.push(`create:${input.uid}`);
        throw new Error("post-create lookup failed");
      },
      setCustomUserClaims: async () => {},
      createCustomToken: async () => "unused",
      deleteUser: async (uid) => { calls.push(`delete:${uid}`); },
      close: async () => {},
    };
    const provider: Extract<CompiledFixtureProvider, { kind: "firebase" }> = {
      name: "auth",
      kind: "firebase",
      config: {},
      timeoutMs: 1_000,
    };
    const response = await new FirebaseTransport(provider, async () => client).call(createRequest());
    expect(response.ok).toBe(false);
    expect(calls).toEqual([
      expect.stringMatching(/^create:polymux_[a-f0-9]{20}$/),
      expect.stringMatching(/^delete:polymux_[a-f0-9]{20}$/),
    ]);
    expect(calls[0]?.replace("create:", "")).toBe(calls[1]?.replace("delete:", ""));
  });

  it("uses the real Firebase Admin SDK request and token-signing path", async () => {
    const previousHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    const previousCredentials = process.env.TEST_FIREBASE_SERVICE_ACCOUNT;
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    process.env.FIREBASE_AUTH_EMULATOR_HOST = new URL(baseUrl).host;
    process.env.TEST_FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
      project_id: "polymux-test",
      client_email: "polymux-test@polymux-test.iam.gserviceaccount.com",
      private_key: privateKey,
    });
    try {
      const provider: Extract<CompiledFixtureProvider, { kind: "firebase" }> = {
        name: "firebaseWire",
        kind: "firebase",
        config: {
          projectId: "polymux-test",
          serviceAccountJsonFromEnv: "TEST_FIREBASE_SERVICE_ACCOUNT",
          createCustomToken: true,
        },
        timeoutMs: 2_000,
      };
      const transport = new FirebaseTransport(provider);
      const created = await transport.call(createRequest({
        email: "wire@example.test",
        customClaims: { role: "buyer" },
      }));
      expect(created.ok).toBe(true);
      if (!created.ok || !created.result) throw new Error("Firebase wire account was not created");
      expect(created.result.handle).toBe("firebase-wire-user");
      expect(created.result.secrets?.customToken).toMatch(/^[^.]+\.[^.]+\.$/);
      const payload = JSON.parse(Buffer.from(
        String(created.result.secrets?.customToken).split(".")[1],
        "base64url",
      ).toString("utf8"));
      expect(payload).toMatchObject({ uid: "firebase-wire-user", claims: { role: "buyer" } });
      const destroyed = await transport.call({
        method: "destroy",
        fixture: "buyerAccount",
        fixtureType: "account",
        handle: created.result.handle,
      });
      expect(destroyed.ok).toBe(true);
      await transport.close();
      const firebaseCalls = requests.filter(({ path }) => path.includes("identitytoolkit.googleapis.com"));
      expect(firebaseCalls.map(({ path }) => path)).toEqual([
        "/identitytoolkit.googleapis.com/v1/projects/polymux-test/accounts",
        "/identitytoolkit.googleapis.com/v1/projects/polymux-test/accounts:lookup",
        "/identitytoolkit.googleapis.com/v1/projects/polymux-test/accounts:update",
        "/identitytoolkit.googleapis.com/v1/projects/polymux-test/accounts:delete",
      ]);
      expect(firebaseCalls[0]?.authorization).toBe("Bearer owner");

      delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
      const signingClient = await loadFirebaseClient({
        ...provider,
        name: "firebaseSigning",
      });
      const signedToken = await signingClient.createCustomToken("signed-user", { role: "buyer" });
      expect(signedToken).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
      const signedHeader = JSON.parse(Buffer.from(signedToken.split(".")[0]!, "base64url").toString("utf8"));
      expect(signedHeader.alg).toBe("RS256");
      await signingClient.close();
    } finally {
      if (previousHost === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
      else process.env.FIREBASE_AUTH_EMULATOR_HOST = previousHost;
      if (previousCredentials === undefined) delete process.env.TEST_FIREBASE_SERVICE_ACCOUNT;
      else process.env.TEST_FIREBASE_SERVICE_ACCOUNT = previousCredentials;
    }
  });

  it("does not require Firebase token-signing permission for ordinary password actors", async () => {
    const calls: string[] = [];
    const client: FirebaseAccountClient = {
      createUser: async () => ({ uid: "password-user" }),
      setCustomUserClaims: async () => {},
      createCustomToken: async () => { calls.push("unexpected-token"); return "unused"; },
      deleteUser: async () => {},
      close: async () => {},
    };
    const provider: Extract<CompiledFixtureProvider, { kind: "firebase" }> = {
      name: "auth",
      kind: "firebase",
      config: {},
      timeoutMs: 1_000,
    };
    const created = await new FirebaseTransport(provider, async () => client).call(createRequest());
    expect(created.ok && created.result?.auth).toMatchObject({
      provider: "firebase",
      email: expect.any(String),
      password: expect.any(String),
    });
    expect(calls).toEqual([]);
  });

  it("obtains an Auth0 Management token, creates a database user, and removes it", async () => {
    const previousId = process.env.TEST_AUTH0_CLIENT_ID;
    const previousSecret = process.env.TEST_AUTH0_CLIENT_SECRET;
    delete process.env.AUTH0_MANAGEMENT_TOKEN;
    process.env.TEST_AUTH0_CLIENT_ID = "client-id";
    process.env.TEST_AUTH0_CLIENT_SECRET = "client-secret";
    try {
      const provider: Extract<CompiledFixtureProvider, { kind: "auth0" }> = {
        name: "auth",
        kind: "auth0",
        config: {
          domain: "tenant.example.test",
          apiBaseUrl: baseUrl,
          connection: "Username-Password-Authentication",
          clientIdFromEnv: "TEST_AUTH0_CLIENT_ID",
          clientSecretFromEnv: "TEST_AUTH0_CLIENT_SECRET",
        },
        timeoutMs: 1_000,
      };
      const transport = new Auth0Transport(provider);
      const created = await transport.call(createRequest());
      expect(created.ok && created.result?.handle).toBe("auth0|user");
      if (!created.ok || !created.result) throw new Error("Account was not created");
      await transport.call({ method: "destroy", fixture: "buyerAccount", fixtureType: "account", handle: created.result.handle });
      expect(requests.find(({ path }) => path === "/oauth/token")?.body).toMatchObject({
        grant_type: "client_credentials",
        audience: "https://tenant.example.test/api/v2/",
      });
      expect(requests.find(({ path }) => path === "/api/v2/users")?.authorization)
        .toBe("Bearer auth0-management-token");
      expect(requests.some(({ path }) => path === "/api/v2/users/auth0%7Cuser")).toBe(true);
    } finally {
      if (previousId === undefined) delete process.env.TEST_AUTH0_CLIENT_ID;
      else process.env.TEST_AUTH0_CLIENT_ID = previousId;
      if (previousSecret === undefined) delete process.env.TEST_AUTH0_CLIENT_SECRET;
      else process.env.TEST_AUTH0_CLIENT_SECRET = previousSecret;
    }
  });

  it("creates and removes Clerk Backend API users", async () => {
    const previous = process.env.TEST_CLERK_SECRET_KEY;
    process.env.TEST_CLERK_SECRET_KEY = "sk_test_fixture";
    try {
      const provider: Extract<CompiledFixtureProvider, { kind: "clerk" }> = {
        name: "auth",
        kind: "clerk",
        config: { apiUrl: `${baseUrl}/v1`, secretKeyFromEnv: "TEST_CLERK_SECRET_KEY" },
        timeoutMs: 1_000,
      };
      const transport = new ClerkTransport(provider);
      const created = await transport.call(createRequest({ firstName: "Test" }));
      expect(created.ok && created.result?.handle).toBe("clerk-user");
      if (!created.ok || !created.result) throw new Error("Account was not created");
      await transport.call({ method: "destroy", fixture: "buyerAccount", fixtureType: "account", handle: created.result.handle });
      const createCall = requests.find(({ path }) => path === "/v1/users");
      expect(createCall?.authorization).toBe("Bearer sk_test_fixture");
      expect(createCall?.body).toMatchObject({ first_name: "Test", email_address: [expect.any(String)] });
      expect(requests.some(({ path }) => path === "/v1/users/clerk-user")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TEST_CLERK_SECRET_KEY;
      else process.env.TEST_CLERK_SECRET_KEY = previous;
    }
  });

  it("rejects provider config and account-input typos before they can be ignored", async () => {
    const parsed = coordinatedFlowSourceSchema.safeParse({
      version: 1,
      name: "Invalid provider config",
      providers: {
        auth: { builtin: "supabase", config: { serviceRoleKeyFromEnb: "TYPO" } },
      },
      actors: { buyer: "buyer.flow.yaml", seller: "seller.flow.yaml" },
    });
    expect(parsed.success).toBe(false);

    const provider: Extract<CompiledFixtureProvider, { kind: "clerk" }> = {
      name: "auth",
      kind: "clerk",
      config: { apiUrl: `${baseUrl}/v1`, secretKeyFromEnv: "TEST_CLERK_SECRET_KEY" },
      timeoutMs: 1_000,
    };
    process.env.TEST_CLERK_SECRET_KEY = "sk_test_fixture";
    try {
      const response = await new ClerkTransport(provider).call(createRequest({ firstNmae: "Typo" }));
      expect(response.ok).toBe(false);
      expect(!response.ok && response.error.message).toContain("firstNmae");
    } finally {
      delete process.env.TEST_CLERK_SECRET_KEY;
    }
  });

  it("does not fall back to fleet process secrets when a per-run environment is supplied", async () => {
    const provider: Extract<CompiledFixtureProvider, { kind: "supabase" }> = {
      name: "auth",
      kind: "supabase",
      config: {
        url: baseUrl,
        serviceRoleKeyFromEnv: "POLYMUX_RUNNER_GRANT",
      },
      timeoutMs: 1_000,
    };
    const previous = process.env.POLYMUX_RUNNER_GRANT;
    process.env.POLYMUX_RUNNER_GRANT = "fleet-secret-must-not-be-visible";
    try {
      const response = await new SupabaseTransport(provider, {}).call({
        method: "health",
      });
      expect(response.ok).toBe(false);
      expect(!response.ok && response.error.message)
        .toContain("needs environment variable POLYMUX_RUNNER_GRANT");
    } finally {
      if (previous === undefined) delete process.env.POLYMUX_RUNNER_GRANT;
      else process.env.POLYMUX_RUNNER_GRANT = previous;
    }
  });
});
