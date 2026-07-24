import { spawn } from "node:child_process";
import { platform } from "node:os";
import { configValue } from "./config.js";
import { deleteCredentials, loadCredentials, saveCredentials, type StoredCredentials } from "./credentials.js";
import { normalizeServiceUrl, trustedAuthorizationUrl } from "./service-url.js";

const defaultAuthUrl = "https://polymux.com";

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  user_id: string;
  api_url?: string;
}

export interface LoginOptions {
  authUrl?: string;
  browser: boolean;
  json?: boolean;
}

export interface LogoutOptions {
  local: boolean;
  json?: boolean;
}

function normalizeAuthUrl(value?: string): string {
  return normalizeServiceUrl(
    value ?? configValue<string>("auth.url") ?? defaultAuthUrl,
    "The Polymux authentication URL",
  );
}

function validateAuthorization(
  value: DeviceAuthorization,
  authUrl: string,
): DeviceAuthorization {
  if (
    typeof value.device_code !== "string" ||
    value.device_code.length < 20 ||
    value.device_code.length > 512 ||
    typeof value.user_code !== "string" ||
    !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(value.user_code) ||
    !Number.isInteger(value.expires_in) ||
    value.expires_in < 60 ||
    value.expires_in > 1_800 ||
    !Number.isInteger(value.interval) ||
    value.interval < 1 ||
    value.interval > 30
  ) {
    throw new Error(
      "The authorization server returned an invalid device response",
    );
  }
  return {
    ...value,
    verification_uri: trustedAuthorizationUrl(
      value.verification_uri,
      authUrl,
      "The verification URL",
    ),
    verification_uri_complete: trustedAuthorizationUrl(
      value.verification_uri_complete,
      authUrl,
      "The complete verification URL",
    ),
  };
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error ?? `Authentication request failed (${response.status})`);
  return body;
}

async function openBrowser(url: string): Promise<boolean> {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolveOpen) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolveOpen(false));
    child.once("spawn", () => {
      child.unref();
      resolveOpen(true);
    });
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export async function login(options: LoginOptions): Promise<void> {
  const authUrl = normalizeAuthUrl(options.authUrl);
  const authorization = validateAuthorization(
    await requestJson<DeviceAuthorization>(
      `${authUrl}/api/cli-auth/device`,
      {
        method: "POST",
        body: JSON.stringify({
          client_name: "Polymux CLI",
          scopes: ["runs:read", "reports:write"],
        }),
      },
    ),
    authUrl,
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ status: "authorization-required", verificationUri: authorization.verification_uri, verificationUriComplete: authorization.verification_uri_complete, userCode: authorization.user_code, expiresIn: authorization.expires_in })}\n`);
  } else process.stdout.write(`Authorize Polymux CLI at:\n${authorization.verification_uri}\n\nCode: ${authorization.user_code}\n`);
  if (options.browser && !options.json) {
    const opened = await openBrowser(authorization.verification_uri_complete);
    process.stdout.write(opened ? "\nOpened your browser. Waiting for authorization…\n" : `\nOpen this URL in any browser:\n${authorization.verification_uri_complete}\n`);
  } else if (!options.json) {
    process.stdout.write(`\nOpen this URL in any browser:\n${authorization.verification_uri_complete}\n`);
  }

  const deadline = Date.now() + authorization.expires_in * 1_000;
  while (Date.now() < deadline) {
    await wait(Math.max(authorization.interval, 1) * 1_000);
    const response = await fetch(`${authUrl}/api/cli-auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: authorization.device_code }),
    });
    const body = (await response.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
    if (response.status === 428) continue;
    if (!response.ok) throw new Error(body.error ?? `Authorization failed (${response.status})`);
    if (
      !body.access_token?.startsWith("pmx_") ||
      body.access_token.length > 512 ||
      !body.user_id ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        body.user_id,
      ) ||
      body.token_type !== "Bearer" ||
      !body.api_url
    ) {
      throw new Error("The authorization server returned an invalid token response");
    }
    const apiUrl = normalizeServiceUrl(
      body.api_url,
      "The Polymux API URL",
    );
    const store = await saveCredentials({
      formatVersion: 1,
      authUrl,
      apiUrl,
      accessToken: body.access_token,
      tokenType: body.token_type,
      userId: body.user_id,
      createdAt: new Date().toISOString(),
    });
    if (options.json) process.stdout.write(`${JSON.stringify({ status: "authenticated", authenticated: true, userId: body.user_id, credentialStore: store })}\n`);
    else process.stdout.write(`Authenticated with Polymux Cloud. Credentials stored in ${store === "native" ? "the operating system keyring" : "a protected local file"}.\n`);
    return;
  }
  throw new Error("Authorization expired. Run `polymux auth login` again.");
}

export async function logout(options: LogoutOptions): Promise<void> {
  if (options.local) {
    await deleteCredentials();
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ authenticated: false, revokedRemotely: false })}\n`);
    } else {
      process.stdout.write("Removed local Polymux credentials.\n");
    }
    return;
  }
  const credentials = await loadCredentials();
  if (!credentials) {
    process.stdout.write(options.json ? `${JSON.stringify({ authenticated: false })}\n` : "Not logged in.\n");
    return;
  }
  await requestJson(`${credentials.authUrl}/api/cli-auth/session`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${credentials.accessToken}` },
  });
  await deleteCredentials();
  if (options.json) process.stdout.write(`${JSON.stringify({ authenticated: false, revokedRemotely: true })}\n`);
  else process.stdout.write("Logged out of Polymux Cloud.\n");
}

export async function authStatus(options: { json?: boolean } = {}): Promise<void> {
  const credentials = await loadCredentials();
  if (!credentials) {
    process.stdout.write(options.json ? `${JSON.stringify({ authenticated: false }, null, 2)}\n` : "Not logged in.\n");
    process.exitCode = 1;
    return;
  }
  const session = await requestJson<{ user_id: string }>(`${credentials.authUrl}/api/cli-auth/session`, {
    method: "GET",
    headers: { authorization: `Bearer ${credentials.accessToken}` },
  });
  if (options.json) process.stdout.write(`${JSON.stringify({ authenticated: true, authUrl: credentials.authUrl, userId: session.user_id }, null, 2)}\n`);
  else process.stdout.write(`Logged in to ${credentials.authUrl} as ${session.user_id}.\n`);
}
