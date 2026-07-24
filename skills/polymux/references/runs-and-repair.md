# Runs and repair

## Inspect efficiently

Start with the run index, then inspect one run:

```bash
polymux runs --limit 10 --json
polymux runs show <run-id> --json
```

Remote evidence is opt-in:

```bash
polymux runs --remote --json
polymux runs show <run-id> --remote --json
```

Each local run is stored beneath `.polymux/runs/<run-id>/`. The immutable
evidence includes:

- `results.json` for the complete structured result;
- `report.html` for human review;
- screenshots, visual diffs, video, and other step artifacts when produced.

Export CI-native results while running:

```bash
polymux run smoke --junit .polymux/junit.xml
```

Expected known failures are emitted as skipped JUnit cases. Unexpected passes,
ordinary failures, and runtime errors remain blocking.

Do not read every artifact by default. Identify the first failed or blocked
step, then inspect its message and directly related artifacts.

## Repair loop

1. Confirm the failed flow, platform, step kind, and error category.
2. Separate setup failures from application regressions and flow defects.
3. Inspect the smallest relevant screenshot, diff, or message.
4. Repair the source of the failure.
5. Run `polymux build <selector> --json`.
6. Run `polymux run <selector> --json`.
7. Expand to the containing collection only after the focused run passes.

Common interpretations:

- Compile failure: correct flow syntax, selectors, references, or unsupported
  platform capabilities.
- Target not found: prefer a stable accessible target; do not add broad
  alternatives without evidence.
- Expectation failure: determine whether the application behavior or expected
  behavior is wrong before editing the assertion.
- Visual failure: inspect the diff and determine whether the change is intended.
  Do not update the baseline automatically.
- Setup/connection failure: run `polymux doctor --json` and verify the app
  server, browser, display, device, or Appium endpoint.
- Coordinated failure: inspect the originating actor before actors that were
  merely unblocked or timed out.

## Diagnostics and reports

Create a sanitized diagnostic:

```bash
polymux diagnose <run-id>
polymux diagnose <run-id> --output ./diagnostic.json --json
```

Diagnostics include run metadata, step outcomes, environment information, and
artifact paths. They exclude artifact contents and redact home paths, Polymux
tokens, bearer tokens, and sensitive URL parameters.

Prepare a local report:

```bash
polymux report <run-id> --message "Checkout fails after redirect"
```

Submitting is a separate external action:

```bash
polymux report <run-id> --message "Checkout fails after redirect" --submit
```

Use `--submit` only when the user explicitly requests submission.

## Cleanup

Preview old run deletion:

```bash
polymux runs clean --older-than 30 --json
```

Only after deletion is explicitly intended:

```bash
polymux runs clean --older-than 30 --yes --json
```
