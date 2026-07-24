# UI regression gallery

A deterministic fixed/broken website pair used to exercise Polymux against 20 UI regressions.

Coverage includes CSS animations and transitions, overlays, accordions, carousels, toasts, loading states, drag and drop, responsive overflow, sticky positioning, keyboard focus, stacking contexts, themes, tables, filtering, forms, optimistic updates, tabs, virtual lists, charts, and command palettes.

Run the complete clean-versus-regressed benchmark from the repository root:

```sh
npm run test:ui-regressions
```

The test creates visual baselines in a temporary project, verifies all 20 fixed cases, then runs the same flows against the broken variant and requires all 20 regressions to be detected.

Regenerate the YAML flows after editing `scenarios.mjs`:

```sh
npm --prefix tests/fixtures/ui-regression-gallery run generate
```
