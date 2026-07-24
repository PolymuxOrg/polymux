# Changelog

Polymux releases follow semantic versioning. Published changes are recorded in GitHub Releases generated from `v*` tags.

## Unreleased

- Headless device authentication and protected credential storage
- Installation-aware `update` and `upgrade` commands
- Run inspection, diagnostics, reporting, configuration, and shell completion management
- Reliable activation of styled checkbox and radio controls through their visible labels
- Unified `*.flow.yaml` format and `polymux run` command for single- and
  multi-actor execution
- Flow-wide, environment-backed test access with an interactive setup wizard,
  automatic local secret loading, exact-origin browser credentials, fail-closed
  production safeguards, and redaction
- Provider-backed email inbox fixtures with deterministic mid-flow waiting,
  OTP and verification-link extraction, dynamic secret redaction, a built-in
  Mailpit adapter, and a language-neutral receive protocol
- Opt-in SMS verification with `receiveSms`, phone fixtures, deterministic OTP
  and link extraction, current-run message isolation, fail-closed number
  leasing, and a read-only built-in Twilio adapter
