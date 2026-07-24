---
name: polymux
description: Author, validate, run, inspect, and repair deterministic Polymux UI flows with the polymux CLI. Use for *.flow.yaml files, polymux.yaml, web or native UI regression flows, coordinated actors, crawl candidates, visual baselines, test fixtures, protected staging access, and evidence under .polymux. Normal execution must remain model-free.
---

# Polymux CLI

Polymux executes declarative UI flows deterministically. Use model reasoning to
author or repair flow source, never as part of normal flow execution.

## Resolve the CLI

Prefer an existing installation. Do not install or update packages unless the
user asks.

```bash
polymux --version
npx --no-install polymux --version
```

Inside the Polymux source repository, use:

```bash
npm run polymux -- --version
```

Use the same resolved command form consistently for the rest of the task.

## Quick start

Initialize only when the project has no Polymux setup:

```bash
polymux init
```

Validate before execution, then run the narrowest relevant selector:

```bash
polymux build checkout
polymux run checkout --json --junit .polymux/junit.xml
```

Inspect the resulting run without reading every artifact:

```bash
polymux runs --limit 5
polymux runs show <run-id> --json
polymux diagnose <run-id>
```

## Operating workflow

1. Locate `polymux.yaml` and the relevant `polymux/**/*.flow.yaml` files.
2. Preserve the project's existing naming, collections, setup commands, URLs,
   and platform defaults.
3. Build the smallest relevant selector before running it.
4. Run headlessly by default and request JSON when structured output helps.
5. Use the run result to identify the first meaningful failed step.
6. Inspect only the evidence needed for that failure.
7. Repair source flows, application code, or test setup. Never edit generated
   files under `.polymux/build` or immutable run evidence.
8. Rebuild and rerun the narrow selector. Expand coverage only after it passes.

Selectors may be flow names, paths, or directory collections:

```bash
polymux build smoke checkout
polymux run smoke checkout
polymux dev smoke --command "npm run dev"
```

Overlapping selectors are deduplicated. A bare `polymux run` runs every root
flow, so avoid it when a narrower selector answers the task.

## Common commands

```bash
polymux doctor --json
polymux build [selectors...] --json
polymux run [selectors...] --json
polymux run checkout --platform web --browser webkit
polymux run checkout --repeat 10
polymux run --include-tags smoke --junit .polymux/junit.xml
polymux devices --platform ios --json
polymux dev [selectors...] --command "npm run dev"
polymux crawl --url https://staging.example.com --json
polymux runs --json
polymux runs show <run-id> --json
polymux diagnose <run-id>
polymux report <run-id>
```

Read [references/cli.md](references/cli.md) when selecting command flags or
working with auth, configuration, completion, updates, or remote runs.

## Evidence and repair

Each run writes immutable evidence beneath `.polymux/runs/<run-id>/`, including
`results.json`, `report.html`, and step artifacts. Prefer `runs show` for
structured inspection and `diagnose` for a sanitized, shareable summary.

Read [references/runs-and-repair.md](references/runs-and-repair.md) when a run
fails, evidence must be inspected, or a diagnostic/report is requested.

## Guardrails

- Treat `--update-snapshots` as baseline approval, not ordinary repair. Use it
  only when the user intends to create or replace visual baselines.
- Treat crawl output as staged candidates. Review and validate candidates
  before moving anything under `polymux/`.
- Run `polymux runs clean` first as a dry run. Add `--yes` only with explicit
  deletion intent.
- Use `report --submit`, `update --yes`, `auth logout`, completion
  installation, and configuration mutations only when the task requests that
  state change.
- Default to headless execution. Use `--headed` only when visible execution is
  explicitly useful to the user.
- Never configure protected access against production or attempt to bypass
  third-party security controls.
- Keep credentials in environment variables or supported credential storage,
  never in flow source or committed artifacts.

## Specialized references

- Read [references/flow-authoring.md](references/flow-authoring.md) to create or
  modify flows, targets, assertions, visual checks, or coordinated actors.
- Read [references/platforms.md](references/platforms.md) for browser, device,
  Linux, or Appium execution.
- Read [references/crawl.md](references/crawl.md) for discovery and candidate
  review.
- Read
  [references/fixtures-and-access.md](references/fixtures-and-access.md) for
  disposable identities, coordinated setup, or protected staging access.
