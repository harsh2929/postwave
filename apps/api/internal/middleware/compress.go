// SPDX-License-Identifier: AGPL-3.0-only
//
// compress.go — transport-layer response compression for the chi
// router. Wraps chimiddleware.NewCompressor(5) (gzip + deflate
// baseline) and additionally registers brotli ("br") via
// github.com/andybalholm/brotli. Encoder selection is driven by the
// client's Accept-Encoding header with brotli taking precedence when
// offered (it was added last to the precedence list).
//
// Skip rules (enforced by chi's content-type allowlist):
//   - text/event-stream — never compressed; preserves SSE flush
//     semantics used by apps/api/internal/sending and
//     apps/api/internal/streams.
//   - Already-compressed binary payloads (image/png, application/zip,
//     application/octet-stream, etc.) — not in the allowed-types
//     list so chi passes them through untouched.
//   - Responses whose Content-Encoding is already set by an upstream
//     handler (e.g. a presigned redirect that already encoded its
//     body) — chi short-circuits these in WriteHeader.
//
// chi's compressor always emits `Vary: Accept-Encoding` on any
// response it actually compresses; clients and intermediate caches
// therefore key correctly.
//
// Note: chi does not provide a sub-1KiB length threshold. Adding one
// would require buffering the entire response which breaks streaming
// handlers (export downloads, SSE) — the bandwidth lost on tiny JSON
// envelopes is negligible compared to that risk.

package middleware

import (
	"io"
	"net/http"

	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"github.com/andybalholm/brotli"
)

// Compress returns a router-level middleware that negotiates gzip,
// deflate, and brotli response compression. Compression level 5 is
// the same balance chi recommends in its docstring: noticeably
// better ratios than 1 at a small CPU cost, far cheaper than 9.
//
// The compressible content-type list extends chi's defaults with the
// JSON and text variants Moosewave actually serves (application/
// problem+json for RFC 7807 envelopes, text/csv for exports, etc.).
func Compress() func(http.Handler) http.Handler {
	c := chimiddleware.NewCompressor(
		5,
		// chi defaults — repeated explicitly because passing any
		// custom type to NewCompressor replaces the default set.
		"text/html",
		"text/css",
		"text/plain",
		"text/javascript",
		"application/javascript",
		"application/x-javascript",
		"application/json",
		"application/atom+xml",
		"application/rss+xml",
		"image/svg+xml",
		// Moosewave additions.
		"application/problem+json", // RFC 7807 error envelopes.
		"text/csv",                 // export downloads.
		"text/xml",                 // sitemap / RSS feed routes.
		"application/xml",
	)

	// Register brotli last so it sits at the front of the encoding
	// precedence list — chi's selectEncoder walks the list in order
	// and picks the first one the client's Accept-Encoding accepts.
	c.SetEncoder("br", brotliEncoder)

	return c.Handler
}

// brotliEncoder adapts brotli.NewWriterLevel to chi's EncoderFunc
// signature. brotli.Writer implements Reset(io.Writer), so chi will
// pool encoder instances and avoid per-request allocations.
func brotliEncoder(w io.Writer, level int) io.Writer {
	// brotli accepts quality 0..11; chi compress level 5 maps
	// directly onto the same scale and gives a similar
	// ratio/CPU balance to gzip-5.
	return brotli.NewWriterLevel(w, level)
}
