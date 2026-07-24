import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type CompletionShell = "bash" | "zsh" | "fish";

const blockStart = "# >>> polymux completion >>>";
const blockEnd = "# <<< polymux completion <<<";
const ownedMarker = "# Managed by Polymux";

const commands = [
  "auth", "access", "version", "update", "upgrade", "runs", "diagnose", "report",
  "config", "completion", "init", "build", "crawl", "doctor", "driver", "dev", "run", "help",
];

function bashCompletion(): string {
  return `# Bash completion for Polymux
_polymux() {
  local current previous command
  COMPREPLY=()
  current="\${COMP_WORDS[COMP_CWORD]}"
  previous="\${COMP_WORDS[COMP_CWORD-1]}"
  command="\${COMP_WORDS[1]}"
  case "$command:$previous" in
    auth:auth) COMPREPLY=( $(compgen -W "login logout status" -- "$current") ); return ;;
    access:access) COMPREPLY=( $(compgen -W "init" -- "$current") ); return ;;
    runs:runs) COMPREPLY=( $(compgen -W "show --remote --all --json --limit --project-dir" -- "$current") ); return ;;
    config:config) COMPREPLY=( $(compgen -W "list get set unset path" -- "$current") ); return ;;
    completion:completion) COMPREPLY=( $(compgen -W "bash zsh fish status install uninstall" -- "$current") ); return ;;
    driver:driver) COMPREPLY=( $(compgen -W "install uninstall" -- "$current") ); return ;;
  esac
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands.join(" ")}" -- "$current") )
  elif [[ "$current" == -* ]]; then
    COMPREPLY=( $(compgen -W "--help --json --project-dir --remote --output --quiet --all" -- "$current") )
  fi
}
complete -F _polymux polymux
`;
}

function zshCompletion(): string {
  return `#compdef polymux
_polymux() {
  local -a commands
  commands=(
    'auth:Authenticate with Polymux Cloud'
    'access:Configure protected test environments'
    'version:Show the installed version'
    'update:Check for and install updates'
    'upgrade:Alias for update'
    'runs:Inspect local and remote runs'
    'diagnose:Create a sanitized diagnostic'
    'report:Prepare or submit a diagnostic report'
    'config:Manage Polymux configuration'
    'completion:Generate shell completion'
    'init:Initialize a Polymux project'
    'build:Validate and compile flows'
    'crawl:Discover test candidates and flow coverage'
    'doctor:Check setup health'
    'driver:Manage local Appium platform drivers'
    'dev:Run continuous checks'
    'run:Compile and run flows'
  )
  _arguments -C '1:command:->command' '*::argument:->args'
  case $state in
    command) _describe 'command' commands ;;
    args)
      case $words[2] in
        auth) _values 'auth command' login logout status ;;
        access) _values 'access command' init ;;
        runs) _values 'runs command' show --remote --all --json --limit --project-dir ;;
        config) _values 'config command' list get set unset path ;;
        completion) _values 'completion action' bash zsh fish status install uninstall ;;
        driver) _values 'driver action' install uninstall ;;
      esac
      ;;
  esac
}
_polymux "$@"
`;
}

function fishCompletion(): string {
  const commandLines = [
    ["auth", "Authenticate with Polymux Cloud"], ["version", "Show the installed version"],
    ["access", "Configure protected test environments"],
    ["update", "Check for and install updates"], ["upgrade", "Alias for update"],
    ["runs", "Inspect local and remote runs"], ["diagnose", "Create a sanitized diagnostic"],
    ["report", "Prepare or submit a diagnostic report"], ["config", "Manage configuration"],
    ["completion", "Generate shell completion"], ["init", "Initialize a project"],
    ["build", "Validate and compile flows"], ["crawl", "Discover candidates and coverage"],
    ["doctor", "Check setup health"],
    ["driver", "Manage local Appium platform drivers"],
    ["dev", "Run continuous checks"], ["run", "Compile and run flows"],
  ].map(([command, description]) => `complete -c polymux -n '__fish_use_subcommand' -a '${command}' -d '${description}'`).join("\n");
  return `# Fish completion for Polymux
${commandLines}
complete -c polymux -n '__fish_seen_subcommand_from auth' -a 'login logout status'
complete -c polymux -n '__fish_seen_subcommand_from access' -a 'init'
complete -c polymux -n '__fish_seen_subcommand_from runs' -a 'show' -l remote -l all -l json -l limit -l project-dir
complete -c polymux -n '__fish_seen_subcommand_from config' -a 'list get set unset path'
complete -c polymux -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish status install uninstall'
complete -c polymux -n '__fish_seen_subcommand_from driver' -a 'install uninstall'
`;
}

export function completionScript(shell: string): string {
  if (shell === "bash") return bashCompletion();
  if (shell === "zsh") return zshCompletion();
  if (shell === "fish") return fishCompletion();
  throw new Error('Shell must be "bash", "zsh", or "fish"');
}

export function printCompletion(shell: string): void {
  process.stdout.write(completionScript(shell));
}

function userHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

function detectShell(value?: string): CompletionShell {
  const name = basename(value ?? process.env.SHELL ?? "").replace(/\.exe$/i, "");
  if (name === "bash" || name === "zsh" || name === "fish") return name;
  throw new Error("Could not detect a supported shell. Specify bash, zsh, or fish.");
}

function installation(shell: CompletionShell): { scriptPath: string; profilePath?: string; profileLine?: string } {
  const home = userHome();
  if (shell === "fish") {
    return { scriptPath: join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "fish/completions/polymux.fish") };
  }
  if (shell === "zsh") {
    const zshHome = process.env.ZDOTDIR ?? home;
    const directory = join(zshHome, ".zfunc");
    return {
      scriptPath: join(directory, "_polymux"),
      profilePath: join(zshHome, ".zshrc"),
      profileLine: `fpath=("${directory}" $fpath)\nautoload -Uz compinit\ncompinit`,
    };
  }
  const directory = join(process.env.XDG_DATA_HOME ?? join(home, ".local/share"), "bash-completion/completions");
  const scriptPath = join(directory, "polymux");
  return {
    scriptPath,
    profilePath: join(home, ".bashrc"),
    profileLine: `[ -r "${scriptPath}" ] && source "${scriptPath}"`,
  };
}

export async function completionStatus(shellValue?: string, json = false): Promise<void> {
  const shell = detectShell(shellValue);
  const target = installation(shell);
  const script = await readOptional(target.scriptPath);
  const profile = target.profilePath ? await readOptional(target.profilePath) : "";
  const installed = script.startsWith(ownedMarker);
  const profileConfigured = !target.profilePath || profile.includes(blockStart);
  const result = { shell, installed, profileConfigured, path: target.scriptPath };
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(installed && profileConfigured
    ? `${shell} completion is installed at ${target.scriptPath}.\n`
    : `${shell} completion is not fully installed. Run \`polymux completion install ${shell}\`.\n`);
  process.exitCode = installed && profileConfigured ? 0 : 1;
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

function removeManagedBlock(content: string): string {
  const pattern = new RegExp(`(?:^|\\n)${blockStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?\\n${blockEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\n|$)`, "g");
  return content.replace(pattern, "\n").replace(/^\n+|\n+$/g, "") + (content.trim() ? "\n" : "");
}

async function installProfileBlock(path: string, line: string): Promise<void> {
  const current = await readOptional(path);
  const clean = removeManagedBlock(current);
  const separator = clean.length > 0 && !clean.endsWith("\n") ? "\n" : "";
  const next = `${clean}${separator}${blockStart}\n${line}\n${blockEnd}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await writeFile(path, next, "utf8");
}

async function removeProfileBlock(path: string): Promise<void> {
  const current = await readOptional(path);
  if (!current.includes(blockStart)) return;
  await writeFile(path, removeManagedBlock(current), "utf8");
}

export async function installCompletion(shellValue?: string, json = false): Promise<void> {
  const shell = detectShell(shellValue);
  const target = installation(shell);
  const existing = await readOptional(target.scriptPath);
  if (existing && !existing.startsWith(ownedMarker)) {
    throw new Error(`Refusing to replace completion file not owned by Polymux: ${target.scriptPath}`);
  }
  await mkdir(dirname(target.scriptPath), { recursive: true, mode: 0o755 });
  await writeFile(target.scriptPath, `${ownedMarker}\n${completionScript(shell)}`, { encoding: "utf8", mode: 0o644 });
  await chmod(target.scriptPath, 0o644);
  if (target.profilePath && target.profileLine) await installProfileBlock(target.profilePath, target.profileLine);
  if (json) process.stdout.write(`${JSON.stringify({ status: "installed", shell, path: target.scriptPath }, null, 2)}\n`);
  else process.stdout.write(`Installed ${shell} completion at ${target.scriptPath}\nRestart your shell to activate it.\n`);
}

export async function uninstallCompletion(shellValue?: string, json = false): Promise<void> {
  const shell = detectShell(shellValue);
  const target = installation(shell);
  const existing = await readOptional(target.scriptPath);
  if (existing && !existing.startsWith(ownedMarker)) {
    throw new Error(`Refusing to remove completion file not owned by Polymux: ${target.scriptPath}`);
  }
  await rm(target.scriptPath, { force: true });
  if (target.profilePath) await removeProfileBlock(target.profilePath);
  if (json) process.stdout.write(`${JSON.stringify({ status: "uninstalled", shell, path: target.scriptPath }, null, 2)}\n`);
  else process.stdout.write(`Uninstalled ${shell} completion.\n`);
}
