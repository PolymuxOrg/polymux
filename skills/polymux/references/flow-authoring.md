# Flow authoring

Author flows as `*.flow.yaml` files beneath `polymux/`. Keep each flow focused
on one user-visible behavior.

## Single-actor flow

```yaml
version: 1
name: Checkout succeeds
description: A signed-in buyer can place an order.
platforms: [web]
baseUrl: https://staging.example.com
timeoutMs: 10000
tags: [smoke, checkout]

steps:
  - navigate: /checkout
  - enter:
      target: { label: Email }
      value: buyer@example.test
  - activate: { role: button, name: Place order }
  - expect: { target: { role: alert }, text: Confirmed }
  - screenshot: checkout-confirmed
```

`name` and at least one step are required. `platforms` defaults to `[web]` and
`timeoutMs` defaults to 10000.

Use directories for stable product structure and tags for cross-cutting
execution intent:

```bash
polymux run checkout --include-tags smoke
polymux run --exclude-tags slow
```

Include filters match any listed tag; exclusions take precedence.

## Known failures

Mark only a confirmed, temporary broken root flow:

```yaml
knownFailure:
  reason: Confirmation state regressed after the checkout redesign
  expires: 2026-08-01
```

The reason and expiry are required. An expected failure remains visible and is
non-blocking, an infrastructure error remains blocking, and an unexpected pass
fails until the marker is removed. Expired markers fail compilation. Put the
marker on a coordinated parent, never an actor flow.

## Targets

A target may be a string or an object using:

```yaml
role: button
name: Place order
label: Email
text: Confirmed
testId: checkout-submit
id: native-control-id
css: ".checkout > button"
accessibilityId: checkout-submit
image: fixtures/place-order.png
exact: true
alternatives:
  - { role: button, name: Place order }
  - { testId: checkout-submit }
```

Prefer stable user-facing accessibility locators in this order:

1. Role with accessible name, or label.
2. Test ID, native ID, or accessibility ID.
3. Stable visible text.
4. CSS only when no semantic locator exists.
5. Image matching only for interfaces without inspectable elements.

Use alternatives only for intentional cross-platform differences, not to hide
an unstable interface.

## Step catalog

| Area | Steps |
| --- | --- |
| Session | `launch`, `terminate`, `reset` |
| Navigation | `navigate`, `deepLink` |
| Interaction | `activate`, `focus`, `enter`, `select`, `clear`, `key` |
| Gestures | `pointer`, `scroll`, `swipe`, `drag`, `multiTouch` |
| Synchronization | `wait`, `stabilize` |
| Assertions | `expect`, `visual` |
| Evidence | `screenshot` |
| Network | `request`, `mock`, `unmock` |
| Time | `clock` |
| Coordination | `signal`, `waitForSignal`, `receiveEmail`, `receiveSms` |
| Native extensions | `platform` |

Common forms:

```yaml
steps:
  - launch: { app: com.example.app, clearState: true }
  - wait: { target: { role: progressbar }, state: hidden, timeoutMs: 5000 }
  - select: { target: { label: Country }, value: Singapore }
  - key: Enter
  - scroll: { target: { text: Terms }, y: 500 }
  - swipe: { direction: up, distance: 300 }
  - drag: { from: { id: item-a }, to: { id: item-c } }
  - expect:
      target: { role: alert }
      state: visible
      text: Saved
      timeoutMs: 3000
  - stabilize: { timeoutMs: 3000, intervalMs: 100 }
  - screenshot: saved-state
```

Use `wait` for a state transition, `expect` for behavior that determines
pass/fail, and `stabilize` before motion-sensitive visual evidence. Avoid fixed
numeric waits unless the behavior genuinely depends on elapsed time.

## Network and time

Web flows can use deterministic route mocks and controlled time:

```yaml
steps:
  - mock:
      url: "**/api/profile"
      response: { status: 200, json: { name: Test User } }
  - navigate: /profile
  - expect: { text: Test User }
  - unmock: "**/api/profile"
```

```yaml
steps:
  - clock: { action: install }
  - clock: { action: pause }
  - clock: { action: advance, ms: 5000 }
  - clock: { action: resume }
```

Native platforms do not provide portable route mocking or clock control.

## Visual checks

```yaml
steps:
  - stabilize: true
  - visual:
      name: checkout-card
      target: { css: ".checkout-card" }
      threshold: 0.005
```

Run with `--update-snapshots` only when creating or intentionally approving a
new baseline. A visual failure is not permission to replace the baseline.

## Coordinated actors

A parent flow gives every actor an isolated session:

```yaml
version: 1
name: Purchase approval
actors:
  buyer: buyer.flow.yaml
  seller: seller.flow.yaml
```

Coordinate through durable named signals:

```yaml
# buyer.flow.yaml
version: 1
name: Buyer
steps:
  - activate: Place order
  - signal: order-created
  - waitForSignal: { name: order-approved, timeoutMs: 15000 }
  - expect: { text: Approved }
```

```yaml
# seller.flow.yaml
version: 1
name: Seller
steps:
  - waitForSignal: order-created
  - activate: Approve
  - signal: order-approved
```

Signals never cross repeated-flow boundaries. If one actor fails, dependent
actors are unblocked with a runtime failure.

## Validate

After every flow edit:

```bash
polymux build <selector> --json
```

Treat compile errors as source errors. Do not edit compiled plans beneath
`.polymux/build`.
