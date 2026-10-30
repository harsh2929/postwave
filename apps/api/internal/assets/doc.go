// Package assets owns the tenant-scoped image library + asset CDN endpoints.
//
// Storage backend selection is driven by startup environment variables. The
// canonical AWS client is injected by main.go; SelectStorage owns the optional
// R2 and development-filesystem alternatives.
//
//	R2_BUCKET             — Cloudflare R2 (S3-compatible) bucket name. If
//	                         set together with the three vars below, uploads
//	                         go straight to R2 and the served URL is built
//	                         off R2_PUBLIC_BASE.
//	R2_ENDPOINT           — e.g. https://<account>.r2.cloudflarestorage.com
//	R2_ACCESS_KEY_ID      — S3 access key
//	R2_SECRET_ACCESS_KEY  — S3 secret
//	R2_PUBLIC_BASE        — explicit public-facing HTTPS custom domain served
//	                         by Cloudflare. Mandatory in production; the private
//	                         R2 S3 API endpoint is never inferred as public.
//
//	POSTWAVE_ASSETS_BUCKET          — canonical private AWS S3 bucket.
//	POSTWAVE_ASSETS_PUBLIC_BASE_URL — mandatory HTTPS CloudFront/CDN prefix
//	                                   backed by that bucket through OAC.
//	POSTWAVE_S3_KMS_KEY_ID          — KMS key required for every S3 write.
//
//	POSTWAVE_DATA_DIR     — local fallback root. Defaults to ./data; assets
//	                         are written under ${POSTWAVE_DATA_DIR}/assets/
//	                         and served via GET /api/v1/assets/{id}/blob.
//
// Validation accepts structurally decodable PNG/JPEG/GIF/WebP images up to
// 10 MiB and enforces bounded pixel dimensions before persistence.
package assets
