const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

function secureUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  if (
    url.protocol !== "https:" &&
    (url.protocol !== "http:" || !localHostnames.has(url.hostname))
  ) {
    throw new Error(`${label} must use HTTPS`);
  }
  return url;
}

export function normalizeServiceUrl(value: string, label: string): string {
  const url = secureUrl(value, label);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must contain only an origin`);
  }
  return url.origin;
}

export function trustedAuthorizationUrl(
  value: string,
  expectedOrigin: string,
  label: string,
): string {
  const url = secureUrl(value, label);
  if (url.origin !== expectedOrigin || url.hash) {
    throw new Error(
      `${label} must stay on the configured authentication origin`,
    );
  }
  return url.toString();
}
