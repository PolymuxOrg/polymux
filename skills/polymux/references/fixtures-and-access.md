# Fixtures and protected access

## Fixtures

Fixtures provision accounts, inboxes, phone numbers, or application state for
coordinated actors and clean them up afterward.

```yaml
version: 1
name: Purchase approval

providers:
  application:
    command: [dart, run, tool/polymux_fixtures.dart]
    timeoutMs: 30000

fixtures:
  buyerAccount:
    provider: application
    type: account
    input: { role: buyer }

actors:
  buyer:
    flow: buyer.flow.yaml
    fixtures: { account: buyerAccount }
  seller: seller.flow.yaml
```

Consume values and secrets through placeholders:

```yaml
steps:
  - enter:
      target: { label: Email }
      value: ${fixtures.account.values.email}
  - enter:
      target: { label: Password }
      value: ${fixtures.account.secrets.password}
```

Providers may be commands, HTTP endpoints, or built-ins for Supabase, Firebase,
Auth0, Clerk, Mailpit, Twilio, and application-owned test challenges. Keep
administrative credentials in environment variables. Provider logs belong on
standard error; standard output is reserved for protocol messages.

Polymux attempts cleanup for resources already created when later setup or
execution fails. Do not treat this as permission to point fixture providers at
production tenants.

## Email verification

Use an `inbox` fixture and `receiveEmail` when the requested behavior must test
real message delivery rather than create an already-confirmed account:

```yaml
# Parent flow
providers:
  mail:
    builtin: mailpit
    config: { url: http://127.0.0.1:8025 }
fixtures:
  signupInbox: { provider: mail, type: inbox }
actors:
  user:
    flow: signup.flow.yaml
    fixtures: { inbox: signupInbox }
```

```yaml
# Actor flow
steps:
  - enter:
      target: { label: Email }
      value: ${fixtures.inbox.values.address}
  - activate: Create account
  - receiveEmail:
      fixture: inbox
      saveAs: verification
      timeoutMs: 60000
      match: { subject: Verify }
      extract: [otp, link]
  - enter:
      target: { label: Code }
      value: ${messages.verification.secrets.otp}
```

Use `${messages.<saveAs>.secrets.link}` for invitations, magic links, and
password resets. Matching and extraction are deterministic and fail on
ambiguity. Keep inboxes test-only; raw bodies and extracted values are omitted
from ordinary results, but UI screenshots can still contain values rendered by
the application.

## SMS verification

Use a `phone` fixture and `receiveSms` with a pre-provisioned Twilio number:

```yaml
# Parent flow
providers:
  sms: { builtin: twilio }
fixtures:
  projectPhone: { provider: sms, type: phone }
actors:
  user:
    flow: signup.flow.yaml
    fixtures: { phone: projectPhone }
```

```yaml
# Actor flow
steps:
  - enter:
      target: { label: Phone }
      value: ${fixtures.phone.values.number}
  - activate: Send code
  - receiveSms:
      fixture: phone
      saveAs: verification
      timeoutMs: 60000
      match: { body: sign-in }
      extract: otp
  - enter:
      target: { label: Code }
      value: ${messages.verification.secrets.otp}
```

Set `TWILIO_ACCOUNT_SID`, `TWILIO_PHONE_NUMBER`, and preferably
`TWILIO_API_KEY`/`TWILIO_API_KEY_SECRET`; `TWILIO_AUTH_TOKEN` is a local
fallback. Polymux validates and process-locally leases the existing number; it
never buys, releases, sends from, or reconfigures it. The built-in adapter is
rejected in cloud mode because distributed runners require a centrally leased
number pool.

## OAuth session testing

Do not automate a hosted Google or Okta login page for routine regression
tests. In a non-production build, use an application-owned endpoint that
atomically consumes a short-lived Polymux test challenge and creates the same
application session as the OAuth callback. Continue the flow against the real
authenticated UI. The endpoint must be absent in production, and the real
provider callback still needs a separate staging smoke test.

## Protected staging access

Set up an exact-origin, test-only access rule with:

```bash
polymux access init
```

For non-interactive setup:

```bash
polymux access init \
  --flow purchase \
  --origin https://staging.example.com \
  --environment test \
  --header x-polymux-test-access \
  --token-env POLYMUX_TEST_ACCESS_TOKEN \
  --json
```

The wizard updates the selected coordinated flow, creates a secret in ignored
local project state, and prints values needed for CI and one-time server or edge
configuration.

The resulting flow uses environment-backed headers:

```yaml
protections:
  staging:
    origin: https://staging.example.com
    headersFromEnv:
      x-polymux-test-access: POLYMUX_TEST_ACCESS_TOKEN
```

Polymux sends the secret only to the declared origin and redacts it from
evidence. It rejects production-like environment names and non-HTTPS origins
except local loopback.

## Boundaries

- Configure only an application-owned staging or test boundary.
- Never use protected access to evade third-party or production controls.
- Prefer a vendor's official sandbox, test key, or staging policy.
- Keep secrets out of flow files, browser bundles, source control, and run
  artifacts.
- Exact-origin header injection is currently a web capability. Native apps need
  a test build, test proxy, or dedicated environment.
