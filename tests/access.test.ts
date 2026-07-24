import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileCoordinatedFlowFile } from "@polymux/core";
import {
  initializeAccess,
  loadProjectAccessEnvironment,
  type AccessPrompter,
} from "../apps/cli/src/access.js";

async function accessProject(): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), "polymux-access-wizard-"));
  await mkdir(join(projectDir, "polymux"));
  for (const actor of ["buyer", "seller"]) {
    await writeFile(join(projectDir, `polymux/${actor}.flow.yaml`), [
      "version: 1",
      `name: ${actor}`,
      "steps:",
      "  - wait: 1",
      "",
    ].join("\n"));
  }
  await writeFile(join(projectDir, "polymux/protected.flow.yaml"), [
    "# Keep this flow comment",
    "version: 1",
    "name: Protected collaboration",
    "actors:",
    "  buyer: buyer.flow.yaml",
    "  seller: seller.flow.yaml",
    "",
  ].join("\n"));
  return projectDir;
}

describe("test-access setup", () => {
  it("asks for missing fields, preserves flow content, and prepares automatic local reruns", async () => {
    const projectDir = await accessProject();
    const questions: string[] = [];
    const messages: string[] = [];
    const replies = [
      "",
      "",
      "https://staging.example.com",
      "",
      "x-project-test-access",
      "PROJECT_TEST_ACCESS_TOKEN",
    ];
    const prompt: AccessPrompter = {
      ask: async (question) => {
        questions.push(question);
        return replies.shift() ?? "";
      },
      write: (message) => messages.push(message),
    };

    const result = await initializeAccess(
      { projectDir, interactive: true },
      prompt,
    );

    expect(result).toMatchObject({
      status: "configured",
      protection: "access",
      origin: "https://staging.example.com",
      environment: "staging",
      header: "x-project-test-access",
      tokenEnv: "PROJECT_TEST_ACCESS_TOKEN",
      flowChanged: true,
      tokenCreated: true,
    });
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(questions).toEqual([
      "Flow [protected]: ",
      "Protection name [access]: ",
      "Staging/test URL: ",
      "Test environment [staging]: ",
      "Access header [x-polymux-test-access]: ",
      "Token environment variable [POLYMUX_TEST_ACCESS_TOKEN]: ",
    ]);
    expect(messages).toEqual([]);

    const flowPath = join(projectDir, "polymux/protected.flow.yaml");
    const flow = await readFile(flowPath, "utf8");
    expect(flow).toContain("# Keep this flow comment");
    expect(flow).toContain("x-project-test-access: PROJECT_TEST_ACCESS_TOKEN");
    await expect(compileCoordinatedFlowFile(flowPath)).resolves.toMatchObject({
      protections: [
        expect.objectContaining({ name: "access", origin: "https://staging.example.com" }),
      ],
    });

    const secretPath = join(projectDir, ".polymux/access.json");
    const stored = JSON.parse(await readFile(secretPath, "utf8"));
    expect(stored).toMatchObject({
      formatVersion: 1,
      environment: "staging",
      secrets: { PROJECT_TEST_ACCESS_TOKEN: result.token },
    });
    if (process.platform !== "win32") {
      expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(join(projectDir, ".gitignore"), "utf8")).toContain(
      "/.polymux/access.json",
    );

    const previousToken = process.env.PROJECT_TEST_ACCESS_TOKEN;
    const previousEnvironment = process.env.POLYMUX_TEST_ENVIRONMENT;
    try {
      delete process.env.PROJECT_TEST_ACCESS_TOKEN;
      delete process.env.POLYMUX_TEST_ENVIRONMENT;
      expect(await loadProjectAccessEnvironment(projectDir, ["PROJECT_TEST_ACCESS_TOKEN"]))
        .toEqual(["POLYMUX_TEST_ENVIRONMENT", "PROJECT_TEST_ACCESS_TOKEN"]);
      expect(process.env.POLYMUX_TEST_ENVIRONMENT).toBe("staging");
      expect(process.env.PROJECT_TEST_ACCESS_TOKEN).toBe(result.token);

      process.env.PROJECT_TEST_ACCESS_TOKEN = "caller-supplied-token";
      expect(await loadProjectAccessEnvironment(projectDir, ["PROJECT_TEST_ACCESS_TOKEN"]))
        .toEqual([]);
      expect(process.env.PROJECT_TEST_ACCESS_TOKEN).toBe("caller-supplied-token");
    } finally {
      if (previousToken === undefined) delete process.env.PROJECT_TEST_ACCESS_TOKEN;
      else process.env.PROJECT_TEST_ACCESS_TOKEN = previousToken;
      if (previousEnvironment === undefined) delete process.env.POLYMUX_TEST_ENVIRONMENT;
      else process.env.POLYMUX_TEST_ENVIRONMENT = previousEnvironment;
    }
  });

  it("is idempotent and refuses conflicting or production access", async () => {
    const projectDir = await accessProject();
    const options = {
      projectDir,
      flow: "protected",
      origin: "https://staging.example.com",
      environment: "test",
      name: "edge",
      header: "x-edge-test",
      tokenEnv: "EDGE_TEST_TOKEN",
      interactive: false,
    } as const;
    const first = await initializeAccess(options);
    const before = await readFile(join(projectDir, "polymux/protected.flow.yaml"), "utf8");
    const second = await initializeAccess(options);
    expect(second).toMatchObject({
      status: "unchanged",
      flowChanged: false,
      tokenCreated: false,
      token: first.token,
    });
    expect(await readFile(join(projectDir, "polymux/protected.flow.yaml"), "utf8")).toBe(before);

    await expect(initializeAccess({
      ...options,
      origin: "https://different.example.com",
    })).rejects.toThrow('Protection "edge" already exists with different settings');
    await expect(initializeAccess({
      ...options,
      environment: "production",
    })).rejects.toThrow("explicitly non-production");
    await expect(initializeAccess({
      ...options,
      name: "another",
      origin: "http://staging.example.com",
    })).rejects.toThrow("requires HTTPS");
    await expect(access(join(projectDir, ".polymux/access.json"))).resolves.toBeUndefined();
  });
});
