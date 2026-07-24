# Polymux Documentation

See [releasing.md](./releasing.md) for the trusted-publisher release process.

## Repository structure

- `apps/` — executable surfaces and platform integration points.
  - `apps/cli` — command-line interface entrypoints.
  - `apps/runner` — workflow execution host.
  - `apps/mcp` — MCP integration layer.
  - `apps/action` — action-related command wiring.
  - `apps/studio` — optional UI surface.

- `packages/` — shared implementation and public APIs.
  - `packages/core` — orchestration, validation, execution, and report plumbing.
  - `packages/protocol` — serializable types/events/results used by tools.
  - `packages/adapters` — platform adapter implementations.
  - `packages/client` — developer-facing client utilities.
  - `packages/test-gates` — test and access guardrail utilities.

- `docs/` — design notes and reference docs.

- `tests/` — unit, integration, and E2E coverage.
  - `tests/fixtures/` for test data used by runtime and adapter suites.

- `scripts/` — repo workflows and maintenance helpers.
- `skills/` — agent skills for cli use.
