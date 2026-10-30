// SPDX-License-Identifier: AGPL-3.0-only

// Package snsverify verifies Amazon SNS message signatures.
//
// It exists because two inbound paths need the same proof and only one had it.
// `internal/webhooks` verified SNS signatures in full — cert-URL host
// validation, x509 parse, RSA verify, cached keys — while `internal/replies`
// authenticated its SES endpoint with a shared secret alone. Copying the
// verifier into the second package would have produced two implementations of
// a security check that must never disagree, so it moved here instead and both
// callers delegate.
//
// Scope is deliberately narrow: this package decides whether an envelope was
// signed by Amazon and whether its topic is allowed. It does NOT decide
// whether verification may be skipped — the bypass is an operator policy that
// belongs to the caller, which owns the environment check and the logger that
// makes a bypass auditable.
package snsverify

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Envelope is the outer SNS envelope. Callers decode their own wire type and
// convert; the field set is fixed by AWS.
type Envelope struct {
	Type             string
	MessageID        string
	TopicArn         string
	Subject          string
	Message          string
	Timestamp        string
	SignatureVersion string
	Signature        string
	SigningCertURL   string
	SubscribeURL     string
	Token            string
}

// Sentinel errors so callers can branch on cause without matching strings.
var (
	ErrInvalidCertURL        = errors.New("snsverify: SigningCertURL is not an Amazon SNS cert URL")
	ErrSignatureMismatch     = errors.New("snsverify: signature verification failed")
	ErrMissingMessageID      = errors.New("snsverify: missing MessageId")
	ErrUnsupportedSigVersion = errors.New("snsverify: unsupported SignatureVersion")
	ErrTopicNotAllowed       = errors.New("snsverify: TopicArn not in allow-list")
	ErrCertFetchFailed       = errors.New("snsverify: cert fetch failed")
	ErrCertParseFailed       = errors.New("snsverify: cert parse failed")
	ErrCertNotRSA            = errors.New("snsverify: cert public key is not RSA")
	ErrMissingSignature      = errors.New("snsverify: missing Signature")
	ErrSignatureNotBase64    = errors.New("snsverify: Signature is not valid base64")
	ErrTopicAllowlistEmpty   = errors.New("snsverify: TopicArn allow-list not configured")
)

// certURLPattern guards against an attacker-supplied cert URL: HTTPS, an AWS
// SNS host, and a .pem suffix. Checked BEFORE any fetch, so a malicious sender
// cannot steer us into an SSRF or get us to trust their own certificate.
var certURLPattern = regexp.MustCompile(`^https://sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?/[A-Za-z0-9_./-]+\.pem$`)

const (
	// certCacheTTL bounds how long a fetched cert stays cached. SNS rotates
	// "infrequently" per AWS, so a day trades freshness against hammering
	// Amazon's cert host from a hot event stream.
	certCacheTTL           = 24 * time.Hour
	certMaxResponseBytes   = int64(1) << 20
	certFetchClientTimeout = 5 * time.Second
)

type certCacheEntry struct {
	pubKey    *rsa.PublicKey
	fetchedAt time.Time
}

var (
	certCache      sync.Map // map[string]*certCacheEntry
	certHTTPClient = &http.Client{Timeout: certFetchClientTimeout}
)

// Verifier is the policy half: which topics are acceptable.
type Verifier struct {
	// AllowedTopicARNs is required. An empty list is an error rather than
	// "allow everything": a misconfigured operator pointing at a stranger's
	// topic should fail closed.
	AllowedTopicARNs []string
}

// Verify reports whether the envelope was signed by Amazon and carries an
// allowed topic.
//
// There is no bypass here on purpose. A verifier that could be told "skip it"
// is one that can be told so in production; the caller owns that decision and
// the log line that makes it auditable.
func (v Verifier) Verify(env Envelope) error {
	if env.MessageID == "" {
		return ErrMissingMessageID
	}
	if env.Signature == "" {
		return ErrMissingSignature
	}

	var hashFn crypto.Hash
	switch env.SignatureVersion {
	case "1":
		hashFn = crypto.SHA1
	case "2":
		hashFn = crypto.SHA256
	default:
		return fmt.Errorf("%w: %q", ErrUnsupportedSigVersion, env.SignatureVersion)
	}

	if !ValidateCertURL(env.SigningCertURL) {
		return fmt.Errorf("%w: %q", ErrInvalidCertURL, env.SigningCertURL)
	}

	pub, err := fetchPublicKey(env.SigningCertURL)
	if err != nil {
		return err
	}

	digest := hashCanonical(CanonicalString(env), hashFn)
	sigBytes, err := base64.StdEncoding.DecodeString(env.Signature)
	if err != nil {
		return ErrSignatureNotBase64
	}
	if err := rsa.VerifyPKCS1v15(pub, hashFn, digest, sigBytes); err != nil {
		return ErrSignatureMismatch
	}

	// Topic allow-list AFTER the signature check. Defence in depth: SNS binds
	// TopicArn into the signed payload, so a forged envelope cannot reach here
	// — this catches an operator pointing at the wrong topic, not an attacker.
	if len(v.AllowedTopicARNs) == 0 {
		return ErrTopicAllowlistEmpty
	}
	for _, arn := range v.AllowedTopicARNs {
		if env.TopicArn == arn {
			return nil
		}
	}
	return fmt.Errorf("%w: %q", ErrTopicNotAllowed, env.TopicArn)
}

// ValidateCertURL enforces HTTPS, an AWS SNS host, and a .pem path.
func ValidateCertURL(raw string) bool {
	if raw == "" || !certURLPattern.MatchString(raw) {
		return false
	}
	// Belt-and-braces parse so a regex misread of e.g. embedded user-info
	// cannot slip through.
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil {
		return false
	}
	host := strings.ToLower(parsed.Host)
	if !strings.HasPrefix(host, "sns.") {
		return false
	}
	return strings.HasSuffix(host, ".amazonaws.com") ||
		strings.HasSuffix(host, ".amazonaws.com.cn")
}

func fetchPublicKey(certURL string) (*rsa.PublicKey, error) {
	if cached, ok := certCache.Load(certURL); ok {
		entry := cached.(*certCacheEntry)
		if time.Since(entry.fetchedAt) < certCacheTTL {
			return entry.pubKey, nil
		}
	}
	resp, err := certHTTPClient.Get(certURL)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCertFetchFailed, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: status %d", ErrCertFetchFailed, resp.StatusCode)
	}
	body, err := readLimited(resp.Body, certMaxResponseBytes)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCertFetchFailed, err)
	}
	pub, err := ParsePEMRSAPublicKey(body)
	if err != nil {
		return nil, err
	}
	certCache.Store(certURL, &certCacheEntry{pubKey: pub, fetchedAt: time.Now()})
	return pub, nil
}

func readLimited(r io.Reader, maxBytes int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, errors.New("response body too large")
	}
	return body, nil
}

// ParsePEMRSAPublicKey decodes a PEM cert and asserts an RSA public key. Used
// by the live fetch path and by test harnesses that seed the cache directly.
func ParsePEMRSAPublicKey(pemBytes []byte) (*rsa.PublicKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, ErrCertParseFailed
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCertParseFailed, err)
	}
	pub, ok := cert.PublicKey.(*rsa.PublicKey)
	if !ok {
		return nil, ErrCertNotRSA
	}
	return pub, nil
}

// SeedCertCache installs a key for a URL. Test-only in practice: it lets a
// suite verify a real signature without reaching the network.
func SeedCertCache(certURL string, key *rsa.PublicKey) {
	certCache.Store(certURL, &certCacheEntry{pubKey: key, fetchedAt: time.Now()})
}

// CanonicalString builds the AWS-spec signing input. The field set differs by
// Type, and each field is `<name>\n<value>\n` in the order below.
func CanonicalString(env Envelope) string {
	var b strings.Builder
	write := func(name, value string) {
		b.WriteString(name)
		b.WriteString("\n")
		b.WriteString(value)
		b.WriteString("\n")
	}
	switch env.Type {
	case "SubscriptionConfirmation", "UnsubscribeConfirmation":
		write("Message", env.Message)
		write("MessageId", env.MessageID)
		write("SubscribeURL", env.SubscribeURL)
		write("Timestamp", env.Timestamp)
		write("Token", env.Token)
		write("TopicArn", env.TopicArn)
		write("Type", env.Type)
	default: // Notification and anything else
		write("Message", env.Message)
		write("MessageId", env.MessageID)
		if env.Subject != "" {
			write("Subject", env.Subject)
		}
		write("Timestamp", env.Timestamp)
		write("TopicArn", env.TopicArn)
		write("Type", env.Type)
	}
	return b.String()
}

func hashCanonical(canonical string, h crypto.Hash) []byte {
	switch h {
	case crypto.SHA1:
		sum := sha1.Sum([]byte(canonical))
		return sum[:]
	case crypto.SHA256:
		sum := sha256.Sum256([]byte(canonical))
		return sum[:]
	default:
		return nil
	}
}

// FailureReason maps an error to a bounded metric label. Bounded on purpose:
// these values become Prometheus label cardinality.
func FailureReason(err error) string {
	switch {
	case errors.Is(err, ErrInvalidCertURL):
		return "invalid_cert_url"
	case errors.Is(err, ErrSignatureMismatch):
		return "signature_mismatch"
	case errors.Is(err, ErrMissingMessageID):
		return "missing_message_id"
	case errors.Is(err, ErrUnsupportedSigVersion):
		return "unsupported_signature_version"
	case errors.Is(err, ErrTopicNotAllowed):
		return "topic_arn_rejected"
	case errors.Is(err, ErrCertFetchFailed):
		return "cert_fetch_failed"
	case errors.Is(err, ErrCertParseFailed):
		return "cert_parse_failed"
	case errors.Is(err, ErrCertNotRSA):
		return "cert_not_rsa"
	case errors.Is(err, ErrMissingSignature):
		return "missing_signature"
	case errors.Is(err, ErrSignatureNotBase64):
		return "signature_not_base64"
	case errors.Is(err, ErrTopicAllowlistEmpty):
		return "topic_allowlist_empty"
	default:
		return "unknown"
	}
}

// ForgetCertCache removes a cached key. Test-only: it lets a suite clean up
// the URL it seeded so cases cannot leak keys into one another.
func ForgetCertCache(certURL string) {
	certCache.Delete(certURL)
}
