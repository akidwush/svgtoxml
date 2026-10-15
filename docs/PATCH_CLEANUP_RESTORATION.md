# Patch Cleanup restoration — v3.0.1

## Scope and audit

Repository: `akidwush/svgtoxml`. Base: main merge `545cc3df866ab9984ef79ef231f07b8299579878`.
Restoration reference: pre-removal commit `5fa267a8168df885ee26da25b3a50d4755509afe`.

The v3.0.0 change removed the full Small Patch Cleanup surface, not just a selector.
This repair restores that surface while retaining the Smart Color Groups implementation.
No merge or production deployment is included; merge awaits the owner's approval.

## Restored contract

- Resolver: `small-patch-cleanup`, `patch-clean`, `small-patch`; canonical quality `patch-clean`.
- Original micro-subpath pruning algorithm, compact-patch threshold, long/thin protection,
  scene-coordinate processing, no color grouping and no node simplification.
- Defaults: `patchAreaPercent=0.01`, `protectThinPercent=2`, minimum thin aspect ratio `6`.
  Existing clamps and POST `microDetailPercent` option alias are preserved.
- Native stroke, gradient, clip, source order, group opacity, nested/flat hierarchy,
  primitive detection, title, duration, FPS, and fail-closed compatibility validation.
- Cleanup counters, metadata, profile, warnings, and intentional fidelity-loss reporting.
- Health/catalog entries, authenticated external GET/POST, raw XML export and website POST.
- UI engine option, threshold controls, mode notes, result statistics, title and status.
- README describes three active engines. Earlier v3.0.0 reports are marked historical.

Only helpers used by Patch Cleanup were restored; removed legacy optimizers and unused
serializers were not reintroduced. No parallel parser, paint resolver or serializer was added.
Smart Color Groups retains its effective-paint signatures, topology checks, z-order audit,
fallback reasons, deterministic metadata and unmerged source geometry.

## Verification

- `npm run check`: PASS.
- `npm test`: **59 passed, 0 failed**.
- Six original Patch Cleanup behavior tests restored.
- Additional regressions cover all aliases/selectors, zero threshold, clamps, legacy option,
  metadata, native styling/hierarchy, cleanup isolation, engine catalog/health, GET/POST,
  authentication and raw XML export.
- UI event integration covers all three engines from file selection through real local
  API handler/converter, result rendering and XML Blob download. This uses a lightweight
  DOM adapter, not a browser or mocked conversion output.
- CI paths expanded to all `lib/**`, `api/**`, `app.js`, `index.html`, and `style.css`, so
  UI/API-only changes also trigger the regression suite.
- One-time historical parity audit imported original sources directly from Git into memory:
  **30 Patch Cleanup cases** matched pre-removal XML, options, cleanup and fidelity reports;
  **10 Maximum Fidelity/Smart Color Groups cases** matched current main XML, grouping and
  fidelity reports. Only timestamps and the Smart Color Groups version comment were
  normalized. Fixtures covered micro-shapes, compound islands, thin details, opacity,
  overlap, holes, and the existing manual fidelity SVG; cleanup tested zero/default/max
  thresholds and flat/nested hierarchy.
- `git diff --check`: PASS.

Smart Color Groups benchmark after restoration:

| Source shapes | Total time | Output color layers |
|---:|---:|---:|
| 100 | 46.085 ms | 10 |
| 500 | 79.129 ms | 10 |
| 1000 | 113.669 ms | 10 |
| 3000 | 334.428 ms | 10 |

These are one-run local timings, not a performance guarantee.

## Remaining validation boundary

Automated XML compatibility and local UI event tests pass. No new visual browser/device
test or actual Android Alight Motion import was performed. The attached `.svg.xml` is
an exported Alight project, not the original SVG, and was not misrepresented as converter input.
