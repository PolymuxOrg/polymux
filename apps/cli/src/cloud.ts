import { loadCredentials } from "./credentials.js";
import { configValue } from "./config.js";
import { normalizeServiceUrl } from "./service-url.js";

export async function cloudRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const credentials = await loadCredentials();
  if (!credentials) throw new Error("Sign in with `polymux auth login` first");
  const configuredApi = configValue<string>("api.url");
  const baseUrl = normalizeServiceUrl(
    process.env.POLYMUX_API_URL ??
      credentials.apiUrl ??
      configuredApi ??
      credentials.authUrl,
    "The Polymux API URL",
  );
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credentials.accessToken}`,
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error ?? `Polymux Cloud request failed (${response.status})`);
  return body;
}
