# Fixtures, identities, and test challenges

Flow fixtures provision accounts, inboxes, phone numbers, and other test state
before actors start. Inbox and phone fixtures can also receive messages while
an actor is running. Providers are language-neutral: they are either an
executable that exchanges newline-delimited JSON on standard input/output, an
HTTP endpoint, or a built-in Polymux provider. Provider logs must use standard
error.

## Flow configuration

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
    input:
      role: buyer

actors:
  buyer:
    flow: buyer.flow.yaml
    fixtures:
      account: buyerAccount
  seller: seller.flow.yaml
```

The provider receives `health`, `create`, `receive`, and `destroy` messages. A
successful create response returns an opaque cleanup handle plus optional
values, secrets, and authentication data. `receive` is sent for an inbox used
by `receiveEmail` or a phone used by `receiveSms`. Polymux always attempts to
destroy resources already created when later provisioning or execution fails.

Flow source can consume fixture data:

```yaml
steps:
  - enter:
      target: { label: Email }
      value: ${fixtures.account.values.email}
  - enter:
      target: { label: Password }
      value: ${fixtures.account.secrets.password}
```

Exact placeholders preserve JSON types. Placeholders embedded inside text must
resolve to a string, number, or boolean. Secrets and authentication payloads are
available during execution but excluded from flow results and redacted from
runtime messages.

## Command providers

Any executable may implement the protocol. This minimal Dart shape requires no
Polymux package:

```dart
import 'dart:async';
import 'dart:convert';
import 'dart:io';

Future<void> main() async {
  await for (final line in stdin
      .transform(utf8.decoder)
      .transform(const LineSplitter())) {
    final request = jsonDecode(line) as Map<String, dynamic>;
    final method = request['method'];
    final response = <String, dynamic>{
      'protocol': request['protocol'],
      'id': request['id'],
      'ok': true,
    };

    if (method == 'create') {
      final user = await createTestUser(request['input']);
      response['result'] = {
        'handle': user.id,
        'values': {'email': user.email},
        'secrets': {'password': user.password},
      };
    } else if (method == 'destroy') {
      await deleteTestUser(request['handle']);
    }

    stdout.writeln(jsonEncode(response));
  }
}
```

The same loop can be implemented with Python, Go, Java, .NET, Rust, PHP, or any
other language that can read and write JSON. The normative contract is
[`fixture-v1.schema.json`](../packages/protocol/schemas/fixture-v1.schema.json).
`polymux init` installs the same schema at
`.polymux/schema/fixture-v1.schema.json` for offline tooling.

## HTTP providers

HTTP providers receive the same JSON request as a `POST` and must echo the
request `id` in their JSON response:

```yaml
providers:
  application:
    http:
      url: https://staging.example.com/__test/fixtures
      headersFromEnv:
        authorization: POLYMUX_FIXTURE_AUTHORIZATION
```

Sensitive headers are read from environment variables rather than stored in
flow source.

## Built-in account providers

Polymux can provision disposable `account` fixtures directly in Supabase,
Firebase, Auth0, and Clerk. Flows remain portable YAML; administrative
credentials stay in the runner environment and are never written to result
artifacts.

### Supabase

```yaml
providers:
  auth:
    builtin: supabase
    config:
      urlFromEnv: SUPABASE_URL
      serviceRoleKeyFromEnv: SUPABASE_SERVICE_ROLE_KEY
```

The environment-variable names shown above are the defaults. The provider uses
Supabase Auth's server-side admin API. It generates an email and password unless
the fixture supplies them, confirms email by default, and accepts
`emailConfirmed`, `phone`, `phoneConfirmed`, `userMetadata`, and `appMetadata`.
The service-role key must only be available to the runner, never application
client code.

### Firebase Authentication

```yaml
providers:
  auth:
    builtin: firebase
    config:
      projectIdFromEnv: FIREBASE_PROJECT_ID
      serviceAccountJsonFromEnv: FIREBASE_SERVICE_ACCOUNT_JSON
      createCustomToken: false
```

`FIREBASE_SERVICE_ACCOUNT_JSON` may contain a service-account JSON object. When
it is absent, the Firebase Admin SDK uses Application Default Credentials. The
provider accepts `uid`, `emailVerified`, `phoneNumber`, `displayName`,
`photoURL`, `disabled`, and `customClaims`.

Email/password login is the default and does not require token-signing
permission. Set `createCustomToken: true` only when the actor will call a
Firebase client SDK's custom-token sign-in method. The token is then available
at `${fixtures.account.auth.customToken}`. Local Application Default
Credentials may need extra service-account token-signing permission; a service
account JSON credential can sign locally.

### Auth0

```yaml
providers:
  auth:
    builtin: auth0
    config:
      domainFromEnv: AUTH0_DOMAIN
      connection: Username-Password-Authentication
      clientIdFromEnv: AUTH0_CLIENT_ID
      clientSecretFromEnv: AUTH0_CLIENT_SECRET
```

Alternatively set `AUTH0_MANAGEMENT_TOKEN`. The machine-to-machine application
needs the `create:users` and `delete:users` scopes. Fixture input supports
`connection`, email and phone verification state, blocked state, names,
username, picture, user ID, `userMetadata`, and `appMetadata`.

### Clerk

```yaml
providers:
  auth:
    builtin: clerk
    config:
      secretKeyFromEnv: CLERK_SECRET_KEY
```

The provider calls Clerk's Backend API. Fixture input supports `firstName`,
`lastName`, `username`, `phoneNumbers`, `externalId`, locale, legal-acceptance
time, locked/banned state, and public/private/unsafe metadata. Clerk instance
settings determine which identity fields are required.

Every built-in account provider returns `values.email`, a generated password in
`secrets.password`, and login data under `auth`. Each account is deleted during
flow cleanup, including rollback after partial provisioning failure.
`emailDomain` can be configured when a provider or application rejects the
default `example.test` addresses.

Provider configuration and account input reject unknown keys so a spelling
mistake cannot be silently ignored.

## Email verification

Polymux can allocate an inbox, wait for a matching email during the flow,
deterministically extract an OTP or verification link, and make that value
available to later steps. Normal runs do not use a model for message matching
or extraction.

For local development, point the application SMTP configuration at
[Mailpit](https://mailpit.axllent.org/) and use the built-in provider:

```yaml
# signup-with-email.flow.yaml
version: 1
name: Signup with email verification

providers:
  mail:
    builtin: mailpit
    config:
      url: http://127.0.0.1:8025
      emailDomain: mailpit.test

fixtures:
  signupInbox:
    provider: mail
    type: inbox

actors:
  user:
    flow: signup.flow.yaml
    fixtures:
      inbox: signupInbox
```

The actor flow consumes the allocated address, waits after triggering the
message, and uses the extracted secret:

```yaml
# signup.flow.yaml
version: 1
name: Verified signup
steps:
  - enter:
      target: { label: Email }
      value: ${fixtures.inbox.values.address}
  - activate: Create account
  - receiveEmail:
      fixture: inbox
      saveAs: verification
      timeoutMs: 60000
      match:
        from: no-reply@example.test
        subject: Verify your account
      extract: [otp, link]
  - enter:
      target: { label: Verification code }
      value: ${messages.verification.secrets.otp}
```

`match.from` and `match.subject` are optional case-insensitive substring
filters. `extract` accepts `otp`, `link`, or both. Extraction fails closed when
there is no candidate or when multiple candidates are equally likely. Extracted
values are available under
`${messages.<saveAs>.secrets.otp}` and
`${messages.<saveAs>.secrets.link}`. Non-secret message metadata is available
under `values.id`, `values.from`, `values.subject`, and `values.receivedAt`.

The Mailpit provider generates a unique address for every fixture instance. Its
API URL defaults to `http://127.0.0.1:8025` and can instead come from
`MAILPIT_API_URL`. Optional HTTP Basic Authentication uses `MAILPIT_USERNAME`
and `MAILPIT_PASSWORD`. `urlFromEnv`, `usernameFromEnv`, and
`passwordFromEnv` can rename those environment variables. `pollIntervalMs` and
`maxMessageBytes` bound polling and message size.

### Custom and managed inbox providers

Command and HTTP providers use the same fixture protocol. On `create`, an
`inbox` provider returns its opaque handle and `values.address`. On `receive`,
it waits for the next unconsumed message matching `input.match`, then returns
the same handle with:

```json
{
  "values": {
    "id": "provider-message-id",
    "from": "no-reply@example.test",
    "subject": "Verify your account",
    "receivedAt": "2026-07-23T12:00:00Z"
  },
  "secrets": {
    "text": "Plain-text body",
    "html": "<p>HTML body</p>"
  }
}
```

At least one of `secrets.text` or `secrets.html` is required. Providers must
scope messages to the fixture handle, ignore mail received before allocation,
and consume each selected message at most once. Raw message bodies and
extracted values are excluded from results and runtime events; extracted values
are also added to text redaction. Polymux disables its browser trace for
message-receiving flows, but explicit screenshots can still contain values
rendered by the application. Use test-only inboxes and short-lived codes.

## SMS verification

The opt-in Twilio adapter leases one pre-provisioned number to one active local
run, waits for a new inbound message, deterministically extracts an OTP or
verification link, and continues the actor flow. It never buys, releases,
reconfigures, sends from, or deletes messages for the number.

```yaml
# signup-with-sms.flow.yaml
version: 1
name: Signup with SMS verification

providers:
  sms:
    builtin: twilio

fixtures:
  projectPhone:
    provider: sms
    type: phone

actors:
  user:
    flow: signup.flow.yaml
    fixtures:
      phone: projectPhone
```

The actor receives the configured E.164 number as
`${fixtures.phone.values.number}`:

```yaml
# signup.flow.yaml
version: 1
name: SMS signup
steps:
  - enter:
      target: { label: Phone }
      value: ${fixtures.phone.values.number}
  - activate: Send code
  - receiveSms:
      fixture: phone
      saveAs: verification
      timeoutMs: 60000
      match:
        from: "+15550001111"
        body: sign-in
      extract: otp
  - enter:
      target: { label: Verification code }
      value: ${messages.verification.secrets.otp}
```

`match.from` and `match.body` are optional case-insensitive substring filters.
`extract` accepts `otp`, `link`, or both, using the same deterministic,
ambiguity-rejecting extraction as email. Metadata is available under
`values.id`, `values.from`, `values.to`, and `values.receivedAt`; extracted
values use `${messages.<saveAs>.secrets.otp}` and
`${messages.<saveAs>.secrets.link}`.

Set `TWILIO_ACCOUNT_SID`, `TWILIO_PHONE_NUMBER`, and the recommended
`TWILIO_API_KEY` plus `TWILIO_API_KEY_SECRET`. Use a dedicated restricted key
limited to reading active numbers and messages. `TWILIO_AUTH_TOKEN` is
supported as a local fallback when API-key variables are absent. The
corresponding `*FromEnv` config options can rename these environment variables.
`pollIntervalMs` and `maxMessageBytes` bound polling and message size. Outside
explicit loopback testing, the adapter sends credentials only to Twilio API
hosts. It verifies that the number belongs to the account and confirms it can
receive SMS before the flow starts.

At allocation, the adapter snapshots existing message IDs. It then accepts
only inbound messages to that exact number whose provider timestamp belongs to
the current allocation, and consumes each selected ID once. A number is leased
to only one active run in a runner process; a second concurrent run fails
closed instead of risking the wrong OTP.

The built-in adapter is intentionally rejected in Polymux cloud execution
because a process-local lease cannot coordinate multiple runners. Distributed
execution needs a managed provider with a central number pool and durable
per-run leases. Command and HTTP providers can implement the same `phone`
fixture protocol for local or self-hosted execution: `create` returns
`values.number`, and `receive` returns the same handle with:

```json
{
  "values": {
    "id": "provider-message-id",
    "from": "+15550001111",
    "to": "+15550002222",
    "receivedAt": "2026-07-23T12:00:00Z"
  },
  "secrets": {
    "body": "Your sign-in code is 593821"
  }
}
```

Providers must isolate messages to the current fixture handle, ignore messages
received before allocation, and consume each selected message at most once.
Raw bodies and extracted values receive the same result exclusion, trace
suppression, and text redaction as email.

## Protected test environments

Bot-protection access is deliberately separate from fixture providers. A
coordinated flow declares an exact origin and environment-backed headers;
Polymux makes no vendor API calls and needs no vendor adapter. See
[test access for protected environments](./protections.md).

## Live account-provider smoke tests

The ordinary suite uses exact HTTP contract servers and the real Firebase Admin
SDK request/token paths, but does not mutate cloud tenants. An explicitly gated
smoke suite can create and delete one user in a test tenant:

```bash
POLYMUX_LIVE_AUTH_PROVIDER=supabase \
POLYMUX_LIVE_AUTH_CONFIRM=delete-test-accounts \
npm run test:providers:live
```

Select `supabase`, `firebase`, `auth0`, or `clerk` and set that provider's normal
environment variables. Auth0 additionally needs
`POLYMUX_LIVE_AUTH0_CONNECTION`. Use only a disposable development tenant; the
confirmation value exists to prevent accidental cloud mutations.

## Authentication payloads

Providers can return credentials under `secrets`, or an arbitrary `auth` JSON
payload containing tokens, cookies, deep links, or application-specific session
data. Web actors may resolve fixture values into actor `headers`. Mobile and
desktop flows can resolve them into launch inputs, deep links, or ordinary
login steps supported by the application.

This separation keeps account provisioning independent from Flutter, React,
native mobile, desktop, and backend language choices.

## Test challenges

The built-in challenge provider creates short-lived HS256 JWT assertions for
application-owned test gates:

```yaml
providers:
  testGate: { builtin: challenge }

fixtures:
  captcha:
    provider: testGate
    type: challenge
    input:
      audience: checkout-api
      action: submit-order
      ttlSeconds: 60

actors:
  buyer:
    flow: buyer.flow.yaml
    fixtures: { challenge: captcha }
    headers:
      x-polymux-test-assertion: ${fixtures.challenge.secrets.assertion}
```

Set a random `POLYMUX_TEST_CHALLENGE_SECRET` of at least 32 characters in both
the runner and the server-side verifier. Set `POLYMUX_TEST_ENVIRONMENT` to a
non-production environment name. Assertions contain issuer, audience, action,
actor, flow run, instance, environment, issued-at, expiry, and nonce claims.

Application verification must:

1. Reject the feature in production from trusted server configuration.
2. Verify the HS256 signature and exact audience, action, and environment.
3. Reject expired or future assertions.
4. Atomically consume the `jti` once in a shared database or cache.
5. Never place the shared secret in browser, Flutter, or other client code.

The assertion bypasses only the application's test integration boundary. It
does not automate or attack a CAPTCHA, payment, identity, or other third-party
service.

For OAuth flows, use that boundary to test the application session instead of
automating Google, Okta, or another hosted login page. A test-only server
endpoint can consume an assertion whose action is `bootstrap-session`, create
the same application session the OAuth callback would create, and return its
normal secure session cookie. The flow then exercises authenticated pages in a
real browser. Keep the endpoint absent (preferably a 404) in production; do not
accept a static bypass header or put the challenge secret in client code. This
tests the application's post-OAuth behavior, while provider configuration and
the real callback still need a separate staging smoke test.

Node server applications may use the optional reference verifier:

```ts
import { verifyPolymuxTestChallenge } from "@polymux/test-gates";

const claims = await verifyPolymuxTestChallenge(assertion, {
  secret: process.env.POLYMUX_TEST_CHALLENGE_SECRET!,
  audience: "checkout-api",
  action: "submit-order",
  environment: trustedServerEnvironment,
  consumeJti: (jti, expiresAt) => nonceStore.consume(jti, expiresAt),
});
```

Other languages verify the same standard HS256 JWT contract directly; they do
not need this package.
