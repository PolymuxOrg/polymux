import { describe, expect, it } from "vitest";
import {
  normalizeServiceUrl,
  trustedAuthorizationUrl,
} from "../apps/cli/src/service-url.js";

describe("cloud service URLs", () => {
  it("accepts exact HTTPS origins and local HTTP development", () => {
    expect(normalizeServiceUrl("https://api.polymux.co/", "API URL")).toBe(
      "https://api.polymux.co",
    );
    expect(normalizeServiceUrl("http://localhost:5173", "API URL")).toBe(
      "http://localhost:5173",
    );
  });

  it("rejects credentials, non-local HTTP, and origin paths", () => {
    expect(() =>
      normalizeServiceUrl("http://api.polymux.co", "API URL"),
    ).toThrow(/HTTPS/);
    expect(() =>
      normalizeServiceUrl("https://user:secret@api.polymux.co", "API URL"),
    ).toThrow(/credentials/);
    expect(() =>
      normalizeServiceUrl("https://api.polymux.co/v1", "API URL"),
    ).toThrow(/only an origin/);
  });

  it("keeps device authorization links on the configured auth origin", () => {
    expect(
      trustedAuthorizationUrl(
        "https://auth.polymux.co/cli/authorize?code=ABCD-EFGH",
        "https://auth.polymux.co",
        "Verification URL",
      ),
    ).toBe("https://auth.polymux.co/cli/authorize?code=ABCD-EFGH");
    expect(() =>
      trustedAuthorizationUrl(
        "https://phishing.example/cli/authorize",
        "https://auth.polymux.co",
        "Verification URL",
      ),
    ).toThrow(/configured authentication origin/);
  });
});
