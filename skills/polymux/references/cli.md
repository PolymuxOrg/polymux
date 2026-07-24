# CLI reference

Use `--verbose` for operational detail on standard error and `--no-color` for
plain output.

```text
polymux [--help] [--version] [--verbose] [--no-color] <command>
```

## Project and execution

```text
polymux init [--project-dir <directory>] [--json]

polymux build [selectors...]
  [--project-dir <directory>]
  [--include-tags <tags>] [--exclude-tags <tags>] [--json]

polymux doctor
  [--project-dir <directory>] [--appium-url <url>] [--json]

polymux devices [--platform <platform>] [--json]

polymux crawl
  [--url <url>] [--project-dir <directory>]
  [--browser <chromium|firefox|webkit>]
  [--max-pages <count>] [--max-depth <count>] [--replays <count>]
  [--timeout-ms <milliseconds>] [--json]

polymux run [selectors...]
  [--project-dir <directory>] [--platform <platform>]
  [--appium-url <url>] [--capabilities <json>] [--target <id>]
  [--browser <chromium|firefox|webkit>] [--device <profile>]
  [--include-tags <tags>] [--exclude-tags <tags>]
  [--url <url>] [--headed] [--json] [--quiet] [--watch]
  [--output <directory>] [--junit <file>] [--video] [--repeat <count>]
  [--update-snapshots]

polymux dev [selectors...]
  [--project-dir <directory>] [--platform <platform>]
  [--appium-url <url>] [--capabilities <json>] [--target <id>]
  [--browser <chromium|firefox|webkit>] [--device <profile>]
  [--include-tags <tags>] [--exclude-tags <tags>]
  [--url <url>] [--command <command>] [--no-start]
  [--headed] [--quiet] [--output <directory>] [--junit <file>] [--video]
  [--debounce-ms <milliseconds>] [--wait-ms <milliseconds>]
```

Platforms are `web`, `ios`, `ipados`, `android`, `macos`, `windows`, and
`linux`. `--capabilities` accepts a JSON object.

## Runs and diagnostics

```text
polymux runs
  [--project-dir <directory>] [--remote] [--all]
  [--limit <count>] [--json]

polymux runs show <run-id>
  [--project-dir <directory>] [--remote] [--json]

polymux runs clean
  [--project-dir <directory>] [--older-than <days>]
  [--yes] [--json]

polymux diagnose <run-id>
  [--project-dir <directory>] [--remote]
  [--output <file>] [--json]

polymux report <run-id>
  [--project-dir <directory>] [--remote]
  [--output <file>] [-m|--message <text>] [--submit] [--json]
```

`runs clean` is a dry run unless `--yes` is supplied. `report` prepares a local
report containing an optional message and a sanitized diagnostic unless
`--submit` is supplied.

## Access and authentication

```text
polymux access init
  [--project-dir <directory>] [--flow <flow>] [--origin <url>]
  [--environment <name>] [--name <name>] [--header <name>]
  [--token-env <name>] [--json]

polymux auth login [--auth-url <url>] [--no-browser] [--json]
polymux auth logout [--local] [--json]
polymux auth status [--json]
```

## Configuration

```text
polymux config [--json]
polymux config list [--json]
polymux config get <key> [--json]
polymux config set <key> <value> [--json]
polymux config unset <key> [--json]
polymux config path [--json]
polymux config doctor [--json]
```

## Shell completion

```text
polymux completion <bash|zsh|fish>
polymux completion status [shell] [--json]
polymux completion install [shell] [--json]
polymux completion uninstall [shell] [--json]
```

## Version and updates

```text
polymux version [--json]
polymux update|upgrade
  [--yes] [--package-manager <npm|pnpm|yarn|bun>] [--json]
```

Without `--yes`, `update` checks for an available update. With `--yes`, it
changes the installed CLI.
