# Paint-aware native contour recovery

2026-10-30. Engine baseline: `bbe382ed4267a1c04d2bb9e9b29725ad03c962ab`.
Integration baseline: Nexora V1 `2f4af18ee847e0595176494a745c1282999c7a1b`.
Branch: `fix/native-contour-paint-degeneracy`. No merge or deployment performed.

## Evidence and acceptance limits

**The original `konzz.svg` was not attached or found in this workspace.** The
active attachment is a screenshot. Its path coordinates cannot be recovered
from that screenshot. Conversion, topology and visual fidelity of **the original
file remain BLOCKED**, including any additional error after the initial guard.
No fixture in this PR is represented as the original user file.

The reported shape counts were used to author a clearly named **synthetic**
regression: 639×641, 113 paths, 13 compound paths, path index 1 containing 72
subcontours, and deliberately zero-paint contours 33 and 51. Their coordinates,
colors beyond the reported fill, and arrangement were authored for testing.
Do not use this fixture's successful conversion as proof about `konzz.svg`.

## Root cause and before/after

`nativeContourPlan()` previously polygon-sampled each cubic at 12 steps and
rejected the entire compound when any sampled signed area was below `1e-7`.
That conflated three different cases:

1. A closed line/point or exactly retraced curve, with no fill contribution.
2. A tiny valid nonzero filled area, or cancellation in a translated polygon sum.
3. A possibly painted self-intersecting contour whose signed areas cancel.

Before the fix, local minimal reproducers for collinear cubic, retraced cubic,
tiny positive area and bow-tie all returned `NATIVE_CONTOUR_DEGENERATE`.
Afterwards, the first two are safely omitted from fill-only compounds, the tiny
contour is retained, and the ambiguous compound remains explicitly unsupported.
This fixes engine logic rather than suppressing an error message or adding a
fallback provider/rendering mode.

## Mathematical proof and preserved contracts

`lib/contour-paint.js` decodes each **finite IEEE-754 coordinate** as an integer
times a power of two. Integer arithmetic evaluates the cubic Green integral
`A = 1/2 ∮(x dy − y dx)`, including the implicit SVG closing edge. Translating
coefficients to the subpath origin avoids large-origin cancellation. The sign
test is exact for the parsed coordinates, without modifying EPS.

Zero signed area is **not** an empty-paint proof. Removal requires one of:

- Every endpoint and cubic control point lies exactly on one supporting line
  (or the curve is a point). The complete Bézier control hull has no interior.
- Every directed nonconstant line/cubic edge is matched by its identical reverse,
  including reversed cubic controls and the implicit closing line. Winding is
  zero off the boundary; its parity is also zero.

These are conservative sufficient proofs under both SVG fill rules. An equivalent
curve encoded with a different subdivision is not assumed identical. Unproved
zero-area compounds return `NATIVE_CONTOUR_ZERO_AREA_PAINT_UNRESOLVED`, rather
than losing possible painted lobes. This PR is not a general self-intersection or
Boolean-path solver. Existing overlap/touch/budget failures remain fail-closed.

Stroke-only and mixed fill/stroke paths keep all stroked contours. Proven
zero-fill contours are excluded from fill-topology calculations without changing
their stroke geometry. Existing mixed open-fill/stroke closure restrictions remain
for compounds with actual fill. Fully zero-paint shapes retain their real original
geometry because the native XML grammar requires a nonempty path; no placeholder
or fake contour is generated.

A zero-fill contour may still influence an objectBoundingBox gradient. The
converter therefore requests `preserveFillBounds` for gradient paint: the real
contour stays in XML, while only its zero winding is excluded from topology
classification. A regression renders an outlying zero-area subpath whose bounds
affect the colors of a visible filled rectangle; removing it would stretch the
gradient incorrectly. All three engines preserve its original colors.

Tiny **nonzero** areas are not discarded using EPS. Non-finite coordinates fail
parsing, and unsupported numeric area ranges remain controlled failures. Existing
8-decimal XML serialization, cubic curve geometry, native `<contour>` schema,
source/layer order, paint, opacity, and compatibility profile are retained. Curves
are neither flattened in output nor rasterized. Topology still uses the existing
bounded sampled/BVH checks; this repair does not claim an exact curve-intersection
algorithm for every possible SVG.

`converter-core.js` also uses the filtered native path when only one contour
survives. Otherwise its previous single-path fast path would reinsert the old
compound string. `converter.js` adds per-conversion aggregate counters in
`stats.nativeContours`: `inputContours`, `removedFillContours`,
`retainedStrokeContours`, and `retainedBoundsContours`. They count native serialization calls, including clip
components where present. A synchronous, nested-safe diagnostic scope restores
state after errors; API stats contain no source paths, coordinate dumps or keys.

## Files

| File | Purpose |
| --- | --- |
| `lib/contour-paint.js` | Exact finite-coordinate area and conservative zero-fill proofs |
| `lib/native-contours.js` | Paint-aware classification, preserved strokes, inspection and counter scope |
| `lib/converter-core.js` | Serialize a filtered single survivor rather than original compound data |
| `lib/converter.js` | Aggregate native contour diagnostics for actual conversions |
| `test/contour-degeneracy.test.js` | 16 regression tests, including real local API handler calls |
| `test/fixtures/zero-paint-compound.svg` | Minimal authored reproducer with real transparent hole |
| `test/fixtures/reported-layout-synthetic.svg` | Explicitly synthetic reported-count regression |
| `scripts/verify-svg-paint.mjs` | Reconstruct native contours from output XML and compare actual pixels |
| `scripts/inspect-native-contours.mjs` | Read-only per-source-path inspection and conversion result |
| `scripts/verify-nexora-native-contours.mjs` | Actual V1 UI/proxy wired to actual local provider handlers |
| `package.json` | Include the new geometry module in the existing syntax check; no dependency/version change |
| This document | Evidence, reproduction commands and unresolved gates |

## Validation actually run

| Check | Result |
| --- | --- |
| Baseline `npm run check`, `npm test` | PASS; 181 tests before changes |
| `npm ci --cache /tmp/svg-native-recovery/npm-cache --no-audit --no-fund` | PASS; 37 packages, frozen lockfile, checksums/TLS unchanged |
| `npm run check` | PASS |
| `npm test` | PASS; 197 tests, no skips; 181 existing + 16 new |
| `node --test test/contour-degeneracy.test.js` | PASS; 16 tests |
| `npm run verify:paint` with installed Chromium | PASS; 35 fixture/engine combinations |
| All three `npm run benchmark:color-groups*` scripts | PASS; existing budgets/assertions unchanged |
| `node scripts/inspect-native-contours.mjs test/fixtures/reported-layout-synthetic.svg` | PASS; 113 editable shapes, exactly 2 fill contours removed; compatibility gate passes |
| `node scripts/verify-nexora-native-contours.mjs` with V1 checkout available | PASS; 360/390/412/1440 px, actual conversion response, full preview/copy/download equality, single-submit and controlled failure |
| V1 `npm run lint`, `npm run check`, `npm test`, `VERCEL=1 npm run build` in disposable V1 snapshot | PASS; 211/211 regression scripts and build |
| `git diff --check` | PASS |
| Original `konzz.svg` | BLOCKED — source not supplied |
| Import on a real Alight Motion Android device | UNVERIFIED — no device environment available |
| Provider deployment/package build | UNVERIFIED — no `build` script is supplied; syntax, converter, Web Handlers and browser integration tested locally; no deployment run |

The first dependency refresh failed because npm's default cache pointed at the
unavailable `/home/agent/.npm/_cacache`. A fresh writable cache fixed installation;
no integrity/TLS verification was bypassed. Checks depending on the removed
node_modules were rerun after the successful frozen installation. An initial
integration harness expected the wrong health label (`CONNECTED`); it was corrected
to the production UI's `API AUTH OK`, without changing production UI or gates.

The real-complex benchmark includes a 1,219,087-byte synthetic source with 987
paths and 78,148 source nodes. The candidate completed its reported run in about
2.55 s under the existing 8 s assertion budget; both benchmark conversions passed.
These are development-run timings, not a Vercel latency/SLA or speedup claim.

## Visual comparison, not just XML parsing

The Chromium verifier renders the source SVG and an SVG reconstructed exclusively
from output XML. Native exclusions are interpreted with opposite winding while
retaining cubic controls; orientation sampling is independent of the production
exact area predicate. No original source path is substituted into reconstruction.
Generated comparison geometry is test-only, not production masks or raster output.

Canvas dimensions and every pixel's alpha and visible RGB channels are compared,
composited against both white and black. A maximum delta of **2 in an 8-bit
channel** allows existing ARGB/alpha rounding. Observed maximum across all 35 cases
was approximately **2.84e-14**, floating-point noise. The synthetic hole's central
alpha is explicitly asserted to be zero in source and reconstructed output.
Nested evenodd holes/islands, same-winding nonzero nesting, implicit closures,
native strokes, cubic curves, multiple colors and layer order are covered.
Unit tests separately preserve tiny positive geometry that cannot be proved by
normal-resolution screenshots.

Cases still rejected include ambiguous zero-area painted compounds, intersecting
or touching contour arrangements outside the existing supported representation,
non-finite inputs and unsupported mixed closure. Their failures are not relabeled
as successful conversions.

## Nexora V1 integration

No V1 production changes or V1 PR are necessary based on the verified cases:
the current `lib/svgtoxml-proxy.js` retains provider HTTP422 error codes, and
`assets/js/features/svg-alight.js` already handles the `NATIVE_CONTOUR_*` family.
Actual local conversion yields `XML READY`; ambiguous geometry yields `FAILED`
with the specific code, and old output is hidden. Compatibility validation remains
active, and a double click sends exactly one conversion request. Full preview,
copy and downloaded bytes equal the actual engine XML.

The cross-repository browser harness uses the real V1 files and real engine API
handlers, with local account permission and HTTPS transport bindings. It does
**not** verify production credentials, a deployed provider, Android hardware,
or an actual Alight Motion application import. No engine implementation was copied
into V1, no provider settings/keys were changed, and V2 was not accessed.

## Complete the original-file gate

After attaching `konzz.svg`, run from the engine checkout:

```sh
node scripts/inspect-native-contours.mjs /path/to/konzz.svg > /tmp/konzz-inspection.json
PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright \
  SVG_PAINT_ARTIFACTS=/tmp/konzz-visual \
  npm run verify:paint -- --source /path/to/konzz.svg
```

Inspection records source SHA256, zero-based path index, one-based contour index,
signed area, area sign, control bounds, segment count, explicit closure and whether
the endpoint already meets the start before Z. Control bounds are conservative
enclosures, not tight cubic extrema. Unsupported raw commands are explicitly
normalized at 12 decimals for inspection. Detailed geometry remains in the local
inspection output; production responses only expose aggregate counters.

Preserve the original fixture unmodified, then inspect any subsequent topology
failure before expanding support. Once all local gates pass on the actual file,
perform a real-device import and review the PR before deployment. Until then,
**the original-file acceptance target is not claimed complete**.

Execution artifacts (not committed): `/tmp/svg-native-recovery/`, including
`before.json`, `synthetic-inspection.json`, `suite-final.log`, `v1-results.json`,
`visual-final/results.json`, PNG comparisons, and `integration-final/results.json`
plus Android/desktop captures. No SVG/Base64 dump or credential was added to
production logs. Existing untracked onboarding files were preserved.
