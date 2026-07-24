# Flows

A flow is the only executable definition in Polymux. A simple flow contains
steps and runs in one isolated browser or device session:

```yaml
# checkout.flow.yaml
version: 1
name: Checkout
steps:
  - navigate: /checkout
  - activate: Place order
  - expect: { text: Confirmed }
```

Setup, main execution, and teardown all accept the same steps:

```yaml
version: 1
name: Checkout
setup:
  - launch: { clearState: true }
  - flow: shared/login.flow.yaml
steps:
  - activate: Place order
  - expect: { text: Confirmed }
teardown:
  - flow: shared/delete-order.flow.yaml
  - terminate: true
```

Referenced paths are relative to the calling flow. Subflows reuse the caller's
session, actor context, fixtures, and message values. Their own setup and
teardown sections are respected, and circular references fail compilation.
Teardown is attempted after setup begins even when setup or main steps fail.
If teardown also fails, both failures remain in the report and the original
failure remains the primary run status.

A coordinated flow contains one or more named actors. Each actor references
another flow and receives an isolated session:

```yaml
# purchase.flow.yaml
version: 1
name: Purchase approval
actors:
  buyer: buyer.flow.yaml
  seller: seller.flow.yaml
```

Actors can coordinate with durable named signals:

```yaml
# buyer.flow.yaml
version: 1
name: Buyer
steps:
  - navigate: /checkout
  - activate: Place order
  - signal: order-created
  - waitForSignal:
      name: order-approved
      timeoutMs: 15000
  - expect: { text: Approved }
```

```yaml
# seller.flow.yaml
version: 1
name: Seller
steps:
  - waitForSignal: order-created
  - navigate: /orders
  - activate: Approve
  - signal: order-approved
```

Run one named flow or every root flow:

```bash
polymux run purchase
polymux run
```

When a coordinated flow references actor flows, a bare `polymux run` executes
them through the parent rather than launching them again independently.

Directories under `polymux/` are zero-configuration collections:

```text
polymux/
  smoke/
    login.flow.yaml
    checkout.flow.yaml
```

Use the directory name anywhere a flow selector is accepted:

```bash
polymux run smoke
polymux build smoke
polymux dev smoke
```

Polymux discovers every root flow below that directory recursively. No entry in
`polymux.yaml` is required. A flow and directory cannot share the same selector
name because that would be ambiguous.

Append selectors to combine any number of flows and directory collections:

```bash
polymux run smoke regression checkout
polymux build smoke regression
polymux dev smoke checkout
```

Selectors are expanded in argument order, then execution is scheduled
automatically. If collections overlap or an individual flow is also included by
a directory, Polymux runs it only once.

Tags provide cross-cutting selection without replacing directory structure:

```yaml
version: 1
name: Checkout
tags: [smoke, critical]
steps:
  - navigate: /checkout
  - expect: { text: Checkout }
```

```bash
polymux run --include-tags smoke
polymux run checkout --include-tags critical
polymux run --exclude-tags slow
```

Include filters match any listed tag. Exclude filters take precedence. Tags use
lowercase letters, numbers, and hyphens.

Temporarily document a confirmed broken root flow with `knownFailure`:

```yaml
knownFailure:
  reason: Checkout confirmation regressed after the payment redesign
  expires: 2026-08-01
```

A failed known flow remains visible but does not fail the suite. Runtime or
infrastructure errors still fail. If the flow passes unexpectedly, the suite
fails until `knownFailure` is removed. Expired markers fail compilation. For a
coordinated flow, declare the marker on the parent rather than an actor.

Repeat either kind of flow with the same option:

```bash
polymux run purchase --repeat 10
```

Coordinated flows may provision accounts and application state through
[fixtures](./fixtures.md), or configure [test-only access](./protections.md)
before actors start. Polymux chooses bounded concurrency from available capacity
and accounts for every actor session. Snapshot updates serialize automatically.

Signals never cross repeated-flow boundaries. If one actor fails, dependent
actors are unblocked with a clear runtime failure. A coordinated flow writes one
aggregate report plus the normal immutable evidence for every actor.
