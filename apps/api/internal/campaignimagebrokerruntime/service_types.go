// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	TesseractEngine             = "tesseract"
	ClamAVEngine                = "clamav"
	ScannerSandboxProfile       = "postwave.scanner.data-only.v1"
	defaultServiceCallTimeout   = 10 * time.Second
	defaultServiceConcurrency   = 2
	maximumServiceConcurrency   = 16
	maximumServiceRequestBytes  = int64(10 << 20)
	maximumServiceResponseBytes = 64 << 10
)

var (
	ErrExecutableUnavailable = errors.New("campaign image broker runtime: fixed executable unavailable")
	ErrExecutableOutputLimit = errors.New("campaign image broker runtime: executable output limit exceeded")
	ErrExecutableIdentity    = errors.New("campaign image broker runtime: executable identity mismatch")
	ErrServiceTimeout        = errors.New("campaign image broker runtime: sandbox service timed out")
)

// ServiceIdentity is derived from the installed executable. It is never
// accepted merely because an operator supplied the same text in configuration.
type ServiceIdentity struct {
	Engine  string
	Version string
}

func (identity ServiceIdentity) valid() bool {
	return methodIdentityPattern.MatchString(identity.Engine) &&
		methodIdentityPattern.MatchString(identity.Version)
}

type OCRServiceInput struct {
	RasterPNG   []byte
	Width       int
	Height      int
	LanguageTag string
}

type OCRServiceOutput struct {
	Text       string
	Language   string
	Confidence *float64
}

// OCRServiceExecutor exposes only fixed-capability pixel recognition. The
// production implementation accepts PNG bytes on stdin and cannot receive a
// URL, path, shell fragment, callback, browser, credential, or tool choice.
type OCRServiceExecutor interface {
	Identity(context.Context) (ServiceIdentity, error)
	Recognize(context.Context, OCRServiceInput) (OCRServiceOutput, error)
}

// ScannerServiceExecutor exposes only a content verdict over provided bytes.
// The production implementation invokes the fixed local ClamAV executable and
// includes the signature-database revision in Identity.Version.
type ScannerServiceExecutor interface {
	Identity(context.Context) (ServiceIdentity, error)
	Scan(context.Context, []byte) error
}

type OCRServiceServerConfig struct {
	SocketPath       string
	SocketMode       os.FileMode
	AllowedClientUID int
	ExpectedIdentity ServiceIdentity
	Executor         OCRServiceExecutor
	Isolation        DataOnlyIsolationAttestation
	CallTimeout      time.Duration
	MaxRequestBytes  int64
	MaxResponseBytes int
	MaxConcurrent    int
}

type ScannerServiceServerConfig struct {
	SocketPath       string
	SocketMode       os.FileMode
	AllowedClientUID int
	ExpectedIdentity ServiceIdentity
	Executor         ScannerServiceExecutor
	Isolation        DataOnlyIsolationAttestation
	CallTimeout      time.Duration
	MaxRequestBytes  int64
	MaxResponseBytes int
	MaxConcurrent    int
}

type serviceRejection struct {
	code  string
	cause error
}

func (failure *serviceRejection) Error() string {
	if failure == nil {
		return "campaign image sandbox service rejected input"
	}
	if failure.cause == nil {
		return failure.code
	}
	return failure.code + ": " + failure.cause.Error()
}

func (failure *serviceRejection) Unwrap() error {
	if failure == nil {
		return nil
	}
	return failure.cause
}

func rejectService(code string, cause error) error {
	if !methodIdentityPattern.MatchString(code) {
		code = "service.execution_failed"
	}
	return &serviceRejection{code: code, cause: cause}
}

func serviceRejectionCode(err error, fallback string) string {
	var rejection *serviceRejection
	if errors.As(err, &rejection) && rejection != nil && methodIdentityPattern.MatchString(rejection.code) {
		return rejection.code
	}
	return fallback
}

func normalizeServiceServerConfig(
	path string,
	mode os.FileMode,
	allowedUID int,
	identity ServiceIdentity,
	isolation DataOnlyIsolationAttestation,
	timeout time.Duration,
	maxRequest int64,
	maxResponse int,
	maxConcurrent int,
) (os.FileMode, time.Duration, int64, int, int, error) {
	if mode == 0 {
		mode = 0o600
	}
	if timeout == 0 {
		timeout = defaultServiceCallTimeout
	}
	if maxRequest == 0 {
		maxRequest = maximumServiceRequestBytes
	}
	if maxResponse == 0 {
		maxResponse = maximumServiceResponseBytes
	}
	if maxConcurrent == 0 {
		maxConcurrent = defaultServiceConcurrency
	}
	if err := validateUnixService(path, identity.Engine, identity.Version,
		timeout, maxRequest, maxResponse); err != nil || mode != mode.Perm() ||
		mode.Perm() != 0o600 || allowedUID < 0 || !identity.valid() || !isolation.valid() ||
		maxConcurrent < 1 || maxConcurrent > maximumServiceConcurrency {
		return 0, 0, 0, 0, 0, ErrInvalidConfiguration
	}
	return mode.Perm(), timeout, maxRequest, maxResponse, maxConcurrent, nil
}

// RejectImageSandboxCredentialEnvironment prevents the OCR and scanner
// processes from starting with application/provider credentials. Linux
// seccomp independently denies internet sockets, but credentials are rejected
// as a separate layer so a future process-boundary regression still fails
// closed.
func RejectImageSandboxCredentialEnvironment(environment []string) error {
	for _, entry := range environment {
		name, value, found := strings.Cut(entry, "=")
		name = strings.ToUpper(strings.TrimSpace(name))
		if !found || name == "" || strings.TrimSpace(value) == "" {
			continue
		}
		if imageSandboxCredentialName(name) {
			return fmt.Errorf("%s must not be present in a data-only image service", name)
		}
	}
	return nil
}

func imageSandboxCredentialName(name string) bool {
	switch name {
	case "DATABASE_URL", "POSTWAVE_DATABASE_URL", "REDIS_URL",
		"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
		"AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_SHARED_CREDENTIALS_FILE",
		"AWS_CONFIG_FILE", "AWS_PROFILE", "GOOGLE_APPLICATION_CREDENTIALS",
		"GEMINI_API_KEY", "POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY":
		return true
	}
	for _, suffix := range []string{
		"_API_KEY", "_ACCESS_TOKEN", "_AUTH_TOKEN", "_CLIENT_SECRET",
		"_PRIVATE_KEY", "_SECRET_ACCESS_KEY", "_PASSWORD",
	} {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}
