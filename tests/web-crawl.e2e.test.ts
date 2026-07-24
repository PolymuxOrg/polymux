import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawlWebApp } from "@polymux/adapter-web";

const repositoryRoot = resolve(import.meta.dirname, "..");
let server: ReturnType<typeof createServer>;
let baseUrl = "";
let activeDocuments = 0;
let peakDocuments = 0;

function page(title: string, body = ""): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
}

async function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(repositoryRoot, "apps/cli/dist/index.js"), ...args], {
      cwd,
      env: {
        ...env,
        POLYMUX_NO_UPDATE_CHECK: "1",
        POLYMUX_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", rejectRun);
    child.once("exit", (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
  });
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (request.method === "POST") {
      response.writeHead(204);
      response.end();
      return;
    }
    activeDocuments += 1;
    peakDocuments = Math.max(peakDocuments, activeDocuments);
    if (request.url === "/a" || request.url === "/b") {
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/") {
      response.end(page("Home", '<a href="/a">A</a><a href="/b">B</a><a href="/mutating">Mutation</a><a href="/private">Private</a><a href="/logout">Logout</a>'));
    } else if (request.url === "/a") {
      response.end(page("A"));
    } else if (request.url === "/b") {
      response.end(page("B"));
    } else if (request.url === "/mutating") {
      response.end(page("Mutation", '<script>fetch("/changed", { method: "POST" })</script>'));
    } else if (request.url === "/private") {
      if (!request.headers.cookie?.includes("session=buyer")) {
        response.writeHead(302, { location: "/login" });
        response.end();
      } else {
        response.end(page("Private"));
      }
    } else if (request.url === "/login") {
      response.end(page("Login", `<form id="login"><label>Email <input aria-label="Email"></label><label>Password <input aria-label="Password" type="password"></label><button type="submit">Sign in</button></form><script>document.querySelector("#login").addEventListener("submit", (event) => { event.preventDefault(); document.cookie = "session=buyer; Path=/"; location.href = "/private"; });</script>`));
    } else {
      response.writeHead(404);
      response.end(page("Missing"));
    }
    activeDocuments -= 1;
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No crawl test port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
});

describe("deterministic web crawl", () => {
  it("uses bounded concurrency and identifies only stable read-only candidates", async () => {
    const result = await crawlWebApp({
      url: baseUrl,
      maxPages: 10,
      maxDepth: 1,
      replays: 2,
    });

    expect(result.concurrency).toBeGreaterThanOrEqual(1);
    expect(result.maxConcurrent).toBeLessThanOrEqual(result.concurrency);
    if (result.concurrency > 1) expect(peakDocuments).toBeGreaterThanOrEqual(2);
    expect(result.pages.map((entry) => new URL(entry.requestedUrl).pathname)).toEqual([
      "/",
      "/a",
      "/b",
      "/mutating",
      "/private",
    ]);
    expect(result.eligibleCandidates).toBe(3);
    expect(result.pages.find((entry) => entry.url.endsWith("/mutating"))).toMatchObject({
      candidateEligible: false,
      reasons: expect.arrayContaining(["mutation-attempted"]),
    });
    expect(result.pages.every((entry) => !entry.url.endsWith("/logout"))).toBe(true);
  });

  it("stages uncovered candidates without activating discovered behaviour", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-crawl-"));
    await mkdir(join(projectDir, "polymux"));
    await writeFile(
      join(projectDir, "polymux/a.flow.yaml"),
      `version: 1\nname: Approved A\nplatforms: [web]\nbaseUrl: ${baseUrl}\nsteps:\n  - navigate: /a\n  - expect:\n      target:\n        role: heading\n        name: A\n`,
    );
    const command = await runCli([
      "crawl",
      "--url", baseUrl,
      "--project-dir", projectDir,
      "--max-depth", "1",
      "--replays", "2",
      "--json",
    ], projectDir);

    expect(command.code, command.stderr).toBe(0);
    const result = JSON.parse(command.stdout);
    expect(result).toMatchObject({
      visited: 5,
      eligibleCandidates: 3,
      staged: 2,
      coverage: { approvedFlows: 1, coveredRoutes: 1, uncoveredRoutes: 4 },
    });
    await expect(access(join(projectDir, "polymux/generated"))).rejects.toThrow();
    expect(await readdir(join(projectDir, "polymux"))).toEqual(["a.flow.yaml"]);
    const candidateDir = join(result.reportPath, "..", "candidates");
    const files = await readdir(candidateDir);
    expect(files).toHaveLength(2);
    const flows = await Promise.all(
      files.map((file) => readFile(join(candidateDir, file), "utf8")),
    );
    expect(flows.every((flow) => flow.includes("Generated by polymux crawl"))).toBe(true);
    expect(flows.some((flow) => flow.includes("Mutation"))).toBe(false);
    expect(flows.some((flow) => flow.includes("Crawl: A"))).toBe(false);
    expect(await readFile(result.reportPath, "utf8")).toContain("mutation-attempted");
    expect(result.pages.find((entry: { url: string }) => entry.url.endsWith("/a"))).toMatchObject({
      routeCoverage: { status: "covered", flows: ["polymux/a.flow.yaml"] },
    });
  });

  it("uses committed project crawl configuration when no URL or limits are passed", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-crawl-config-"));
    await mkdir(join(projectDir, "polymux"));
    await writeFile(
      join(projectDir, "polymux.yaml"),
      `version: 1\napp:\n  url: ${baseUrl}\ncrawl:\n  browser: chromium\n  maxPages: 1\n  maxDepth: 0\n  replays: 1\n  timeoutMs: 5000\n`,
    );
    const command = await runCli([
      "crawl",
      "--project-dir", projectDir,
      "--json",
    ], projectDir);

    expect(command.code, command.stderr).toBe(0);
    const result = JSON.parse(command.stdout);
    expect(result).toMatchObject({
      seedUrl: baseUrl,
      urlSource: "project-config",
      visited: 1,
      staged: 1,
      coverage: { approvedFlows: 0, invalidFlows: [] },
    });
    expect(result.pages).toHaveLength(1);
    expect(await readdir(join(projectDir, "polymux"))).toEqual([]);
  });

  it("warns about anonymous auth barriers and crawls every enabled actor", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-crawl-actors-"));
    await mkdir(join(projectDir, "polymux/actors"), { recursive: true });
    await writeFile(
      join(projectDir, "polymux/actors.yaml"),
      `version: 1\nactors:\n  buyer:\n    setup: actors/buyer.setup.yaml\n    variablesFromEnv:\n      email: CRAWL_BUYER_EMAIL\n      password: CRAWL_BUYER_PASSWORD\n`,
    );
    await writeFile(
      join(projectDir, "polymux/actors/buyer.setup.yaml"),
      `version: 1\nname: Buyer crawl login\nplatforms: [web]\nbaseUrl: ${baseUrl}\nsteps:\n  - navigate: /login\n  - enter:\n      target: { label: Email }\n      value: \${actor.email}\n  - enter:\n      target: { label: Password }\n      value: \${actor.password}\n  - activate: { role: button, name: Sign in }\n  - expect: { text: Private }\n`,
    );
    const command = await runCli([
      "crawl",
      "--url", baseUrl,
      "--project-dir", projectDir,
      "--max-depth", "1",
      "--replays", "2",
      "--json",
    ], projectDir, {
      ...process.env,
      CRAWL_BUYER_EMAIL: "buyer@example.test",
      CRAWL_BUYER_PASSWORD: "secret-password",
    });

    expect(command.code, command.stderr).toBe(0);
    expect(command.stdout).not.toContain("secret-password");
    const result = JSON.parse(command.stdout);
    expect(result.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: "anonymous", status: "completed" }),
      expect.objectContaining({ actor: "buyer", status: "completed", setup: "polymux/actors/buyer.setup.yaml" }),
    ]));
    expect(result.accessWarnings).toBeGreaterThan(0);
    expect(result.coverage.invalidFlows).toEqual([]);
    expect(result.accessMatrix["/private"]).toMatchObject({ anonymous: "gated", buyer: "reached" });
    const actorCandidate = result.pages.find(
      (entry: { actor: string; requestedUrl: string }) =>
        entry.actor === "buyer" && entry.requestedUrl.endsWith("/private"),
    );
    expect(actorCandidate).toMatchObject({ candidateEligible: true, routeCoverage: { status: "uncovered" } });
    expect(actorCandidate.candidatePath).toContain("buyer-private-");
    const staged = await readFile(actorCandidate.candidatePath, "utf8");
    expect(staged).toContain('"actor": "buyer"');
    expect(staged).not.toContain("secret-password");
    expect(await readdir(join(projectDir, "polymux"))).toEqual(["actors", "actors.yaml"]);

    const summary = await runCli([
      "crawl",
      "--url", baseUrl,
      "--project-dir", projectDir,
      "--max-depth", "1",
      "--replays", "2",
    ], projectDir, {
      ...process.env,
      CRAWL_BUYER_EMAIL: "buyer@example.test",
      CRAWL_BUYER_PASSWORD: "secret-password",
    });
    expect(summary.code, summary.stderr).toBe(0);
    expect(summary.stdout).toContain("Crawled 2 sessions");
    expect(summary.stdout).toContain("anonymous routes show possible authentication barriers");
    expect(summary.stdout).not.toContain("secret-password");
  }, 15_000);
});
