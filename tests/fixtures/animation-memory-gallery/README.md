# Animation memory gallery

This fixture proves that a final screenshot is not enough to validate an animation. Each of three animations has two flows:

- `final frame only` remembers the completed state.
- `timeline memory` remembers the synchronized midpoint and completed state.

The broken variant introduces a temporary overlap, double-exposure, or clipping/path defect at the midpoint, then arrives at exactly the same final frame. Consequently, final-only checks pass while timeline checks correctly fail.

Run the benchmark from the repository root:

```sh
npm run test:animation-memory
```

The deterministic clock sequence is `install`, `pause`, then explicit `advance` calls. Installing the clock without pausing it allows screenshot latency to move the page beyond the intended frame.
