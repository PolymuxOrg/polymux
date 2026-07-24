import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

function sampleRun(runId: string, kind: "local" | "remote") {
  return {
    formatVersion: 1,
    runId,
    flow: `${kind} checkout`,
    flowHash: "abc123",
    sourcePath: `/private/project/polymux/${kind}.yaml`,
    platform: "web",
    origin: kind === "local"
      ? { kind, runnerId: "test-host", host: "test-host" }
      : { kind, runnerId: "runner-sg-1", host: "worker-7", region: "ap-southeast-1" },
    status: "error",
    startedAt: "2026-07-22T01:00:00.000Z",
    finishedAt: "2026-07-22T01:00:01.000Z",
    durationMs: 1000,
    artifactsDir: `/private/project/.polymux/runs/${runId}`,
    artifacts: ["trace.zip"],
    steps: [{
      id: "step-1",
      kind: "expect",
      status: "error",
      startedAt: "2026-07-22T01:00:00.000Z",
      finishedAt: "2026-07-22T01:00:01.000Z",
      durationMs: 1000,
      artifacts: ["failure.png"],
      error: {
        name: "RuntimeFailure",
        message: "Bearer secret-value failed at https://example.com?a=1&token=private-token with pmx_secret123",
        category: "runtime",
      },
    }],
  };
}

async function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [join(repositoryRoot, "apps/cli/dist/index.js"), ...args],
      {
        cwd,
        env: {
          ...env,
          POLYMUX_NO_UPDATE_CHECK: env.POLYMUX_NO_UPDATE_CHECK ?? "1",
          POLYMUX_CREDENTIAL_STORE: env.POLYMUX_CREDENTIAL_STORE ?? "file",
          POLYMUX_TELEMETRY_DISABLED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      resolveRun({ code: code ?? -1, stdout, stderr }),
    );
  });
}

describe("polymux CLI project setup", () => {
  it("manages typed configuration with file and environment precedence", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-config-"));
    const configDir = join(projectDir, "config");
    const env = { ...process.env, POLYMUX_CONFIG_DIR: configDir };

    const set = await runCli(["config", "set", "defaults.platform", "linux"], projectDir, env);
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toContain("defaults.platform=linux");

    const get = await runCli(["config", "get", "defaults.platform"], projectDir, env);
    expect(get.stdout.trim()).toBe("linux");

    const list = await runCli(["config", "list", "--json"], projectDir, env);
    expect(JSON.parse(list.stdout)["defaults.platform"]).toMatchObject({ value: "linux", source: "file" });

    const overridden = await runCli(
      ["config", "get", "defaults.platform", "--json"],
      projectDir,
      { ...env, POLYMUX_DEFAULT_PLATFORM: "ios" },
    );
    expect(JSON.parse(overridden.stdout)).toMatchObject({ value: "ios" });

    const invalid = await runCli(["config", "set", "credentials.store", "plaintext"], projectDir, env);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("auto, native, or file");
    if (process.platform !== "win32") {
      expect((await stat(join(configDir, "config.json"))).mode & 0o777)
        .toBe(0o600);
    }

    const unset = await runCli(["config", "unset", "defaults.platform"], projectDir, env);
    expect(unset.code).toBe(0);
    const reset = await runCli(["config", "get", "defaults.platform"], projectDir, env);
    expect(reset.stdout.trim()).toBe("web");

    const doctor = await runCli(["config", "doctor", "--json"], projectDir, env);
    expect(JSON.parse(doctor.stdout).checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "syntax", status: "passed" })]));
  }, 10_000);

  it("generates Bash, Zsh, and Fish completions without editing shell profiles", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-completion-"));
    const bash = await runCli(["completion", "bash"], projectDir);
    const zsh = await runCli(["completion", "zsh"], projectDir);
    const fish = await runCli(["completion", "fish"], projectDir);
    expect(bash.code).toBe(0);
    expect(bash.stdout).toContain("complete -F _polymux polymux");
    expect(zsh.stdout).toContain("#compdef polymux");
    expect(zsh.stdout).toContain("diagnose:Create a sanitized diagnostic");
    expect(zsh.stdout).toContain("crawl:Discover test candidates");
    expect(zsh.stdout).toContain("access:Configure protected test environments");
    expect(zsh.stdout).toContain("driver:Manage local Appium platform drivers");
    expect(fish.stdout).toContain("complete -c polymux");
    expect(fish.stdout).toContain("login logout status");
    expect(fish.stdout).toContain("driver' -a 'install uninstall");
  });

  it("installs and uninstalls only Polymux-owned completion files and profile blocks", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-completion-install-"));
    const home = join(projectDir, "home");
    await mkdir(home);
    await writeFile(join(home, ".zshrc"), "export KEEP_THIS=1\n");
    const env = { ...process.env, HOME: home, ZDOTDIR: home, XDG_DATA_HOME: join(home, ".local/share") };

    const first = await runCli(["completion", "install", "zsh"], projectDir, env);
    const second = await runCli(["completion", "install", "zsh"], projectDir, env);
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const completionPath = join(home, ".zfunc/_polymux");
    expect((await readFile(completionPath, "utf8"))).toContain("# Managed by Polymux");
    const profile = await readFile(join(home, ".zshrc"), "utf8");
    expect(profile).toContain("export KEEP_THIS=1");
    expect(profile.match(/>>> polymux completion >>>/g)).toHaveLength(1);

    const removed = await runCli(["completion", "uninstall", "zsh"], projectDir, env);
    expect(removed.code, removed.stderr).toBe(0);
    await expect(access(completionPath)).rejects.toThrow();
    const restored = await readFile(join(home, ".zshrc"), "utf8");
    expect(restored).toContain("export KEEP_THIS=1");
    expect(restored).not.toContain("polymux completion");

    const detected = await runCli(
      ["completion", "install"],
      projectDir,
      { ...env, SHELL: "/usr/bin/fish", XDG_CONFIG_HOME: join(home, ".config") },
    );
    expect(detected.code, detected.stderr).toBe(0);
    expect(detected.stdout).toContain("fish completion");
    const fishPath = join(home, ".config/fish/completions/polymux.fish");
    await expect(access(fishPath)).resolves.toBeUndefined();
    const fishRemoved = await runCli(
      ["completion", "uninstall"],
      projectDir,
      { ...env, SHELL: "/usr/bin/fish", XDG_CONFIG_HOME: join(home, ".config") },
    );
    expect(fishRemoved.code, fishRemoved.stderr).toBe(0);
    await expect(access(fishPath)).rejects.toThrow();
  });

  it("reports completion status as JSON", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-completion-status-"));
    const home = join(projectDir, "home");
    const env = { ...process.env, HOME: home, ZDOTDIR: home, SHELL: "/bin/zsh" };
    await runCli(["completion", "install", "zsh"], projectDir, env);
    const status = await runCli(["completion", "status", "zsh", "--json"], projectDir, env);
    expect(JSON.parse(status.stdout)).toMatchObject({ shell: "zsh", installed: true, profileConfigured: true });
  });

  it("lists, inspects, and diagnoses local runs with their execution origin", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-runs-local-"));
    const run = sampleRun("local-run-1", "local");
    const runDir = join(projectDir, ".polymux/runs/local-run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "results.json"), JSON.stringify(run));

    const list = await runCli(["runs", "--project-dir", projectDir], projectDir);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toContain("local-run-1");
    expect(list.stdout).toContain("local:test-host");

    const show = await runCli(["runs", "show", "local-run-1", "--project-dir", projectDir], projectDir);
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toContain("Origin: local:test-host");

    const diagnose = await runCli(["diagnose", "local-run-1", "--project-dir", projectDir, "--json"], projectDir);
    expect(diagnose.code, diagnose.stderr).toBe(0);
    const result = JSON.parse(diagnose.stdout);
    expect(result.diagnostic.run.origin).toMatchObject({ kind: "local", runnerId: "test-host" });
    expect(result.diagnostic.privacy.artifactContentsIncluded).toBe(false);
    const serialized = JSON.stringify(result.diagnostic);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("pmx_secret123");
    await expect(access(result.path)).resolves.toBeUndefined();

    const report = await runCli([
      "report",
      "local-run-1",
      "--project-dir",
      projectDir,
      "--message",
      "Checkout fails after redirect",
      "--json",
    ], projectDir);
    expect(report.code, report.stderr).toBe(0);
    const prepared = JSON.parse(report.stdout);
    expect(prepared).toMatchObject({
      submitted: false,
      report: {
        runId: "local-run-1",
        message: "Checkout fails after redirect",
        diagnostic: { run: { runId: "local-run-1" } },
      },
    });
    expect(prepared.path).toBe(
      join(projectDir, ".polymux", "reports", "local-run-1.json"),
    );
    await expect(access(prepared.path)).resolves.toBeUndefined();
  });

  it("caps report messages at 4,000 characters", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-report-message-"));
    const runDir = join(projectDir, ".polymux/runs/message-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "results.json"), JSON.stringify(sampleRun("message-run", "local")));

    const accepted = await runCli([
      "report",
      "message-run",
      "--project-dir",
      projectDir,
      "--message",
      "a".repeat(4_000),
      "--json",
    ], projectDir);
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout).report.message).toHaveLength(4_000);

    const rejected = await runCli([
      "report",
      "message-run",
      "--project-dir",
      projectDir,
      "--message",
      "a".repeat(4_001),
      "--json",
    ], projectDir);
    expect(rejected.code).toBe(2);
    expect(JSON.parse(rejected.stdout).error.message).toContain("4,000 characters or fewer");
  });

  it("previews old run cleanup before deleting with explicit confirmation", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-runs-clean-"));
    const runDir = join(projectDir, ".polymux/runs/old-run");
    await mkdir(runDir, { recursive: true });
    const old = new Date("2020-01-01T00:00:00.000Z");
    await utimes(runDir, old, old);
    const preview = await runCli(["runs", "clean", "--project-dir", projectDir, "--older-than", "30", "--json"], projectDir);
    expect(JSON.parse(preview.stdout)).toMatchObject({ dryRun: true, deleted: 0, candidates: ["old-run"] });
    expect((await stat(runDir)).isDirectory()).toBe(true);
    const confirmed = await runCli(["runs", "clean", "--project-dir", projectDir, "--older-than", "30", "--yes", "--json"], projectDir);
    expect(JSON.parse(confirmed.stdout)).toMatchObject({ dryRun: false, deleted: 1 });
    await expect(access(runDir)).rejects.toThrow();
  });

  it("inspects remote runs and explicitly submits their origin-aware diagnostic", async () => {
    const remote = sampleRun("remote-run-1", "remote");
    let submitted: unknown;
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== "Bearer pmx_remote") {
        response.writeHead(401);
        response.end(JSON.stringify({ error: "unauthorized" }));
      } else if (request.url?.startsWith("/api/runs?")) {
        response.end(JSON.stringify({ runs: [remote] }));
      } else if (request.url === "/api/runs/remote-run-1") {
        response.end(JSON.stringify({ run: remote }));
      } else if (request.url === "/api/reports" && request.method === "POST") {
        submitted = JSON.parse(raw);
        response.writeHead(201);
        response.end(JSON.stringify({ reportId: "report-1" }));
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No remote run test port");
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-runs-remote-"));
    const configDir = join(projectDir, "config");
    await mkdir(configDir);
    const cloudUrl = `http://127.0.0.1:${address.port}`;
    await writeFile(join(configDir, "credentials.json"), JSON.stringify({
      formatVersion: 1,
      authUrl: cloudUrl,
      apiUrl: cloudUrl,
      accessToken: "pmx_remote",
      tokenType: "Bearer",
      userId: "user-remote",
      createdAt: new Date().toISOString(),
    }));
    const env = { ...process.env, POLYMUX_CONFIG_DIR: configDir };
    try {
      const list = await runCli(["runs", "--remote"], projectDir, env);
      expect(list.code, list.stderr).toBe(0);
      expect(list.stdout).toContain("remote:runner-sg-1:ap-southeast-1");

      const show = await runCli(["runs", "show", "remote-run-1", "--remote"], projectDir, env);
      expect(show.code, show.stderr).toBe(0);
      expect(show.stdout).toContain("Origin: remote:runner-sg-1:ap-southeast-1");

      const report = await runCli([
        "report",
        "remote-run-1",
        "--remote",
        "--message",
        "Remote checkout failed",
        "--submit",
        "--json",
      ], projectDir, env);
      expect(report.code, report.stderr).toBe(0);
      expect(JSON.parse(report.stdout)).toMatchObject({ submitted: true, reportId: "report-1" });
      expect(submitted).toMatchObject({
        runId: "remote-run-1",
        message: "Remote checkout failed",
        origin: { kind: "remote", runnerId: "runner-sg-1", region: "ap-southeast-1" },
        diagnostic: { privacy: { artifactContentsIncluded: false } },
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("checks for updates without installing them", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/polymux/latest") response.end(JSON.stringify({ version: "1.2.3" }));
      else {
        response.writeHead(404);
        response.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No registry test port");
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-update-"));
    try {
      const result = await runCli([
        "update",
        "--package-manager", "npm",
      ], projectDir, {
        ...process.env,
        POLYMUX_UPDATE_REGISTRY_URL: `http://127.0.0.1:${address.port}`,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Polymux 1.2.3 is available");
      expect(result.stdout).toContain("could not safely identify this installation");

      const alias = await runCli(
        ["upgrade", "--package-manager", "npm"],
        projectDir,
        {
          ...process.env,
          POLYMUX_UPDATE_REGISTRY_URL: `http://127.0.0.1:${address.port}`,
        },
      );
      expect(alias.code, alias.stderr).toBe(0);
      expect(alias.stdout).toBe(result.stdout);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("uses a cached daily update check without changing command output", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-update-notice-"));
    const cacheDir = join(projectDir, "cache");
    await mkdir(cacheDir);
    await writeFile(join(cacheDir, "update.json"), JSON.stringify({
      checkedAt: new Date().toISOString(),
      latestVersion: "1.2.3",
    }));
    const result = await runCli(
      ["init", "--project-dir", projectDir],
      projectDir,
      {
        ...process.env,
        CI: "",
        POLYMUX_CACHE_DIR: cacheDir,
        POLYMUX_NO_UPDATE_CHECK: "0",
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Ready:");
    expect(result.stderr).toContain("Update available: Polymux 0.0.0 → 1.2.3");
  });

  it("caches unavailable update checks instead of delaying every command", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not published" }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No registry test port");
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-update-failure-"));
    const cacheDir = join(projectDir, "cache");
    const env = {
      ...process.env,
      CI: "",
      POLYMUX_CACHE_DIR: cacheDir,
      POLYMUX_NO_UPDATE_CHECK: "0",
      POLYMUX_UPDATE_REGISTRY_URL: `http://127.0.0.1:${address.port}`,
    };
    try {
      const first = await runCli(["init", "--project-dir", projectDir], projectDir, env);
      const second = await runCli(["init", "--project-dir", projectDir], projectDir, env);
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("authenticates headless machines and revokes the stored session", async () => {
    let polls = 0;
    let revoked = false;
    const userId = "123e4567-e89b-42d3-a456-426614174000";
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/cli-auth/device" && request.method === "POST") {
        response.end(JSON.stringify({
          device_code: "device-secret-with-sufficient-entropy",
          user_code: "ABCD-EFGH",
          verification_uri: `http://127.0.0.1:${(server.address() as { port: number }).port}/cli/authorize`,
          verification_uri_complete: `http://127.0.0.1:${(server.address() as { port: number }).port}/cli/authorize?code=ABCD-EFGH`,
          expires_in: 600,
          interval: 1,
        }));
      } else if (request.url === "/api/cli-auth/token" && request.method === "POST") {
        polls += 1;
        if (polls === 1) {
          response.writeHead(428);
          response.end(JSON.stringify({ error: "authorization_pending" }));
        } else {
          response.end(JSON.stringify({
            access_token: "pmx_test",
            token_type: "Bearer",
            user_id: userId,
            api_url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          }));
        }
      } else if (request.url === "/api/cli-auth/session" && request.method === "GET") {
        response.end(JSON.stringify({ user_id: userId }));
      } else if (request.url === "/api/cli-auth/session" && request.method === "DELETE") {
        revoked = request.headers.authorization === "Bearer pmx_test";
        response.end(JSON.stringify({ revoked: true }));
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No auth test port");
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-auth-"));
    const configDir = join(projectDir, "config");
    const env = { ...process.env, POLYMUX_CONFIG_DIR: configDir };
    const authUrl = `http://127.0.0.1:${address.port}`;
    try {
      const login = await runCli(["auth", "login", "--no-browser", "--auth-url", authUrl], projectDir, env);
      expect(login.code, login.stderr).toBe(0);
      expect(login.stdout).toContain("Code: ABCD-EFGH");
      expect(login.stdout).toContain("Authenticated with Polymux Cloud");
      const stored = JSON.parse(await readFile(join(configDir, "credentials.json"), "utf8"));
      expect(stored).toMatchObject({ accessToken: "pmx_test", userId, authUrl, apiUrl: authUrl });
      if (process.platform !== "win32") {
        expect((await stat(join(configDir, "credentials.json"))).mode & 0o777)
          .toBe(0o600);
      }

      const status = await runCli(["auth", "status"], projectDir, env);
      expect(status.code).toBe(0);
      expect(status.stdout).toContain(userId);

      const logout = await runCli(["auth", "logout"], projectDir, env);
      expect(logout.code).toBe(0);
      expect(revoked).toBe(true);
      await expect(access(join(configDir, "credentials.json"))).rejects.toThrow();
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 15_000);

  it("removes local credentials without contacting the unavailable auth service", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-auth-local-"));
    const configDir = join(projectDir, "config");
    await mkdir(configDir);
    await writeFile(join(configDir, "credentials.json"), JSON.stringify({
      formatVersion: 1,
      authUrl: "http://127.0.0.1:1",
      accessToken: "pmx_unreachable",
      tokenType: "Bearer",
      userId: "user-local",
      createdAt: new Date().toISOString(),
    }));

    const result = await runCli(
      ["auth", "logout", "--local"],
      projectDir,
      { ...process.env, POLYMUX_CONFIG_DIR: configDir },
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Removed local Polymux credentials");
    await expect(access(join(configDir, "credentials.json"))).rejects.toThrow();
  });

  it("rejects stored credential origins that could redirect the token", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-auth-tampered-"));
    const configDir = join(projectDir, "config");
    await mkdir(configDir);
    await writeFile(join(configDir, "credentials.json"), JSON.stringify({
      formatVersion: 1,
      authUrl: "https://attacker.example/collect?next=/api/cli-auth/session",
      accessToken: "pmx_sensitive",
      tokenType: "Bearer",
      userId: "user-local",
      createdAt: new Date().toISOString(),
    }));

    const status = await runCli(
      ["auth", "status"],
      projectDir,
      { ...process.env, POLYMUX_CONFIG_DIR: configDir },
    );
    expect(status.code).not.toBe(0);
    expect(status.stderr).toContain("must contain only an origin");

    const logout = await runCli(
      ["auth", "logout", "--local"],
      projectDir,
      { ...process.env, POLYMUX_CONFIG_DIR: configDir },
    );
    expect(logout.code, logout.stderr).toBe(0);
    await expect(access(join(configDir, "credentials.json"))).rejects.toThrow();
  });

  it("shows help for both the bare command and the help command", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-help-"));
    const bare = await runCli([], projectDir);
    const help = await runCli(["help"], projectDir);

    expect(bare.code).toBe(0);
    expect(help.code).toBe(0);
    expect(bare.stdout).toContain("Usage: polymux [options] [command]");
    expect(help.stdout).toBe(bare.stdout);
  });

  it("shows the same package version through the option and command forms", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-version-"));
    const option = await runCli(["--version"], projectDir);
    const command = await runCli(["version"], projectDir);

    expect(option.code).toBe(0);
    expect(command.code).toBe(0);
    expect(command.stdout).toBe(option.stdout);
    expect(command.stdout.trim()).toBe("0.0.0");
  });

  it("provides the JSON shortcut consistently", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-json-help-"));
    const runHelp = await runCli(["run", "--help"], projectDir);
    const doctorHelp = await runCli(["doctor", "--help"], projectDir);
    const crawlHelp = await runCli(["crawl", "--help"], projectDir);

    expect(runHelp.stdout).toContain("-j, --json");
    expect(doctorHelp.stdout).toContain("-j, --json");
    expect(crawlHelp.stdout).toContain("-j, --json");
    expect(crawlHelp.stdout).not.toContain("--concurrency");
  });

  it("adds namespaced scripts without replacing existing scripts", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-init-"));
    await writeFile(
      join(projectDir, "package.json"),
      `${JSON.stringify(
        {
          name: "example-app",
          private: true,
          scripts: {
            dev: "vite",
            "polymux:run": "custom regression command",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runCli(["init", "--project-dir", projectDir], projectDir);
    expect(result.code).toBe(0);
    await expect(access(join(projectDir, "polymux"))).resolves.toBeUndefined();
    expect(await readFile(join(projectDir, "polymux.yaml"), "utf8")).toBe(
      "# yaml-language-server: $schema=./.polymux/schema/config-v1.schema.json\nversion: 1\n",
    );
    const projectSchema = JSON.parse(
      await readFile(
        join(projectDir, ".polymux/schema/config-v1.schema.json"),
        "utf8",
      ),
    );
    expect(projectSchema.$id).toBe(
      "https://polymux.dev/schemas/config-v1.schema.json",
    );
    expect(projectSchema.properties.crawl.properties).toHaveProperty("maxPages");
    expect(projectSchema.properties).not.toHaveProperty("suites");
    expect(projectSchema.properties.crawl.properties).not.toHaveProperty(
      "concurrency",
    );
    const fixtureSchema = JSON.parse(
      await readFile(
        join(projectDir, ".polymux/schema/fixture-v1.schema.json"),
        "utf8",
      ),
    );
    expect(fixtureSchema.$id).toBe(
      "https://polymux.com/schemas/fixture-v1.schema.json",
    );
    expect(fixtureSchema.$defs.request.properties.protocol.const).toBe(
      "polymux.fixture/v1",
    );

    const packageJson = JSON.parse(
      await readFile(join(projectDir, "package.json"), "utf8"),
    );
    expect(packageJson.scripts).toMatchObject({
      dev: "vite",
      "polymux:build": "polymux build",
      "polymux:dev": "polymux dev",
      "polymux:run": "custom regression command",
    });
    expect(result.stdout).toContain("polymux:build");
    expect(result.stdout).toContain("polymux:dev");

    await writeFile(join(projectDir, "polymux.yaml"), "version: 1\napp:\n  url: http://localhost:3000\n");
    const repeated = await runCli(["init", "--project-dir", projectDir], projectDir);
    expect(repeated.code, repeated.stderr).toBe(0);
    expect(await readFile(join(projectDir, "polymux.yaml"), "utf8")).toContain("http://localhost:3000");
  });

  it("configures protected test access non-interactively without committing the secret", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-access-cli-"));
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
    const flowPath = join(projectDir, "polymux/protected.flow.yaml");
    await writeFile(flowPath, [
      "# Preserve this comment",
      "version: 1",
      "name: Protected actors",
      "actors:",
      "  buyer: buyer.flow.yaml",
      "  seller: seller.flow.yaml",
      "",
    ].join("\n"));

    const args = [
      "access", "init",
      "-P", projectDir,
      "-f", "protected",
      "-u", "https://staging.example.com",
      "-e", "test",
      "-n", "edge",
      "-H", "x-project-test",
      "-E", "PROJECT_TEST_TOKEN",
      "--json",
    ];
    const configured = await runCli(args, projectDir);
    expect(configured.code, configured.stderr).toBe(0);
    const result = JSON.parse(configured.stdout);
    expect(result).toMatchObject({
      status: "configured",
      flow: flowPath,
      protection: "edge",
      tokenEnv: "PROJECT_TEST_TOKEN",
      tokenCreated: true,
    });
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await readFile(flowPath, "utf8")).toContain("# Preserve this comment");
    expect(await readFile(flowPath, "utf8")).toContain(
      "x-project-test: PROJECT_TEST_TOKEN",
    );
    const storedPath = join(projectDir, ".polymux/access.json");
    expect(JSON.parse(await readFile(storedPath, "utf8"))).toMatchObject({
      environment: "test",
      secrets: { PROJECT_TEST_TOKEN: result.token },
    });
    if (process.platform !== "win32") {
      expect((await stat(storedPath)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(join(projectDir, ".gitignore"), "utf8")).toContain(
      "/.polymux/access.json",
    );

    const repeated = await runCli(args, projectDir);
    expect(repeated.code, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      status: "unchanged",
      token: result.token,
      tokenCreated: false,
    });
    const built = await runCli(["build", "protected", "-j", "--project-dir", projectDir], projectDir);
    expect(built.code, built.stderr).toBe(0);
    expect(JSON.parse(built.stdout).builds[0].flow).toBe("Protected actors");
  });

  it("reports setup health as JSON without creating generated state", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-doctor-"));
    await mkdir(join(projectDir, "polymux"));
    await writeFile(join(projectDir, "polymux/example.flow.yaml"), "version: 1\n");

    const result = await runCli(
      ["doctor", "--project-dir", projectDir, "-j"],
      projectDir,
    );

    const report = JSON.parse(result.stdout);
    expect(result.code).toBe(report.status === "passed" ? 0 : 1);
    expect(report).toMatchObject({
      projectDir,
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "node", status: "passed" }),
        expect.objectContaining({ id: "flows", status: "passed" }),
        expect.objectContaining({ id: "web-driver-chromium" }),
        expect.objectContaining({ id: "web-driver-firefox" }),
        expect.objectContaining({ id: "web-driver-webkit" }),
      ]),
      driverSetup: {
        appiumInstalled: expect.any(Boolean),
        appiumInstallCommand: "npm install --global appium",
        drivers: expect.arrayContaining([
          expect.objectContaining({ platform: "ios" }),
          expect.objectContaining({ platform: "android" }),
          expect.objectContaining({ platform: "macos" }),
          expect.objectContaining({ platform: "windows" }),
        ]),
      },
      targets: expect.arrayContaining([
        expect.objectContaining({
          id: "web-local",
          available: expect.any(Boolean),
        }),
        expect.objectContaining({ id: "cloud", available: false }),
      ]),
    });
    const webChecks = report.checks.filter(
      ({ id }: { id: string }) => id.startsWith("web-driver-"),
    );
    expect(webChecks).toHaveLength(3);
    expect(
      webChecks.every(
        ({ status }: { status: string }) =>
          status === "passed" || status === "failed",
      ),
    ).toBe(true);
    await expect(access(join(projectDir, ".polymux"))).rejects.toThrow();
  });

  it("keeps driver management non-interactive and requires an explicit scope", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-drivers-"));
    const help = await runCli(["driver", "install", "--help"], projectDir);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("--all");
    expect(help.stdout).toContain("[platforms...]");

    const missingScope = await runCli(["driver", "install"], projectDir);
    expect(missingScope.code).toBe(2);
    expect(missingScope.stderr).toContain("Choose a platform or pass --all");

    const legacy = await runCli(["drivers", "install"], projectDir);
    expect(legacy.code).not.toBe(0);
    expect(legacy.stderr).toContain("unknown command 'drivers'");
  });

  it("returns an unhealthy result for a missing project", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-doctor-missing-"));
    const missing = join(projectDir, "missing");
    const result = await runCli(
      ["doctor", "--project-dir", missing, "--json"],
      projectDir,
    );

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "failed",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "project", status: "failed" }),
      ]),
    });
  });

  it("selects a native Appium backend from CLI flags", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      requests.push({ url: request.url ?? "", body: raw ? JSON.parse(raw) : undefined });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/session") response.end(JSON.stringify({ value: { sessionId: "cli-native", capabilities: {} } }));
      else if (request.url?.endsWith("/element")) response.end(JSON.stringify({ value: { "element-6066-11e4-a52e-4f735466cecf": "element-1" } }));
      else if (request.url?.endsWith("/displayed")) response.end(JSON.stringify({ value: true }));
      else if (request.url?.endsWith("/attribute/states")) response.end(JSON.stringify({ value: "[ENABLED,SENSITIVE,SHOWING,VISIBLE]" }));
      else response.end(JSON.stringify({ value: null }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No Appium test port");
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-native-cli-"));
    await mkdir(join(projectDir, "polymux/native"), { recursive: true });
    await writeFile(join(projectDir, "polymux/native/check.flow.yaml"), [
      "version: 1",
      "name: Native CLI",
      "platforms: [linux]",
      "steps:",
      "  - launch: example.app",
      "  - activate: { accessibilityId: pay }",
      "  - expect:",
      "      target: { accessibilityId: confirmation }",
      "      state: visible",
      "",
    ].join("\n"));
    try {
      const result = await runCli([
        "run", "native", "polymux/native/check.flow.yaml", "--project-dir", projectDir,
        "-p", "linux", "-a", `http://127.0.0.1:${address.port}`,
        "-C", '{"appium:example":true}', "-q",
      ], projectDir);
      expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(requests.filter((request) => request.url === "/session")).toHaveLength(1);
      expect(requests[0]?.body).toMatchObject({ capabilities: { alwaysMatch: {
        platformName: "linux",
        "appium:automationName": "AtSpi2",
        "appium:appName": "example.app",
        "appium:example": true,
      } } });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("fails cleanly instead of hanging when watch has no flow directory", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-watch-missing-"));
    const result = await runCli(
      ["run", "--watch", "--project-dir", projectDir],
      projectDir,
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("No flows found");
  });

  it("combines and deduplicates flow and directory selectors without project configuration", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-directory-cli-"));
    await mkdir(join(projectDir, "polymux/smoke"), { recursive: true });
    await mkdir(join(projectDir, "polymux/regression"));
    for (const name of ["login", "checkout"]) {
      await writeFile(join(projectDir, `polymux/smoke/${name}.flow.yaml`), [
        "version: 1",
        `name: ${name}`,
        "steps:",
        "  - wait: 1",
        "",
      ].join("\n"));
    }
    await writeFile(join(projectDir, "polymux/regression/payments.flow.yaml"), [
      "version: 1",
      "name: payments",
      "steps:",
      "  - wait: 1",
      "",
    ].join("\n"));

    const built = await runCli(
      ["build", "smoke", "regression", "login", "--json", "--project-dir", projectDir],
      projectDir,
    );
    expect(built.code, built.stderr).toBe(0);
    expect(JSON.parse(built.stdout).builds).toEqual([
      expect.objectContaining({ flow: "checkout" }),
      expect.objectContaining({ flow: "login" }),
      expect.objectContaining({ flow: "payments" }),
    ]);
    await expect(access(join(projectDir, "polymux.yaml"))).rejects.toThrow();
  });

  it("does not retain the legacy command or generic YAML discovery", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-flow-format-"));
    await mkdir(join(projectDir, "polymux"));
    await writeFile(
      join(projectDir, "polymux/legacy.yaml"),
      "version: 1\nname: Legacy\nsteps:\n  - navigate: https://example.com\n",
    );

    const run = await runCli(["run", "--project-dir", projectDir, "--json"], projectDir);
    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout).error.message).toContain("No flows found");

    const legacyCommand = await runCli(["simulate"], projectDir);
    expect(legacyCommand.code).not.toBe(0);
    expect(legacyCommand.stderr).toContain("unknown command 'simulate'");

    const legacySuite = await runCli(["run", "--suite", "smoke"], projectDir);
    expect(legacySuite.code).not.toBe(0);
    expect(legacySuite.stderr).toContain("unknown option '--suite'");
  });
});
