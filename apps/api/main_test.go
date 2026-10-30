package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/uploads"
	"github.com/postwave/postwave/apps/api/internal/warehouse"
)

type readinessCipher struct {
	encryptErr error
	decryptErr error
	corrupt    bool
}

func (c readinessCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	if c.encryptErr != nil {
		return nil, c.encryptErr
	}
	return append([]byte("sealed:"), plaintext...), nil
}

func (c readinessCipher) Decrypt(_ context.Context, blob, _ []byte) ([]byte, error) {
	if c.decryptErr != nil {
		return nil, c.decryptErr
	}
	if c.corrupt {
		return []byte("different"), nil
	}
	return append([]byte(nil), blob[len("sealed:"):]...), nil
}

func TestProductionEnvDetection(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	if !isProductionEnv() {
		t.Fatalf("expected production env")
	}
}

func TestCORSExposesRecoveryAndConcurrencyHeaders(t *testing.T) {
	exposed := make(map[string]bool, len(browserExposedResponseHeaders))
	for _, header := range browserExposedResponseHeaders {
		exposed[http.CanonicalHeaderKey(header)] = true
	}
	for _, required := range []string{
		"Idempotent-Replayed",
		"Idempotent-Replay",
		"X-Idempotent-Replay",
		"ETag",
		"Location",
		"Retry-After",
		// A cross-origin client that cannot read this cannot tell a
		// re-authentication challenge from a dead session, and the honest
		// fallback is to log the user out — which is the behaviour step-up
		// exists to prevent. Clients also read the body code, so losing the
		// header degrades rather than breaks; pinned anyway, because "degrades
		// silently on one surface" is how the desktop shell ends up behaving
		// differently from web for reasons nobody can see.
		"X-Postwave-Step-Up",
		"X-Postwave-Sending-Cap-Outcome",
		"X-Postwave-Agency-Mutation-Outcome",
	} {
		if !exposed[http.CanonicalHeaderKey(required)] {
			t.Errorf("CORS does not expose %s", required)
		}
	}
}

func TestCORSExposesHumanEngagedReachEvidenceHeaders(t *testing.T) {
	exposed := make(map[string]bool, len(browserExposedResponseHeaders))
	for _, header := range browserExposedResponseHeaders {
		exposed[http.CanonicalHeaderKey(header)] = true
	}
	for _, required := range []string{
		"Content-Disposition",
		"Content-Digest",
		"X-Postwave-Artifact-SHA256",
	} {
		if !exposed[http.CanonicalHeaderKey(required)] {
			t.Errorf("CORS does not expose evidence-export header %s", required)
		}
	}
}

func TestPublicConsentMarketingOriginCORSContract(t *testing.T) {
	router := chi.NewRouter()
	router.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"https://app.moosewave.com", "https://moosewave.com"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   browserAllowedRequestHeaders,
		ExposedHeaders:   browserExposedResponseHeaders,
		AllowCredentials: true,
	}))
	deps := &consent.Deps{}
	router.Post("/api/public/consent", deps.PublicRecord)

	preflight := httptest.NewRequest(http.MethodOptions, "/api/public/consent", nil)
	preflight.Header.Set("Origin", "https://moosewave.com")
	preflight.Header.Set("Access-Control-Request-Method", http.MethodPost)
	preflight.Header.Set("Access-Control-Request-Headers", "Content-Type, Idempotency-Key, X-Postwave-Site-Key")
	preflightResult := httptest.NewRecorder()
	router.ServeHTTP(preflightResult, preflight)
	if preflightResult.Code != http.StatusOK {
		t.Fatalf("preflight status=%d body=%s", preflightResult.Code, preflightResult.Body.String())
	}
	if got := preflightResult.Header().Get("Access-Control-Allow-Origin"); got != "https://moosewave.com" {
		t.Fatalf("preflight ACAO=%q", got)
	}
	allowed := strings.ToLower(preflightResult.Header().Get("Access-Control-Allow-Headers"))
	for _, header := range []string{"content-type", "idempotency-key", "x-postwave-site-key"} {
		if !strings.Contains(allowed, header) {
			t.Errorf("preflight did not allow %s: %q", header, allowed)
		}
	}

	request := httptest.NewRequest(http.MethodPost, "/api/public/consent", strings.NewReader(
		`{"visitor_id":"0123456789abcdef","choice":"reject"}`,
	))
	request.Header.Set("Origin", "https://moosewave.com")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Postwave-Site-Key", "pwk_marketing_test")
	request.Header["Idempotency-Key"] = []string{"duplicate-a", "duplicate-b"}
	result := httptest.NewRecorder()
	router.ServeHTTP(result, request)
	if result.Code != http.StatusBadRequest {
		t.Fatalf("early public-consent status=%d body=%s", result.Code, result.Body.String())
	}
	if got := result.Header().Get("Access-Control-Allow-Origin"); got != "https://moosewave.com" {
		t.Fatalf("early public-consent ACAO=%q", got)
	}
	if got := result.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("early public-consent Cache-Control=%q", got)
	}
}

func TestProductionStartupRejectsUnsignedSMSProviderWebhookBypass(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS", "true")
	if err := validateProductionSMSProviderWebhookConfig(); err == nil {
		t.Fatal("production startup accepted POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS")
	}

	t.Setenv("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS", "")
	if err := validateProductionSMSProviderWebhookConfig(); err != nil {
		t.Fatalf("production startup rejected closed SMS webhook config: %v", err)
	}
}

func TestMemoryFallbackGate(t *testing.T) {
	if allowMemoryFallback() {
		t.Fatalf("fallback should default closed")
	}
	t.Setenv("POSTWAVE_ALLOW_MEMORY_FALLBACK", "true")
	if !allowMemoryFallback() {
		t.Fatalf("fallback flag should accept true")
	}
}

func TestVerifyEnvelopeCipher(t *testing.T) {
	t.Parallel()

	if err := verifyEnvelopeCipher(context.Background(), readinessCipher{}); err != nil {
		t.Fatalf("healthy cipher rejected: %v", err)
	}
	for _, test := range []struct {
		name   string
		cipher interface {
			Encrypt(context.Context, []byte) ([]byte, error)
			Decrypt(context.Context, []byte, []byte) ([]byte, error)
		}
	}{
		{name: "missing", cipher: nil},
		{name: "encrypt failure", cipher: readinessCipher{encryptErr: errors.New("kms unavailable")}},
		{name: "decrypt failure", cipher: readinessCipher{decryptErr: errors.New("kms denied")}},
		{name: "corrupt round trip", cipher: readinessCipher{corrupt: true}},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := verifyEnvelopeCipher(context.Background(), test.cipher); err == nil {
				t.Fatal("expected readiness failure")
			}
		})
	}
}

func TestZeroCopyConnectionAvailableRejectsDisconnectedWarehouseRows(t *testing.T) {
	if err := zeroCopyConnectionAvailable(&warehouse.Connection{Status: "active", Direction: "import"}); err != nil {
		t.Fatalf("active connection should pass: %v", err)
	}
	if err := zeroCopyConnectionAvailable(&warehouse.Connection{Status: "disconnected", Direction: "import"}); !errors.Is(err, warehouse.ErrDisconnected) {
		t.Fatalf("disconnected connection error = %v", err)
	}
	if err := zeroCopyConnectionAvailable(&warehouse.Connection{Status: "paused", Direction: "import"}); err == nil {
		t.Fatal("paused connection should fail")
	}
	if err := zeroCopyConnectionAvailable(&warehouse.Connection{Status: "active", Direction: "export"}); err == nil {
		t.Fatal("export-only connection should fail")
	}
	if err := zeroCopyConnectionAvailable(nil); !errors.Is(err, warehouse.ErrNotFound) {
		t.Fatalf("nil connection error = %v", err)
	}
}

func TestValidateProductionUploadStoreConfig(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")

	for _, tc := range []struct {
		name   string
		bucket string
		region string
		kmsKey string
		want   string
	}{
		{name: "missing bucket", region: "us-east-1", kmsKey: "arn:aws:kms:us-east-1:123456789012:key/test", want: "POSTWAVE_UPLOADS_BUCKET"},
		{name: "missing region", bucket: "postwave-uploads", kmsKey: "arn:aws:kms:us-east-1:123456789012:key/test", want: "AWS_REGION"},
		{name: "missing s3 kms key", bucket: "postwave-uploads", region: "us-east-1", want: "POSTWAVE_S3_KMS_KEY_ID"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateProductionUploadStoreConfig(tc.bucket, tc.region, tc.kmsKey)
			if err == nil {
				t.Fatalf("expected production upload config error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q in error, got %v", tc.want, err)
			}
		})
	}

	if err := validateProductionUploadStoreConfig("postwave-uploads", "us-east-1", "arn:aws:kms:us-east-1:123456789012:key/test"); err != nil {
		t.Fatalf("expected configured production uploads to pass: %v", err)
	}
}

func TestValidateProductionUploadStoreConfigAllowsLocalOutsideProduction(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "development")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")

	if err := validateProductionUploadStoreConfig("", "", ""); err != nil {
		t.Fatalf("dev upload config should allow local fallback: %v", err)
	}
}

func TestValidateProductionFormUploadScannerConfig(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")
	if err := validateProductionFormUploadScannerConfig(""); err == nil || !strings.Contains(err.Error(), "POSTWAVE_FORM_UPLOAD_CLAMAV_ADDR") {
		t.Fatalf("missing production scanner error = %v", err)
	}
	if err := validateProductionFormUploadScannerConfig("clamav.internal:3310"); err != nil {
		t.Fatalf("configured production scanner rejected: %v", err)
	}
}

func TestValidateProductionFormUploadScannerConfigAllowsEmptyDevelopment(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "development")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")
	if err := validateProductionFormUploadScannerConfig(""); err != nil {
		t.Fatalf("development scanner should be optional: %v", err)
	}
}

func TestS3FormsAdapterReturnsSignedPutHeaders(t *testing.T) {
	adapter := &s3FormsAdapter{store: &uploads.S3UploadStore{
		SSEKMSKeyID: "arn:aws:kms:us-east-1:123456789012:key/test",
	}}
	headers := adapter.PresignPutHeaders("application/pdf")
	if headers["Content-Type"] != "application/pdf" {
		t.Fatalf("content type = %q", headers["Content-Type"])
	}
	if headers["x-amz-server-side-encryption"] != "aws:kms" {
		t.Fatalf("SSE algorithm = %q", headers["x-amz-server-side-encryption"])
	}
	if headers["x-amz-server-side-encryption-aws-kms-key-id"] != adapter.store.SSEKMSKeyID {
		t.Fatalf("SSE KMS key = %q", headers["x-amz-server-side-encryption-aws-kms-key-id"])
	}
}

func TestPresignedS3PutContractExposesRequiredBrowserHeaders(t *testing.T) {
	previous := formsPresignClient
	formsPresignClient = s3.NewPresignClient(s3.NewFromConfig(aws.Config{
		Region:      "us-east-1",
		Credentials: credentials.NewStaticCredentialsProvider("test-access", "test-secret", ""),
	}))
	t.Cleanup(func() { formsPresignClient = previous })

	rawURL, err := presignPutObject(
		context.Background(),
		"postwave-uploads-test",
		"arn:aws:kms:us-east-1:123456789012:key/test",
		"_forms",
		"tenant/t/form/f/upload/document.pdf",
		"application/pdf",
		123,
		10*time.Minute,
	)
	if err != nil {
		t.Fatalf("presign PUT: %v", err)
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse presigned URL: %v", err)
	}
	signedHeaders := ";" + parsed.Query().Get("X-Amz-SignedHeaders") + ";"
	for _, header := range []string{
		"content-type",
		"x-amz-server-side-encryption",
		"x-amz-server-side-encryption-aws-kms-key-id",
	} {
		if !strings.Contains(signedHeaders, ";"+header+";") {
			t.Fatalf("signed headers %q do not contain %q", signedHeaders, header)
		}
	}
}

func TestJSONRecovererWritesCanonicalEnvelope(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := chimiddleware.RequestID(jsonRecoverer(logger)(http.HandlerFunc(
		func(http.ResponseWriter, *http.Request) {
			panic("database password leaked in panic")
		},
	)))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/panic", nil)
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q", got)
	}
	var body struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"request_id"`
		} `json:"error"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Error.Code != "internal_server_error" {
		t.Fatalf("code = %q", body.Error.Code)
	}
	if body.Error.Message != "Internal server error." {
		t.Fatalf("message leaked details: %q", body.Error.Message)
	}
	if body.Error.RequestID == "" {
		t.Fatalf("request id missing from body")
	}
}

func TestJSONRecovererPreservesIntentionalConnectionAbort(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := jsonRecoverer(logger)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("partial-stream"))
		panic(http.ErrAbortHandler)
	}))

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/export.csv", http.NoBody)
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		handler.ServeHTTP(recorder, request)
	}()
	if recovered != http.ErrAbortHandler {
		t.Fatalf("panic = %#v, want http.ErrAbortHandler", recovered)
	}
	if recorder.Code != http.StatusOK || recorder.Body.String() != "partial-stream" {
		t.Fatalf("pre-abort response = (%d,%q), want (200,%q)", recorder.Code, recorder.Body.String(), "partial-stream")
	}
}
