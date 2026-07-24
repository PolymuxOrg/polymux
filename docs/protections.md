# Test access for protected environments

Polymux does not integrate with, mutate, or maintain adapters for bot-protection
vendors. Instead, configure a test-only access rule once in the staging
application or edge layer, then let Polymux send its secret only to that exact
origin.

The simplest setup is the interactive wizard:

```bash
polymux access init
```

It updates the selected coordinated flow, generates the secret, stores it in
ignored local project state for automatic reruns, and prints the values needed
for CI and the one-time application or edge rule. Use `polymux access init
--help` for non-interactive flags.

```yaml
version: 1
name: Protected purchase

protections:
  staging:
    originFromEnv: POLYMUX_TEST_ORIGIN
    headersFromEnv:
      x-polymux-test-access: POLYMUX_TEST_ACCESS_TOKEN

actors:
  buyer: buyer.flow.yaml
  seller: seller.flow.yaml
```

When configuring another runner or CI secret store, use the values printed by
the wizard:

```bash
export POLYMUX_TEST_ENVIRONMENT=test
export POLYMUX_TEST_ORIGIN=https://staging.example.com
export POLYMUX_TEST_ACCESS_TOKEN=a-long-random-secret
```

The origin may also be written directly in the flow because it is not a
credential:

```yaml
protections:
  staging:
    origin: https://staging.example.com
    headersFromEnv:
      x-polymux-test-access: POLYMUX_TEST_ACCESS_TOKEN
```

Polymux fails before opening an actor session when the environment or secret is
missing. It refuses production-like environment names, requires HTTPS except
for local loopback, redacts header values from evidence, and applies headers
only to the declared origin, including its port. Cross-origin requests do not
receive them.

The configured origin remains available to each actor as
`${protections.staging.values.origin}`. The same access configuration is shared
by all actors in that coordinated flow.

## One-time application setup

The staging application, reverse proxy, or edge service must trust the header
only in a non-production environment. A typical rule is:

1. Read the expected secret from trusted server or edge configuration.
2. Compare it with the request header using a timing-safe comparison where
   applicable.
3. Skip only the application-owned test barrier needed for the flow.
4. Reject the mechanism entirely in production.

Keep the secret out of browser bundles, committed flow files, and result
artifacts. Rotate it using the normal secret-management process.

## Third-party services

Use each service's supported testing mechanism in the staging configuration:

- Cloudflare can use a one-time custom skip rule matching the test header and
  the required [supported skip options](https://developers.cloudflare.com/waf/custom-rules/skip/options/).
  Polymux does not create or delete that rule.
- Cloudflare Turnstile provides official
  [dummy test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
  for automated testing.
- Other bot and CAPTCHA products should use their official sandbox, test key,
  staging policy, or an application-owned test boundary.

This design does not attempt to evade protection on third-party or production
systems. If a vendor offers no legitimate testing control, Polymux does not try
to bypass it.

## Platform scope

Exact-origin header injection is currently supported by the web driver, so it
works for websites and Flutter web without an application SDK. Native Flutter,
iOS, and Android applications can use the same static secret through a test
build or test proxy, or use a dedicated test environment that needs no client
header. Those applications still do not need a Polymux vendor adapter.
