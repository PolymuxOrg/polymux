# Crawl and candidate review

`polymux crawl` discovers web test candidates and reports coverage by already
approved flows. It does not approve discovered behavior.

```bash
polymux crawl --url https://staging.example.com --json
```

The URL resolves in this order:

1. `--url`;
2. `app.url` in `polymux.yaml`;
3. a unique `baseUrl` from existing flows.

Bound discovery when appropriate:

```bash
polymux crawl \
  --url https://staging.example.com \
  --browser chromium \
  --max-pages 20 \
  --max-depth 3 \
  --replays 2 \
  --timeout-ms 10000 \
  --json
```

Results are written beneath `.polymux/crawls/<crawl-id>/`. Eligible drafts are
staged under its `candidates/` directory. Actor-dependent discoveries may be
JSON records requiring explicit setup rather than directly executable flows.

## Review workflow

1. Inspect the crawl summary and uncovered routes.
2. Select only candidates relevant to the requested behavior.
3. Verify that repeated probes produced stable behavior.
4. Review navigation, actions, targets, assertions, and required setup.
5. Replace fragile targets with accessible, intentional locators.
6. Add an explicit expectation that expresses the behavior being protected.
7. For actor-dependent behavior, author the required fixture or coordinated
   actor setup.
8. Move or rewrite the reviewed candidate beneath `polymux/`.
9. Run `polymux build <selector> --json`.
10. Run the new flow and inspect its evidence before treating it as approved.

Never bulk-promote crawl output or silently modify existing approved flows from
a crawl result.
