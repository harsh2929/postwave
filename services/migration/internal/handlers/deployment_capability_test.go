package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
)

func TestDeploymentCapabilityBlocksSubscriberCommitWithoutExactDedicatedDestination(t *testing.T) {
	cap := canonical.AdapterCapabilities{Source: canonical.SourceMailchimp, AuthMethod: "oauth2"}
	cap.Supports.Subscribers = true
	t.Setenv("LISTMONK_TENANT_MODE", "shared")
	t.Setenv("LISTMONK_DEDICATED_TENANT_ID", "")

	result := deploymentCapability(cap, "tenant-a")
	if result.CommitAvailable {
		t.Fatal("subscriber commit advertised on a shared Listmonk destination")
	}
	if result.CommitUnavailableCode != migrationCommitIsolationUnavailable {
		t.Fatalf("commit unavailable code = %q", result.CommitUnavailableCode)
	}

	t.Setenv("LISTMONK_TENANT_MODE", "dedicated")
	t.Setenv("LISTMONK_DEDICATED_TENANT_ID", "tenant-b")
	if deploymentCapability(cap, "tenant-a").CommitAvailable {
		t.Fatal("subscriber commit advertised for the wrong dedicated tenant")
	}

	t.Setenv("LISTMONK_DEDICATED_TENANT_ID", "tenant-a")
	if !deploymentCapability(cap, "tenant-a").CommitAvailable {
		t.Fatal("exact tenant-dedicated destination was not advertised as commit-capable")
	}
}

func TestDeploymentCapabilityBlocksEphemeralUploadIntakeOutsideDevelopment(t *testing.T) {
	cap := canonical.AdapterCapabilities{Source: canonical.SourceCSV, AuthMethod: "csv_upload"}
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("POSTWAVE_ALLOW_EPHEMERAL_MIGRATION_UPLOADS", "1")

	result := deploymentCapability(cap, "tenant-a")
	if result.IntakeAvailable {
		t.Fatal("task-local upload intake advertised in production")
	}
	if result.IntakeUnavailableCode != migrationUploadDurabilityUnavailable {
		t.Fatalf("intake unavailable code = %q", result.IntakeUnavailableCode)
	}
}

func TestProductionUploadEndpointFailsBeforeAcceptingBytes(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	h := NewMigration("", jobstore.NewMemoryJobStore())
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodPut, "/v1/migrations/csv/uploads/upload-a", nil)
	req.Header.Set("X-Tenant-ID", "tenant-a")
	req.Header.Set("Content-Range", "bytes 0-0/1")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
}

func TestOAuthAvailabilityReflectsAppCredentials(t *testing.T) {
	for _, tc := range []struct {
		source canonical.SourcePlatform
		prefix string
	}{{canonical.SourceMailchimp, "MAILCHIMP"}, {canonical.SourceConvertKit, "CONVERTKIT"}} {
		t.Run(string(tc.source), func(t *testing.T) {
			cap := canonical.AdapterCapabilities{Source: tc.source, AuthMethod: "oauth2"}
			t.Setenv(tc.prefix+"_CLIENT_ID", "")
			t.Setenv(tc.prefix+"_CLIENT_SECRET", "")
			result := deploymentCapability(cap, "tenant-a")
			if result.IntakeAvailable || result.IntakeUnavailableCode != migrationOAuthUnavailable {
				t.Fatalf("unconfigured OAuth advertised as available: %+v", result)
			}
			t.Setenv(tc.prefix+"_CLIENT_ID", "test-client")
			t.Setenv(tc.prefix+"_CLIENT_SECRET", "test-secret")
			if !deploymentCapability(cap, "tenant-a").IntakeAvailable {
				t.Fatal("configured OAuth is unavailable")
			}
		})
	}
}

func TestSourcesRejectPersistedDestinationBindingConflict(t *testing.T) {
	tenant := "11111111-1111-4111-8111-111111111111"
	t.Setenv("LISTMONK_TENANT_ROUTES", `[{"tenant_id":"11111111-1111-4111-8111-111111111111","destination_id":"22222222-2222-4222-8222-222222222222","base_url":"https://engine.test","admin_user":"admin","admin_password":"test"}]`)
	h := NewMigration("", jobstore.NewMemoryJobStore())
	calls := 0
	h.SetListmonkClientFactory(func(ctx context.Context) (*listmonkx.Client, error) {
		calls++
		got, _ := jobstore.TenantIDFromContext(ctx)
		if got != tenant {
			t.Fatal("missing tenant")
		}
		return nil, fmt.Errorf("persisted destination was retargeted")
	})
	router := chi.NewRouter()
	h.Mount(router)
	req := httptest.NewRequest(http.MethodGet, "/v1/migrations/sources", nil)
	req.Header.Set("X-Tenant-ID", tenant)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	var caps []migrationDeploymentCapability
	if err := json.Unmarshal(rec.Body.Bytes(), &caps); err != nil {
		t.Fatal(err)
	}
	subscribers := 0
	for _, cap := range caps {
		if cap.Supports.Subscribers {
			subscribers++
			if cap.CommitAvailable || cap.CommitUnavailableCode != migrationCommitIsolationUnavailable {
				t.Fatalf("false readiness: %+v", cap)
			}
		}
	}
	if calls != 1 || subscribers == 0 {
		t.Fatalf("calls=%d subscriber sources=%d", calls, subscribers)
	}
}
