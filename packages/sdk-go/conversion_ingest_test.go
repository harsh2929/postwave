package postwave

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestConversionIngestSignsExactSingleAndBatchBytesWithoutBearer(t *testing.T) {
	t.Parallel()

	credentials := SignedConversionCredentials{
		KeyID:  "orders-primary",
		Secret: "sk_conversion_test_super_secret",
	}
	timestamp := time.Unix(1786242151, 0).UTC()
	type capturedRequest struct {
		path, body, signature, timestamp, idempotency, authorization, tenant string
	}
	requests := make([]capturedRequest, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		requests = append(requests, capturedRequest{
			path:          request.URL.Path,
			body:          string(body),
			signature:     request.Header.Get("X-Postwave-Signature"),
			timestamp:     request.Header.Get("X-Postwave-Timestamp"),
			idempotency:   request.Header.Get("Idempotency-Key"),
			authorization: request.Header.Get("Authorization"),
			tenant:        request.Header.Get("X-Tenant-Slug"),
		})
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(request.URL.Path, "/batch") {
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"accepted":2,"conversion_ids":[41,42],"key_id":"orders-primary"}`))
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"accepted":1,"conversion_ids":[40],"key_id":"orders-primary"}`))
	}))
	defer server.Close()

	client := New("pw_dashboard_must_not_leak", WithBaseURL(server.URL), WithMaxRetries(0))
	value := json.Number("129.00")
	input := SignedConversionInput{
		EventName:  "purchase",
		OccurredAt: ptrTime(time.Date(2026, 8, 9, 10, 22, 31, 0, time.UTC)),
		Identity:   SignedConversionIdentity{ExternalID: "customer-1"},
		Value:      &value,
		Currency:   "USD",
		Metadata:   map[string]any{"order_id": "ord-1"},
	}
	single, err := client.ConversionIngest.Ingest(context.Background(), &input, credentials,
		SignedConversionIngestOptions{IdempotencyKey: "order-1", Timestamp: timestamp})
	if err != nil {
		t.Fatal(err)
	}
	second := input
	second.Identity = SignedConversionIdentity{ClickID: "click-2"}
	batch, err := client.ConversionIngest.IngestBatch(context.Background(),
		[]SignedConversionInput{input, second}, credentials,
		SignedConversionIngestOptions{IdempotencyKey: "orders-batch-1", Timestamp: timestamp})
	if err != nil {
		t.Fatal(err)
	}
	if single.Accepted != 1 || batch.Accepted != 2 || len(requests) != 2 {
		t.Fatalf("single=%+v batch=%+v requests=%d", single, batch, len(requests))
	}
	if requests[0].path != "/api/public/conversions/ingest" ||
		requests[1].path != "/api/public/conversions/ingest/batch" {
		t.Fatalf("paths=%+v", requests)
	}
	for _, request := range requests {
		if request.authorization != "" || request.tenant != "" {
			t.Fatalf("HMAC request leaked dashboard auth/tenant: %+v", request)
		}
		if request.timestamp != strconv.FormatInt(timestamp.Unix(), 10) {
			t.Fatalf("timestamp=%q", request.timestamp)
		}
		want := "keyid=" + credentials.KeyID + ",v2=" + independentConversionSignature(
			credentials.Secret, credentials.KeyID, timestamp.Unix(), []byte(request.body),
		)
		if request.signature != want {
			t.Fatalf("signature=%q want=%q body=%s", request.signature, want, request.body)
		}
	}
	if requests[0].idempotency != "order-1" || requests[1].idempotency != "orders-batch-1" {
		t.Fatalf("idempotency=%q/%q", requests[0].idempotency, requests[1].idempotency)
	}
	if !strings.Contains(requests[0].body, `"value":129.00`) {
		t.Fatalf("exact decimal bytes were not preserved: %s", requests[0].body)
	}
}

func TestConversionIngestBindsKeyAndMapsFlatErrors(t *testing.T) {
	t.Parallel()

	body := []byte(`{"event_name":"purchase","identity":{"external_id":"c-1"}}`)
	timestamp := int64(1786242151)
	first, err := ComputeConversionIngestSignature("secret", "key-a", timestamp, body)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ComputeConversionIngestSignature("secret", "key-b", timestamp, body)
	if err != nil {
		t.Fatal(err)
	}
	if first == second || first != independentConversionSignature("secret", "key-a", timestamp, body) {
		t.Fatal("conversion signature is not independently reproducible and key-bound")
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"idempotency_conflict","message":"different bytes"}`))
	}))
	defer server.Close()
	client := New("", WithBaseURL(server.URL), WithMaxRetries(0))
	_, err = client.ConversionIngest.Ingest(context.Background(), &SignedConversionInput{
		EventName: "purchase",
		Identity:  SignedConversionIdentity{ExternalID: "c-1"},
	}, SignedConversionCredentials{KeyID: "key-a", Secret: "secret"})
	apiErr, ok := err.(*Error)
	if !ok || apiErr.Status != http.StatusConflict || apiErr.Code != "idempotency_conflict" || apiErr.Message != "different bytes" {
		t.Fatalf("flat conversion error mapping=%#v", err)
	}
}

func TestComputeConversionEmailHMACSHA256NormalizesAndBindsSecret(t *testing.T) {
	t.Parallel()

	got, err := ComputeConversionEmailHMACSHA256(
		"sk_conversion_test_super_secret", "  Buyer@Example.COM  ",
	)
	if err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha256.New, []byte("sk_conversion_test_super_secret"))
	_, _ = mac.Write([]byte("buyer@example.com"))
	want := hex.EncodeToString(mac.Sum(nil))
	if got != want {
		t.Fatalf("email HMAC = %q, want %q", got, want)
	}
	rotated, err := ComputeConversionEmailHMACSHA256(
		"sk_conversion_test_rotated_secret", "buyer@example.com",
	)
	if err != nil {
		t.Fatal(err)
	}
	if rotated == got {
		t.Fatal("email HMAC must be scoped to the signing secret")
	}
}

func independentConversionSignature(secret, keyID string, timestamp int64, body []byte) string {
	timestampText := strconv.FormatInt(timestamp, 10)
	prefix := "postwave-conversion-v2\n" + strconv.Itoa(len([]byte(keyID))) + "\n" +
		keyID + strconv.Itoa(len([]byte(timestampText))) + "\n" + timestampText
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(prefix))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func ptrTime(value time.Time) *time.Time { return &value }
