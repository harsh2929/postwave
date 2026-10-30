// Package activitypub — HTTP Signature signing + verification scaffold.
//
// The Fediverse runs on "draft-cavage-http-signatures-12" (a.k.a. the
// pre-RFC HTTP Message Signatures spec Mastodon ships). Every POST to
// a remote inbox MUST carry a `Signature:` header of the form:
//
//   Signature: keyId="https://our.host/api/public/activitypub/users/foo#main-key",
//              algorithm="rsa-sha256",
//              headers="(request-target) host date digest",
//              signature="<base64 rsa-sha256 of the signed string>"
//
// And the signed string is constructed by concatenating each named
// header (with `(request-target)` resolving to "<method> <path>") with
// a `\n` separator. Mastodon refuses unsigned POSTs.
//
// Inbound side is symmetric: every Activity in the public /inbox MUST
// carry a Signature header that verifies against the remote actor's
// publicKey.publicKeyPem. The v1 inbox handler tags incoming rows
// `sig_state='unverified'`; the verification path lives here.
//
// This file is a scaffold:
//
//   - Signer / Verifier interfaces are defined.
//   - SignRequest is a stub that returns the canonical signing string
//     (the part that DOES NOT depend on private-key crypto). The
//     RSA-sha256 step + base64 encoding is deferred to the full
//     implementation.
//   - VerifyRequest stubs the parse-header / canonicalise-signing-
//     string path; the actual crypto.Verify call is the deferred step.
//
// Why scaffold instead of ship: the full signing path needs careful
// handling of header normalisation (case-insensitive, trailing-space
// trimmed, Digest header SHA-256 of the body), and parity tests
// against real Mastodon traffic — a multi-week effort that's
// explicitly deferred per the XL scoping.

package activitypub

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Signer signs an outbound HTTP request in place — sets the Date,
// Digest, and Signature headers in a Mastodon-compatible form.
//
// The interface intentionally takes the *http.Request itself (not a
// canonical envelope) so callers can sign requests built by any
// transport — including the delivery worker's batched fan-out to
// shared inboxes.
//
// Returns the keyId that was used (so the caller can log it).
type Signer interface {
	Sign(ctx context.Context, tenantID string, req *http.Request, body []byte) (keyID string, err error)
}

// Verifier verifies an inbound HTTP request's Signature header against
// the remote actor's published public key. Returns ErrSignatureInvalid
// when the signature can be parsed but fails verification; returns
// ErrSignatureMissing when no Signature header is present.
type Verifier interface {
	Verify(ctx context.Context, req *http.Request, body []byte) (actorURL string, err error)
}

// ErrSignatureMissing — no Signature header in the request.
var ErrSignatureMissing = errors.New("activitypub: signature header missing")

// ErrSignatureInvalid — header parsed but signature did not verify.
var ErrSignatureInvalid = errors.New("activitypub: signature invalid")

// ErrSignatureUnsupported — algorithm other than rsa-sha256 (we don't
// federate with ed25519 yet because Mastodon doesn't accept ed25519
// public keys in actor JSON-LD as of v4.2).
var ErrSignatureUnsupported = errors.New("activitypub: signature algorithm unsupported")

// defaultSignedHeaders is the canonical Mastodon-compatible header
// order. Mastodon rejects signatures that omit any of these. Listed in
// the order the signing string concatenates them.
var defaultSignedHeaders = []string{
	"(request-target)",
	"host",
	"date",
	"digest",
	"content-type",
}

// BuildSigningString assembles the canonical signing string from the
// supplied request + the list of headers to sign. Exported so the
// future Sign/Verify implementations share one canonicaliser (and so
// a parity test against a recorded Mastodon request can pin it).
//
// (request-target) special-cases to "<method-lowercase> <path>". All
// other headers resolve via req.Header.Get with leading/trailing
// whitespace trimmed.
func BuildSigningString(req *http.Request, headers []string) string {
	if len(headers) == 0 {
		headers = defaultSignedHeaders
	}
	parts := make([]string, 0, len(headers))
	for _, h := range headers {
		lh := strings.ToLower(h)
		if lh == "(request-target)" {
			parts = append(parts, "(request-target): "+
				strings.ToLower(req.Method)+" "+req.URL.RequestURI())
			continue
		}
		v := strings.TrimSpace(req.Header.Get(h))
		// Host header is a special case: net/http exposes it as
		// req.Host, not as a Header entry.
		if lh == "host" && v == "" {
			v = req.Host
		}
		parts = append(parts, lh+": "+v)
	}
	return strings.Join(parts, "\n")
}

// ParseSignatureHeader splits a `Signature: keyId="...",algorithm="...",...`
// header into its key/value pairs. Whitespace-tolerant. Returns the
// raw map — callers pull the bits they need.
//
// Exported so the future Verify implementation can use it; the
// parsing logic is straightforward and shipping it now keeps tests
// for it in this package.
func ParseSignatureHeader(h string) (map[string]string, error) {
	if h == "" {
		return nil, ErrSignatureMissing
	}
	out := map[string]string{}
	// Split on commas, but only outside quotes. Mastodon never embeds
	// commas inside quoted values, so a simple state machine is enough.
	var cur strings.Builder
	inQuote := false
	flush := func() {
		token := strings.TrimSpace(cur.String())
		cur.Reset()
		if token == "" {
			return
		}
		eq := strings.IndexByte(token, '=')
		if eq < 0 {
			return
		}
		k := strings.TrimSpace(token[:eq])
		v := strings.TrimSpace(token[eq+1:])
		v = strings.Trim(v, `"`)
		out[strings.ToLower(k)] = v
	}
	for _, r := range h {
		switch {
		case r == '"':
			inQuote = !inQuote
			cur.WriteRune(r)
		case r == ',' && !inQuote:
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	if len(out) == 0 {
		return nil, ErrSignatureInvalid
	}
	return out, nil
}

// canonicaliseSignedHeaders normalises the `headers="..."` field of a
// Signature header into the list-of-strings form BuildSigningString
// consumes.
func canonicaliseSignedHeaders(headers string) []string {
	if headers == "" {
		return defaultSignedHeaders
	}
	parts := strings.Fields(headers)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		out = append(out, strings.ToLower(p))
	}
	return out
}

// SetSigningHeaders pre-populates the request with the headers a
// Signature must cover (Date, Digest, Host). The Signer implementation
// then computes the Signature header itself.
//
// `body` is the exact request body bytes; we SHA-256 it for the
// Digest header. Empty body emits a Digest of the empty string per
// AP convention.
func SetSigningHeaders(req *http.Request, body []byte, now time.Time) {
	if req.Header.Get("Date") == "" {
		req.Header.Set("Date", now.UTC().Format(http.TimeFormat))
	}
	if req.Header.Get("Host") == "" && req.URL != nil {
		req.Header.Set("Host", req.URL.Host)
	}
	if req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", MimeActivityJSON)
	}
	if req.Header.Get("Digest") == "" {
		req.Header.Set("Digest", computeDigest(body))
	}
}

// computeDigest is the SHA-256(body) base64 string per Mastodon
// convention: `SHA-256=<base64>`, per the HTTP Signatures RFC and
// RFC 3230 Digest header. Empty body hashes to the SHA-256 of the
// empty string, which Mastodon accepts.
func computeDigest(body []byte) string {
	h := sha256.Sum256(body)
	return "SHA-256=" + base64.StdEncoding.EncodeToString(h[:])
}

// FormatSignatureHeader assembles the final `Signature:` header value
// from its component parts. Pure formatter; no crypto. Exported so
// tests can pin the wire format independently of the signing path.
func FormatSignatureHeader(keyID, algorithm string, headers []string, signatureB64 string) string {
	if algorithm == "" {
		algorithm = "rsa-sha256"
	}
	hdrs := strings.Join(headers, " ")
	// Deterministic field order — Mastodon doesn't care but tests do.
	fields := []string{
		fmt.Sprintf(`keyId="%s"`, keyID),
		fmt.Sprintf(`algorithm="%s"`, algorithm),
		fmt.Sprintf(`headers="%s"`, hdrs),
		fmt.Sprintf(`signature="%s"`, signatureB64),
	}
	sort.Strings(fields[:2]) // keyId before algorithm — stable.
	return strings.Join(fields, ",")
}

// noopSigner is the dev/test signer that satisfies the Signer
// interface without doing any crypto. The delivery worker accepts a
// nil Signer; this struct lets tests inject "signed but garbage" to
// exercise the rest of the pipeline.
type noopSigner struct{}

// NewNoopSigner returns a Signer that stamps an obviously-fake header.
// MUST NOT be used in production — Mastodon will reject the request.
func NewNoopSigner() Signer { return noopSigner{} }

func (noopSigner) Sign(_ context.Context, _ string, req *http.Request, body []byte) (string, error) {
	if req == nil {
		return "", errors.New("activitypub.noopSigner: nil request")
	}
	SetSigningHeaders(req, body, time.Now())
	header := FormatSignatureHeader("noop#main-key", "rsa-sha256", defaultSignedHeaders, "DEFERRED")
	req.Header.Set("Signature", header)
	return "noop#main-key", nil
}
