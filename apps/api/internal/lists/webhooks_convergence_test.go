package lists

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

func TestListWebhookEventCatalogMatchesProducedCanonicalEvent(t *testing.T) {
	t.Parallel()

	if len(webhookEventCatalog) != 1 {
		t.Fatalf("list webhook event catalog has %d events, want exactly 1 produced event", len(webhookEventCatalog))
	}
	if _, ok := webhookEventCatalog[outbound_webhooks.EventListSubscriberAdded]; !ok {
		t.Fatalf("list webhook event catalog does not contain %q", outbound_webhooks.EventListSubscriberAdded)
	}
}

func TestProjectCanonicalListWebhookNeverProjectsSigningSecret(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	projected := projectCanonicalListWebhook(&outbound_webhooks.Webhook{
		ID:                   "webhook-id",
		URL:                  "https://receiver.example/…",
		Description:          "List receiver",
		Events:               []string{outbound_webhooks.EventListSubscriberAdded},
		Active:               true,
		URLStatus:            "ready",
		AuthConfigStatus:     "ready",
		DeliveryPolicyStatus: "ready",
		CreatedAt:            now,
		UpdatedAt:            now,
	})
	if projected == nil {
		t.Fatal("projection is nil")
	}
	if projected.SigningSecret != "" {
		t.Fatal("ordinary projection exposed signing material")
	}
	if projected.URL != "https://receiver.example/…" {
		t.Fatalf("projection replaced canonical display-only destination: %q", projected.URL)
	}
	if projected.URLStatus != "ready" ||
		projected.AuthConfigStatus != "ready" ||
		projected.DeliveryPolicyStatus != "ready" {
		t.Fatalf("projection lost readiness state: %#v", projected)
	}
}

func TestRequestWithCanonicalWebhookIDUsesVerifiedChildID(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest(http.MethodPost, "/api/v1/lists/list-id/webhooks/webhook-id/test", nil)
	canonical := requestWithCanonicalWebhookID(request, "verified-webhook-id")
	if got := chi.URLParam(canonical, "id"); got != "verified-webhook-id" {
		t.Fatalf("canonical id = %q, want verified child webhook id", got)
	}
}

func TestListWebhookRotationGraceWindowValidation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		query       string
		wantMinutes int
		wantError   bool
	}{
		{query: "", wantMinutes: 1440},
		{query: "?grace_minutes=1", wantMinutes: 1},
		{query: "?grace_minutes=10080", wantMinutes: 10080},
		{query: "?grace_minutes=", wantError: true},
		{query: "?grace_minutes=0", wantError: true},
		{query: "?grace_minutes=10081", wantError: true},
		{query: "?grace_minutes=1&grace_minutes=2", wantError: true},
	}
	for _, test := range tests {
		test := test
		t.Run(test.query, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(
				http.MethodPost,
				"/api/v1/lists/list/webhooks/hook/rotate-secret"+test.query,
				nil,
			)
			got, err := listWebhookRotationGraceMinutes(request)
			if test.wantError {
				if err == nil {
					t.Fatalf("minutes = %d, want validation error", got)
				}
				return
			}
			if err != nil || got != test.wantMinutes {
				t.Fatalf("minutes = %d, error = %v, want %d", got, err, test.wantMinutes)
			}
		})
	}
}

func TestListWebhookOneTimeSecretOperationsRequireOneBoundedIdempotencyKey(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		values    []string
		wantKey   string
		wantError error
	}{
		{name: "missing", wantError: errListWebhookIdempotencyRequired},
		{
			name:      "blank",
			values:    []string{"   "},
			wantError: errListWebhookIdempotencyRequired,
		},
		{
			name:      "multiple",
			values:    []string{"create-1", "create-2"},
			wantError: errListWebhookIdempotencyInvalid,
		},
		{
			name:      "oversized",
			values:    []string{strings.Repeat("k", idempotency.MaxKeyLength+1)},
			wantError: errListWebhookIdempotencyInvalid,
		},
		{
			name:      "control character",
			values:    []string{"create\n1"},
			wantError: errListWebhookIdempotencyInvalid,
		},
		{
			name:      "invalid UTF-8",
			values:    []string{string([]byte{0xff})},
			wantError: errListWebhookIdempotencyInvalid,
		},
		{
			name:    "valid",
			values:  []string{"  create-list-webhook-1  "},
			wantKey: "create-list-webhook-1",
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			header := make(http.Header)
			if test.values != nil {
				header[idempotency.HeaderName] = test.values
			}
			got, err := requiredListWebhookIdempotencyKey(header)
			if test.wantError != nil {
				if !errors.Is(err, test.wantError) {
					t.Fatalf("error = %v, want %v", err, test.wantError)
				}
				return
			}
			if err != nil || got != test.wantKey {
				t.Fatalf("key = %q, error = %v, want %q", got, err, test.wantKey)
			}
		})
	}
}

func TestListWebhookOneTimeSecretHandlersRejectInvalidIdempotencyKeysFirst(t *testing.T) {
	t.Parallel()

	handlers := []struct {
		name    string
		handler http.HandlerFunc
		path    string
	}{
		{
			name:    "create",
			handler: (&Deps{}).CreateWebhook,
			path:    "/api/v1/lists/list-id/webhooks",
		},
		{
			name:    "rotate",
			handler: (&Deps{}).RotateWebhookSecret,
			path:    "/api/v1/lists/list-id/webhooks/webhook-id/rotate-secret",
		},
	}
	idempotencyCases := []struct {
		name     string
		values   []string
		wantCode string
	}{
		{
			name:     "missing",
			wantCode: "idempotency_key_required",
		},
		{
			name:     "blank",
			values:   []string{"   "},
			wantCode: "idempotency_key_required",
		},
		{
			name:     "multiple",
			values:   []string{"operation-1", "operation-2"},
			wantCode: "idempotency_key_invalid",
		},
		{
			name:     "oversized",
			values:   []string{strings.Repeat("k", idempotency.MaxKeyLength+1)},
			wantCode: "idempotency_key_invalid",
		},
		{
			name:     "control character",
			values:   []string{"operation\n1"},
			wantCode: "idempotency_key_invalid",
		},
		{
			name:     "invalid UTF-8",
			values:   []string{string([]byte{0xff})},
			wantCode: "idempotency_key_invalid",
		},
	}

	for _, handler := range handlers {
		handler := handler
		t.Run(handler.name, func(t *testing.T) {
			t.Parallel()

			for _, idempotencyCase := range idempotencyCases {
				idempotencyCase := idempotencyCase
				t.Run(idempotencyCase.name, func(t *testing.T) {
					t.Parallel()

					response := httptest.NewRecorder()
					request := httptest.NewRequest(http.MethodPost, handler.path, nil)
					if idempotencyCase.values != nil {
						request.Header[idempotency.HeaderName] = idempotencyCase.values
					}
					handler.handler(response, request)

					if response.Code != http.StatusBadRequest {
						t.Fatalf(
							"status = %d, want 400; body=%s",
							response.Code,
							response.Body.String(),
						)
					}
					if !strings.Contains(
						response.Body.String(),
						`"`+idempotencyCase.wantCode+`"`,
					) {
						t.Fatalf(
							"missing typed idempotency error %q: %s",
							idempotencyCase.wantCode,
							response.Body.String(),
						)
					}
				})
			}
		})
	}
}

func TestListWebhookStoreErrorsAreActionable(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{"missing", errWebhookMissing, http.StatusNotFound, "not_found"},
		{"description", outbound_webhooks.ErrInvalidDescription, http.StatusBadRequest, "invalid_description"},
		{"list", outbound_webhooks.ErrListNotFound, http.StatusNotFound, "list_not_found"},
		{"asymmetric", errListWebhookRotationRequiresHMAC, http.StatusConflict, "list_rotation_requires_hmac"},
		{"auth", outbound_webhooks.ErrAuthConfigInvalid, http.StatusConflict, "receiver_auth_unavailable"},
		{"destination", outbound_webhooks.ErrDestinationPending, http.StatusConflict, "destination_unavailable"},
		{"policy", outbound_webhooks.ErrDeliveryPolicyInvalid, http.StatusConflict, "delivery_configuration_invalid"},
		{"cipher", outbound_webhooks.ErrCipherUnconfigured, http.StatusServiceUnavailable, "cipher_unconfigured"},
	}
	deps := &Deps{}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPatch, "/compatibility", nil)
			deps.writeListWebhookStoreError(response, request, test.err)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.wantStatus, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), `"`+test.wantCode+`"`) {
				t.Fatalf("body does not contain code %q: %s", test.wantCode, response.Body.String())
			}
		})
	}
}

func TestListWebhookCompatibilitySourceHasNoLegacySecretOrDeliveryPath(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("webhooks.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	for _, forbidden := range []string{
		"INSERT INTO list_webhook_deliveries",
		"ListWebhookDeliveries(",
		"RecordListWebhookDelivery(",
		"secretBytes :=",
		"X-Postwave-Test",
		"http.NewRequestWithContext",
	} {
		if strings.Contains(source, forbidden) {
			t.Errorf("legacy list webhook path remains in source: %q", forbidden)
		}
	}
	for _, required := range []string{
		"r.OutboundWebhooks.Create(",
		"r.OutboundWebhooks.Update(",
		"r.OutboundWebhooks.Delete(",
		"r.OutboundWebhooks.Get(",
		"r.OutboundWebhooks.ListForListPage(",
		"d.canonicalOutboundWebhookDeps().Test(",
		"d.canonicalOutboundWebhookDeps().Deliveries(",
		"r.OutboundWebhooks.Rotate(",
		"if webhook.ListID != listUUID",
		"projected.SigningSecret = created.SigningSecret",
		"safeAuditWebhook.SigningSecret = \"\"",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("canonical convergence contract missing from source: %q", required)
		}
	}

	listStart := strings.Index(source, "func (r *Repo) ListWebhooksForList(")
	if listStart < 0 {
		t.Fatal("ListWebhooksForList source start not found")
	}
	listEnd := strings.Index(source[listStart:], "\n// GetListWebhook")
	if listEnd < 0 {
		t.Fatal("ListWebhooksForList source boundaries not found")
	}
	listMethod := source[listStart : listStart+listEnd]
	parentCheck := strings.Index(listMethod, "r.GetListBigintIDByUUID(")
	childQuery := strings.Index(listMethod, "r.OutboundWebhooks.ListForListPage(")
	if parentCheck < 0 || childQuery < 0 || parentCheck > childQuery {
		t.Error("list webhook catalog must validate tenant-owned parent before querying children")
	}
}
