<h1 align="center">
  <img src=".github/assets/polymux-lockup.svg" alt="Polymux" width="300" />
</h1>

<p align="center"><strong>Deterministic UI testing across every platform.</strong></p>

<p align="center">Agent-assisted authoring. Model-free execution.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/polymux"><img src="https://img.shields.io/npm/v/polymux.svg" alt="npm version" /></a>&nbsp;&nbsp;
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 license" /></a>&nbsp;&nbsp;
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933.svg" alt="Node.js 22 or newer" />
</p>

<p align="center">
  <a href="https://polymux.com/docs">Documentation</a>
  ·
  <a href="#quick-setup">Getting started</a>
  ·
  <a href="https://www.polymux.com/">Polymux Cloud</a>
</p>

## Iterate without fear of regressions

Polymux is an end-to-end UI testing framework that turns real user journeys—
clicking, typing, navigating, and checking what appears—into reusable flows.
Run them continuously while you build to catch regressions early, in CI before
you ship, or across local and cloud devices.

Coding agents can help create and repair flows, then Polymux compiles them
into deterministic tests. Every normal run is fast and reproducible.

- **Deterministic by default** — the same flow follows the same compiled
  execution plan on every run.
- **Lower testing costs** — use an agent to create or repair a test once, then
  rerun it without paying for model calls.
- **Visual and motion coverage** — compare screenshots, control time, and wait
  for stable frames to test animation states and visually driven behaviour.
- **Fast regression feedback** — rerun relevant journeys as the application
  changes and get concise failures with detailed evidence.
- **Cross-platform flows** — describe a user journey once and run it across
  supported browsers, devices, and desktop platforms.
- **Multi-actor flows** — coordinate isolated user roles with automatic test
  accounts, exact-origin test access, reproducible hand-offs, and bounded
  concurrency.
- **Email and SMS verification flows** — wait on provider-backed inboxes or a
  leased test number, extract OTPs or verification links deterministically,
  and continue the same test without mailbox-specific browser automation.

See the [documentation](https://polymux.com/docs) to get started.

## What this repository contains

- **CLI** — the primary developer interface for creating, running, and watching
  tests, with installable skills that teach coding agents how to use Polymux.
- **MCP** — a tighter integration for agents to build, run, inspect, and repair
  tests during development.
- **Studio** — the Polymux UI. Launch it locally from the CLI, install the
  desktop app, or use it on the web for visual test authoring, reports, and
  cloud execution. Learn more at [www.polymux.com](https://www.polymux.com/).

## Quick setup

Requires Node.js 22 or newer:

```bash
npm install -g polymux
polymux init
```

Continue with the [documentation](https://polymux.com/docs) to create and run
your first flow.

Prefer a graphical interface? [Download Polymux](https://www.polymux.com/downloads)
for desktop or use [Polymux Cloud](https://www.polymux.com/).

## Platform support

| Target | Backend | Requirements |
| --- | --- | --- |
| Web — Chromium, Firefox, WebKit | Built-in Playwright adapter | Install the selected browser engines |
| Linux desktop | Built-in AT-SPI adapter | Run inside an active graphical desktop session |
| iOS and iPadOS | Appium XCUITest | Appium host on macOS with a simulator or trusted device |
| Android | Appium UiAutomator2 | Appium host with an emulator or authorized device |
| macOS | Appium Mac2 | Appium host on macOS |
| Windows | Appium Windows or NovaWindows | Appium host on Windows |

Web and Linux use adapters included with Polymux. Other native targets connect
to a local or remote Appium server. The legacy Windows backend relies on
WinAppDriver; NovaWindows can be selected as a newer community replacement.

Run `polymux doctor` for a read-only setup report and exact install or uninstall
commands for every Appium driver compatible with the current machine.

See [platform setup](./docs/platforms.md) for prerequisites and exact capability
coverage. Cloud execution is not part of this repository yet.

## Telemetry

Polymux collects pseudonymous CLI usage and coarse unexpected-error categories
through PostHog. It never captures command arguments, exception messages,
stacks, flow contents, paths, URLs, artifacts, tokens, or diagnostic report
messages. Disable it with:

```bash
polymux config set telemetry.enabled false
```

See the [privacy policy](https://www.polymux.com/privacy) for the complete
collection and opt-out notice.

## Development

```bash
npm install
npx playwright install chromium firefox webkit
npm run check
npm test
npm run test:e2e
```

Repository layout:

```text
apps/       CLI, MCP, runner, and Studio interfaces
packages/   core, protocol, adapters, and shared libraries
skills/     installable coding-agent instructions
docs/       repository-level technical notes
```

Managed organisations, billing, authentication, scheduling, and cloud fleet
operations live in the separate private `PolymuxOrg/cloud` repository.

## License

Apache-2.0. See [LICENSE](./LICENSE).
