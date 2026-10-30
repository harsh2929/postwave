# Campaign image broker and OCR boundary

This package is the only Campaign Assurance component allowed to acquire a
remote image. A request is bound to the frozen revision source hash, outbound
artifact hash, exact HTML hash, locale, and a node/URL review derived from the
effective semantic revision. Any unreviewed image, `srcset`, `<source>`, CSS
`url(...)`, duplicate node, or source mismatch rejects the rendered image set
before a network request is made.

`New` builds a proxy-free HTTPS client with an exact hostname allowlist,
TLS 1.2 minimum, port 443 only, bounded redirects and headers, and a dialer that
resolves and validates every address immediately before connecting. Private,
loopback, link-local, multicast, documentation, benchmarking, transition, and
metadata address ranges are rejected. A mixed public/private DNS answer is
rejected in full, and the dial-time resolution prevents a validation/dial DNS
rebinding gap.

Each response has per-image and campaign byte, pixel, dimension, frame, time,
OCR-text, DNS-answer, and concurrency bounds. Content encoding is disabled;
the declared media type must match a fully decoded and metadata-sanitized
signature. GIF uses the first frame under an aggregate frame bound. APNG and
animated WebP are rejected. SVG is rejected by default; the opt-in policy
accepts only inert vector geometry and requires an injected rasterizer after
scripts, external references, images, text/fonts, styles, animation, active
XML, and unknown elements/attributes have been rejected.

The OCR engine receives one canonical PNG, immutable hashes, dimensions, and a
BCP-47 language hint. Its input contains no URL, HTTP client, browser, tool,
credential, or token. A successful result requires bounded UTF-8 text, a
declared/detected BCP-47 language, valid confidence, immutable
engine/runtime provenance, and prior idempotent persistence of the exact
raster through `EvidenceStore`. Optional caching is tenant/content/raster/
engine/runtime/language keyed; URLs are not cache keys.

The package supplies interfaces, closed receipts, runtime enforcement, and
adversarial tests. `internal/campaignimagebrokerruntime` supplies the gated
Unix-domain OCR/scanner adapters, forced-RLS exact-content cache, versioned
SSE-KMS evidence adapter, exact-version deletion receipts, and bounded
retention hook. Production promotion still requires the named credentialed
CDN/DNS/S3/KMS/scanner/OCR corpus and calibrated language evidence described in
`docs/runbooks/campaign-image-broker-runtime.md`. Without a ready injected
runtime the receipt remains `unavailable`; no OCR text or green claim is
fabricated.
