import { describe, expect, it } from "vitest";
import type { CompiledFixtureProvider } from "@polymux/protocol";
import {
  Auth0Transport,
  ClerkTransport,
  FirebaseTransport,
  SupabaseTransport,
  type BuiltinFixtureTransport,
  type FixtureRequestInput,
} from "../apps/runner/src/builtin-providers.js";

const selected = process.env.POLYMUX_LIVE_AUTH_PROVIDER;
const confirmed = process.env.POLYMUX_LIVE_AUTH_CONFIRM === "delete-test-accounts";
const emailDomain = process.env.POLYMUX_LIVE_EMAIL_DOMAIN;

function enabled(provider: string): boolean {
  return confirmed && selected === provider;
}

function accountRequest(): Extract<FixtureRequestInput, { method: "create" }> {
  return {
    method: "create",
    fixture: `live-${Date.now()}`,
    fixtureType: "account",
    context: {
      flow: "Polymux live provider smoke test",
      flowRunId: `live-${Date.now()}`,
      instance: 1,
      seed: `${Date.now()}-${Math.random()}`,
      actors: ["live-test"],
    },
  };
}

async function verifyLifecycle(transport: BuiltinFixtureTransport): Promise<void> {
  let handle: string | undefined;
  try {
    const health = await transport.call({ method: "health" });
    if (!health.ok) throw new Error(health.error.message);
    const created = await transport.call(accountRequest());
    if (!created.ok) throw new Error(created.error.message);
    if (!created.result) throw new Error("Provider returned no account resource");
    handle = created.result.handle;
    expect(created.result.handle).toBeTruthy();
    expect(created.result.values?.email).toBeTruthy();
    expect(created.result.secrets?.password).toBeTruthy();
  } finally {
    let cleanupError: Error | undefined;
    if (handle) {
      const destroyed = await transport.call({
        method: "destroy",
        fixture: "live-account",
        fixtureType: "account",
        handle,
      });
      if (!destroyed.ok) cleanupError = new Error(destroyed.error.message);
    }
    await transport.close();
    if (cleanupError) throw cleanupError;
  }
}

describe("live built-in provider smoke tests", () => {
  it.runIf(enabled("supabase"))("creates and deletes a real Supabase test user", async () => {
    const provider: Extract<CompiledFixtureProvider, { kind: "supabase" }> = {
      name: "liveSupabase",
      kind: "supabase",
      config: { ...(emailDomain ? { emailDomain } : {}) },
      timeoutMs: 30_000,
    };
    await verifyLifecycle(new SupabaseTransport(provider));
  });

  it.runIf(enabled("firebase"))("creates and deletes a real Firebase test user", async () => {
    const provider: Extract<CompiledFixtureProvider, { kind: "firebase" }> = {
      name: "liveFirebase",
      kind: "firebase",
      config: {
        ...(emailDomain ? { emailDomain } : {}),
        createCustomToken: process.env.POLYMUX_LIVE_FIREBASE_CUSTOM_TOKEN === "true",
      },
      timeoutMs: 30_000,
    };
    await verifyLifecycle(new FirebaseTransport(provider));
  });

  it.runIf(enabled("auth0"))("creates and deletes a real Auth0 test user", async () => {
    const connection = process.env.POLYMUX_LIVE_AUTH0_CONNECTION;
    if (!connection) throw new Error("POLYMUX_LIVE_AUTH0_CONNECTION is required");
    const provider: Extract<CompiledFixtureProvider, { kind: "auth0" }> = {
      name: "liveAuth0",
      kind: "auth0",
      config: { connection, ...(emailDomain ? { emailDomain } : {}) },
      timeoutMs: 30_000,
    };
    await verifyLifecycle(new Auth0Transport(provider));
  });

  it.runIf(enabled("clerk"))("creates and deletes a real Clerk test user", async () => {
    const provider: Extract<CompiledFixtureProvider, { kind: "clerk" }> = {
      name: "liveClerk",
      kind: "clerk",
      config: { ...(emailDomain ? { emailDomain } : {}) },
      timeoutMs: 30_000,
    };
    await verifyLifecycle(new ClerkTransport(provider));
  });
});
