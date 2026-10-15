# Smart Color Groups implementation report

## Audit findings

The previous engine already shared DOM, computed-style, transform, geometry, serializer, and compatibility code with Maximum Fidelity. It canonicalized effective color values, isolated complex paint, and kept source paths separate. Its principal correctness gap was treating every positive-area bounding-box intersection as painted overlap. Eligibility also returned only a color or `null`, which made fallback decisions opaque.

Small Patch Cleanup was a separate resolver branch with dedicated thresholds, path-pruning helpers, fidelity losses, counters, response metadata, API options, UI controls, documentation, and tests.

## Files changed

- `lib/converter.js` — removed Small Patch execution and metadata; added explicit unsupported-engine errors, effective paint signatures, auditable eligibility, fallback reasons, topology-aware planning, sweep broad phase, graph metrics, and timing metadata.
- `lib/path-geometry.js` — added deterministic filled-path relationship classification for disjoint, touching, overlap, containment, inside, and unknown cases.
- `lib/api-http.js` — removed Small Patch query options and exposes the rejected engine ID.
- `api/v1/engines.js`, `api/health.js` — advertise only active engines and Smart Color Groups capabilities.
- `index.html`, `app.js` — removed Small Patch controls/results and expose topology/grouping diagnostics.
- `README.md` — documents the two-engine contract and migration behavior.
- `test/converter.test.js`, `test/api-handler.test.js` — removed Small Patch behavior tests and added paint, fallback, topology, touching, conflict, API, and compatibility regression coverage.
- `scripts/benchmark-color-groups.mjs` — reproducible 100/500/1000/3000-shape benchmark.

## Removed

- Small Patch engine and aliases;
- patch thresholds and GET parameters;
- micro-subpath pruning helpers and statistics;
- cleanup fidelity/report branches;
- API catalog and health entries;
- UI controls and result presentation;
- behavior tests and documentation.

## Smart Color Groups upgrade

- Effective paint continues to come from the shared cascade/inheritance resolver. Each candidate now records a paint signature separating paint type, canonical color, alpha, fill rule, gradient, stroke, clip, mask, filter, and blend mode.
- Eligibility returns deterministic reason codes. Only visible, fully opaque, solid, stroke-free, un-clipped, compositing-safe geometry enters color packing.
- A sweep-line broad phase avoids scanning unrelated x-ranges. Filled-path topology is the narrow phase; edge-only touching does not create a z-order dependency. Unknown geometry remains conservative.
- Source order creates directed constraints only for actual interaction or unknown relationships. A cyclic graph marks strict-one-color output non-exact.
- Source path nodes remain individual; no compound path merge is performed.

## Test results

- Maximum Fidelity regression: PASS
- Smart Color Groups paint/topology/z-order tests: PASS
- API and UI contract tests: PASS
- Alight compatibility validation: PASS
- Full suite: 40 passed, 0 failed

## Benchmark

Measured locally with Node.js using the same deterministic non-overlapping rectangle fixtures before and after the change. Times naturally vary between runs.

| Shapes | Before total | After total | After parse | After analysis | After planning | After serialize + validate |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 50.074 ms | 43.223 ms | 3.322 ms | 17.365 ms | 4.443 ms | 16.731 ms |
| 500 | 82.742 ms | 73.570 ms | 2.783 ms | 21.446 ms | 15.688 ms | 33.290 ms |
| 1000 | 169.340 ms | 106.592 ms | 4.506 ms | 35.811 ms | 17.308 ms | 48.605 ms |
| 3000 | 506.766 ms | 296.199 ms | 6.900 ms | 84.022 ms | 42.309 ms | 162.189 ms |

All four fixtures produced 10 color layers, zero missing shapes, and compatibility-valid XML. The fixtures contain separated islands, so the broad phase correctly produced zero topology candidates.

## Before vs after

| Metric | Before | After |
|---|---:|---:|
| Active engines | 3 | 2 |
| Grouping identity | canonical solid fill | effective paint signature |
| Broad phase | all source pairs + AABB final decision | x-sweep + AABB candidate |
| Narrow phase | none | filled-path topology |
| Touching distinction | no | yes |
| Hole false-positive regression | no | yes |
| Fallback reason histogram | no | yes |
| Z-order conflicts | reported | reported with topology evidence |
| Geometry merged | false | false |
| Compatibility | PASS | PASS |
| Missing shapes in benchmark | 0 | 0 |

## Known limitations

- Bézier topology uses deterministic curve flattening for analysis only. Original geometry is untouched, and uncertain relationships remain conservative.
- SVG filters, masks, markers, advanced radial focal points, non-pad gradient spread, and some stroke semantics still have no proven one-to-one Alight mapping; fidelity reporting remains authoritative.
- Strict-one-color intentionally reports A–B–A conflicts instead of splitting a color into multiple layers. A future fidelity-first split strategy can be added without changing the current default.
