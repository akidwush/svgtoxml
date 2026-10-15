# Smart Color Groups audit

## Current architecture

`lib/converter.js` owns DOM parsing, CSS cascade, inherited style resolution, transform normalization, paint extraction, candidate creation, serialization, and engine dispatch. `lib/path-geometry.js` provides the shared canonical path pipeline. `lib/alight-compatibility.js` parses and validates every generated XML document before it is returned.

## Previous Color Groups limitations

- Effective colors were already canonicalized through the shared CSS color parser, but grouping eligibility returned only a color or `null`; callers could not audit why a shape fell back.
- Gradient, stroke, partial alpha, clip, mask, filter, marker, and blend mode were conservatively isolated, but there was no fallback reason histogram.
- Bounds intersection was both broad phase and final overlap decision. Hole containment and other bbox false positives could create false z-order constraints.
- Metadata did not distinguish candidate pairs, topology checks, actual overlaps, touching pairs, unknown relationships, constraints, and conflicts.
- Unknown engine IDs silently selected Maximum Fidelity.

## Previous z-order strategy

Source draw order created directed edges between distinct output units whenever their bounding boxes had positive-area intersection. Kahn topological sorting used first source order as a stable tie-breaker. A direct reverse edge or an incomplete topological result reported a conflict.

## Paint strategy

The existing computed-style resolver supports presentation attributes, stylesheet selectors, inline style, inheritance, CSS variables, `currentColor`, RGB/RGBA, HSL/HSLA, short/long hex, named colors, opacity, gradients, and native strokes. The upgrade retains that resolver and records a `paintSignature` plus explicit grouping reason codes instead of adding a parallel paint parser.

## Small Patch Cleanup removal surface

- quality aliases and thresholds in `lib/converter.js`;
- micro-subpath helpers and counters;
- execution, fidelity, response metadata, warnings, and profile branches;
- GET query options in `lib/api-http.js`;
- engine catalog and health response;
- standalone UI controls and result rendering;
- README contract and converter/API tests.

## Reference XML observations

The supplied `1003324361.svg.xml` contains 42 shapes, 3 `embedScene` wrappers, 4 scenes, and one native linear gradient. Twenty-four shapes do not have a direct child `fillColor`, demonstrating that wrapper paint and drawable paint are distinct concepts. The healthy structure uses nested scenes, centered transforms, optional pivots, individual path nodes, and wrapper fill values that must not be treated as automatic child paint.

The second filename named in the task was not present in the supplied workspace, so no claim is made about invariants unique to that file.

## Risk areas

- Curve topology is classified through deterministic adaptive-style flattening for analysis only. Unknown relationships remain conservative constraints.
- SVG group opacity cannot always be flattened identically; partial effective alpha therefore remains a fallback and fidelity reporting remains authoritative.
- Unsupported SVG filter/mask semantics remain fidelity losses even when the grouping decision itself is safe.

## Implementation plan

1. Remove Small Patch Cleanup and reject its old aliases explicitly.
2. Reuse computed styles to produce effective paint signatures and eligibility reason codes.
3. Keep AABB as broad phase and add filled-path topology as narrow phase.
4. Feed proven overlaps, containment, and conservative unknowns into the z-order graph; ignore edge-only touching.
5. Expose deterministic grouping audit metadata and fallback histograms.
6. Preserve existing Maximum Fidelity and compatibility validation paths.
