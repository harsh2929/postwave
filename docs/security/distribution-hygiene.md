# Distribution hygiene

Status: active  
Owner: security-engineering  
Version: 1  
Last reviewed: 2026-07-15

Only product artwork, signed-bundle icons and assertion-bearing visual
baselines belong in the source distribution. Dated walkthrough captures,
browser-review dumps, screenshots saved at repository root and mobile audit
captures are reproducible internal artifacts; they are ignored and must not be
tracked or sent to customers.

`config/distribution-assets.json` is the closed allowlist for raster asset
roots, owners, purposes and size ceilings. `scripts/check-distribution-hygiene.mjs`
enumerates the Git index, rejects ad-hoc audit/review roots and root-level
rasters, enforces that each retained image belongs to exactly one reviewed
root, rejects symlinks/oversized files and scans raw metadata for
high-confidence credentials. Product source directories named `audit` or
`reviews` are not blocked merely by name; only the explicit generated-artifact
roots are forbidden.
