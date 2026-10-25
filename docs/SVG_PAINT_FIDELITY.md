# SVG paint fidelity v3.1.0

Scope: engine `akidwush/svgtoxml`, based on main `679add7`. The Nexora V1 frontend
uses this provider through its existing authenticated proxy; no V2, database,
credential, authorization or production configuration changes are required.

## Confirmed defects

Local reproductions showed `color(srgb …)`, `hwb(…)` and nested `var()` fallback
paint could lose a shape or fail exact conversion. `hsl(.5turn 100% 50%)` became
near red instead of cyan while the old engine still called its output exact.
Custom property names were lowercased even though they are case-sensitive. A
regex split selector lists at commas inside `:is()`/`:where()`, and repeated CSS
declarations could overwrite an earlier important declaration incorrectly.
An explicitly visible child inside a hidden container was also dropped before
its own visibility was evaluated.

Gradient stop currentColor was resolved against the referencing shape rather
than the stop's CSS context. Invalid/unrecognized stroke paint could disappear
without an explicit paint loss. Regex stylesheet parsing also applied conditional
rules without evaluating their condition.

## Implementation

`lib/svg-paint.js` is the shared server-side paint/cascade module. Culori 4.0.2
parses legacy and CSS Color 4 color syntax and converts supported color spaces
to sRGB; CSS Tree 3.2.1 parses declarations, selector lists and variable functions.
These are exact runtime pins, replacing the old color-name-only parser. Playwright
1.55.1 is a development dependency for visual regression checks, not browser
application code or a runtime provider dependency.

The module handles hexadecimal/named colors, case-insensitive RGB/HSL functions,
angle units, percentages, alpha, HWB, Lab/LCH, OKLab/OKLCH, standard `color()`
profiles and missing color components outside interpolation. It keeps case-sensitive
custom properties, nested fallbacks and cycles, inheritance/initial/unset,
currentColor and the important cascade. Selectors use parsed specificity tuples
and actual static selector matching. Gradient stops retain their own color context;
stop-color and stop-opacity do not implicitly inherit.
Two-stop linear gradient endpoints are adjusted to the actual stop offsets,
preserving pad regions. Coincident hard stops and unmapped radial offsets produce
`gradient-stop-offset` instead of a false exact result. Hidden containers are
walked so visible descendants retain their geometry and paint.

Variable dependency depth is bounded and expanded values are limited to 16 KiB
before AST insertion, preventing exponential expansion. CSS imports are not
fetched, scripts are not evaluated, and unsafe compatibility/auth/resource guards
remain. The path parser, source order, transform, geometry precision, stroke,
clip mapping and color-group topology implementation are retained.

Provider/package, health and catalog version become 3.1.0. The catalog advertises
paint syntax, static CSS and the 8-bit sRGB output limit while preserving engine
IDs, aliases, options and the existing Alight compatibility contract/profile.
Only version expectations in existing tests change; their other assertions remain.

## Exactness boundary

The output schema stores 8-bit ARGB sRGB colors. A converted wide-gamut color
outside that space is reported as `color-gamut`. Unhandled fill/stroke syntax is
`unsupported-paint`; it cannot be labelled exact merely because the remaining
XML is well formed. Dynamic/conditional at-rules/selectors, unsupported CSS reset,
CSS geometry and numeric expressions are conservatively reported as
`css-unsupported`. A bare invalid CSS color name leaves an earlier valid fallback
declaration active, matching the cascade; an unmapped complex paint function does
not silently expose default black.

Chromium testing found that a gradient using a modern color-space stop could
differ by four channel levels after mapping to two quantized native endpoints.
The output's interpolation space is not verified to reproduce that behavior.
Such gradients and linearRGB interpolation now report `gradient-color-space` and
are rejected with `requireExact: true`, instead of relaxing visual assertions or
calling a different result exact. Legacy two-stop gradients remain tested.

The existing multi-stop, repeat/reflect, radial-focus, filter, mask/pattern,
marker, text/bitmap and animation limits remain. Smart Color Groups also retains
its existing warning when flattening an overlapping opacity group; the visual
opacity-group checks therefore cover Maximum Fidelity and zero-threshold cleanup.
Non-exact modes can still return explicitly degraded results by their established
contract. Maximum Fidelity with `requireExact: true` is the path for rejecting
known loss. No claim of universal 100% SVG support or native device import is made.

## Verification

The original baseline passes 66 Node tests. Updated checks cover 153 tests: legacy
and modern colors through all three engines, geometry/node retention, CSS cascade,
variables, gradients, unsupported paint, gamut, conditional CSS and expansion limits,
alongside all original converter/API/auth/schema/performance/UI tests.

`scripts/verify-svg-paint.mjs` compares the browser-rendered source SVG with a static
SVG reconstruction of the actual validated XML's paths, group placement/opacity,
fills, strokes and normalized two-stop gradients. Eleven comparisons cover legacy
SVG 1.1/CDATA, modern solid paint, transformed curves, strokes, gradients and group
opacity in the supported modes. The verifier checks visible channels over black
and white backgrounds with a two-level tolerance for 8-bit quantization and saves
PNGs/results. This is an offline XML-structure/render comparison, not an Alight
Motion application renderer or Android device test. It is not evidence for the
unsupported features listed above.

A separate local integration invokes the actual engine v1 catalog/auth/convert
handlers behind the unchanged Nexora V1 proxy, with a local test key and no
external request. All three modes preserve green/cyan modern paints through both
compatibility validators, and a gamut loss remains a controlled 422 without XML.
No engine implementation is copied into Nexora.

Final verification in a disposable copy with its own frozen dependency install:

| Command/check | Actual result |
| --- | --- |
| `npm ci --include=dev --no-audit --no-fund` | PASS, 37 packages; lockfile/integrity verification preserved |
| `npm run check` | PASS, existing syntax checks plus the new module/verifier |
| `npm test` | PASS, 153/153; 0 failed, cancelled or skipped; baseline 66/66 |
| `npm run verify:paint` with installed Chromium | PASS, 11 render comparisons |
| `npm run benchmark:color-groups` | PASS, existing 100/500/1000/3000-shape benchmark |
| `npm run benchmark:color-groups-overlap` | PASS, existing 987-shape overlap benchmark |
| `npm run benchmark:color-groups-real-complex` | PASS, 1,219,087-byte / 987-shape / 78,148-node fixture, 2,570.378 ms in this run |
| Actual local engine API through Nexora V1 proxy | PASS, five catalog/auth/conversion/error cases |
| Source/dependency hash comparison to tested copy and `git diff --check` | PASS |

The render comparison has a worst visible-channel delta of approximately
`2.84e-14` (floating-point zero) for these fixtures; it is not a universal pixel
or native-device guarantee. The two-level tolerance remains unchanged. The initial
gradient reconstruction incorrectly treated normalized endpoints as pixel values;
the verifier was corrected to the actual object-bounds contract. The separate
modern color-space gradient difference was retained as a rejected-exact regression,
not hidden by increasing tolerance.

There is no build/lint script in this repository beyond `check`; API handlers and
the converter are executed directly by functional tests. No production build or
live conversion is claimed. Artifacts/logs use `/tmp/nexora-svg-paint/`; generated
`artifacts/` is ignored by Git. The CI workflow retains all prior checks/benchmarks
and adds the Chromium comparison. Environment cache paths are outside the checkout.

Changes: `lib/svg-paint.js`, `lib/converter-core.js`, `lib/alight-compatibility.js`,
`api/health.js`, `api/v1/engines.js`, `package.json`/lockfile, the version expectations
in two existing test files, `test/svg-paint.test.js`, `scripts/verify-svg-paint.mjs`,
the existing CI workflow, `.gitignore`, this report and README. Setup-only AGENTS
and cloud-context files and all private images/artifacts remain outside the commit.

Production conversion and actual Alight Motion import remain unverified. The
provider PR requires review/merge before Nexora can consume the upgraded deployed
engine; no main push, merge or production deployment is performed in this task.
