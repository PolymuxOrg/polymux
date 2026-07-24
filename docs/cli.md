# `polymux` CLI Reference

## Global

```bash
polymux [--help] [--version] [--verbose] [--no-color] <command>
```

- `--verbose`: write detailed operational information to `stderr`
- `--no-color`: disable colored output

## Agents and CI

Prefer `--json` for machine-readable output. Commands do not prompt when JSON is
requested or the shell is non-interactive. Mutating commands require explicit
scope such as a platform, `--all`, or `--yes`; failures return a non-zero exit
code with a clear error.

## auth

- `polymux auth login [--auth-url <url>] [--no-browser] [--json]`
- `polymux auth logout [--local] [--json]`
- `polymux auth status [--json]`

## access

- `polymux access init [--project-dir <directory>] [--flow <flow>] [--origin <url>] [--environment <name>] [--name <name>] [--header <name>] [--token-env <name>] [--json]`

## version

- `polymux version [--json]`

## config

- `polymux config [--json]`
- `polymux config list [--json]`
- `polymux config get <key> [--json]`
- `polymux config set <key> <value> [--json]`
- `polymux config unset <key> [--json]`
- `polymux config path [--json]`
- `polymux config doctor [--json]`

## completion

- `polymux completion <bash|zsh|fish>`
- `polymux completion status [shell] [--json]`
- `polymux completion install [shell] [--json]`
- `polymux completion uninstall [shell] [--json]`

## runs

- `polymux runs [--project-dir <directory>] [--remote] [--all] [--limit <count>] [--json]`
- `polymux runs show <run-id> [--project-dir <directory>] [--remote] [--json]`
- `polymux runs clean [--project-dir <directory>] [--older-than <days>] [--yes] [--json]`

## diagnose

- `polymux diagnose <run-id> [--project-dir <directory>] [--remote] [--output <file>] [--json]`

## report

- `polymux report <run-id> [--project-dir <directory>] [--remote] [--output <file>] [-m|--message <text>] [--submit] [--json]`

`report` writes `.polymux/reports/<run-id>.json`, combining an optional
user-written message with a freshly generated sanitized diagnostic. Nothing is
uploaded unless `--submit` is supplied.

## update

- `polymux update|upgrade [--yes] [--package-manager <npm|pnpm|yarn|bun>] [--json]`

## init

- `polymux init [--project-dir <directory>] [--json]`

## build

- `polymux build [selectors...] [--project-dir <directory>] [--include-tags <tags>] [--exclude-tags <tags>] [--json]`

## crawl

- `polymux crawl [--url <url>] [--project-dir <directory>] [--browser <chromium|firefox|webkit>] [--max-pages <count>] [--max-depth <count>] [--replays <count>] [--timeout-ms <milliseconds>] [--json]`

## doctor

- `polymux doctor [--project-dir <directory>] [--appium-url <url>] [--json]`

`doctor` is read-only. It reports local Appium and platform-driver status and
prints the exact `polymux driver` commands for anything installable on the
current machine.

## driver

- `polymux driver install <ios|android|macos|windows>... [--all] [--json]`
- `polymux driver uninstall <ios|android|macos|windows>... [--all] [--json]`

Install Appium itself first with `npm install --global appium`. Driver commands
are non-interactive. `--all` affects only drivers compatible with the current
machine. In `--json` mode, nested Appium console output is captured so stdout
contains one valid JSON document.

## devices

- `polymux devices [--platform <platform>] [--json]`

## dev

- `polymux dev [selectors...] [--project-dir <directory>] [--platform <platform>] [--appium-url <url>] [--capabilities <json>] [--target <id>] [--browser <chromium|firefox|webkit>] [--device <profile>] [--include-tags <tags>] [--exclude-tags <tags>] [--url <url>] [--command <command>] [--no-start] [--headed] [--quiet] [--output <directory>] [--junit <file>] [--video] [--debounce-ms <milliseconds>] [--wait-ms <milliseconds>]`

## run

- `polymux run [selectors...] [--project-dir <directory>] [--platform <platform>] [--appium-url <url>] [--capabilities <json>] [--target <id>] [--browser <chromium|firefox|webkit>] [--device <profile>] [--include-tags <tags>] [--exclude-tags <tags>] [--url <url>] [--headed] [--json] [--quiet] [--watch] [--output <directory>] [--junit <file>] [--video] [--repeat <count>] [--update-snapshots]`

## Note

- Commands: `mcp`, `flows`, `platforms`, and `protections` are documented elsewhere and not in the top-level CLI parser.
- Pseudonymous CLI analytics and error reporting are described in the
  [privacy policy](https://www.polymux.com/privacy).
