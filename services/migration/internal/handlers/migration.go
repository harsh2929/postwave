// Package handlers exposes the migration service's HTTP API.
//
// Routes are intentionally thin: they parse + validate, hand off to an
// adapter (looked up via the registry), and return JSON/SSE. Job and control
// state are written via the injected MigrationJobStore.
package handlers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/migrate/activecampaign"
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/beehiiv"
	"github.com/postwave/migrate/brevo"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/convertkit"
	"github.com/postwave/migrate/customerio"
	"github.com/postwave/migrate/hubspot"
	"github.com/postwave/migrate/mailchimp"
	"github.com/postwave/postwave/packages/runtime/tenantengine"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

type sourceEventApplyFunc func(context.Context, canonical.MigrationJob, canonical.SourceEvent, int) (jobstore.SourceEventRecord, bool)
type listmonkClientFactory func(context.Context) (*listmonkx.Client, error)

// Migration is the chi-mountable handler set for the migration API.
type Migration struct {
	mu        sync.Mutex
	store     jobstore.MigrationJobStore
	db        *sql.DB
	rollbacks map[string]*orchestrator.RollbackEngine // job_id → engine
	active    map[string]struct{}                     // job_id → in-process runner

	// broadcaster fans the orchestrator's per-batch progress callback out
	// to every SSE subscriber for the same job. Created in NewMigration
	// so even handlers without a backing DB still emit live events.
	broadcaster *progressBroadcaster

	// control gives the owning replica a zero-delay cancellation path. A
	// durable lifecycle marker plus polling covers requests routed elsewhere.
	control *jobControl

	// ownerID identifies this process to the lease-aware store. Generated
	// fresh on every NewMigration so a process restart can immediately
	// re-claim its own (now-expired) leases.
	ownerID string

	// RedirectURI is the absolute URL the OAuth providers should bounce back
	// to. Configured at construction so handlers stay env-agnostic.
	RedirectURI string

	// sourceEventApply is a test seam for source-event replay. Production uses
	// applySourceEvent so replay semantics stay centralized here.
	sourceEventApply sourceEventApplyFunc

	// listmonkClientFactory resolves the destination writer client. Production
	// wires this to the same secrets/env resolver used at startup; tests can
	// inject a local HTTP stub. Nil falls back to LISTMONK_* env vars.
	listmonkClientFactory listmonkClientFactory
	kitSessionRefresher   func(context.Context, adapter.Session) (adapter.Session, error)
}

// LeaseTTL is how long a worker may run a single job before it must renew
// its claim. The recovery loop renews at LeaseTTL/2 intervals while the job
// is alive. A worker that crashes or stalls past this window loses its
// lease and another instance can pick the job up.
const LeaseTTL = 2 * time.Minute

// A cancellation request may arrive at any migration-service replica. Active
// jobs poll the durable lifecycle marker so a non-owner replica can interrupt
// the owning worker, including an in-flight source or destination request.
const durableCancellationPollInterval = 500 * time.Millisecond

const (
	oauthStateTTL                         = 15 * time.Minute
	sessionTTL                            = 30 * 24 * time.Hour
	sourceBridgeSessionTTL                = 90 * 24 * time.Hour
	sourceBridgeNearExpiryWindow          = 14 * 24 * time.Hour
	activeCampaignSourceSessionTTL        = sourceBridgeSessionTTL
	activeCampaignCutoverNearExpiryWindow = sourceBridgeNearExpiryWindow
	defaultMigrationRollbackWindow        = 7 * 24 * time.Hour
	// ActiveCampaign and HubSpot certification intentionally observe source
	// changes for at least seven full days after the base commit. Keep a second
	// seven-day cushion so a failed final delta can still restore and roll back
	// the retained base import instead of crossing its cleanup deadline.
	activeCampaignRollbackWindow = 14 * 24 * time.Hour
)

func migrationRollbackWindow(source canonical.SourcePlatform) time.Duration {
	if source == canonical.SourceActiveCampaign || source == canonical.SourceHubSpot || source == canonical.SourceKlaviyo {
		return activeCampaignRollbackWindow
	}
	return defaultMigrationRollbackWindow
}

// cancelledByOperatorMsg is the canonical job error recorded when an
// operator cancels a run via DELETE /v1/migrations/{id}. The job store
// has no first-class "cancelled" status — a cancelled run persists as
// status=failed plus this message. Both the desktop's cancelled-import
// banner (matches /cancel/i) and ResumeJob's eligibility check key off
// it, so keep the wording stable.
const cancelledByOperatorMsg = "migration cancelled by operator"

var (
	errOperatorCancelled         = errors.New(cancelledByOperatorMsg)
	errWorkerLeaseLost           = errors.New("migration worker lease lost")
	errHubSpotLineageConflict    = errors.New("HubSpot account already has an unrolled-back migration lineage")
	errKlaviyoLineageConflict    = errors.New("Klaviyo account already has an unrolled-back migration lineage")
	errCustomerIOLineageConflict = errors.New("Customer.io workspace already has an unrolled-back migration lineage")
)

type hubSpotLineageConflictError struct {
	jobID string
}

func (e *hubSpotLineageConflictError) Error() string {
	return fmt.Sprintf("HubSpot account already has unrolled-back migration job %s; reconnect or continue that job, use delta-import after it completes, or roll it back before starting a new migration", e.jobID)
}

func (e *hubSpotLineageConflictError) Unwrap() error {
	return errHubSpotLineageConflict
}

type klaviyoLineageConflictError struct {
	jobID string
}

func (e *klaviyoLineageConflictError) Error() string {
	return fmt.Sprintf("Klaviyo account already has unrolled-back migration job %s; reconnect or continue that job, use delta-import after it completes, or roll it back before starting a new migration", e.jobID)
}

func (e *klaviyoLineageConflictError) Unwrap() error {
	return errKlaviyoLineageConflict
}

type customerIOLineageConflictError struct {
	jobID string
}

func (e *customerIOLineageConflictError) Error() string {
	return fmt.Sprintf("Customer.io workspace already has unrolled-back migration job %s; reconnect or continue that job, use delta-import after it completes, or roll it back before starting a new migration", e.jobID)
}

func (e *customerIOLineageConflictError) Unwrap() error {
	return errCustomerIOLineageConflict
}

// runModeCursorKey is the Cursor-map slot where kickoff records whether
// the run was a dry-run or a commit, so resume-after-cancel restarts in
// the same mode. Lives next to the per-resource checkpoints because the
// Cursor map is the only durable per-run ledger the job carries.
const (
	runModeCursorKey               = "run_mode"
	selectedAudiencesCursorKey     = "mailchimp_selected_audience_ids"
	mailchimpAccountCursorKey      = "mailchimp_account_fingerprint"
	brevoAccountCursorKey          = "brevo_organization_id"
	kitAccountCursorKey            = "kit_account_id"
	activeCampaignAccountCursorKey = "activecampaign_account_fingerprint"
	hubSpotAccountCursorKey        = "hubspot_account_fingerprint"
	hubSpotDataLocationCursorKey   = "hubspot_data_hosting_location"
	klaviyoAccountCursorKey        = "klaviyo_account_fingerprint"
	customerIOWorkspaceCursorKey   = "customerio_workspace_fingerprint"
	customerIOWorkspaceIDCursorKey = "customerio_workspace_id"
	customerIORegionCursorKey      = "customerio_region"
	beehiivAccountCursorKey        = "beehiiv_account_fingerprint"
	beehiivWorkspaceCursorKey      = "beehiiv_workspace_fingerprint"
	beehiivPublicationCursorKey    = "beehiiv_publication_id"
	deltaImportSnapshotKey         = "delta_import_previous_job"
	deltaImportLastErrorKey        = "delta_import_last_error"
	deltaImportStartedAtKey        = "delta_import_started_at"
	sourceEventPreDeltaSyncedKey   = "source_event_synced_before_delta_at"
	sourceEventOverlapSnapshotKey  = "source_event_overlap_snapshot_v1"
	rateLimitRetryAtCursorKey      = "rate_limit_retry_at"
	rateLimitRetryAfterCursorKey   = "rate_limit_retry_after"
	// MIGR-038: an optional future RFC3339Nano UTC instant. While set and in the
	// future, the recovery worker holds the job (mirrors the rate-limit deferral).
	scheduledStartAtCursorKey      = "scheduled_start_at"
	rollbackRehearsalStatusKey     = "rollback_rehearsal_status"
	rollbackRehearsalAtKey         = "rollback_rehearsal_generated_at"
	rollbackRehearsalTotalKey      = "rollback_rehearsal_total_resources"
	rollbackRehearsalSourceKey     = "rollback_rehearsal_count_source"
	rollbackRehearsalValidationKey = "rollback_rehearsal_destination_validation"
	rollbackRehearsalValidationV1  = "read_only_destination_preflight_v1"
	acDeliverabilityStatusKey      = "activecampaign_deliverability_status"
	acDeliverabilityAtKey          = "activecampaign_deliverability_reviewed_at"
	acDeliverabilityDetailKey      = "activecampaign_deliverability_detail"
	acDeliverabilityEvidenceKey    = "activecampaign_deliverability_evidence"
	runModeImporting               = "importing"
	runModeDryRun                  = "dry_run"
	runModeDeltaImport             = "delta_import"
)

const defaultRateLimitRetryAfter = 30 * time.Second

// NewMigration constructs a handler with the given OAuth callback URL.
func NewMigration(redirectURI string, stores ...jobstore.MigrationJobStore) *Migration {
	store := jobstore.MigrationJobStore(jobstore.NewMemoryJobStore())
	if len(stores) > 0 && stores[0] != nil {
		store = stores[0]
	}
	return &Migration{
		store:       store,
		rollbacks:   map[string]*orchestrator.RollbackEngine{},
		active:      map[string]struct{}{},
		broadcaster: newProgressBroadcaster(),
		control:     newJobControl(),
		ownerID:     newOwnerID(),
		RedirectURI: redirectURI,
	}
}

// newOwnerID returns a fresh per-process UUID-shaped id used as the lease
// owner in migration_jobs. Format-compatible with PostgreSQL's uuid type
// (the column is uuid-typed). We keep the implementation tiny + dep-free
// to avoid pulling another uuid library into the migration service.
func newOwnerID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		seed := fmt.Sprintf("migration:%d:%d:%v", os.Getpid(), time.Now().UnixNano(), err)
		sum := sha256.Sum256([]byte(seed))
		copy(b[:], sum[:16])
	}
	// RFC 4122 v4 markers
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// NewMigrationWithDB constructs a handler that can persist imported
// Moosewave-owned resources and roll them back by job id.
func NewMigrationWithDB(redirectURI string, store jobstore.MigrationJobStore, db *sql.DB) *Migration {
	h := NewMigration(redirectURI, store)
	h.db = db
	return h
}

// SetListmonkClientFactory configures how commit, rollback, and source-event
// replay resolve the Listmonk destination client.
func (h *Migration) SetListmonkClientFactory(factory func(context.Context) (*listmonkx.Client, error)) {
	h.listmonkClientFactory = factory
}

func (h *Migration) listmonkClient(ctx context.Context) (*listmonkx.Client, error) {
	if h != nil && h.listmonkClientFactory != nil {
		return h.listmonkClientFactory(ctx)
	}
	return listmonkx.NewClientFromEnv()
}

// Mount registers all routes onto a chi router under /v1.
func (h *Migration) Mount(r chi.Router) {
	r.Route("/v1/migrations", func(r chi.Router) {
		r.Use(migrationBuildIdentity)
		r.Get("/", h.ListJobs)
		r.Get("/sources", h.ListSources)
		r.Get("/capabilities", h.ListSources)
		r.Post("/{source}/oauth/start", h.OAuthStart)
		r.Get("/{source}/oauth/callback", h.OAuthCallback)
		r.Post("/{source}/credentials", h.Credentials)
		r.Put("/{source}/uploads/{upload_id}", h.UploadChunk)
		r.Get("/{source}/uploads/{upload_id}", h.UploadStatus)
		r.Post("/{source}/uploads/{upload_id}/complete", h.CompleteUpload)
		r.Post("/{source}/discover", h.Discover)
		r.Post("/{source}/shadow-check", h.ShadowCheck)
		// Start-monitor routes carry a source slug, whereas GET/DELETE monitor
		// routes below carry a job id. Keep the templates structurally distinct
		// so OpenAPI clients and routers cannot conflate the two identifiers.
		r.Post("/sources/{source}/shadow-monitor", h.StartShadowMonitor)
		r.Post("/sources/{source}/source-events", h.StartSourceEventMonitor)
		// Deprecated pre-0.2 compatibility aliases. Retain them for existing
		// clients during the route transition, but do not advertise them in the
		// public OpenAPI contract.
		r.Post("/{source}/shadow-monitor", h.StartShadowMonitor)
		r.Post("/{source}/source-events", h.StartSourceEventMonitor)
		r.Post("/{source}/dry-run", h.DryRun)
		r.Post("/{source}/commit", h.Commit)
		r.Post("/{source}/delta-import", h.DeltaImport)
		r.Get("/{job_id}", h.GetJob)
		r.Patch("/{job_id}", h.UpdateJob)
		r.Delete("/{job_id}", h.CancelJob)
		r.Post("/{job_id}/resume", h.ResumeJob)
		r.Post("/{job_id}/source-session", h.RefreshSourceSession)
		r.Delete("/{job_id}/source-session", h.DeleteSourceSession)
		r.Get("/{job_id}/events", h.GetJobEvents)
		r.Get("/{job_id}/verification", h.GetVerification)
		r.Get("/{job_id}/shadow-monitor", h.GetShadowMonitor)
		r.Delete("/{job_id}/shadow-monitor", h.StopShadowMonitor)
		r.Get("/{job_id}/source-events", h.GetSourceEventMonitor)
		r.Delete("/{job_id}/source-events", h.StopSourceEventMonitor)
		r.Patch("/{job_id}/source-events/{event_id}/review", h.UpdateSourceEventReview)
		r.Get("/{job_id}/pilot-acceptance", h.GetPilotAcceptance)
		r.Patch("/{job_id}/cutover-evidence", h.UpdateCutoverEvidence)
		r.Get("/{job_id}/rollback-rehearsal", h.GetRollbackRehearsal)
		r.Get("/{job_id}/automation-rebuilds", h.ListAutomationRebuilds)
		r.Patch("/{job_id}/automation-rebuilds", h.UpdateAutomationRebuilds)
		r.Post("/{job_id}/rollback", h.StartRollback)
		r.Get("/{job_id}/rollback-status", h.GetRollbackStatus)
		r.Get("/{job_id}/audit", h.GetAudit)
	})
}

// ListJobs returns recent migration jobs for the authenticated tenant.
func (h *Migration) ListJobs(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	rows, err := h.store.List(jobstore.WithTenantID(r.Context(), tenantID), tenantID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	for i := range rows {
		h.decorateJobSessionInfo(r.Context(), tenantID, &rows[i])
		sanitizeMigrationJobForResponse(&rows[i])
	}
	writeJSON(w, http.StatusOK, rows)
}

// ListSources returns the registered migration adapters and their capability
// matrix. Both /sources and /capabilities are supported for SDK/UI backwards
// compatibility.
func (h *Migration) ListSources(w http.ResponseWriter, r *http.Request) {
	sources := adapter.Sources()
	sort.Slice(sources, func(i, j int) bool { return sources[i] < sources[j] })
	tenantID, _ := tenantIDFromRequest(r)
	// The registry alone is insufficient: a persisted binding may reject a
	// retargeted instance. Use the same factory and isolation check as commit.
	destinationAvailable := listmonkCommitAvailableForTenant(tenantID)
	if destinationAvailable && strings.TrimSpace(os.Getenv(tenantengine.RoutesEnv)) != "" {
		client, err := h.listmonkClient(jobstore.WithTenantID(r.Context(), tenantID))
		destinationAvailable = err == nil && client != nil && client.ValidateMigrationIsolation(tenantID) == nil
	}
	out := make([]migrationDeploymentCapability, 0, len(sources))
	for _, source := range sources {
		ad, err := adapter.Get(source)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		capability := deploymentCapability(ad.Capabilities(), tenantID)
		if capability.AuthMethod == "oauth2" {
			if ready, _ := h.oauthReady(source); !ready {
				capability.IntakeAvailable = false
				capability.IntakeUnavailableCode = migrationOAuthUnavailable
			}
		}
		if capability.Supports.Subscribers && !destinationAvailable {
			capability.CommitAvailable = false
			capability.CommitUnavailableCode = migrationCommitIsolationUnavailable
		}
		out = append(out, capability)
	}
	writeJSON(w, http.StatusOK, out)
}

const (
	migrationCommitIsolationUnavailable  = "tenant_destination_not_isolated"
	migrationUploadDurabilityUnavailable = "durable_upload_storage_unavailable"
	migrationOAuthUnavailable            = "oauth_app_not_configured"
)

type migrationDeploymentCapability struct {
	canonical.AdapterCapabilities
	IntakeAvailable       bool   `json:"intake_available"`
	IntakeUnavailableCode string `json:"intake_unavailable_code,omitempty"`
	CommitAvailable       bool   `json:"commit_available"`
	CommitUnavailableCode string `json:"commit_unavailable_code,omitempty"`
}

func deploymentCapability(cap canonical.AdapterCapabilities, tenantID string) migrationDeploymentCapability {
	result := migrationDeploymentCapability{
		AdapterCapabilities: cap,
		IntakeAvailable:     true,
		CommitAvailable:     true,
	}
	if cap.AuthMethod == "csv_upload" && !migrationUploadsAllowed() {
		result.IntakeAvailable = false
		result.IntakeUnavailableCode = migrationUploadDurabilityUnavailable
	}
	if cap.AuthMethod == "oauth2" {
		if configured, _ := oauthConfigured(cap.Source); !configured {
			result.IntakeAvailable = false
			result.IntakeUnavailableCode = migrationOAuthUnavailable
		}
	}
	if cap.Supports.Subscribers && !listmonkCommitAvailableForTenant(tenantID) {
		result.CommitAvailable = false
		result.CommitUnavailableCode = migrationCommitIsolationUnavailable
	}
	return result
}

func listmonkCommitAvailableForTenant(tenantID string) bool {
	if strings.TrimSpace(os.Getenv(tenantengine.RoutesEnv)) != "" {
		routes, err := tenantengine.FromEnv()
		if err != nil {
			return false
		}
		_, err = routes.Resolve(tenantID)
		return err == nil
	}
	return strings.EqualFold(strings.TrimSpace(os.Getenv("LISTMONK_TENANT_MODE")), "dedicated") &&
		strings.TrimSpace(tenantID) != "" &&
		strings.TrimSpace(os.Getenv("LISTMONK_DEDICATED_TENANT_ID")) == strings.TrimSpace(tenantID)
}

func ephemeralMigrationUploadsAllowed() bool {
	environment := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		os.Getenv("POSTWAVE_ENV"),
		os.Getenv("ENVIRONMENT"),
		os.Getenv("NODE_ENV"),
	)))
	if environment == "production" || environment == "prod" {
		return false
	}
	if os.Getenv("POSTWAVE_ALLOW_EPHEMERAL_MIGRATION_UPLOADS") == "1" {
		return true
	}
	switch environment {
	case "", "development", "dev", "test", "local":
		return true
	default:
		return false
	}
}

// OAuthStart returns the authorize URL for the chosen source plus a CSRF state.
func (h *Migration) OAuthStart(w http.ResponseWriter, r *http.Request) {
	source := canonical.SourcePlatform(chi.URLParam(r, "source"))
	if _, err := adapter.Get(source); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	oauthOK, oauthMessage := h.oauthReady(source)
	if !oauthOK && !localDemoMode() {
		writeErr(w, http.StatusServiceUnavailable, errors.New(oauthMessage))
		return
	}
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	state := randomState()
	if reconnectJobID := strings.TrimSpace(r.URL.Query().Get("job_id")); reconnectJobID != "" {
		job, err := h.loadJob(r.Context(), tenantID, reconnectJobID)
		if err != nil {
			writeJobStoreErr(w, err)
			return
		}
		if job.Source != source {
			writeErr(w, http.StatusConflict, fmt.Errorf("job source %q does not match OAuth source %q", job.Source, source))
			return
		}
		if migrationJobSessionRefreshRunning(job.Status) {
			writeErr(w, http.StatusConflict, fmt.Errorf("source session cannot be refreshed while migration job is running"))
			return
		}
		state = oauthStateForJob(state, job.ID)
	}
	now := time.Now()
	if err := h.store.SaveOAuthState(jobstore.WithTenantID(r.Context(), tenantID), jobstore.OAuthStateRecord{
		State:     state,
		Source:    source,
		TenantID:  tenantID,
		CreatedAt: now,
		ExpiresAt: now.Add(oauthStateTTL),
	}); err != nil {
		writeJobStoreErr(w, err)
		return
	}

	if !oauthOK && localDemoMode() {
		writeJSON(w, http.StatusOK, map[string]string{
			"authorize_url": h.localDemoCallbackURL(source, state),
			"state":         state,
		})
		return
	}

	authURL := ""
	redirectURI := h.redirectURI(source)
	switch source {
	case canonical.SourceMailchimp:
		authURL = mailchimp.BuildAuthorizeURL(state, redirectURI)
	case canonical.SourceConvertKit:
		authURL = convertkit.BuildAuthorizeURL(state, redirectURI)
	case canonical.SourceBrevo:
		// This Brevo adapter uses API keys; the desktop app intercepts this
		// custom scheme and renders an API key entry modal instead of opening
		// a browser tab. The state token still ties the eventual /credentials
		// POST back to this start request.
		authURL = brevo.BuildAPIKeyEntryURL(state)
	case canonical.SourceActiveCampaign:
		authURL = activecampaign.BuildAPIKeyEntryURL(state)
	case canonical.SourceHubSpot:
		authURL = hubspot.BuildPrivateAppTokenEntryURL(state)
	default:
		writeErr(w, http.StatusBadRequest, fmt.Errorf("oauth is not supported for %q; use the credentials flow", source))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"authorize_url": authURL,
		"state":         state,
	})
}

func oauthConfigured(source canonical.SourcePlatform) (bool, string) {
	switch source {
	case canonical.SourceMailchimp:
		if strings.TrimSpace(os.Getenv("MAILCHIMP_CLIENT_ID")) == "" || strings.TrimSpace(os.Getenv("MAILCHIMP_CLIENT_SECRET")) == "" {
			return false, "Mailchimp OAuth is not configured"
		}
	case canonical.SourceConvertKit:
		if strings.TrimSpace(os.Getenv("CONVERTKIT_CLIENT_ID")) == "" || strings.TrimSpace(os.Getenv("CONVERTKIT_CLIENT_SECRET")) == "" {
			return false, "ConvertKit OAuth is not configured"
		}
	case canonical.SourceBrevo:
		// This adapter uses API keys; the auth URL is a self-contained deep link
		// the desktop app intercepts to render an API key entry form.
		// No environment configuration is required.
		return true, ""
	case canonical.SourceActiveCampaign:
		return true, ""
	case canonical.SourceHubSpot:
		return true, ""
	default:
		return false, fmt.Sprintf("oauth is not supported for %q; use the credentials flow", source)
	}
	return true, ""
}

func localDemoMode() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("POSTWAVE_MIGRATION_DEMO_MODE"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// OAuthCallback completes the auth dance.
func (h *Migration) OAuthCallback(w http.ResponseWriter, r *http.Request) {
	source := canonical.SourcePlatform(chi.URLParam(r, "source"))
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}

	st, err := h.store.ConsumeOAuthState(jobstore.WithTenantID(r.Context(), tenantID), tenantID, state, time.Now())
	if errors.Is(err, jobstore.ErrNotFound) {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid or expired state"))
		return
	}
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if st.Source != source {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid or expired state"))
		return
	}

	if localDemoMode() && code == localDemoOAuthCode() {
		sess := localDemoSession(source, "oauth")
		jobID, err := h.completeOAuthJob(r.Context(), tenantID, source, state, sess, st.CreatedAt)
		if err != nil {
			writeOAuthCompletionErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{
			"job_id":     jobID,
			"account_id": sess.AccountID,
		})
		return
	}

	ad, err := adapter.Get(source)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	sess, err := ad.Authenticate(r.Context(), adapter.Credentials{
		OAuthCode: code,
		Extra:     map[string]string{"redirect_uri": h.redirectURI(source)},
	})
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err)
		return
	}

	jobID, err := h.completeOAuthJob(r.Context(), tenantID, source, state, sess, st.CreatedAt)
	if err != nil {
		writeOAuthCompletionErr(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"job_id":     jobID,
		"account_id": sess.AccountID,
	})
}

const oauthReconnectStateMarker = ".job."

var errOAuthAccountMismatch = errors.New("OAuth account does not match migration job")

func writeOAuthCompletionErr(w http.ResponseWriter, err error) {
	if errors.Is(err, errOAuthAccountMismatch) {
		writeErr(w, http.StatusConflict, err)
		return
	}
	if errors.Is(err, errHubSpotLineageConflict) {
		writeErr(w, http.StatusConflict, err)
		return
	}
	if errors.Is(err, errKlaviyoLineageConflict) {
		writeErr(w, http.StatusConflict, err)
		return
	}
	if errors.Is(err, errCustomerIOLineageConflict) {
		writeErr(w, http.StatusConflict, err)
		return
	}
	if errors.Is(err, orchestrator.ErrMigrationExecutionInProgress) {
		writeErr(w, http.StatusConflict, err)
		return
	}
	if errors.Is(err, orchestrator.ErrMigrationExecutionLockUnavailable) {
		writeErr(w, http.StatusServiceUnavailable, err)
		return
	}
	writeErr(w, http.StatusInternalServerError, err)
}

func writeMigrationJobCreationErr(w http.ResponseWriter, err error) {
	if errors.Is(err, errHubSpotLineageConflict) || errors.Is(err, errKlaviyoLineageConflict) || errors.Is(err, errCustomerIOLineageConflict) {
		writeErr(w, http.StatusConflict, err)
		return
	}
	writeErr(w, http.StatusInternalServerError, err)
}

// oauthStateForJob binds a reconnect target to the same opaque, single-use
// state value that is persisted by the job store. The complete value must
// match the stored row before the suffix is trusted, so changing the embedded
// job id invalidates the state instead of retargeting the callback.
func oauthStateForJob(state, jobID string) string {
	state = strings.TrimSpace(state)
	jobID = strings.TrimSpace(jobID)
	if state == "" || jobID == "" {
		return state
	}
	return state + oauthReconnectStateMarker + jobID
}

func oauthStateJobID(state string) string {
	idx := strings.LastIndex(state, oauthReconnectStateMarker)
	if idx <= 0 {
		return ""
	}
	return strings.TrimSpace(state[idx+len(oauthReconnectStateMarker):])
}

func migrationJobSessionRefreshRunning(status canonical.MigrationStatus) bool {
	switch status {
	case canonical.MigDryRun, canonical.MigImporting, canonical.MigAuthenticating, canonical.MigDiscovering, canonical.MigRollingBack:
		return true
	default:
		return false
	}
}

func (h *Migration) completeOAuthJob(ctx context.Context, tenantID string, source canonical.SourcePlatform, state string, sess adapter.Session, issuedAt ...time.Time) (string, error) {
	reconnectJobID := oauthStateJobID(state)
	if reconnectJobID == "" {
		return h.createJob(jobstore.WithTenantID(ctx, tenantID), tenantID, source, sess)
	}
	job, err := h.loadJob(ctx, tenantID, reconnectJobID)
	if err != nil {
		return "", err
	}
	if job.Source != source || sess.Source != source {
		return "", fmt.Errorf("OAuth reconnect source does not match migration job")
	}
	if migrationJobSessionRefreshRunning(job.Status) {
		return "", fmt.Errorf("source session cannot be refreshed while migration job is running")
	}
	executionLease, err := h.acquireJobExecution(ctx, tenantID, job.ID)
	if err != nil {
		return "", err
	}
	defer func() { _ = executionLease.Release() }()
	job, err = h.loadJob(ctx, tenantID, reconnectJobID)
	if err != nil {
		return "", err
	}
	if job.Source != source || sess.Source != source {
		return "", fmt.Errorf("OAuth reconnect source does not match migration job")
	}
	if migrationJobSessionRefreshRunning(job.Status) {
		return "", fmt.Errorf("source session cannot be refreshed while migration job is running")
	}
	if stamp, ok := cursorString(job.Cursor, "source_cleanup_started_at"); ok {
		cleanupAt, parseErr := time.Parse(time.RFC3339Nano, stamp)
		if parseErr != nil || len(issuedAt) != 1 || !issuedAt[0].After(cleanupAt) {
			return "", fmt.Errorf("%w; source credentials were removed after this authorization began; start reconnect again", errOAuthAccountMismatch)
		}
	}
	if err := activeCampaignPostPilotCleanupFreezeError(job, "source credential reconnect"); err != nil {
		return "", err
	}
	if source == canonical.SourceMailchimp {
		expectedFingerprint, _ := cursorString(job.Cursor, mailchimpAccountCursorKey)
		actualFingerprint := mailchimpAccountFingerprint(sess)
		if expectedFingerprint == "" || actualFingerprint == "" || expectedFingerprint != actualFingerprint {
			return "", fmt.Errorf("%w; reconnect the original Mailchimp account or start a new migration", errOAuthAccountMismatch)
		}
		selected := selectedAudienceIDsFromJobCursor(job)
		if len(selected) > 0 {
			var selectionErr error
			sess, selectionErr = applySelectedAudiences(source, sess, &selected)
			if selectionErr != nil {
				return "", selectionErr
			}
		}
	}
	if source == canonical.SourceConvertKit {
		if err := requireBoundSourceAccount(job, sess); err != nil {
			return "", fmt.Errorf("%w: reconnect the original Kit account", errOAuthAccountMismatch)
		}
	}
	if err := h.saveSourceSession(jobstore.WithTenantID(ctx, tenantID), job.ID, tenantID, sess, sessionExpiresAt(sess, time.Now())); err != nil {
		return "", err
	}
	return job.ID, nil
}

type credentialRequest struct {
	APIKey       string            `json:"api_key"`
	AccessToken  string            `json:"access_token"`
	RefreshToken string            `json:"refresh_token"`
	AccountID    string            `json:"account_id"`
	Extra        map[string]string `json:"extra"`
}

// Credentials creates a migration job for non-OAuth sources such as API-key
// based adapters. Local demo mode also creates local source sessions so the
// dashboard can exercise CSV/Substack flows without external providers.
func (h *Migration) Credentials(w http.ResponseWriter, r *http.Request) {
	source := canonical.SourcePlatform(chi.URLParam(r, "source"))
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	ad, err := adapter.Get(source)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	caps := ad.Capabilities()

	var body credentialRequest
	if err := decodeRequestJSON(w, r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("decode credentials: %w", err))
		return
	}
	if localDemoMode() {
		if caps.AuthMethod == "csv_upload" && strings.TrimSpace(body.APIKey) == "" {
			body.APIKey = "local-upload"
		}
		if strings.TrimSpace(body.APIKey) != "" {
			sess := localDemoSession(source, firstNonEmpty(body.AccountID, body.Extra["file_name"], "api-key"))
			jobID, err := h.createJob(jobstore.WithTenantID(r.Context(), tenantID), tenantID, source, sess)
			if err != nil {
				writeMigrationJobCreationErr(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{
				"job_id":     jobID,
				"account_id": credentialAccountIDForResponse(source, sess.AccountID),
			})
			return
		}
	}
	var accountExecutionLease *orchestrator.MigrationExecutionLease
	if source == canonical.SourceActiveCampaign {
		if strings.TrimSpace(body.APIKey) == "" {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("ActiveCampaign API token required"))
			return
		}
		fingerprint, fingerprintErr := activeCampaignCredentialFingerprint(body)
		if fingerprintErr != nil {
			writeErr(w, http.StatusBadRequest, sanitizeMigrationError(source, fingerprintErr))
			return
		}
		accountExecutionLease, err = orchestrator.AcquireActiveCampaignAccountExecutionLease(r.Context(), h.db, fingerprint)
		if err != nil {
			writeActiveCampaignAccountExecutionErr(w, err)
			return
		}
		defer func() { _ = accountExecutionLease.Release() }()
	}
	sess, status, err := authenticateFromCredentialRequest(r.Context(), source, ad, caps, body)
	if err != nil {
		writeErr(w, status, sanitizeMigrationError(source, err))
		return
	}
	if source == canonical.SourceHubSpot {
		fingerprint := hubSpotAccountFingerprint(sess)
		if fingerprint == "" {
			writeErr(w, http.StatusUnauthorized, fmt.Errorf("HubSpot authentication did not return a stable account identity"))
			return
		}
		accountExecutionLease, err = orchestrator.AcquireHubSpotAccountExecutionLease(r.Context(), h.db, fingerprint)
		if err != nil {
			writeSourceAccountExecutionErr(w, source, err)
			return
		}
		defer func() { _ = accountExecutionLease.Release() }()
	}
	// A Beehiiv credential cannot be mapped to its workspace until the
	// provider identity call succeeds. Once known, join the same workspace
	// lease used by every job-backed operation before persisting the session.
	if source == canonical.SourceBeehiiv {
		workspaceFingerprint := beehiivWorkspaceFingerprint(sess)
		if workspaceFingerprint == "" {
			writeErr(w, http.StatusUnauthorized, fmt.Errorf("Beehiiv authentication did not return a stable workspace identity"))
			return
		}
		accountExecutionLease, err = orchestrator.AcquireBeehiivWorkspaceExecutionLease(r.Context(), h.db, workspaceFingerprint)
		if err != nil {
			writeSourceAccountExecutionErr(w, source, err)
			return
		}
		defer func() { _ = accountExecutionLease.Release() }()
	}
	if source == canonical.SourceKlaviyo {
		fingerprint := klaviyoAccountFingerprint(sess)
		if fingerprint == "" {
			writeErr(w, http.StatusUnauthorized, fmt.Errorf("Klaviyo authentication did not return a stable account identity"))
			return
		}
		accountExecutionLease, err = orchestrator.AcquireKlaviyoAccountExecutionLease(r.Context(), h.db, fingerprint)
		if err != nil {
			writeSourceAccountExecutionErr(w, source, err)
			return
		}
		defer func() { _ = accountExecutionLease.Release() }()
	}
	if source == canonical.SourceCustomerIO {
		fingerprint := customerIOWorkspaceFingerprint(sess)
		if fingerprint == "" {
			writeErr(w, http.StatusUnauthorized, fmt.Errorf("Customer.io authentication did not return a stable region/workspace identity"))
			return
		}
		accountExecutionLease, err = orchestrator.AcquireCustomerIOWorkspaceExecutionLease(r.Context(), h.db, fingerprint)
		if err != nil {
			writeSourceAccountExecutionErr(w, source, err)
			return
		}
		defer func() { _ = accountExecutionLease.Release() }()
	}
	jobID, err := h.createJob(jobstore.WithTenantID(r.Context(), tenantID), tenantID, source, sess)
	if err != nil {
		writeMigrationJobCreationErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"job_id":     jobID,
		"account_id": credentialAccountIDForResponse(source, sess.AccountID),
	})
}

func credentialAccountIDForResponse(source canonical.SourcePlatform, accountID string) string {
	if source == canonical.SourceActiveCampaign && strings.TrimSpace(accountID) != "" {
		return "[redacted-activecampaign-account]"
	}
	if source == canonical.SourceHubSpot && strings.TrimSpace(accountID) != "" {
		return "[redacted-hubspot-portal]"
	}
	return accountID
}

// RefreshSourceSession reauthenticates an existing migration job without
// creating a new job. It is used when long ActiveCampaign cutover work reaches
// an expired or near-expired saved source session before final delta/shadow
// checks.
func (h *Migration) RefreshSourceSession(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	jobID := chi.URLParam(r, "job_id")
	job, err := h.store.Get(jobstore.WithTenantID(r.Context(), tenantID), jobID)
	if errors.Is(err, jobstore.ErrNotFound) {
		writeErr(w, http.StatusNotFound, fmt.Errorf("migration job not found"))
		return
	}
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if migrationJobSessionRefreshRunning(job.Status) {
		writeErr(w, http.StatusConflict, fmt.Errorf("source session cannot be refreshed while migration job is running"))
		return
	}
	// MailerLite does not return an immutable account identity. A new key
	// cannot prove that it belongs to the original account, so do not allow a
	// credential change to retarget an existing import or its rollback ledger.
	if job.Source == canonical.SourceMailerLite {
		writeErr(w, http.StatusConflict, fmt.Errorf("MailerLite key rotation requires a new migration; the API cannot verify that a replacement key belongs to the original account"))
		return
	}
	ad, err := adapter.Get(job.Source)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	caps := ad.Capabilities()
	var body credentialRequest
	if err := decodeRequestJSON(w, r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("decode credentials: %w", err))
		return
	}
	executionLease, err := h.acquireJobExecution(r.Context(), tenantID, job.ID)
	if err != nil {
		writeExecutionLeaseErr(w, err)
		return
	}
	defer func() { _ = executionLease.Release() }()
	initialSource := job.Source
	job, err = h.store.Get(jobstore.WithTenantID(r.Context(), tenantID), jobID)
	if errors.Is(err, jobstore.ErrNotFound) {
		writeErr(w, http.StatusNotFound, fmt.Errorf("migration job not found"))
		return
	}
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if job.Source != initialSource {
		writeErr(w, http.StatusConflict, fmt.Errorf("migration source changed concurrently; reload the job and retry"))
		return
	}
	if migrationJobSessionRefreshRunning(job.Status) {
		writeErr(w, http.StatusConflict, fmt.Errorf("source session cannot be refreshed while migration job is running"))
		return
	}
	if err := activeCampaignPostPilotCleanupFreezeError(job, "source credential refresh"); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	var accountExecutionLease *orchestrator.MigrationExecutionLease
	if job.Source == canonical.SourceActiveCampaign {
		if strings.TrimSpace(body.APIKey) == "" {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("ActiveCampaign API token required"))
			return
		}
		fingerprint, fingerprintErr := activeCampaignCredentialFingerprint(body)
		if fingerprintErr != nil {
			writeErr(w, http.StatusBadRequest, sanitizeMigrationError(job.Source, fingerprintErr))
			return
		}
		expected := activeCampaignExpectedAccountFingerprint(job)
		if expected == "" || fingerprint != expected {
			writeErr(w, http.StatusConflict, fmt.Errorf("ActiveCampaign account does not match migration job; reconnect the original account or start a new migration"))
			return
		}
		accountExecutionLease, err = orchestrator.AcquireActiveCampaignAccountExecutionLease(r.Context(), h.db, expected)
		if err != nil {
			writeActiveCampaignAccountExecutionErr(w, err)
			return
		}
		defer func() { _ = accountExecutionLease.Release() }()
	}
	if job.Source == canonical.SourceHubSpot {
		if strings.TrimSpace(body.APIKey) == "" {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("HubSpot Service Key or access token required"))
			return
		}
		expected := hubSpotExpectedAccountFingerprint(job)
		if expected == "" {
			writeErr(w, http.StatusConflict, fmt.Errorf("HubSpot account binding is missing; start a new migration"))
			return
		}
		accountExecutionLease, err = orchestrator.AcquireHubSpotAccountExecutionLease(r.Context(), h.db, expected)
		if err != nil {
			writeSourceAccountExecutionErr(w, job.Source, err)
			return
		}
		defer func() { _ = accountExecutionLease.Release() }()
	}
	if job.Source == canonical.SourceBeehiiv {
		if strings.TrimSpace(body.APIKey) == "" {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("Beehiiv API key required"))
			return
		}
		expectedWorkspace := beehiivExpectedWorkspaceFingerprint(job)
		expectedAccount := beehiivExpectedAccountFingerprint(job)
		expectedPublication := beehiivExpectedPublicationID(job)
		if expectedWorkspace == "" || expectedAccount == "" || expectedPublication == "" {
			writeErr(w, http.StatusConflict, fmt.Errorf("Beehiiv workspace/publication binding is missing; start a new migration"))
			return
		}
		if requestedPublication := strings.TrimSpace(body.AccountID); requestedPublication != "" && requestedPublication != expectedPublication {
			writeErr(w, http.StatusConflict, fmt.Errorf("Beehiiv workspace/publication does not match migration job; reconnect the original publication or start a new migration"))
			return
		}
		if strings.TrimSpace(body.AccountID) == "" {
			body.AccountID = expectedPublication
		}
		accountExecutionLease, err = orchestrator.AcquireBeehiivWorkspaceExecutionLease(r.Context(), h.db, expectedWorkspace)
		if err != nil {
			writeSourceAccountExecutionErr(w, job.Source, err)
			return
		}
		defer func() { _ = accountExecutionLease.Release() }()
	}
	if job.Source == canonical.SourceKlaviyo {
		if strings.TrimSpace(body.APIKey) == "" && strings.TrimSpace(body.AccessToken) == "" {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("Klaviyo private API key or OAuth access token required"))
			return
		}
		expected := klaviyoExpectedAccountFingerprint(job)
		if expected == "" {
			writeErr(w, http.StatusConflict, fmt.Errorf("Klaviyo account binding is missing; start a new migration"))
			return
		}
		accountExecutionLease, err = orchestrator.AcquireKlaviyoAccountExecutionLease(r.Context(), h.db, expected)
		if err != nil {
			writeSourceAccountExecutionErr(w, job.Source, err)
			return
		}
		defer func() { _ = accountExecutionLease.Release() }()
	}
	if job.Source == canonical.SourceCustomerIO {
		if strings.TrimSpace(body.APIKey) == "" && strings.TrimSpace(body.AccessToken) == "" {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("Customer.io App API key required"))
			return
		}
		expected := customerIOExpectedWorkspaceFingerprint(job)
		expectedWorkspaceID := customerIOExpectedWorkspaceID(job)
		expectedRegion := customerIOExpectedRegion(job)
		if expected == "" || expectedWorkspaceID == "" || expectedRegion == "" {
			writeErr(w, http.StatusConflict, fmt.Errorf("Customer.io region/workspace binding is missing; start a new migration"))
			return
		}
		requestedWorkspaceID := strings.TrimSpace(firstNonEmpty(body.AccountID, body.Extra[customerio.WorkspaceIDExtraKey]))
		if requestedWorkspaceID != "" && requestedWorkspaceID != expectedWorkspaceID {
			writeErr(w, http.StatusConflict, fmt.Errorf("Customer.io region/workspace does not match migration job; reconnect the original workspace or start a new migration"))
			return
		}
		requestedRegion := strings.ToLower(strings.TrimSpace(body.Extra[customerio.RegionExtraKey]))
		if requestedRegion != "" && requestedRegion != expectedRegion {
			writeErr(w, http.StatusConflict, fmt.Errorf("Customer.io region/workspace does not match migration job; reconnect the original workspace or start a new migration"))
			return
		}
		if body.Extra == nil {
			body.Extra = map[string]string{}
		}
		body.AccountID = expectedWorkspaceID
		body.Extra[customerio.WorkspaceIDExtraKey] = expectedWorkspaceID
		body.Extra[customerio.RegionExtraKey] = expectedRegion
		accountExecutionLease, err = orchestrator.AcquireCustomerIOWorkspaceExecutionLease(r.Context(), h.db, expected)
		if err != nil {
			writeSourceAccountExecutionErr(w, job.Source, err)
			return
		}
		defer func() { _ = accountExecutionLease.Release() }()
	}
	sess, status, err := authenticateFromCredentialRequest(r.Context(), job.Source, ad, caps, body)
	if err != nil {
		writeErr(w, status, sanitizeMigrationError(job.Source, err))
		return
	}
	if sess.Source != job.Source {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("refreshed source session is for %q, want %q", sess.Source, job.Source))
		return
	}
	if job.Source == canonical.SourceMailchimp {
		expectedFingerprint, _ := cursorString(job.Cursor, mailchimpAccountCursorKey)
		actualFingerprint := mailchimpAccountFingerprint(sess)
		if expectedFingerprint == "" || actualFingerprint == "" || expectedFingerprint != actualFingerprint {
			writeErr(w, http.StatusConflict, fmt.Errorf("%w; reconnect the original Mailchimp account or start a new migration", errOAuthAccountMismatch))
			return
		}
		selected := selectedAudienceIDsFromJobCursor(job)
		if len(selected) > 0 {
			sess, err = applySelectedAudiences(job.Source, sess, &selected)
			if err != nil {
				writeErr(w, http.StatusBadRequest, err)
				return
			}
		}
	}
	if job.Source == canonical.SourceBrevo || job.Source == canonical.SourceConvertKit || job.Source == canonical.SourceActiveCampaign || job.Source == canonical.SourceHubSpot || job.Source == canonical.SourceBeehiiv || job.Source == canonical.SourceKlaviyo || job.Source == canonical.SourceCustomerIO {
		if err := requireBoundSourceAccount(job, sess); err != nil {
			writeErr(w, http.StatusConflict, err)
			return
		}
	}
	if err := h.saveSourceSession(jobstore.WithTenantID(r.Context(), tenantID), job.ID, tenantID, sess, sessionExpiresAt(sess, time.Now())); err != nil {
		writeJobStoreErr(w, err)
		return
	}
	h.decorateJobSessionInfo(r.Context(), tenantID, job)
	sanitizeMigrationJobForResponse(job)
	writeJSON(w, http.StatusOK, job)
}

func authenticateFromCredentialRequest(ctx context.Context, source canonical.SourcePlatform, ad adapter.Adapter, caps canonical.AdapterCapabilities, body credentialRequest) (adapter.Session, int, error) {
	if source == canonical.SourceKlaviyo && strings.TrimSpace(body.AccessToken) != "" {
		extra := body.Extra
		if extra == nil {
			extra = map[string]string{}
		}
		extra["auth_scheme"] = "bearer"
		sess, err := ad.Authenticate(ctx, adapter.Credentials{
			AccessToken:  strings.TrimSpace(body.AccessToken),
			RefreshToken: strings.TrimSpace(body.RefreshToken),
			AccountID:    strings.TrimSpace(body.AccountID),
			Extra:        extra,
		})
		if err != nil {
			return adapter.Session{}, http.StatusUnauthorized, err
		}
		return sess, http.StatusOK, nil
	}
	if source == canonical.SourceCustomerIO && strings.TrimSpace(body.AccessToken) != "" {
		sess, err := ad.Authenticate(ctx, adapter.Credentials{
			AccessToken: strings.TrimSpace(body.AccessToken),
			AccountID:   strings.TrimSpace(body.AccountID),
			Extra:       body.Extra,
		})
		if err != nil {
			return adapter.Session{}, http.StatusUnauthorized, err
		}
		return sess, http.StatusOK, nil
	}
	if caps.AuthMethod == "oauth2" {
		if strings.TrimSpace(body.AccessToken) == "" || strings.TrimSpace(body.AccountID) == "" {
			return adapter.Session{}, http.StatusBadRequest, fmt.Errorf("source %q requires OAuth or access_token with account_id", source)
		}
		extra := body.Extra
		if extra == nil {
			extra = map[string]string{}
		}
		sess, err := ad.Authenticate(ctx, adapter.Credentials{
			AccessToken:  strings.TrimSpace(body.AccessToken),
			RefreshToken: strings.TrimSpace(body.RefreshToken),
			AccountID:    strings.TrimSpace(body.AccountID),
			Extra:        extra,
		})
		if err != nil {
			return adapter.Session{}, http.StatusUnauthorized, err
		}
		return sess, http.StatusOK, nil
	}
	if caps.AuthMethod == "csv_upload" {
		return adapter.Session{}, http.StatusServiceUnavailable, fmt.Errorf("CSV upload storage is not configured")
	}
	if strings.TrimSpace(body.APIKey) == "" {
		if source == canonical.SourceActiveCampaign {
			return adapter.Session{}, http.StatusBadRequest, fmt.Errorf("ActiveCampaign API token required")
		}
		return adapter.Session{}, http.StatusBadRequest, fmt.Errorf("api_key required")
	}
	extra := body.Extra
	if extra == nil {
		extra = map[string]string{}
	}
	if source == canonical.SourceBeehiiv && strings.TrimSpace(body.AccountID) != "" && extra["publication_id"] == "" {
		extra["publication_id"] = strings.TrimSpace(body.AccountID)
	}
	if source == canonical.SourceActiveCampaign && firstNonEmpty(extra["api_url"], extra["account_api_url"], extra["account_url"], extra["base_url"], body.AccountID) == "" {
		return adapter.Session{}, http.StatusBadRequest, fmt.Errorf("ActiveCampaign account API URL required")
	}
	sess, err := ad.Authenticate(ctx, adapter.Credentials{
		APIKey:    strings.TrimSpace(body.APIKey),
		AccountID: strings.TrimSpace(body.AccountID),
		Extra:     extra,
	})
	if err != nil {
		return adapter.Session{}, http.StatusUnauthorized, err
	}
	return sess, http.StatusOK, nil
}

type uploadMeta struct {
	TenantID  string                   `json:"tenant_id"`
	Source    canonical.SourcePlatform `json:"source"`
	UploadID  string                   `json:"upload_id"`
	Filename  string                   `json:"filename"`
	Total     int64                    `json:"total"`
	UpdatedAt time.Time                `json:"updated_at"`
	Received  int64                    `json:"received"`
}

const (
	maxMigrationUploadBytes      int64 = 200 << 20 // 200 MiB per uploaded source file.
	maxMigrationUploadChunkBytes int64 = 16 << 20  // 16 MiB per resumable chunk.
	maxMigrationUploadMetaBytes  int64 = 64 << 10
)

func (h *Migration) redirectURI(source canonical.SourcePlatform) string {
	if h.RedirectURI == "" {
		return ""
	}
	if strings.Contains(h.RedirectURI, "{source}") {
		return strings.ReplaceAll(h.RedirectURI, "{source}", string(source))
	}
	return h.RedirectURI
}

func (h *Migration) createJob(ctx context.Context, tenantID string, source canonical.SourcePlatform, sess adapter.Session) (string, error) {
	return h.createJobWithID(ctx, randomState(), tenantID, source, sess)
}

func (h *Migration) createJobWithID(ctx context.Context, jobID, tenantID string, source canonical.SourcePlatform, sess adapter.Session) (string, error) {
	cursor := map[string]*string{}
	if id := sess.Extra["upload_id"]; id != "" {
		digest := sess.Extra["upload_sha256"]
		cursor["upload_id"], cursor["upload_sha256"] = &id, &digest
	}
	if source == canonical.SourceBrevo && !isLocalDemoSession(sess) {
		id := sess.Extra["brevo_organization_id"]
		if id == "" || id != sess.AccountID {
			return "", fmt.Errorf("Brevo organization identity is required")
		}
		cursor[brevoAccountCursorKey] = &id
	}
	if source == canonical.SourceConvertKit && !isLocalDemoSession(sess) {
		if sess.AccountID == "" || sess.Extra["api_version"] != "4" {
			return "", fmt.Errorf("Kit v4 account identity is required")
		}
		id := sess.AccountID
		cursor[kitAccountCursorKey] = &id
	}
	if source == canonical.SourceMailchimp {
		fingerprint := mailchimpAccountFingerprint(sess)
		if fingerprint == "" {
			return "", fmt.Errorf("create Mailchimp migration job: stable account identity is missing")
		}
		cursor[mailchimpAccountCursorKey] = &fingerprint
	}
	if source == canonical.SourceActiveCampaign {
		fingerprint := activeCampaignAccountFingerprint(sess)
		if fingerprint == "" {
			return "", fmt.Errorf("create ActiveCampaign migration job: stable account identity is missing")
		}
		cursor[activeCampaignAccountCursorKey] = &fingerprint
	}
	if source == canonical.SourceHubSpot {
		fingerprint := hubSpotAccountFingerprint(sess)
		dataHostingLocation := strings.ToLower(strings.TrimSpace(sess.Extra[hubspot.DataHostingLocationExtraKey]))
		if fingerprint == "" || dataHostingLocation == "" {
			return "", fmt.Errorf("create HubSpot migration job: stable account identity is missing")
		}
		existing, err := h.unrolledBackHubSpotLineage(ctx, tenantID, fingerprint)
		if err != nil {
			return "", fmt.Errorf("check existing HubSpot migration lineage: %w", err)
		}
		if existing != nil {
			return "", &hubSpotLineageConflictError{jobID: existing.ID}
		}
		cursor[hubSpotAccountCursorKey] = &fingerprint
		cursor[hubSpotDataLocationCursorKey] = &dataHostingLocation
	}
	if source == canonical.SourceBeehiiv {
		accountFingerprint := beehiivAccountFingerprint(sess)
		derivedAccountFingerprint := beehiivDerivedAccountFingerprint(sess)
		workspaceFingerprint := beehiivWorkspaceFingerprint(sess)
		publicationID := beehiivPublicationID(sess)
		if accountFingerprint == "" || derivedAccountFingerprint == "" || accountFingerprint != derivedAccountFingerprint || workspaceFingerprint == "" || publicationID == "" {
			return "", fmt.Errorf("create Beehiiv migration job: stable workspace/publication identity is missing")
		}
		cursor[beehiivAccountCursorKey] = &accountFingerprint
		cursor[beehiivWorkspaceCursorKey] = &workspaceFingerprint
		cursor[beehiivPublicationCursorKey] = &publicationID
	}
	if source == canonical.SourceKlaviyo {
		fingerprint := klaviyoAccountFingerprint(sess)
		if fingerprint == "" {
			return "", fmt.Errorf("create Klaviyo migration job: stable account identity is missing")
		}
		existing, err := h.unrolledBackKlaviyoLineage(ctx, tenantID, fingerprint)
		if err != nil {
			return "", fmt.Errorf("check existing Klaviyo migration lineage: %w", err)
		}
		if existing != nil {
			return "", &klaviyoLineageConflictError{jobID: existing.ID}
		}
		cursor[klaviyoAccountCursorKey] = &fingerprint
	}
	if source == canonical.SourceCustomerIO {
		fingerprint := customerIOWorkspaceFingerprint(sess)
		workspaceID := strings.TrimSpace(sess.AccountID)
		region := strings.ToLower(strings.TrimSpace(sess.Extra[customerio.RegionExtraKey]))
		if fingerprint == "" || workspaceID == "" || region == "" {
			return "", fmt.Errorf("create Customer.io migration job: stable region/workspace identity is missing")
		}
		existing, err := h.unrolledBackCustomerIOLineage(ctx, tenantID, fingerprint)
		if err != nil {
			return "", fmt.Errorf("check existing Customer.io migration lineage: %w", err)
		}
		if existing != nil {
			return "", &customerIOLineageConflictError{jobID: existing.ID}
		}
		cursor[customerIOWorkspaceCursorKey] = &fingerprint
		cursor[customerIOWorkspaceIDCursorKey] = &workspaceID
		cursor[customerIORegionCursorKey] = &region
	}
	job := &canonical.MigrationJob{
		ID:        jobID,
		TenantID:  tenantID,
		Source:    source,
		Status:    canonical.MigAwaitingConfirmation,
		StartedAt: time.Now(),
		Cursor:    cursor,
	}
	if err := h.store.Create(ctx, job); err != nil {
		return "", fmt.Errorf("create migration job: %w", err)
	}
	if err := h.saveSourceSession(ctx, jobID, tenantID, sess, sessionExpiresAt(sess, time.Now())); err != nil {
		if sess.Extra["upload_id"] != "" {
			return "", fmt.Errorf("save upload session: %w", err)
		}
		// No provider or destination work can have started before createJob
		// returns. Release account/workspace lineage ownership by durably marking
		// this empty job rolled back; otherwise a transient encrypted-session
		// write failure would strand a Customer.io/Klaviyo lineage forever.
		cleanupErr := h.store.UpdateStatus(ctx, jobID, canonical.MigRolledBack, "credential session persistence failed before migration execution")
		if cleanupErr != nil {
			return "", errors.Join(fmt.Errorf("save migration session: %w", err), fmt.Errorf("release empty migration lineage: %w", cleanupErr))
		}
		return "", fmt.Errorf("save migration session: %w", err)
	}
	return jobID, nil
}

// unrolledBackHubSpotLineage preserves one durable owner for every
// tenant/portal bridge. Final snapshots and source-event replay update the same
// destination identities, so a second job cannot safely establish independent
// rollback ownership. Failed and cancelled jobs may contain partial writes;
// only rollback releases the lineage.
func (h *Migration) unrolledBackHubSpotLineage(ctx context.Context, tenantID, accountFingerprint string) (*canonical.MigrationJob, error) {
	jobs, err := h.store.List(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	var oldest *canonical.MigrationJob
	for i := range jobs {
		job := jobs[i]
		if job.Source != canonical.SourceHubSpot || job.Status == canonical.MigRolledBack {
			continue
		}
		fingerprint, ok := cursorString(job.Cursor, hubSpotAccountCursorKey)
		if !ok || fingerprint != accountFingerprint {
			continue
		}
		if oldest == nil || job.StartedAt.Before(oldest.StartedAt) || (job.StartedAt.Equal(oldest.StartedAt) && job.ID < oldest.ID) {
			candidate := job
			oldest = &candidate
		}
	}
	return oldest, nil
}

// unrolledBackKlaviyoLineage returns the oldest job that still owns the
// tenant/account migration lineage. The credential endpoint holds the global
// Klaviyo account lease while this check and the subsequent create run, so
// normal API callers cannot race two lineages into existence across replicas.
// Failed and cancelled jobs remain owners because either may contain partial
// destination writes; only a completed rollback releases the lineage.
func (h *Migration) unrolledBackKlaviyoLineage(ctx context.Context, tenantID, accountFingerprint string) (*canonical.MigrationJob, error) {
	jobs, err := h.store.List(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	var oldest *canonical.MigrationJob
	for i := range jobs {
		job := jobs[i]
		if job.Source != canonical.SourceKlaviyo || job.Status == canonical.MigRolledBack {
			continue
		}
		fingerprint, ok := cursorString(job.Cursor, klaviyoAccountCursorKey)
		if !ok || fingerprint != accountFingerprint {
			continue
		}
		if oldest == nil || job.StartedAt.Before(oldest.StartedAt) || (job.StartedAt.Equal(oldest.StartedAt) && job.ID < oldest.ID) {
			candidate := job
			oldest = &candidate
		}
	}
	return oldest, nil
}

// unrolledBackCustomerIOLineage preserves one durable owner for every
// tenant/region/workspace import. Customer.io's immutable cio_id can move
// between email addresses and multiple profiles can share one address, so a
// second job cannot safely reconcile ownership against only its own ledger.
// Failed and cancelled jobs may contain partial writes; only rollback releases
// the lineage.
func (h *Migration) unrolledBackCustomerIOLineage(ctx context.Context, tenantID, workspaceFingerprint string) (*canonical.MigrationJob, error) {
	jobs, err := h.store.List(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	var oldest *canonical.MigrationJob
	for i := range jobs {
		job := jobs[i]
		if job.Source != canonical.SourceCustomerIO || job.Status == canonical.MigRolledBack {
			continue
		}
		fingerprint, ok := cursorString(job.Cursor, customerIOWorkspaceCursorKey)
		if !ok || fingerprint != workspaceFingerprint {
			continue
		}
		if oldest == nil || job.StartedAt.Before(oldest.StartedAt) || (job.StartedAt.Equal(oldest.StartedAt) && job.ID < oldest.ID) {
			candidate := job
			oldest = &candidate
		}
	}
	return oldest, nil
}

// Discover runs a synchronous pre-flight count.
func (h *Migration) Discover(w http.ResponseWriter, r *http.Request) {
	source := canonical.SourcePlatform(chi.URLParam(r, "source"))
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}

	var body struct {
		JobID               string   `json:"job_id"`
		SelectedAudienceIDs []string `json:"selected_audience_ids,omitempty"`
	}
	if err := decodeRequestJSON(w, r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	job, err := h.loadJob(r.Context(), tenantID, body.JobID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if job.Source != source {
		writeErr(w, http.StatusConflict, fmt.Errorf("job source %q does not match route source %q", job.Source, source))
		return
	}
	executionLease, err := h.acquireJobExecution(r.Context(), tenantID, job.ID)
	if err != nil {
		writeExecutionLeaseErr(w, err)
		return
	}
	defer func() { _ = executionLease.Release() }()
	job, err = h.loadJob(r.Context(), tenantID, body.JobID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if job.Source != source {
		writeErr(w, http.StatusConflict, fmt.Errorf("job source %q does not match route source %q", job.Source, source))
		return
	}
	sess, status, err := h.loadCutoverSession(r.Context(), tenantID, body.JobID, source, "running discovery")
	if err != nil {
		if status != 0 {
			writeErr(w, status, err)
			return
		}
		writeJobStoreErr(w, err)
		return
	}
	if len(body.SelectedAudienceIDs) > 0 {
		var selectionErr error
		sess, selectionErr = applySelectedAudiences(source, sess, &body.SelectedAudienceIDs)
		if selectionErr != nil {
			writeErr(w, http.StatusBadRequest, selectionErr)
			return
		}
	}
	if isLocalDemoSession(sess) {
		writeDiscoveryJSON(w, job.ID, source, localDemoDiscovery(source))
		return
	}
	ad, err := adapter.Get(source)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	accountExecutionLease, err := h.acquireSourceAccountSessionExecution(r.Context(), job, sess)
	if err != nil {
		writeSourceAccountExecutionErr(w, source, err)
		return
	}
	defer func() { _ = accountExecutionLease.Release() }()
	h.configureSourceSessionResolver(ad, job)
	rep, err := ad.Discover(r.Context(), sess)
	if err != nil {
		writeErr(w, http.StatusBadGateway, sanitizeMigrationError(source, err))
		return
	}
	writeDiscoveryJSON(w, job.ID, source, rep)
}

// DryRun kicks off Discover + Verification only; returns 202.
func (h *Migration) DryRun(w http.ResponseWriter, r *http.Request) {
	h.kickoff(w, r, canonical.MigDryRun)
}

// Commit runs the full migration; returns 202.
func (h *Migration) Commit(w http.ResponseWriter, r *http.Request) {
	h.kickoff(w, r, canonical.MigImporting)
}

func (h *Migration) kickoff(w http.ResponseWriter, r *http.Request, target canonical.MigrationStatus) {
	source := canonical.SourcePlatform(chi.URLParam(r, "source"))
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	var body struct {
		JobID               string    `json:"job_id"`
		SelectedAudienceIDs *[]string `json:"selected_audience_ids,omitempty"`
		// MIGR-038: optional RFC3339 instant to defer the run until.
		ScheduledFor string `json:"scheduled_for,omitempty"`
	}
	if err := decodeRequestJSON(w, r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	job, err := h.loadJob(r.Context(), tenantID, body.JobID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if job.Source != source {
		writeErr(w, http.StatusConflict, fmt.Errorf("job source %q does not match route source %q", job.Source, source))
		return
	}
	if job.Status != canonical.MigAwaitingConfirmation {
		writeErr(w, http.StatusConflict, fmt.Errorf("migration job must be awaiting confirmation before starting; current status is %q", job.Status))
		return
	}
	action := "starting import"
	if target == canonical.MigDryRun {
		action = "starting dry-run"
	}
	sess, status, err := h.loadCutoverSession(r.Context(), tenantID, body.JobID, source, action)
	if err != nil {
		if status != 0 {
			writeErr(w, status, err)
			return
		}
		writeJobStoreErr(w, err)
		return
	}
	if target == canonical.MigImporting && job.VerificationReport == nil {
		writeErr(w, http.StatusConflict, fmt.Errorf("run and review a dry-run before committing the migration"))
		return
	}
	if source == canonical.SourceActiveCampaign || source == canonical.SourceBeehiiv || source == canonical.SourceCustomerIO {
		if err := requireBoundSourceAccount(job, sess); err != nil {
			writeErr(w, http.StatusConflict, err)
			return
		}
	}
	var selectedUpdated bool
	if body.SelectedAudienceIDs != nil {
		nextSess, err := applySelectedAudiences(source, sess, body.SelectedAudienceIDs)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		sess = nextSess
		selectedUpdated = true
	}
	if source == canonical.SourceMailchimp && len(selectedAudienceIDsFromSession(sess)) == 0 {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("select at least one Mailchimp audience before starting a dry-run or import"))
		return
	}
	if target == canonical.MigImporting && source == canonical.SourceMailchimp {
		reviewed := selectedAudienceIDsFromJobCursor(job)
		selected := selectedAudienceIDsFromSession(sess)
		if len(reviewed) == 0 || strings.Join(reviewed, ",") != strings.Join(selected, ",") {
			writeErr(w, http.StatusConflict, fmt.Errorf("Mailchimp audience scope changed after the reviewed dry-run; run and review a new dry-run before committing"))
			return
		}
	}
	executionLease, err := h.acquireJobExecution(r.Context(), tenantID, job.ID)
	if err != nil {
		writeExecutionLeaseErr(w, err)
		return
	}
	defer func() { _ = executionLease.Release() }()
	scopedCtx := jobstore.WithTenantID(r.Context(), tenantID)
	if target == canonical.MigImporting && !isLocalDemoSession(sess) && strings.TrimSpace(os.Getenv(tenantengine.RoutesEnv)) != "" {
		client, err := h.listmonkClient(scopedCtx)
		if err == nil {
			err = bindJobDestination(job, client)
		}
		if err != nil {
			writeErr(w, http.StatusServiceUnavailable, err)
			return
		}
	}
	prepareJobForNewRun(job, target, time.Now())
	// Remember which mode this run started in. The store has no
	// first-class "cancelled" status — a cancel persists as failed —
	// so the status alone can't tell ResumeJob whether to restart as a
	// dry-run or a commit. The Cursor map is the job's durable ledger;
	// stash the mode there alongside the per-resource checkpoints.
	mode := runModeImporting
	if target == canonical.MigDryRun {
		mode = runModeDryRun
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	job.Cursor[runModeCursorKey] = &mode
	persistSelectedAudienceCursor(job, sess)
	// MIGR-038: demo sessions complete immediately (below), which can't honor a
	// deferral — reject scheduling rather than silently running now.
	if body.ScheduledFor != "" && isLocalDemoSession(sess) {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("scheduling is not supported for demo migrations"))
		return
	}
	// Stamp an optional scheduled-start cursor so it persists atomically with the
	// accept transition below. A bad (non-empty, unparseable) value is a 400
	// before anything is persisted.
	scheduled, err := applyScheduledStart(job, body.ScheduledFor)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if err := h.transitionJob(scopedCtx, job, canonical.MigAwaitingConfirmation); err != nil {
		writeTransitionErr(w, err)
		return
	}
	if err := orchestrator.ClearSubscriberVerifierObservations(scopedCtx, h.db, tenantID, job.ID); err != nil {
		h.failAcceptedTransition(scopedCtx, job, target, err)
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if selectedUpdated {
		if err := h.saveSourceSession(scopedCtx, body.JobID, tenantID, sess, sessionExpiresAt(sess, time.Now())); err != nil {
			h.failAcceptedTransition(scopedCtx, job, target, err)
			writeJobStoreErr(w, err)
			return
		}
	}
	if isLocalDemoSession(sess) {
		h.completeDemoJob(scopedCtx, job, target == canonical.MigDryRun)
		writeJSON(w, http.StatusAccepted, map[string]string{"job_id": job.ID})
		return
	}
	if err := executionLease.Release(); err != nil {
		h.failAcceptedTransition(scopedCtx, job, target, err)
		writeExecutionLeaseErr(w, err)
		return
	}
	// MIGR-038: a scheduled job is left runnable for the recovery worker to pick
	// up at its start instant; only an immediate run launches now.
	if !scheduled {
		h.launchRunnableJob(tenantID, job.ID)
	}

	writeJSON(w, http.StatusAccepted, map[string]string{"job_id": job.ID})
}

func prepareJobForNewRun(job *canonical.MigrationJob, target canonical.MigrationStatus, startedAt time.Time) {
	if job == nil {
		return
	}
	job.Status = target
	job.Progress = canonical.MigrationProgress{}
	job.VerificationReport = nil
	job.Error = nil
	job.CompletedAt = nil
	job.RollbackUntil = nil
	job.StartedAt = startedAt
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	orchestrator.ResetExecutionState(job)
	delete(job.Cursor, shadowAttemptTokenCursorKey)
	if target == canonical.MigDryRun {
		orchestrator.ResetMailchimpCustomFieldPlan(job)
	}
	clearRateLimitPause(job)
	// MIGR-038: a fresh run starts clean; the kickoff handler re-stamps a
	// schedule afterward if the operator requested one.
	clearScheduledStart(job)
}

// RecoverRunnableJobs synchronously resumes jobs accepted before a service
// restart. It is safe to call repeatedly.
//
// When the store implements LeasingJobStore (Postgres + Memory both do),
// the recovery loop uses ClaimJob — atomic, multi-instance-safe pickup
// via FOR UPDATE SKIP LOCKED. Each claimed job runs with lease-renewal
// heartbeats so a worker death frees the job within LeaseTTL.
//
// When the store only implements the legacy RunnableJobStore (third-party
// fakes), we fall back to the historical ListRunnable + in-process map
// dedup. That path is correct for single-instance deployments only — but
// is preserved so existing test fakes keep working.
func (h *Migration) RecoverRunnableJobs(ctx context.Context) (int, error) {
	if leaser, ok := h.store.(jobstore.LeasingJobStore); ok {
		return h.recoverWithLeases(ctx, leaser)
	}
	lister, ok := h.store.(jobstore.RunnableJobStore)
	if !ok {
		return 0, nil
	}
	jobs, err := lister.ListRunnable(ctx)
	if err != nil {
		return 0, err
	}
	recovered := 0
	for _, job := range jobs {
		if retryAt, paused := rateLimitPausedUntil(&job, time.Now()); paused {
			slog.Info("migration: runnable job paused by source rate limit",
				"job_id", job.ID, "retry_at", retryAt.Format(time.RFC3339))
			continue
		}
		// MIGR-038: hold a scheduled job until its start instant.
		if startAt, deferred := scheduledStartPausedUntil(&job, time.Now()); deferred {
			slog.Info("migration: runnable job deferred by schedule",
				"job_id", job.ID, "start_at", startAt.Format(time.RFC3339))
			continue
		}
		h.runJob(ctx, job.TenantID, job.ID)
		recovered++
	}
	return recovered, nil
}

// recoverWithLeases drains every currently-claimable job via ClaimJob and
// runs each with a lease-renewal heartbeat. Stops at ErrJobNotClaimable.
func (h *Migration) recoverWithLeases(ctx context.Context, leaser jobstore.LeasingJobStore) (int, error) {
	picked := 0
	for {
		job, err := leaser.ClaimJob(ctx, h.ownerID, LeaseTTL)
		if errors.Is(err, jobstore.ErrJobNotClaimable) {
			return picked, nil
		}
		if err != nil {
			return picked, err
		}
		if retryAt, paused := rateLimitPausedUntil(job, time.Now()); paused {
			wait := time.Until(retryAt)
			if wait <= 0 {
				wait = time.Second
			}
			if wait > LeaseTTL {
				wait = LeaseTTL
			}
			if err := leaser.RenewLease(ctx, job.ID, h.ownerID, wait); err != nil &&
				!errors.Is(err, jobstore.ErrLeaseLost) &&
				!errors.Is(err, jobstore.ErrNotFound) {
				slog.Warn("migration: rate-limit pause lease shorten failed",
					"job_id", job.ID, "err", err.Error())
			}
			slog.Info("migration: claimable job paused by source rate limit",
				"job_id", job.ID, "retry_at", retryAt.Format(time.RFC3339))
			continue
		}
		// MIGR-038: a scheduled job is already claimed for a full LeaseTTL here,
		// so shorten the lease to its start (clamped to [1s, LeaseTTL]) before
		// releasing it, else it stays pinned for the whole TTL. Far-future
		// schedules re-poll every LeaseTTL — bounded, same as the rate-limit path.
		if startAt, deferred := scheduledStartPausedUntil(job, time.Now()); deferred {
			wait := time.Until(startAt)
			if wait <= 0 {
				wait = time.Second
			}
			if wait > LeaseTTL {
				wait = LeaseTTL
			}
			if err := leaser.RenewLease(ctx, job.ID, h.ownerID, wait); err != nil &&
				!errors.Is(err, jobstore.ErrLeaseLost) &&
				!errors.Is(err, jobstore.ErrNotFound) {
				slog.Warn("migration: scheduled-start lease shorten failed",
					"job_id", job.ID, "err", err.Error())
			}
			slog.Info("migration: claimable job deferred by schedule",
				"job_id", job.ID, "start_at", startAt.Format(time.RFC3339))
			continue
		}
		picked++
		h.runWithLease(ctx, leaser, job)
	}
}

// runWithLease wraps runJob with a periodic RenewLease heartbeat. If the
// lease is lost mid-execution (another worker took over after a stall),
// the heartbeat goroutine cancels the runJob context so we abandon
// gracefully instead of double-writing.
func (h *Migration) runWithLease(ctx context.Context, leaser jobstore.LeasingJobStore, job *canonical.MigrationJob) {
	runCtx, cancelRun := context.WithCancelCause(ctx)
	defer cancelRun(nil)

	hbDone := make(chan struct{})
	go func() {
		defer close(hbDone)
		t := time.NewTicker(LeaseTTL / 2)
		defer t.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-t.C:
				if err := leaser.RenewLease(runCtx, job.ID, h.ownerID, LeaseTTL); err != nil {
					if errors.Is(err, jobstore.ErrLeaseLost) {
						slog.Warn("migration: lease lost; abandoning job",
							"job_id", job.ID, "owner", h.ownerID)
						cancelRun(errWorkerLeaseLost)
						return
					}
					slog.Warn("migration: lease renew failed",
						"job_id", job.ID, "err", err.Error())
				}
			}
		}
	}()

	h.runJob(runCtx, job.TenantID, job.ID)
	cancelRun(nil)
	<-hbDone

	// Best-effort release. ErrLeaseLost is benign here — it just means the
	// lease already expired or another worker reclaimed it.
	if err := leaser.ReleaseLease(ctx, job.ID, h.ownerID); err != nil &&
		!errors.Is(err, jobstore.ErrLeaseLost) &&
		!errors.Is(err, jobstore.ErrNotFound) {
		slog.Warn("migration: lease release failed",
			"job_id", job.ID, "err", err.Error())
	}
}

// StartRecoveryWorker periodically resumes runnable jobs from durable storage.
// The one-shot pass on startup is what turns an accepted migration into a
// restart-resumable workflow in local/single-instance deployments.
func (h *Migration) StartRecoveryWorker(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	go func() {
		if n, err := h.RecoverRunnableJobs(ctx); err != nil {
			slog.Warn("migration: recover runnable jobs failed", "err", err)
		} else if n > 0 {
			slog.Info("migration: recovered runnable jobs", "count", n)
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if n, err := h.RecoverRunnableJobs(ctx); err != nil {
					slog.Warn("migration: recover runnable jobs failed", "err", err)
				} else if n > 0 {
					slog.Info("migration: recovered runnable jobs", "count", n)
				}
			}
		}
	}()
}

// launchRunnableJob keeps low-latency HTTP kickoff while preserving the same
// cluster-wide lease discipline as restart recovery. Leasing stores may pick
// an older runnable job first; the recovery pass drains the queue and reaches
// this job without allowing two instances to execute it concurrently.
func (h *Migration) launchRunnableJob(tenantID, jobID string) {
	go func() {
		if _, ok := h.store.(jobstore.LeasingJobStore); ok {
			if _, err := h.RecoverRunnableJobs(context.Background()); err != nil {
				slog.Warn("migration: immediate leased launch failed", "job_id", jobID, "tenant_id", tenantID, "err", err)
			}
			return
		}
		h.runJob(context.Background(), tenantID, jobID)
	}()
}

func (h *Migration) runJob(ctx context.Context, tenantID, jobID string) {
	if !h.markActive(jobID) {
		return
	}
	defer h.unmarkActive(jobID)

	executionLease, err := h.acquireJobExecution(ctx, tenantID, jobID)
	if err != nil {
		// A source-event replay or rollback may briefly own the same job. Keep
		// the durable runnable status unchanged so the recovery worker can retry
		// after that owner releases the shared tenant/job lease.
		slog.Info("migration: runnable job execution lease unavailable", "job_id", jobID, "tenant_id", tenantID, "err", err)
		return
	}
	defer func() {
		if err := executionLease.Release(); err != nil {
			slog.Error("migration: release runnable job execution lease failed", "job_id", jobID, "tenant_id", tenantID, "err", err)
		}
	}()

	var job *canonical.MigrationJob
	var scopedCtx context.Context
	defer func() {
		if rec := recover(); rec != nil {
			err := fmt.Errorf("migration worker panic: %v", rec)
			slog.Error("migration: worker panic recovered", "job_id", jobID, "err", err.Error())
			if job != nil {
				failCtx := jobstore.WithTenantID(context.Background(), tenantID)
				h.failJob(failCtx, job, err)
				h.broadcaster.Publish(jobID, ProgressEvent{
					Resource:    "all",
					CurrentStep: "Migration failed",
					Snapshot:    job.Progress,
					At:          time.Now(),
				})
			}
		}
	}()
	// Wire a cancellable context so DELETE /migrations/{id} can stop the
	// orchestrator at the next batch boundary. Cancellation cause matters:
	// operator cancellation is terminal/resumable by explicit user action,
	// while process shutdown or lease loss should leave the job runnable for
	// automatic recovery.
	runCtx, cancelRun := context.WithCancelCause(ctx)
	defer cancelRun(nil)
	h.control.Register(jobID, func() { cancelRun(errOperatorCancelled) })
	defer h.control.Unregister(jobID)

	scopedCtx = jobstore.WithTenantID(runCtx, tenantID)
	job, err = h.loadJob(scopedCtx, tenantID, jobID)
	if err != nil {
		slog.Warn("migration: load runnable job failed", "job_id", jobID, "err", err)
		return
	}
	dryRun := job.Status == canonical.MigDryRun
	if job.Status != canonical.MigDryRun && job.Status != canonical.MigImporting {
		return
	}
	runStatus := job.Status
	if retryAt, paused := rateLimitPausedUntil(job, time.Now()); paused {
		h.broadcaster.Publish(jobID, ProgressEvent{
			Resource:    "all",
			CurrentStep: "Migration paused by source rate limit",
			Snapshot:    job.Progress,
			At:          time.Now(),
		})
		slog.Info("migration: job waiting for source rate limit",
			"job_id", job.ID, "retry_at", retryAt.Format(time.RFC3339))
		return
	}
	// MIGR-038: hold a scheduled job at its entry gate until the start instant,
	// surfacing an operator-visible progress step (never touching job.Error).
	if startAt, deferred := scheduledStartPausedUntil(job, time.Now()); deferred {
		h.broadcaster.Publish(jobID, ProgressEvent{
			Resource:    "all",
			CurrentStep: fmt.Sprintf("Migration scheduled to start at %s", startAt.Format(time.RFC3339)),
			Snapshot:    job.Progress,
			At:          time.Now(),
		})
		slog.Info("migration: job waiting for scheduled start",
			"job_id", job.ID, "start_at", startAt.Format(time.RFC3339))
		return
	}
	clearRateLimitPause(job)
	clearScheduledStart(job)
	cancellationWatchDone := make(chan struct{})
	go h.watchDurableCancellation(runCtx, tenantID, jobID, cancelRun, cancellationWatchDone)
	defer func() {
		cancelRun(nil)
		<-cancellationWatchDone
	}()
	sess, err := h.loadSession(scopedCtx, tenantID, jobID)
	if errors.Is(err, jobstore.ErrNotFound) {
		h.failJob(scopedCtx, job, fmt.Errorf("source session expired; reconnect source before continuing"))
		return
	}
	if err != nil {
		h.failJob(scopedCtx, job, err)
		return
	}
	if job.Source == canonical.SourceBrevo || job.Source == canonical.SourceConvertKit || job.Source == canonical.SourceActiveCampaign || job.Source == canonical.SourceBeehiiv || job.Source == canonical.SourceKlaviyo || job.Source == canonical.SourceCustomerIO {
		if err := requireBoundSourceAccount(job, sess); err != nil {
			h.failJob(scopedCtx, job, err)
			return
		}
	}
	if isLocalDemoSession(sess) {
		h.completeDemoJob(scopedCtx, job, dryRun)
		// Demo path completes synchronously; broadcast a final event so
		// any SSE subscriber knows the run is over.
		h.broadcaster.Publish(jobID, ProgressEvent{
			Resource:    "all",
			CurrentStep: "Migration complete",
			Snapshot:    job.Progress,
			At:          time.Now(),
		})
		return
	}
	accountExecutionLease, err := h.acquireSourceAccountSessionExecution(scopedCtx, job, sess)
	if err != nil {
		// Another job for the same provider account may be importing,
		// discovering, refreshing, or monitoring. Leave this job runnable so
		// recovery can retry after that account owner releases its lease.
		slog.Info("migration: source account execution lease unavailable", "job_id", jobID, "tenant_id", tenantID, "err", err)
		if errors.Is(err, orchestrator.ErrMigrationExecutionInProgress) || errors.Is(err, orchestrator.ErrMigrationExecutionLockUnavailable) {
			h.pauseSourceAccountJob(scopedCtx, job)
		}
		return
	}
	defer func() {
		if err := accountExecutionLease.Release(); err != nil {
			slog.Error("migration: release source account execution lease failed", "job_id", jobID, "tenant_id", tenantID, "err", err)
		}
	}()
	ad, err := adapter.Get(job.Source)
	if err != nil {
		h.failJob(scopedCtx, job, err)
		return
	}
	h.configureSourceSessionResolver(ad, job)
	var lmc *listmonkx.Client
	if !dryRun {
		c, lerr := h.listmonkClientForJob(scopedCtx, job)
		if lerr != nil {
			h.failJob(scopedCtx, job, lerr)
			return
		}
		lmc = c
		if err := listmonkx.ReconcileExternalWriteIntents(scopedCtx, lmc, h.db, job.TenantID, job.ID); err != nil {
			h.failJob(scopedCtx, job, fmt.Errorf("reconcile durable external write intents: %w", err))
			return
		}
	}
	orc := &orchestrator.Orchestrator{
		Listmonk: lmc,
		DB:       h.db,
		TenantID: job.TenantID,
		DryRun:   dryRun,
	}
	prevProgress := job.Progress
	err = orc.Run(scopedCtx, ad, sess, job, func(p canonical.MigrationProgress) {
		job.Progress = p
		// Progress persistence must preserve the same lifecycle epoch as the
		// worker. A full, unconditional Update could resurrect importing after
		// another owner had committed a terminal transition.
		if err := h.transitionJob(scopedCtx, job, runStatus); err != nil {
			slog.Warn("migration: persist progress failed", "job_id", job.ID, "err", err)
			orc.RecordProgressPersistenceError(err)
		}
		// Fan out to SSE subscribers. We compute the delta against the
		// previous snapshot so the event names a single resource bucket
		// (subscribers / segments / …) — easier for the UI to render.
		if evt, ok := progressDelta(prevProgress, p, ""); ok {
			if evt.CurrentStep == "" {
				evt.CurrentStep = resourceLabelForSource(job.Source, evt.Resource, evt.Completed, evt.Total)
			}
			h.broadcaster.Publish(jobID, evt)
		}
		prevProgress = p
	})
	sanitizeMigrationJobEvidence(job)
	if err != nil {
		persistCtx := jobstore.WithTenantID(context.Background(), tenantID)
		durablyCancelled := h.isDurablyStoppedByOperator(persistCtx, jobID)
		operatorCancelled := errors.Is(context.Cause(runCtx), errOperatorCancelled) || durablyCancelled
		// Honour operator cancellation explicitly so the operator sees a
		// clean "cancelled" message rather than a generic context error.
		// Other cancellations (service shutdown, lease lost, parent context
		// timeout) abandon the worker without terminally failing the job; the
		// recovery loop can pick it back up from the durable cursor.
		if operatorCancelled {
			if !dryRun {
				rb := time.Now().Add(migrationRollbackWindow(job.Source))
				job.RollbackUntil = &rb
			}
			if durablyCancelled && isDeltaImportRun(job) && restoreDeltaImportSnapshot(job, errOperatorCancelled) {
				if persistErr := h.transitionJob(persistCtx, job, canonical.MigFailed, canonical.MigCompleted, runStatus); persistErr != nil {
					slog.Warn("migration: persist cancelled delta import restore failed", "job_id", job.ID, "err", persistErr)
				}
			} else {
				h.failJob(persistCtx, job, errOperatorCancelled)
			}
			// A remote cancellation marker can win the lifecycle CAS before the
			// worker exits. Purge only after the worker has stopped so no final
			// verifier observation can race behind the handler's initial cleanup.
			h.clearTerminalVerifierObservations(persistCtx, job)
		} else if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			if !errors.Is(context.Cause(runCtx), errOperatorCancelled) {
				slog.Info("migration: worker abandoned runnable job",
					"job_id", job.ID, "cause", context.Cause(runCtx))
				h.broadcaster.Publish(jobID, ProgressEvent{
					Resource:    "all",
					CurrentStep: "Migration paused for recovery",
					Snapshot:    job.Progress,
					At:          time.Now(),
				})
				return
			}
		} else {
			var rateLimited *adapter.ErrRateLimited
			if errors.As(err, &rateLimited) {
				h.pauseRateLimitedJob(persistCtx, job, rateLimited)
				h.broadcaster.Publish(jobID, ProgressEvent{
					Resource:    "all",
					CurrentStep: "Migration paused by source rate limit",
					Snapshot:    job.Progress,
					At:          time.Now(),
				})
				return
			}
			if !dryRun {
				rb := time.Now().Add(migrationRollbackWindow(job.Source))
				job.RollbackUntil = &rb
			}
			h.failJob(persistCtx, job, err)
		}
		h.broadcaster.Publish(jobID, ProgressEvent{
			Resource:    "all",
			CurrentStep: "Migration ended",
			Snapshot:    job.Progress,
			At:          time.Now(),
		})
		return
	}
	now := time.Now()
	if dryRun {
		job.Status = canonical.MigAwaitingConfirmation
	} else {
		job.Status = canonical.MigCompleted
		job.CompletedAt = &now
		rb := now.Add(migrationRollbackWindow(job.Source))
		job.RollbackUntil = &rb
	}
	if isDeltaImportRun(job) {
		clearDeltaImportSnapshot(job)
	}
	clearRateLimitPause(job)
	clearScheduledStart(job)
	job.Error = nil
	persistBaseCtx, cancelPersist := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelPersist()
	persistCtx := jobstore.WithTenantID(persistBaseCtx, tenantID)
	completionPersisted := false
	durablyCancelled := false
	if err := h.transitionJob(persistCtx, job, runStatus); err != nil {
		// A remote cancellation can commit after the orchestrator's final
		// cancellation check but before this completion CAS. Reload on a detached
		// bounded context: never announce success for a durable failed/cancelled
		// job, and erase its now-terminal raw verifier evidence.
		durableJob, loadErr := h.loadJob(persistCtx, tenantID, job.ID)
		if loadErr == nil && (isCancelledJob(durableJob) || isCancelledDeltaImport(durableJob)) {
			job = durableJob
			durablyCancelled = true
			h.clearTerminalVerifierObservations(persistCtx, job)
			slog.Info("migration: completion lost to durable operator cancellation", "job_id", job.ID)
		} else {
			slog.Warn("migration: persist completion failed", "job_id", job.ID, "err", err, "reload_err", loadErr)
		}
	} else {
		completionPersisted = true
		if err := orchestrator.ClearSubscriberVerifierObservations(persistCtx, h.db, tenantID, job.ID); err != nil {
			// The verification report is durable at this point, so the raw
			// subscriber observations are no longer needed. A cleanup failure must
			// be visible operationally but must not erase the completed report.
			slog.Error("migration: purge completed subscriber verification observations failed", "job_id", job.ID, "err", err)
		}
	}
	currentStep := "Migration completion persistence failed; awaiting recovery"
	if completionPersisted {
		currentStep = "Migration complete"
	} else if durablyCancelled {
		currentStep = "Migration cancelled"
	}
	// Final fan-out carries the durable outcome. The SSE handler independently
	// reloads the job before emitting its terminal `done` frame.
	h.broadcaster.Publish(jobID, ProgressEvent{
		Resource:    "all",
		CurrentStep: currentStep,
		Snapshot:    job.Progress,
		At:          time.Now(),
	})
}

func (h *Migration) markActive(jobID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, exists := h.active[jobID]; exists {
		return false
	}
	h.active[jobID] = struct{}{}
	return true
}

func (h *Migration) unmarkActive(jobID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.active, jobID)
}

func (h *Migration) watchDurableCancellation(ctx context.Context, tenantID, jobID string, cancel context.CancelCauseFunc, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(durableCancellationPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if h.isDurablyStoppedByOperator(jobstore.WithTenantID(ctx, tenantID), jobID) {
				cancel(errOperatorCancelled)
				return
			}
		}
	}
}

func (h *Migration) isDurablyStoppedByOperator(ctx context.Context, jobID string) bool {
	job, err := h.store.Get(ctx, jobID)
	return err == nil && (isCancelledJob(job) || isCancelledDeltaImport(job))
}

// failJob is the central place job-level errors are recorded.
func (h *Migration) failJob(ctx context.Context, job *canonical.MigrationJob, err error) {
	if job == nil {
		return
	}
	expected := job.Status
	if restoreDeltaImportSnapshot(job, err) {
		if persistErr := h.transitionJob(ctx, job, expected); persistErr != nil {
			slog.Warn("migration: persist delta import failure restore failed", "job_id", job.ID, "err", persistErr)
			return
		}
		h.clearTerminalVerifierObservations(ctx, job)
		return
	}
	job.Status = canonical.MigFailed
	msg := sanitizeMigrationErrorText(job.Source, err)
	job.Error = &msg
	if persistErr := h.transitionJob(ctx, job, expected); persistErr != nil {
		slog.Warn("migration: persist failure failed", "job_id", job.ID, "err", persistErr)
		return
	}
	h.clearTerminalVerifierObservations(ctx, job)
}

func (h *Migration) clearTerminalVerifierObservations(ctx context.Context, job *canonical.MigrationJob) {
	if h == nil || job == nil {
		return
	}
	if err := orchestrator.ClearSubscriberVerifierObservations(ctx, h.db, job.TenantID, job.ID); err != nil {
		slog.Error("migration: purge terminal subscriber verification observations failed", "job_id", job.ID, "err", err)
	}
}

func (h *Migration) pauseRateLimitedJob(ctx context.Context, job *canonical.MigrationJob, err *adapter.ErrRateLimited) {
	if job == nil {
		return
	}
	retryAfter := defaultRateLimitRetryAfter
	if d, ok := retryAfterFromError(err); ok {
		retryAfter = d
	}
	h.pauseRunnableJob(ctx, job, retryAfter, "source rate limited")
}

func (h *Migration) pauseSourceAccountJob(ctx context.Context, job *canonical.MigrationJob) {
	const retryAfter = time.Second
	sourceName := "source account"
	if job != nil {
		switch job.Source {
		case canonical.SourceActiveCampaign:
			sourceName = "ActiveCampaign account"
		case canonical.SourceBeehiiv:
			sourceName = "Beehiiv workspace"
		default:
			sourceName = string(job.Source) + " account"
		}
	}
	h.pauseRunnableJob(ctx, job, retryAfter, "another "+sourceName+" operation is in progress")
}

func (h *Migration) pauseRunnableJob(ctx context.Context, job *canonical.MigrationJob, retryAfter time.Duration, reason string) {
	if job == nil {
		return
	}
	retryAt := time.Now().UTC().Add(retryAfter)
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	retryAtValue := retryAt.Format(time.RFC3339Nano)
	retryAfterValue := retryAfter.String()
	job.Cursor[rateLimitRetryAtCursorKey] = &retryAtValue
	job.Cursor[rateLimitRetryAfterCursorKey] = &retryAfterValue
	msg := fmt.Sprintf("%s; migration will retry after %s", reason, retryAt.Format(time.RFC3339))
	job.Error = &msg
	if persistErr := h.transitionJob(ctx, job, job.Status); persistErr != nil {
		slog.Warn("migration: persist rate-limit pause failed", "job_id", job.ID, "err", persistErr)
	}
}

type deltaImportSnapshot struct {
	Progress           canonical.MigrationProgress   `json:"progress"`
	Cursor             map[string]string             `json:"cursor,omitempty"`
	StartedAt          time.Time                     `json:"started_at"`
	CompletedAt        *time.Time                    `json:"completed_at,omitempty"`
	RollbackUntil      *time.Time                    `json:"rollback_until,omitempty"`
	VerificationReport *canonical.VerificationReport `json:"verification_report,omitempty"`
}

func attachDeltaImportSnapshot(job *canonical.MigrationJob) error {
	sanitizeMigrationJobEvidence(job)
	snap := deltaImportSnapshot{
		Progress:           job.Progress,
		Cursor:             cursorStringMap(job.Cursor),
		StartedAt:          job.StartedAt,
		CompletedAt:        job.CompletedAt,
		RollbackUntil:      job.RollbackUntil,
		VerificationReport: job.VerificationReport,
	}
	delete(snap.Cursor, deltaImportSnapshotKey)
	delete(snap.Cursor, deltaImportLastErrorKey)
	delete(snap.Cursor, rateLimitRetryAtCursorKey)
	delete(snap.Cursor, rateLimitRetryAfterCursorKey)
	delete(snap.Cursor, scheduledStartAtCursorKey)
	payload, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	mode := runModeDeltaImport
	snapshot := string(payload)
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	// Delta import is a fresh execution over the same reviewed source scope.
	// Clear only stage/checkpoint state so immutable account identity, audience
	// selection, and other control-plane evidence survive the lifecycle.
	orchestrator.ResetExecutionState(job)
	// The snapshot above retains the previous token for failure recovery. A
	// started delta must invalidate that attempt immediately; successful
	// completion leaves it absent until a new shadow check rotates a token.
	delete(job.Cursor, shadowAttemptTokenCursorKey)
	clearRateLimitPause(job)
	// MIGR-038: a delta import is a fresh run — never inherit the base run's
	// schedule (the DeltaImport handler sets its own if requested).
	clearScheduledStart(job)
	delete(job.Cursor, deltaImportSnapshotKey)
	delete(job.Cursor, deltaImportLastErrorKey)
	delete(job.Cursor, deltaImportStartedAtKey)
	delete(job.Cursor, sourceEventPreDeltaSyncedKey)
	delete(job.Cursor, sourceEventOverlapSnapshotKey)
	job.Cursor[runModeCursorKey] = &mode
	job.Cursor[deltaImportSnapshotKey] = &snapshot
	return nil
}

func restoreDeltaImportSnapshot(job *canonical.MigrationJob, err error) bool {
	if job == nil || !isDeltaImportRun(job) {
		return false
	}
	raw, ok := cursorString(job.Cursor, deltaImportSnapshotKey)
	if !ok || strings.TrimSpace(raw) == "" {
		return false
	}
	var snap deltaImportSnapshot
	if jsonErr := json.Unmarshal([]byte(raw), &snap); jsonErr != nil {
		return false
	}
	msg := fmt.Sprintf("delta import failed; previous completed migration preserved: %s", sanitizeMigrationErrorText(job.Source, err))
	job.Status = canonical.MigCompleted
	job.Progress = snap.Progress
	job.Cursor = cursorPointerMap(snap.Cursor)
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	job.CompletedAt = snap.CompletedAt
	job.RollbackUntil = snap.RollbackUntil
	job.VerificationReport = snap.VerificationReport
	if !snap.StartedAt.IsZero() {
		job.StartedAt = snap.StartedAt
	}
	job.Error = &msg
	job.Cursor[deltaImportLastErrorKey] = &msg
	sanitizeMigrationJobEvidence(job)
	return true
}

func clearDeltaImportSnapshot(job *canonical.MigrationJob) {
	if job == nil || job.Cursor == nil {
		return
	}
	restoreDeltaImportImmutableControlCursors(job)
	delete(job.Cursor, deltaImportSnapshotKey)
	delete(job.Cursor, deltaImportLastErrorKey)
}

var deltaImportImmutableControlCursorKeys = []string{
	destinationIDCursorKey,
	destinationHashCursorKey,
	"source_data_removed_at",
	"source_cleanup_started_at",
	brevoAccountCursorKey,
	kitAccountCursorKey,
	activeCampaignAccountCursorKey,
	hubSpotAccountCursorKey,
	hubSpotDataLocationCursorKey,
	beehiivAccountCursorKey,
	beehiivWorkspaceCursorKey,
	beehiivPublicationCursorKey,
	klaviyoAccountCursorKey,
	customerIOWorkspaceCursorKey,
	customerIOWorkspaceIDCursorKey,
	customerIORegionCursorKey,
	mailchimpAccountCursorKey,
	selectedAudiencesCursorKey,
}

// restoreDeltaImportImmutableControlCursors makes completion safe for jobs
// attached by an older service version and prevents execution from replacing
// immutable account/scope controls before the snapshot is cleared.
func restoreDeltaImportImmutableControlCursors(job *canonical.MigrationJob) {
	if job == nil || job.Cursor == nil {
		return
	}
	raw, ok := cursorString(job.Cursor, deltaImportSnapshotKey)
	if !ok || strings.TrimSpace(raw) == "" {
		return
	}
	var snap deltaImportSnapshot
	if err := json.Unmarshal([]byte(raw), &snap); err != nil {
		return
	}
	for _, key := range deltaImportImmutableControlCursorKeys {
		value, exists := snap.Cursor[key]
		if !exists {
			delete(job.Cursor, key)
			continue
		}
		v := value
		job.Cursor[key] = &v
	}
}

func isDeltaImportRun(job *canonical.MigrationJob) bool {
	if job == nil || job.Cursor == nil {
		return false
	}
	mode, ok := cursorString(job.Cursor, runModeCursorKey)
	return ok && mode == runModeDeltaImport
}

func cursorString(cursor map[string]*string, key string) (string, bool) {
	value, ok := cursor[key]
	if !ok || value == nil {
		return "", false
	}
	return *value, true
}

func cursorStringMap(cursor map[string]*string) map[string]string {
	if len(cursor) == 0 {
		return nil
	}
	out := make(map[string]string, len(cursor))
	for key, value := range cursor {
		if value != nil {
			out[key] = *value
		}
	}
	return out
}

func cursorPointerMap(cursor map[string]string) map[string]*string {
	if len(cursor) == 0 {
		return nil
	}
	out := make(map[string]*string, len(cursor))
	for key, value := range cursor {
		v := value
		out[key] = &v
	}
	return out
}

func rateLimitPausedUntil(job *canonical.MigrationJob, now time.Time) (time.Time, bool) {
	if job == nil {
		return time.Time{}, false
	}
	raw, ok := cursorString(job.Cursor, rateLimitRetryAtCursorKey)
	if !ok || strings.TrimSpace(raw) == "" {
		return time.Time{}, false
	}
	retryAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(raw))
	if err != nil {
		return time.Time{}, false
	}
	return retryAt, retryAt.After(now)
}

// scheduledStartPausedUntil reports whether a job is held for a future scheduled
// start (MIGR-038). Mirrors rateLimitPausedUntil: unset/blank/unparseable →
// (zero, false) so an UNSCHEDULED job always runs (fail-open); the strict
// After(now) boundary makes the exact scheduled instant run (inclusive start).
func scheduledStartPausedUntil(job *canonical.MigrationJob, now time.Time) (time.Time, bool) {
	if job == nil {
		return time.Time{}, false
	}
	raw, ok := cursorString(job.Cursor, scheduledStartAtCursorKey)
	if !ok || strings.TrimSpace(raw) == "" {
		return time.Time{}, false
	}
	startAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(raw))
	if err != nil {
		return time.Time{}, false
	}
	return startAt, startAt.After(now)
}

func retryAfterFromError(err error) (time.Duration, bool) {
	var rateLimited *adapter.ErrRateLimited
	if !errors.As(err, &rateLimited) {
		return 0, false
	}
	if rateLimited != nil && rateLimited.RetryAfter > 0 {
		return rateLimited.RetryAfter, true
	}
	return defaultRateLimitRetryAfter, true
}

func nextRetryAwareAttemptAt(now time.Time, baseInterval time.Duration, err error) time.Time {
	if baseInterval <= 0 {
		baseInterval = defaultRateLimitRetryAfter
	}
	next := now.Add(baseInterval)
	if retryAfter, ok := retryAfterFromError(err); ok {
		retryAt := now.Add(retryAfter)
		if retryAt.After(next) {
			return retryAt
		}
	}
	return next
}

func clearRateLimitPause(job *canonical.MigrationJob) {
	if job == nil || job.Cursor == nil {
		return
	}
	delete(job.Cursor, rateLimitRetryAtCursorKey)
	delete(job.Cursor, rateLimitRetryAfterCursorKey)
}

// clearScheduledStart drops a job's scheduled-start hold (MIGR-038). In-memory
// only; a following transitionJob/progress callback persists the removal.
func clearScheduledStart(job *canonical.MigrationJob) {
	if job == nil || job.Cursor == nil {
		return
	}
	delete(job.Cursor, scheduledStartAtCursorKey)
}

// applyScheduledStart stamps an optional future scheduled-start instant onto the
// job's cursor (MIGR-038). raw is the request's scheduled_for (RFC3339); empty
// or a past/now value means "run immediately" (returns scheduled=false, no
// cursor write); a non-empty unparseable value is a client error. When a future
// instant is given, the cursor gets it as RFC3339Nano UTC and the caller SKIPs
// the immediate launch so the recovery worker starts it at that time. Does not
// touch job.Error — scheduling is not a failure.
func applyScheduledStart(job *canonical.MigrationJob, raw string) (bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false, nil
	}
	startAt, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return false, fmt.Errorf("scheduled_for must be an RFC3339 timestamp: %w", err)
	}
	if !startAt.After(time.Now()) {
		// A past/now schedule is a no-op: run immediately.
		return false, nil
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	value := startAt.UTC().Format(time.RFC3339Nano)
	job.Cursor[scheduledStartAtCursorKey] = &value
	return true, nil
}

// GetJob is the polling endpoint.
func (h *Migration) GetJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "job_id")
	// Friendly 400 instead of letting a non-UUID id fall through to
	// the loadJob path where pg returns "invalid input syntax for
	// type uuid: \"…\"" (SQLSTATE 22P02) as a 500. This catches the
	// common case where a client guesses `/v1/migrations/jobs` or
	// `/v1/migrations/list` thinking those are collection routes.
	if _, perr := uuid.Parse(id); perr != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid job_id: %q is not a UUID", id))
		return
	}
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	job, err := h.loadJob(r.Context(), tenantID, id)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	sanitizeMigrationJobForResponse(job)
	writeJSON(w, http.StatusOK, job)
}

// updateJobRequest is the body of PATCH /v1/migrations/{job_id} (MIGR-037).
// A field's absence leaves it unchanged; an empty string clears it.
type updateJobRequest struct {
	Label *string `json:"label"`
	Notes *string `json:"notes"`
}

const (
	maxMigrationLabelLen = 120
	maxMigrationNotesLen = 2000
)

// normalizeAnnotation trims, bounds by rune length, and returns nil for an empty
// result so the column is cleared rather than set to "".
func normalizeAnnotation(s string, max int) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	if r := []rune(s); len(r) > max {
		s = string(r[:max])
	}
	return &s
}

// UpdateJob sets the operator label/notes on a migration (MIGR-037) so two
// same-source/same-day attempts are distinguishable. Only the annotation
// columns are touched (jobstore.UpdateAnnotations), never lifecycle state.
func (h *Migration) UpdateJob(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "job_id")
	if _, err := uuid.Parse(jobID); err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid job_id: %q is not a UUID", jobID))
		return
	}
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	var in updateJobRequest
	if err := decodeRequestJSON(w, r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	// Load first so an unknown/foreign job returns 404 (RLS also guards the write).
	job, err := h.loadJob(r.Context(), tenantID, jobID)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	label, notes := job.Label, job.Notes
	if in.Label != nil {
		label = normalizeAnnotation(*in.Label, maxMigrationLabelLen)
	}
	if in.Notes != nil {
		notes = normalizeAnnotation(*in.Notes, maxMigrationNotesLen)
	}
	if err := h.store.UpdateAnnotations(jobstore.WithTenantID(r.Context(), tenantID), jobID, label, notes); err != nil {
		writeJobStoreErr(w, err)
		return
	}
	job.Label, job.Notes = label, notes
	sanitizeMigrationJobForResponse(job)
	writeJSON(w, http.StatusOK, job)
}

// GetJobEvents streams migration progress as Server-Sent Events.
//
// Wire format:
//
//	event: snapshot                 ← initial state (compat with old clients)
//	data: <full MigrationJob JSON>
//
//	event: progress                 ← one per resource batch boundary
//	data: {"resource":"subscribers","completed":234,"total":1500,
//	        "current_step":"Importing subscribers","snapshot":{…},"at":"…"}
//
//	:keepalive                      ← every 30s while no real frame fired
//
//	event: done                     ← single terminal frame, then close
//	data: {"status":"completed|failed|rolled_back","resources":{…},"job":{…}}
//
// The handler subscribes to an in-process broadcaster fed by runJob's
// progress callback. If the job is already terminal when the request
// arrives we stream the final snapshot + `done` and close immediately.
// Connections are capped at 10 minutes to keep proxies + load balancers
// happy.
func (h *Migration) GetJobEvents(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "job_id")
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, fmt.Errorf("streaming unsupported"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	// Subscribe early so events fired between our snapshot read and the
	// first select() aren't dropped.
	events, unsubscribe := h.broadcaster.Subscribe(id)
	defer unsubscribe()

	// Initial snapshot — also acts as authorization check (404s a stale
	// id, 403s a cross-tenant peek).
	job, err := h.loadJob(r.Context(), tenantID, id)
	if err != nil {
		writeSSE(w, "error", map[string]string{"error": err.Error()})
		flusher.Flush()
		return
	}
	writeSSE(w, "snapshot", job)
	flusher.Flush()
	if isTerminalStatus(job.Status) {
		writeSSE(w, "done", terminalDoneEvent(job))
		flusher.Flush()
		return
	}

	keepalive := time.NewTicker(30 * time.Second)
	defer keepalive.Stop()
	deadline := time.NewTimer(10 * time.Minute)
	defer deadline.Stop()
	// While the orchestrator broadcasts on every batch boundary, we still
	// re-read the persisted job at a slow tick so terminal transitions
	// observed by other workers (or completed-without-progress flows)
	// get surfaced as a `done` event.
	pollTicker := time.NewTicker(2 * time.Second)
	defer pollTicker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-deadline.C:
			// Tell the client we hit the connection cap. Browsers will
			// reconnect on the next animation frame; the next call gets a
			// fresh 10 minute window and a snapshot of the current state.
			writeSSE(w, "error", map[string]string{"error": "connection cap reached; reconnect"})
			flusher.Flush()
			return
		case <-keepalive.C:
			_, _ = fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case evt := <-events:
			writeSSE(w, "progress", evt)
			flusher.Flush()
		case <-pollTicker.C:
			j, err := h.loadJob(r.Context(), tenantID, id)
			if err != nil {
				writeSSE(w, "error", map[string]string{"error": err.Error()})
				flusher.Flush()
				return
			}
			if isTerminalStatus(j.Status) {
				writeSSE(w, "done", terminalDoneEvent(j))
				flusher.Flush()
				return
			}
		}
	}
}

// terminalDoneEvent is the JSON payload emitted on the final `event:
// done` frame. Mirrors the desktop wizard's expectations: top-level
// status + per-resource imported/skipped/failed counts derived from the
// VerificationReport when present, otherwise from the orchestrator's
// progress counters. ActiveCampaign automation rebuild inventory also
// carries a `review` count so clients do not present intentional rebuild
// review as failed runtime automation import.
func terminalDoneEvent(job *canonical.MigrationJob) map[string]any {
	resources := map[string]map[string]int{}
	addResourceCounts := func(name string, imported, skipped, failed int) {
		resources[name] = map[string]int{
			"imported": imported,
			"skipped":  skipped,
			"failed":   failed,
		}
	}
	remainder := func(total, imported int) int {
		if total > imported {
			return total - imported
		}
		return 0
	}
	addResource := func(name string, imported, total int) {
		addResourceCounts(name, imported, 0, remainder(total, imported))
	}
	addActiveCampaignAutomations := func(imported, total int) {
		review := remainder(total, imported)
		resources["automations"] = map[string]int{
			"imported": imported,
			"skipped":  review,
			"failed":   0,
			"review":   review,
		}
	}
	if vr := job.VerificationReport; vr != nil {
		addResource("subscribers", vr.SubscribersImported, job.Progress.SubscribersTotal)
		addResource("segments", vr.SegmentsTranslated, job.Progress.SegmentsTotal)
		if job.Source == canonical.SourceActiveCampaign {
			addActiveCampaignAutomations(vr.AutomationsTranslated, job.Progress.AutomationsTotal)
		} else {
			addResource("automations", vr.AutomationsTranslated, job.Progress.AutomationsTotal)
		}
		addResource("archive", vr.ArchiveImported, job.Progress.ArchiveTotal)
		addResource("paid_subs", vr.PaidSubsImported, job.Progress.PaidSubsTotal)
		addResource("templates", vr.TemplatesImported, job.Progress.TemplatesTotal)
		addResource("source_archive", vr.SourceArchiveImported, job.Progress.SourceArchiveTotal)
	} else {
		p := job.Progress
		addResource("subscribers", p.SubscribersDone, p.SubscribersTotal)
		addResource("segments", p.SegmentsDone, p.SegmentsTotal)
		if job.Source == canonical.SourceActiveCampaign {
			addActiveCampaignAutomations(p.AutomationsDone, p.AutomationsTotal)
		} else {
			addResource("automations", p.AutomationsDone, p.AutomationsTotal)
		}
		addResource("archive", p.ArchiveDone, p.ArchiveTotal)
		addResource("paid_subs", p.PaidSubsDone, p.PaidSubsTotal)
		addResource("templates", p.TemplatesDone, p.TemplatesTotal)
		addResource("source_archive", p.SourceArchiveDone, p.SourceArchiveTotal)
	}
	out := map[string]any{
		"status":    string(job.Status),
		"resources": resources,
		"job":       job,
	}
	if job.Error != nil {
		out["error"] = *job.Error
	}
	return out
}

// CancelJob atomically records an operator cancellation without replacing the
// worker's progress/cursor checkpoint. The owning replica is interrupted
// immediately when local; otherwise its durable watcher observes the marker.
// Repeating cancellation for a terminal job is a successful no-op. Only an
// unknown job_id returns 404.
func (h *Migration) CancelJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "job_id")
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	job, err := h.loadJob(r.Context(), tenantID, id)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	cancelled := false
	if job.Status == canonical.MigDryRun || job.Status == canonical.MigImporting {
		scopedCtx := jobstore.WithTenantID(r.Context(), tenantID)
		expectedStatus := job.Status
		var cancelErr error
		if isDeltaImportRun(job) && restoreDeltaImportSnapshot(job, errOperatorCancelled) {
			// Restore the immutable pre-delta completed snapshot in the cancelling
			// transaction. This remains correct if the owner is another replica or
			// dies before it observes the durable stop marker.
			cancelErr = h.transitionJob(scopedCtx, job, expectedStatus)
		} else {
			store, ok := h.store.(jobstore.CancellationJobStore)
			if !ok {
				writeErr(w, http.StatusInternalServerError, fmt.Errorf("migration job store does not support durable cancellation"))
				return
			}
			var rollbackUntil *time.Time
			if expectedStatus == canonical.MigImporting {
				value := time.Now().Add(migrationRollbackWindow(job.Source))
				rollbackUntil = &value
			}
			cancelErr = store.CancelIfStatus(scopedCtx, id, cancelledByOperatorMsg, rollbackUntil, expectedStatus)
		}
		if cancelErr != nil {
			if !errors.Is(cancelErr, jobstore.ErrStatusTransitionConflict) {
				writeJobStoreErr(w, cancelErr)
				return
			}
		} else {
			cancelled = true
			// This handles the owning replica with no polling delay. A different
			// replica observes the same marker in watchDurableCancellation.
			_ = h.control.Cancel(id)
			h.clearTerminalVerifierObservations(scopedCtx, job)
		}
		job, err = h.loadJob(r.Context(), tenantID, id)
		if err != nil {
			writeJobStoreErr(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"job_id":             id,
		"cancelled":          cancelled,
		"status":             string(job.Status),
		"progress":           job.Progress,
		"rollback_available": job.RollbackUntil != nil && time.Now().Before(*job.RollbackUntil),
		"rollback_until":     job.RollbackUntil,
	})
}

// isCancelledJob reports whether a job is in the operator-cancelled
// state: status=failed with the cancellation message recorded by
// runJob's context.Canceled branch. (There is no dedicated "cancelled"
// status — see cancelledByOperatorMsg.)
func isCancelledJob(job *canonical.MigrationJob) bool {
	return job != nil &&
		job.Status == canonical.MigFailed &&
		job.Error != nil &&
		strings.TrimSpace(*job.Error) == cancelledByOperatorMsg
}

func isCancelledDeltaImport(job *canonical.MigrationJob) bool {
	if job == nil || job.Status != canonical.MigCompleted || job.Error == nil {
		return false
	}
	expected := "delta import failed; previous completed migration preserved: " + cancelledByOperatorMsg
	return strings.TrimSpace(*job.Error) == expected
}

// ResumeJob restarts a cancelled migration: POST /v1/migrations/{job_id}/resume.
//
// Eligibility: ONLY the cancelled state (status=failed + cancellation
// error). Other failures should go through a fresh dry-run/commit so
// the operator re-confirms after fixing the root cause; resuming them
// here returns 409.
//
// Resume semantics — restart-from-checkpoint with dedupe-skip:
//   - The job's Cursor map is the persisted ledger. Cursor-paginated
//     resources (subscribers, templates, campaign archive, source
//     archive) continue from the last batch boundary the progress
//     callback persisted before the cancel — no re-read of completed
//     pages.
//   - List-shaped resources (segments, automations, paid subs) re-run
//     from the top; their persistence layer is keyed on (tenant, job,
//     source id) so replays upsert/skip rather than duplicate.
//   - The run restarts in its original mode (dry_run vs importing),
//     read from the run_mode cursor slot kickoff recorded; legacy jobs
//     without the slot default to importing — resuming a *cancelled*
//     dry-run as a commit would be the dangerous direction, but a
//     dry-run writes nothing, so the importing default only ever
//     affects pre-resume-era jobs whose operator already confirmed.
//
// Responds 202 {"job_id": "...", "status": "importing"|"dry_run"} and
// the existing /events SSE + GET endpoints track progress as usual.
func (h *Migration) ResumeJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "job_id")
	if _, perr := uuid.Parse(id); perr != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid job_id: %q is not a UUID", id))
		return
	}
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	job, err := h.loadJob(r.Context(), tenantID, id)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if !isCancelledJob(job) {
		writeErr(w, http.StatusConflict,
			fmt.Errorf("job status %q is not resumable; only a cancelled migration can be resumed", job.Status))
		return
	}
	executionLease, err := h.acquireJobExecution(r.Context(), tenantID, job.ID)
	if err != nil {
		writeExecutionLeaseErr(w, err)
		return
	}
	defer func() { _ = executionLease.Release() }()

	// The eligibility read above is only an early user-facing check. Reload
	// under the shared execution lease so every setup decision is based on the
	// same lifecycle epoch that the CAS below will commit.
	job, err = h.loadJob(r.Context(), tenantID, id)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if !isCancelledJob(job) {
		writeErr(w, http.StatusConflict,
			fmt.Errorf("job status %q is not resumable; only a cancelled migration can be resumed", job.Status))
		return
	}
	// The source session must still be live — a resume without one would
	// immediately fail in runJob; surface the reconnect ask up front.
	if _, serr := h.loadSession(r.Context(), tenantID, id); serr != nil {
		if errors.Is(serr, jobstore.ErrNotFound) {
			writeErr(w, http.StatusConflict, fmt.Errorf("source session expired; reconnect source before continuing"))
			return
		}
		writeJobStoreErr(w, serr)
		return
	}

	target := canonical.MigImporting
	if m, ok := job.Cursor[runModeCursorKey]; ok && m != nil && *m == runModeDryRun {
		target = canonical.MigDryRun
	}
	if err := orchestrator.ResetSubscriberVerificationState(job); err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Errorf("reset subscriber verification checkpoint: %w", err))
		return
	}
	job.Status = target
	job.Error = nil
	// MIGR-038: a resume starts the run NOW (there is no scheduled_for field on
	// /resume), so scrub any stale schedule inherited from a job that was
	// cancelled before its future start — otherwise the deferral gate would
	// silently re-hold the resumed job until the original instant. Mirrors the
	// clears in prepareJobForNewRun + attachDeltaImportSnapshot.
	clearScheduledStart(job)
	clearRateLimitPause(job)
	scopedCtx := jobstore.WithTenantID(r.Context(), tenantID)
	if err := h.transitionJob(scopedCtx, job, canonical.MigFailed); err != nil {
		writeTransitionErr(w, err)
		return
	}
	if err := orchestrator.ClearSubscriberVerifierObservations(scopedCtx, h.db, tenantID, job.ID); err != nil {
		h.failAcceptedTransition(scopedCtx, job, target, err)
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if err := executionLease.Release(); err != nil {
		h.failAcceptedTransition(scopedCtx, job, target, err)
		writeExecutionLeaseErr(w, err)
		return
	}
	// Same launch shape as kickoff: a detached context so the run
	// outlives this request. The recovery worker would also pick the
	// job up (its status is runnable again), but launching directly
	// avoids the up-to-30s poll latency.
	h.launchRunnableJob(tenantID, job.ID)

	writeJSON(w, http.StatusAccepted, map[string]string{
		"job_id": job.ID,
		"status": string(target),
	})
}

// GetVerification returns the VerificationReport for a job, or 404 if no
// report has been built yet (e.g. the job is still authenticating).
func (h *Migration) GetVerification(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "job_id")
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	job, err := h.loadJob(r.Context(), tenantID, id)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	if job.VerificationReport == nil {
		writeErr(w, http.StatusNotFound, fmt.Errorf("verification report not yet available"))
		return
	}
	sanitizeMigrationJobEvidence(job)
	writeJSON(w, http.StatusOK, job.VerificationReport)
}

// StartRollback marks the job rolling_back durably, kicks off a rollback
// worker, and returns 202 immediately. Use GetRollbackStatus to poll
// progress. If the process restarts while a job is rolling_back, polling the
// status endpoint recreates the worker and resumes the idempotent rollback.
func (h *Migration) StartRollback(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "job_id")
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	job, err := h.loadJob(r.Context(), tenantID, id)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	// Reject ineligible states up front so the UI gets a clean error rather
	// than a 202 + a failed background task.
	failedCleanupCandidate := job.Status == canonical.MigFailed && !isCancelledJob(job)
	if job.Status != canonical.MigCompleted && job.Status != canonical.MigRollingBack && !isCancelledJob(job) && !failedCleanupCandidate {
		writeErr(w, http.StatusConflict, fmt.Errorf("job status %q is not rollback-able", job.Status))
		return
	}
	if job.RollbackUntil == nil || time.Now().After(*job.RollbackUntil) {
		writeErr(w, http.StatusGone, orchestrator.ErrRollbackWindowExpired)
		return
	}
	executionLease, err := h.acquireJobExecution(r.Context(), tenantID, job.ID)
	if err != nil {
		writeExecutionLeaseErr(w, err)
		return
	}
	defer func() { _ = executionLease.Release() }()

	job, err = h.loadJob(r.Context(), tenantID, id)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	failedCleanupCandidate = job.Status == canonical.MigFailed && !isCancelledJob(job)
	if job.Status != canonical.MigCompleted && job.Status != canonical.MigRollingBack && !isCancelledJob(job) && !failedCleanupCandidate {
		writeErr(w, http.StatusConflict, fmt.Errorf("job status %q is not rollback-able", job.Status))
		return
	}
	if job.RollbackUntil == nil || time.Now().After(*job.RollbackUntil) {
		writeErr(w, http.StatusGone, orchestrator.ErrRollbackWindowExpired)
		return
	}

	engine, err := h.rollbackEngineForJob(r.Context(), job)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, err)
		return
	}
	if failedCleanupCandidate {
		hasWrites, checkErr := engine.HasTrackedWrites(r.Context(), job)
		if checkErr != nil {
			writeErr(w, http.StatusServiceUnavailable, checkErr)
			return
		}
		if !hasWrites {
			writeErr(w, http.StatusConflict, fmt.Errorf("failed migration has no tracked destination writes to roll back"))
			return
		}
	}
	cleanupStarted := markPostPilotCleanupStarted(job, time.Now())
	if job.Source == canonical.SourceHubSpot && postPilotCleanupStarted(job) {
		if err := h.clearHubSpotPostPilotSourceSession(jobstore.WithTenantID(r.Context(), job.TenantID), job, time.Now()); err != nil {
			writeJobStoreErr(w, err)
			return
		}
	}

	if job.Status == canonical.MigCompleted || job.Status == canonical.MigFailed {
		originStatus := job.Status
		if job.Cursor == nil {
			job.Cursor = map[string]*string{}
		}
		origin := string(job.Status)
		job.Cursor[rollbackOriginStatusCursorKey] = &origin
		job.Status = canonical.MigRollingBack
		job.Error = nil
		if err := h.transitionJob(jobstore.WithTenantID(r.Context(), job.TenantID), job, originStatus); err != nil {
			writeTransitionErr(w, err)
			return
		}
	} else if cleanupStarted {
		if err := h.transitionJob(jobstore.WithTenantID(r.Context(), job.TenantID), job, job.Status); err != nil {
			writeTransitionErr(w, err)
			return
		}
	}
	if err := executionLease.Release(); err != nil {
		writeExecutionLeaseErr(w, err)
		return
	}
	h.startRollbackWorker(job, engine)

	writeJSON(w, http.StatusAccepted, map[string]string{"job_id": id, "state": "running"})
}

// GetRollbackStatus returns the current rollback progress, or 404 if no
// rollback has been started for this job.
func (h *Migration) GetRollbackStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "job_id")
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	job, err := h.loadJob(r.Context(), tenantID, id)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	h.mu.Lock()
	eng, ok := h.rollbacks[id]
	h.mu.Unlock()
	if !ok {
		switch job.Status {
		case canonical.MigRolledBack:
			writeJSON(w, http.StatusOK, rollbackProgressFromJob(job, "completed"))
			return
		case canonical.MigRollingBack:
			var engErr error
			eng, engErr = h.rollbackEngineForJob(r.Context(), job)
			if engErr != nil {
				writeErr(w, http.StatusServiceUnavailable, engErr)
				return
			}
			h.startRollbackWorker(job, eng)
			if prog := eng.Progress(id); prog != nil {
				writeJSON(w, http.StatusOK, sanitizeRollbackProgressForResponse(job.Source, prog))
				return
			}
			writeJSON(w, http.StatusOK, rollbackProgressFromJob(job, "running"))
			return
		default:
			writeErr(w, http.StatusNotFound, fmt.Errorf("no rollback for this job"))
		}
		return
	}
	prog := eng.Progress(id)
	if prog == nil {
		writeErr(w, http.StatusNotFound, fmt.Errorf("no rollback progress recorded"))
		return
	}
	writeJSON(w, http.StatusOK, sanitizeRollbackProgressForResponse(job.Source, prog))
}

func (h *Migration) rollbackEngineForJob(ctx context.Context, job *canonical.MigrationJob) (*orchestrator.RollbackEngine, error) {
	h.mu.Lock()
	if eng, ok := h.rollbacks[job.ID]; ok {
		h.mu.Unlock()
		return eng, nil
	}
	h.mu.Unlock()

	eng, err := h.newRollbackEngineForJob(ctx, job)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if existing, ok := h.rollbacks[job.ID]; ok {
		return existing, nil
	}
	h.rollbacks[job.ID] = eng
	return eng, nil
}

// newRollbackEngineForJob resolves current destination requirements without
// caching engine state. Rollback rehearsal uses a fresh engine so a prior
// zero-write rehearsal cannot leave a stale nil destination client after a
// later delta import adds Listmonk-backed resources.
func (h *Migration) newRollbackEngineForJob(ctx context.Context, job *canonical.MigrationJob) (*orchestrator.RollbackEngine, error) {
	var lmc *listmonkx.Client
	needsListmonk, err := h.rollbackNeedsListmonk(ctx, job)
	if err != nil {
		return nil, fmt.Errorf("inspect rollback destination requirements: %w", err)
	}
	if needsListmonk {
		c, err := h.listmonkClientForJob(ctx, job)
		if err != nil {
			return nil, fmt.Errorf("rollback requires destination Listmonk credentials: %w", err)
		}
		lmc = c
	} else if c, lerr := h.listmonkClientForJob(ctx, job); lerr == nil {
		lmc = c
	}
	return orchestrator.NewRollbackEngine(lmc, h.db, job.TenantID), nil
}

func (h *Migration) rollbackNeedsListmonk(ctx context.Context, job *canonical.MigrationJob) (bool, error) {
	if job == nil {
		return false, nil
	}
	if h != nil && h.db != nil && strings.TrimSpace(job.TenantID) != "" && strings.TrimSpace(job.ID) != "" {
		for _, resourceType := range []string{listmonkx.ResourceSubscriber, listmonkx.ResourceList, listmonkx.ResourceTemplate} {
			count, err := listmonkx.CountImportedResources(ctx, h.db, job.TenantID, job.ID, resourceType)
			if err != nil {
				return false, err
			}
			if count > 0 {
				return true, nil
			}
		}
		intentCount, err := listmonkx.CountExternalWriteIntents(ctx, h.db, job.TenantID, job.ID)
		if err != nil {
			return false, err
		}
		if intentCount > 0 {
			return true, nil
		}
		return false, nil
	}
	return job.Progress.SubscribersDone > 0 || job.Progress.TemplatesDone > 0, nil
}

func (h *Migration) startRollbackWorker(job *canonical.MigrationJob, eng *orchestrator.RollbackEngine) {
	if job == nil || eng == nil {
		return
	}
	if prog := eng.Progress(job.ID); prog != nil && prog.State == "running" {
		return
	}
	go func(j canonical.MigrationJob, eng *orchestrator.RollbackEngine) {
		ctx := jobstore.WithTenantID(context.Background(), j.TenantID)
		defer func() {
			if rec := recover(); rec != nil {
				err := fmt.Errorf("rollback worker panic: %v", rec)
				slog.Error("migration: rollback panic recovered", "job_id", j.ID, "err", err.Error())
				eng.MarkFailed(j.ID, err)
				msg := err.Error()
				j.Status = rollbackFailureStatus(&j)
				j.Error = &msg
				if perr := h.transitionJob(ctx, &j, canonical.MigRollingBack); perr != nil {
					slog.Warn("migration: persist rollback panic state failed", "job_id", j.ID, "err", perr)
				}
			}
		}()
		if err := eng.Rollback(ctx, &j); err != nil {
			if errors.Is(err, orchestrator.ErrRollbackInProgress) {
				// Another local worker or service instance owns the job-wide
				// rollback lock. Leave the durable state rolling_back; the owner
				// will publish the terminal state, and polling can resume the job
				// if that owner disappears.
				slog.Info("migration: rollback already owned by another worker", "job_id", j.ID)
				return
			}
			slog.Warn("migration: rollback failed", "job_id", j.ID, "err", err)
			msg := err.Error()
			j.Status = rollbackFailureStatus(&j)
			j.Error = &msg
			if perr := h.transitionJob(ctx, &j, canonical.MigRollingBack); perr != nil {
				slog.Warn("migration: persist rollback failure state failed", "job_id", j.ID, "err", perr)
			}
			return
		}
		if j.Cursor != nil {
			delete(j.Cursor, rollbackOriginStatusCursorKey)
		}
		if err := h.transitionJob(ctx, &j, canonical.MigRollingBack); err != nil {
			slog.Warn("migration: persist rollback failed", "job_id", j.ID, "err", err)
		} else {
			h.clearTerminalVerifierObservations(ctx, &j)
		}
	}(*job, eng)
}

const rollbackOriginStatusCursorKey = "__postwave_rollback_origin_status"

func rollbackFailureStatus(job *canonical.MigrationJob) canonical.MigrationStatus {
	if job != nil && job.Cursor != nil && job.Cursor[rollbackOriginStatusCursorKey] != nil {
		switch canonical.MigrationStatus(strings.TrimSpace(*job.Cursor[rollbackOriginStatusCursorKey])) {
		case canonical.MigFailed:
			return canonical.MigFailed
		case canonical.MigCompleted:
			return canonical.MigCompleted
		}
	}
	// Backward compatibility for rolling_back jobs accepted before the origin
	// sentinel existed: historically only completed jobs entered this state.
	return canonical.MigCompleted
}

func rollbackProgressFromJob(job *canonical.MigrationJob, state string) *orchestrator.RollbackProgress {
	if job == nil {
		return nil
	}
	p := &orchestrator.RollbackProgress{
		State:            state,
		ArchiveTotal:     job.Progress.ArchiveDone + job.Progress.SourceArchiveDone,
		TemplatesTotal:   job.Progress.TemplatesDone,
		AutomationsTotal: job.Progress.AutomationsDone,
		SegmentsTotal:    job.Progress.SegmentsDone,
		SubscribersTotal: job.Progress.SubscribersDone,
		PaidSubsTotal:    job.Progress.PaidSubsDone,
		StartedAt:        job.StartedAt.UTC().Format(time.RFC3339),
	}
	if state == "completed" {
		p.ArchiveDeleted = p.ArchiveTotal
		p.TemplatesDeleted = p.TemplatesTotal
		p.AutomationsDeleted = p.AutomationsTotal
		p.SegmentsDeleted = p.SegmentsTotal
		p.SubscribersDeleted = p.SubscribersTotal
		p.PaidSubsDeleted = p.PaidSubsTotal
		if job.CompletedAt != nil {
			p.CompletedAt = job.CompletedAt.UTC().Format(time.RFC3339)
		} else {
			p.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		}
	}
	if job.Error != nil {
		p.Error = sanitizeMigrationText(job.Source, *job.Error)
	}
	return p
}

func sanitizeRollbackProgressForResponse(source canonical.SourcePlatform, prog *orchestrator.RollbackProgress) *orchestrator.RollbackProgress {
	if prog == nil || !migrationSensitiveSource(source) || prog.Error == "" {
		return prog
	}
	out := *prog
	out.Error = sanitizeMigrationText(source, out.Error)
	return &out
}

type migrationAuditEntry struct {
	ID        string         `json:"id"`
	Timestamp time.Time      `json:"timestamp"`
	Event     string         `json:"event"`
	Actor     string         `json:"actor"`
	Fields    map[string]any `json:"fields"`
}

// GetAudit returns the five newest tenant-scoped migration events for a job.
// Postgres deployments read the immutable audit_log. Memory/local deployments
// derive a minimal truthful lifecycle entry from the job instead of returning
// the old hardcoded empty array.
func (h *Migration) GetAudit(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "job_id")
	tenantID, ok := tenantIDFromRequest(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	job, err := h.loadJob(r.Context(), tenantID, id)
	if err != nil {
		writeJobStoreErr(w, err)
		return
	}
	entries := []migrationAuditEntry{}
	if h.db != nil {
		entries, err = h.loadMigrationAuditEntries(r.Context(), tenantID, id, job.Source)
		if err != nil {
			slog.Warn("migration: load audit entries failed", "job_id", id, "err", err)
			entries = nil
		}
	}
	if len(entries) == 0 {
		entries = derivedMigrationAuditEntries(job)
	}
	writeJSON(w, http.StatusOK, entries)
}

func (h *Migration) loadMigrationAuditEntries(ctx context.Context, tenantID, jobID string, source canonical.SourcePlatform) ([]migrationAuditEntry, error) {
	tx, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `
SELECT id::text, at, action,
       COALESCE(NULLIF(actor_label, ''), NULLIF(actor_type, ''), 'system'),
       metadata
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND action LIKE 'migration.%'
   AND (
        resource_id = $2
        OR metadata->>'job_id' = $2
        OR metadata->>'migration_job_id' = $2
   )
 ORDER BY at DESC, id DESC
 LIMIT 5`, tenantID, jobID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	entries := []migrationAuditEntry{}
	for rows.Next() {
		var entry migrationAuditEntry
		var metadata []byte
		if err := rows.Scan(&entry.ID, &entry.Timestamp, &entry.Event, &entry.Actor, &metadata); err != nil {
			return nil, err
		}
		entry.Fields = safeMigrationAuditFields(source, metadata)
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return entries, nil
}

func safeMigrationAuditFields(source canonical.SourcePlatform, raw []byte) map[string]any {
	decoded := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &decoded)
	}
	fields := map[string]any{}
	for key, value := range decoded {
		switch typed := value.(type) {
		case string:
			fields[key] = sanitizeMigrationText(source, typed)
		case float64, bool, nil:
			fields[key] = typed
		}
	}
	return fields
}

func derivedMigrationAuditEntries(job *canonical.MigrationJob) []migrationAuditEntry {
	if job == nil {
		return []migrationAuditEntry{}
	}
	fields := map[string]any{
		"source": string(job.Source),
		"status": string(job.Status),
	}
	entries := []migrationAuditEntry{}
	if job.CompletedAt != nil {
		entries = append(entries, migrationAuditEntry{
			ID:        "derived-terminal-" + job.ID,
			Timestamp: *job.CompletedAt,
			Event:     "migration." + string(job.Status),
			Actor:     "system",
			Fields:    fields,
		})
	}
	if !job.StartedAt.IsZero() {
		entries = append(entries, migrationAuditEntry{
			ID:        "derived-started-" + job.ID,
			Timestamp: job.StartedAt,
			Event:     "migration.started",
			Actor:     "system",
			Fields: map[string]any{
				"source": string(job.Source),
			},
		})
	}
	return entries
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeSSE(w http.ResponseWriter, event string, v interface{}) {
	if event != "" {
		_, _ = fmt.Fprintf(w, "event: %s\n", event)
	}
	_, _ = fmt.Fprint(w, "data: ")
	_ = json.NewEncoder(w).Encode(v)
	_, _ = fmt.Fprint(w, "\n")
}

func isTerminalStatus(status canonical.MigrationStatus) bool {
	switch status {
	case canonical.MigCompleted, canonical.MigFailed, canonical.MigRolledBack:
		return true
	default:
		return false
	}
}

func writeDiscoveryJSON(w http.ResponseWriter, jobID string, source canonical.SourcePlatform, rep adapter.DiscoveryReport) {
	rep = sanitizeDiscoveryReport(source, rep)
	ad, err := adapter.Get(source)
	if err != nil {
		// Discover only reaches this renderer after a registered adapter has
		// authenticated the job. Keep the response fail-closed if that invariant
		// is ever broken instead of advertising guessed capabilities.
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"job_id":                            jobID,
		"source":                            source,
		"capabilities":                      ad.Capabilities(),
		"subscribers_count":                 rep.SubscribersTotal,
		"profiles_without_email_count":      rep.ProfilesWithoutEmailTotal,
		"additional_email_identities_count": rep.AdditionalEmailIdentitiesTotal,
		"segments_count":                    rep.SegmentsTotal,
		"automations_count":                 rep.AutomationsTotal,
		"archive_count":                     rep.ArchiveTotal,
		"source_archive_count":              rep.SourceArchiveTotal,
		"paid_subs_count":                   rep.PaidSubsTotal,
		"templates_count":                   rep.TemplatesTotal,
		"campaigns_count":                   rep.CampaignsTotal,
		"reports_count":                     rep.ReportsTotal,
		"groups_count":                      rep.GroupsTotal,
		"forms_count":                       rep.FormsTotal,
		"landing_pages_count":               rep.LandingPagesTotal,
		"ecommerce_count":                   rep.EcommerceTotal,
		"custom_objects_count":              rep.CustomObjectsTotal,
		"subscription_channels_count":       rep.SubscriptionChannelsTotal,
		"sms_campaigns_count":               rep.SMSCampaignsTotal,
		"push_campaigns_count":              rep.PushCampaignsTotal,
		"resource_metadata":                 discoveryResourceMetadata(source, rep),
		"custom_fields":                     stringListOrEmpty(rep.CustomFields),
		"warnings":                          stringListOrEmpty(rep.Warnings),
		"audiences":                         audienceListOrEmpty(rep.Audiences),
	})
}

func audienceListOrEmpty(values []adapter.DiscoveryAudience) []adapter.DiscoveryAudience {
	if values == nil {
		return []adapter.DiscoveryAudience{}
	}
	return values
}

func stringListOrEmpty(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func writeErr(w http.ResponseWriter, status int, err error) {
	if status == http.StatusBadRequest {
		status = requestJSONStatusCode(err)
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func sanitizeMigrationError(source canonical.SourcePlatform, err error) error {
	if err == nil {
		return nil
	}
	msg := sanitizeMigrationErrorText(source, err)
	if msg == err.Error() {
		return err
	}
	return errors.New(msg)
}

func sanitizeMigrationErrorText(source canonical.SourcePlatform, err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if !migrationSensitiveSource(source) {
		return msg
	}
	return redactCutoverEvidenceText(msg)
}

func sanitizeMigrationText(source canonical.SourcePlatform, msg string) string {
	if !migrationSensitiveSource(source) {
		return msg
	}
	return redactCutoverEvidenceText(msg)
}

func sanitizeMigrationJobForResponse(job *canonical.MigrationJob) {
	if job == nil || !migrationSensitiveSource(job.Source) {
		return
	}
	if job.Error != nil {
		msg := sanitizeMigrationText(job.Source, *job.Error)
		job.Error = &msg
	}
	for key, value := range job.Cursor {
		if value == nil {
			continue
		}
		msg := sanitizeMigrationText(job.Source, *value)
		job.Cursor[key] = &msg
	}
	sanitizeMigrationJobEvidence(job)
}

func sanitizeDiscoveryReport(source canonical.SourcePlatform, rep adapter.DiscoveryReport) adapter.DiscoveryReport {
	if !migrationSensitiveSource(source) {
		return rep
	}
	rep.Warnings = sanitizeStringSlice(source, rep.Warnings)
	return rep
}

func sanitizeMigrationJobEvidence(job *canonical.MigrationJob) {
	if job == nil || !migrationSensitiveSource(job.Source) || job.VerificationReport == nil {
		return
	}
	report := job.VerificationReport
	report.DiscoveryWarnings = sanitizeStringSlice(job.Source, report.DiscoveryWarnings)
	for i := range report.SegmentsWithWarnings {
		report.SegmentsWithWarnings[i].Warning = sanitizeMigrationText(job.Source, report.SegmentsWithWarnings[i].Warning)
	}
	for i := range report.AutomationsUnsupported {
		report.AutomationsUnsupported[i].Reason = sanitizeMigrationText(job.Source, report.AutomationsUnsupported[i].Reason)
	}
	for i := range report.AutomationRebuilds {
		report.AutomationRebuilds[i].Notes = sanitizeMigrationText(job.Source, report.AutomationRebuilds[i].Notes)
		report.AutomationRebuilds[i].TestEvidence = sanitizeMigrationText(job.Source, report.AutomationRebuilds[i].TestEvidence)
	}
	sanitizeResourceWarnings(job.Source, report.CampaignArchiveWarnings)
	sanitizeResourceWarnings(job.Source, report.TemplateWarnings)
	sanitizeResourceWarnings(job.Source, report.SourceArchiveWarnings)
	for i := range report.ResourceCompleteness {
		report.ResourceCompleteness[i].Notes = sanitizeStringSlice(job.Source, report.ResourceCompleteness[i].Notes)
	}
}

func sanitizeResourceWarnings(source canonical.SourcePlatform, warnings []canonical.ResourceWarning) {
	if !migrationSensitiveSource(source) {
		return
	}
	for i := range warnings {
		warnings[i].Warning = sanitizeMigrationText(source, warnings[i].Warning)
	}
}

func sanitizeStringSlice(source canonical.SourcePlatform, values []string) []string {
	if !migrationSensitiveSource(source) || len(values) == 0 {
		return values
	}
	out := make([]string, len(values))
	for i, value := range values {
		out[i] = sanitizeMigrationText(source, value)
	}
	return out
}

func writeJobStoreErr(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	if errors.Is(err, jobstore.ErrNotFound) {
		writeErr(w, http.StatusNotFound, fmt.Errorf("job not found"))
		return
	}
	if errors.Is(err, jobstore.ErrTenantRequired) {
		writeErr(w, http.StatusUnauthorized, fmt.Errorf("tenant header required"))
		return
	}
	writeErr(w, http.StatusInternalServerError, err)
}

func (h *Migration) loadJob(ctx context.Context, tenantID, id string) (*canonical.MigrationJob, error) {
	job, err := h.store.Get(jobstore.WithTenantID(ctx, tenantID), id)
	if err != nil {
		return nil, err
	}
	h.decorateJobSessionInfo(ctx, tenantID, job)
	return job, nil
}

func (h *Migration) loadSession(ctx context.Context, tenantID, jobID string) (adapter.Session, error) {
	sess, err := h.loadAndRefreshSession(ctx, tenantID, jobID)
	if err != nil {
		return adapter.Session{}, err
	}
	return h.restoreUploadSession(ctx, tenantID, jobID, sess)
}

func (h *Migration) loadCutoverSession(ctx context.Context, tenantID, jobID string, source canonical.SourcePlatform, action string) (adapter.Session, int, error) {
	scopedCtx := jobstore.WithTenantID(ctx, tenantID)
	now := time.Now()
	info, err := h.store.GetSessionInfo(scopedCtx, tenantID, jobID, now)
	if errors.Is(err, jobstore.ErrNotFound) {
		return adapter.Session{}, http.StatusConflict, fmt.Errorf("source session expired; reconnect source before %s", action)
	}
	if err != nil {
		return adapter.Session{}, 0, err
	}
	if cutoverSessionNearExpiry(source, info.ExpiresAt, now) {
		return adapter.Session{}, http.StatusConflict, fmt.Errorf("source session expires %s; reconnect source before %s so the job cannot expire mid-run", info.ExpiresAt.UTC().Format(time.RFC3339), action)
	}
	sess, err := h.loadSession(scopedCtx, tenantID, jobID)
	if errors.Is(err, jobstore.ErrNotFound) {
		return adapter.Session{}, http.StatusConflict, fmt.Errorf("source session expired; reconnect source before %s", action)
	}
	if err != nil {
		return adapter.Session{}, 0, err
	}
	job, err := h.store.Get(scopedCtx, jobID)
	if errors.Is(err, jobstore.ErrNotFound) {
		return adapter.Session{}, http.StatusNotFound, fmt.Errorf("migration job not found")
	}
	if err != nil {
		return adapter.Session{}, 0, err
	}
	if job.Source != source || sess.Source != source {
		return adapter.Session{}, http.StatusConflict, fmt.Errorf("saved source session does not match migration job")
	}
	if err := requireBoundSourceAccount(job, sess); err != nil {
		return adapter.Session{}, http.StatusConflict, err
	}
	return sess, http.StatusOK, nil
}

func cutoverSessionNearExpiry(source canonical.SourcePlatform, expiresAt, now time.Time) bool {
	if !sourceBridgeSessionSource(source) {
		return false
	}
	return !expiresAt.IsZero() && expiresAt.Sub(now) <= sourceBridgeNearExpiryWindow
}

func (h *Migration) decorateJobSessionInfo(ctx context.Context, tenantID string, job *canonical.MigrationJob) {
	if job == nil {
		return
	}
	cursorAudienceIDs := selectedAudienceIDsFromJobCursor(job)
	info, err := h.store.GetSessionInfo(jobstore.WithTenantID(ctx, tenantID), tenantID, job.ID, time.Now())
	if err != nil {
		job.SourceSessionExpiresAt = nil
		job.SelectedAudienceIDs = cursorAudienceIDs
		return
	}
	job.SourceSessionExpiresAt = &info.ExpiresAt
	if len(info.SelectedAudienceIDs) > 0 {
		job.SelectedAudienceIDs = append([]string(nil), info.SelectedAudienceIDs...)
	} else {
		job.SelectedAudienceIDs = cursorAudienceIDs
	}
}

func sessionExpiresAt(sess adapter.Session, now time.Time) time.Time {
	expiresAt := now.Add(sessionTTLForSource(sess.Source))
	if sess.Source == canonical.SourceConvertKit && sess.RefreshToken != "" {
		return expiresAt
	}
	if !sess.ExpiresAt.IsZero() && sess.ExpiresAt.Before(expiresAt) {
		return sess.ExpiresAt
	}
	return expiresAt
}

func sessionTTLForSource(source canonical.SourcePlatform) time.Duration {
	if sourceBridgeSessionSource(source) {
		return sourceBridgeSessionTTL
	}
	return sessionTTL
}

func sourceBridgeSessionSource(source canonical.SourcePlatform) bool {
	switch source {
	case canonical.SourceActiveCampaign, canonical.SourceBeehiiv, canonical.SourceHubSpot, canonical.SourceKlaviyo, canonical.SourceCustomerIO:
		return true
	default:
		return false
	}
}

func migrationSensitiveSource(source canonical.SourcePlatform) bool {
	switch source {
	case canonical.SourceActiveCampaign, canonical.SourceBeehiiv, canonical.SourceHubSpot, canonical.SourceKlaviyo, canonical.SourceCustomerIO:
		return true
	default:
		return false
	}
}

func applySelectedAudiences(source canonical.SourcePlatform, sess adapter.Session, selected *[]string) (adapter.Session, error) {
	if selected == nil || source != canonical.SourceMailchimp {
		return sess, nil
	}
	ids := normalizeSelectedAudienceIDs(*selected)
	if len(ids) == 0 {
		if len(sess.Extra) > 0 {
			delete(sess.Extra, mailchimp.SelectedAudiencesExtraKey)
		}
		return sess, nil
	}
	for _, id := range ids {
		if strings.Contains(id, ",") {
			return adapter.Session{}, fmt.Errorf("mailchimp audience id %q is invalid", id)
		}
	}
	if sess.Extra == nil {
		sess.Extra = map[string]string{}
	}
	sess.Extra[mailchimp.SelectedAudiencesExtraKey] = strings.Join(ids, ",")
	return sess, nil
}

func persistSelectedAudienceCursor(job *canonical.MigrationJob, sess adapter.Session) {
	if job == nil || job.Source != canonical.SourceMailchimp {
		return
	}
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	ids := selectedAudienceIDsFromSession(sess)
	if len(ids) == 0 {
		delete(job.Cursor, selectedAudiencesCursorKey)
		return
	}
	value := strings.Join(ids, ",")
	job.Cursor[selectedAudiencesCursorKey] = &value
}

func selectedAudienceIDsFromSession(sess adapter.Session) []string {
	if len(sess.Extra) == 0 {
		return nil
	}
	return normalizeSelectedAudienceIDs(strings.Split(sess.Extra[mailchimp.SelectedAudiencesExtraKey], ","))
}

func mailchimpAccountFingerprint(sess adapter.Session) string {
	if len(sess.Extra) == 0 {
		return ""
	}
	return strings.TrimSpace(sess.Extra[mailchimp.AccountFingerprintExtraKey])
}

func activeCampaignAccountFingerprint(sess adapter.Session) string {
	return activecampaign.AccountFingerprint(sess)
}

func requireActiveCampaignAccount(job *canonical.MigrationJob, sess adapter.Session) error {
	if job == nil || job.Source != canonical.SourceActiveCampaign || sess.Source != canonical.SourceActiveCampaign {
		return fmt.Errorf("ActiveCampaign source account does not match migration job")
	}
	expected, _ := cursorString(job.Cursor, activeCampaignAccountCursorKey)
	actual := activeCampaignAccountFingerprint(sess)
	if expected == "" || actual == "" || expected != actual {
		return fmt.Errorf("ActiveCampaign account does not match migration job; reconnect the original account or start a new migration")
	}
	return nil
}

func selectedAudienceIDsFromJobCursor(job *canonical.MigrationJob) []string {
	if job == nil || job.Source != canonical.SourceMailchimp || job.Cursor == nil {
		return nil
	}
	value, ok := job.Cursor[selectedAudiencesCursorKey]
	if !ok || value == nil {
		return nil
	}
	return normalizeSelectedAudienceIDs(strings.Split(*value, ","))
}

func normalizeSelectedAudienceIDs(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		id := strings.TrimSpace(value)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func tenantIDFromRequest(r *http.Request) (string, bool) {
	tenantID := strings.TrimSpace(r.Header.Get("X-Tenant-ID"))
	if tenantID == "" {
		tenantID = strings.TrimSpace(r.Header.Get("X-Postwave-Tenant-ID"))
	}
	return tenantID, tenantID != ""
}

func randomState() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (h *Migration) localDemoCallbackURL(source canonical.SourcePlatform, state string) string {
	raw := h.redirectURI(source)
	if strings.TrimSpace(raw) == "" {
		raw = "/app/migrations/oauth/callback?source=" + url.QueryEscape(string(source))
	}
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	q := u.Query()
	q.Set("source", string(source))
	q.Set("code", localDemoOAuthCode())
	q.Set("state", state)
	u.RawQuery = q.Encode()
	return u.String()
}

func localDemoOAuthCode() string {
	return "postwave-local-demo"
}

func localDemoSession(source canonical.SourcePlatform, accountHint string) adapter.Session {
	sess := adapter.Session{
		AccessToken: "postwave-local-demo",
		AccountID:   "demo-" + string(source) + "-" + sanitizeDemoHint(accountHint),
		Source:      source,
	}
	if source == canonical.SourceMailchimp {
		sum := sha256.Sum256([]byte("mailchimp-demo-account"))
		sess.Extra = map[string]string{mailchimp.AccountFingerprintExtraKey: hex.EncodeToString(sum[:])}
	}
	if source == canonical.SourceActiveCampaign {
		sum := sha256.Sum256([]byte("activecampaign-demo-account"))
		sess.Extra = map[string]string{activecampaign.AccountFingerprintExtraKey: hex.EncodeToString(sum[:])}
	}
	if source == canonical.SourceHubSpot {
		hubID := "123456"
		sum := sha256.Sum256([]byte("hubspot-account-v1\x00" + hubID))
		sess.AccountID = hubID
		sess.Extra = map[string]string{
			hubspot.HubIDExtraKey:               hubID,
			hubspot.DataHostingLocationExtraKey: "na1",
			hubspot.AccountFingerprintExtraKey:  hex.EncodeToString(sum[:]),
		}
	}
	if source == canonical.SourceBeehiiv {
		workspaceID := "work_postwave_local_demo"
		publicationID := "pub_postwave_local_demo"
		accountDigest := sha256.Sum256([]byte(workspaceID + "\x00" + publicationID))
		sess.AccountID = publicationID
		sess.Extra = map[string]string{
			beehiiv.WorkspaceIDExtraKey:        workspaceID,
			beehiiv.PublicationIDExtraKey:      publicationID,
			beehiiv.AccountFingerprintExtraKey: hex.EncodeToString(accountDigest[:]),
		}
	}
	if source == canonical.SourceCustomerIO {
		workspaceID := "1"
		region := "us"
		fingerprint := sha256.Sum256([]byte("customerio|" + region + "|" + workspaceID))
		sess.AccountID = workspaceID
		sess.Extra = map[string]string{
			customerio.WorkspaceIDExtraKey:          workspaceID,
			customerio.RegionExtraKey:               region,
			customerio.WorkspaceFingerprintExtraKey: hex.EncodeToString(fingerprint[:]),
		}
	}
	return sess
}

func isLocalDemoSession(sess adapter.Session) bool {
	return sess.AccessToken == "postwave-local-demo"
}

func sanitizeDemoHint(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return "account"
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
		if b.Len() >= 32 {
			break
		}
	}
	out := strings.Trim(b.String(), "-_")
	if out == "" {
		return "account"
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func sourceSupportsUploads(source canonical.SourcePlatform) bool {
	return source == canonical.SourceSubstack || sourceUsesCSVUpload(source)
}

func sourceUsesCSVUpload(source canonical.SourcePlatform) bool {
	switch source {
	case canonical.SourceCSV,
		canonical.SourceSendy,
		canonical.SourceConstantContact,
		canonical.SourceAWeber,
		canonical.SourceDrip,
		canonical.SourceCampaignMonitor,
		canonical.SourceOmnisend,
		canonical.SourceLoops,
		canonical.SourceFlodesk,
		canonical.SourceBento:
		return true
	default:
		return false
	}
}

func cleanUploadID(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 80 {
		return "", fmt.Errorf("invalid upload id")
	}
	for _, r := range raw {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return "", fmt.Errorf("invalid upload id")
	}
	return raw, nil
}

func parseContentRange(raw string) (start, end, total int64, err error) {
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, "bytes ") {
		return 0, 0, 0, fmt.Errorf("Content-Range must be bytes start-end/total")
	}
	rest := strings.TrimPrefix(raw, "bytes ")
	dash := strings.IndexByte(rest, '-')
	slash := strings.IndexByte(rest, '/')
	if dash <= 0 || slash <= dash+1 || slash == len(rest)-1 {
		return 0, 0, 0, fmt.Errorf("Content-Range must be bytes start-end/total")
	}
	start, err = strconv.ParseInt(rest[:dash], 10, 64)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("invalid range start")
	}
	end, err = strconv.ParseInt(rest[dash+1:slash], 10, 64)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("invalid range end")
	}
	total, err = strconv.ParseInt(rest[slash+1:], 10, 64)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("invalid range total")
	}
	return start, end, total, nil
}

func uploadDir(tenantID string, source canonical.SourcePlatform, uploadID string) (string, error) {
	return configuredUploadStore().Dir(tenantID, string(source), uploadID)
}

func writeUploadMeta(dir string, meta uploadMeta) error {
	b, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "meta.json"), b, 0o600)
}

func readUploadMeta(dir string) (uploadMeta, error) {
	var meta uploadMeta
	f, err := os.Open(filepath.Join(dir, "meta.json"))
	if err != nil {
		return meta, err
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, maxMigrationUploadMetaBytes+1))
	if err != nil {
		return meta, err
	}
	if int64(len(b)) > maxMigrationUploadMetaBytes {
		return meta, fmt.Errorf("upload metadata exceeds %d bytes", maxMigrationUploadMetaBytes)
	}
	if err := json.Unmarshal(b, &meta); err != nil {
		return meta, err
	}
	return meta, nil
}

func sanitizeUploadFilename(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	name = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case r == '.', r == '-', r == '_':
			return r
		default:
			return '-'
		}
	}, name)
	name = strings.Trim(name, ".-_")
	if len(name) > 96 {
		name = name[:96]
	}
	return name
}

func localDemoDiscovery(source canonical.SourcePlatform) adapter.DiscoveryReport {
	seed := len(source)
	rep := adapter.DiscoveryReport{
		SubscribersTotal: 12400 + seed*37,
		SegmentsTotal:    8 + seed%5,
		AutomationsTotal: 4 + seed%3,
		ArchiveTotal:     142,
		CampaignsTotal:   142,
		ReportsTotal:     142,
		CustomFields:     localDemoCustomFields(),
		Warnings:         localDemoWarnings(source),
	}
	if source == canonical.SourceMailchimp {
		rep.TemplatesTotal = 36
		rep.CampaignsTotal = 168
		rep.ReportsTotal = 142
		rep.GroupsTotal = 12
		rep.FormsTotal = 3
		rep.LandingPagesTotal = 2
		rep.EcommerceTotal = 1
		rep.Audiences = []adapter.DiscoveryAudience{
			{ID: "list_newsletter", Name: "Newsletter", SubscribersTotal: 8800},
			{ID: "list_customers", Name: "Customers", SubscribersTotal: 3200},
			{ID: "list_events", Name: "Events", SubscribersTotal: 733},
		}
	}
	if source == canonical.SourceConvertKit {
		rep.GroupsTotal = 18
		rep.FormsTotal = 6
		rep.LandingPagesTotal = 3
	}
	if source == canonical.SourceSubstack || source == canonical.SourceBeehiiv {
		rep.PaidSubsTotal = 312
	}
	if source == canonical.SourceBeehiiv {
		rep.GroupsTotal = 3
	}
	if source == canonical.SourceMailerLite {
		rep.GroupsTotal = 14
		rep.SegmentsTotal = 18
		rep.CampaignsTotal = rep.ArchiveTotal + 6
		rep.ReportsTotal = rep.ArchiveTotal
		rep.FormsTotal = 7
		rep.EcommerceTotal = 2
		rep.SourceArchiveTotal = len(rep.CustomFields) + 6 + rep.FormsTotal + rep.EcommerceTotal + 1
	}
	if source == canonical.SourceActiveCampaign {
		rep.TemplatesTotal = 42
		rep.CampaignsTotal = 210
		rep.ReportsTotal = 198
		rep.GroupsTotal = 24
		rep.FormsTotal = 8
		rep.EcommerceTotal = 3
		rep.DealsTotal = 510
		rep.PipelinesTotal = 4
		rep.CRMTotal = rep.DealsTotal + rep.PipelinesTotal
		rep.CustomObjectsTotal = 9
		rep.SMSCampaignsTotal = 18
	}
	if source == canonical.SourceHubSpot {
		rep.ArchiveTotal = 0
		rep.CampaignsTotal = 0
		rep.ReportsTotal = 0
		rep.AutomationsTotal = 0
		rep.GroupsTotal = 64
		rep.SegmentsTotal = 18
		rep.CRMTotal = rep.SubscribersTotal
	}
	if source == canonical.SourceCustomerIO {
		rep.ProfilesWithoutEmailTotal = 25
		rep.SegmentsTotal = 14
		rep.AutomationsTotal = 28
		rep.ArchiveTotal = 32
		rep.TemplatesTotal = 12
		rep.CampaignsTotal = 70
		rep.ReportsTotal = 0
		rep.CustomObjectsTotal = 4
		rep.SubscriptionChannelsTotal = 3
		rep.SMSCampaignsTotal = 8
		rep.PushCampaignsTotal = 6
		rep.Audiences = make([]adapter.DiscoveryAudience, 0, rep.SegmentsTotal)
		for i := 1; i <= 10; i++ {
			rep.Audiences = append(rep.Audiences, adapter.DiscoveryAudience{
				ID:               fmt.Sprintf("customerio:segment:demo_%d", i),
				Name:             fmt.Sprintf("Customer.io segment %d", i),
				SubscribersTotal: rep.SubscribersTotal / 2,
			})
		}
		for i := 1; i <= 4; i++ {
			rep.Audiences = append(rep.Audiences, adapter.DiscoveryAudience{
				ID:               fmt.Sprintf("customerio:topic:demo_%d", i),
				Name:             fmt.Sprintf("Customer.io topic %d", i),
				SubscribersTotal: rep.SubscribersTotal,
			})
		}
		rep.SourceArchiveTotal = sumIntMap(customerIODemoSourceArchiveByResource(rep))
	}
	if sourceUsesCSVUpload(source) {
		rep.SegmentsTotal = 0
		rep.AutomationsTotal = 0
		rep.ArchiveTotal = 0
		rep.CampaignsTotal = 0
		rep.ReportsTotal = 0
	}
	return rep
}

func localDemoCustomFields() []string {
	return []string{"first_name", "last_name", "signup_source", "city"}
}

func localDemoWarnings(source canonical.SourcePlatform) []string {
	switch source {
	case canonical.SourceMailchimp:
		return []string{"Two automations use goal tracking, which Moosewave will flag for manual review."}
	case canonical.SourceConvertKit:
		return []string{"Kit forms, landing pages, commerce products, and incentive downloads are flagged as manual rebuild items."}
	case canonical.SourceSubstack:
		return []string{"Substack comments, recommendations, publication settings, and rich analytics are not included in standard exports."}
	case canonical.SourceBeehiiv:
		return []string{"Beehiiv automations and dynamic segment predicates require rebuild; accessible referral milestones and polls are source evidence, while recommendations, boosts, billing objects, and website settings require a separate handoff."}
	case canonical.SourceMailerLite:
		return []string{"MailerLite groups import as tag-backed segments. Custom-field definitions plus draft/ready campaign, form, and ecommerce-shop metadata are preserved as source evidence. Saved-segment predicates and automations require rebuild review; rendered campaign HTML, reusable templates, sites, and landing-page inventory are not exposed by the documented API."}
	case canonical.SourceActiveCampaign:
		return []string{"ActiveCampaign automations, templates, forms, CRM, custom objects, ecommerce, and SMS are preserved for rebuild/review; non-executable automation placeholders are not activated in Moosewave."}
	case canonical.SourceHubSpot:
		return []string{"HubSpot remains the CRM system of record; Moosewave imports contact fields and exact list-membership tags for email/SMS targeting only."}
	case canonical.SourceCustomerIO:
		return []string{"Customer.io campaign, broadcast, transactional, non-email channel, sender, custom-object, and ecosystem definitions are preserved for explicit rebuild or retirement; they are not executable imports."}
	case canonical.SourceCSV:
		return []string{"CSV imports include subscribers only; segments and automations are not present in the file."}
	case canonical.SourceSendy:
		return []string{"Sendy does not expose a complete subscriber-export API; upload the Sendy CSV export so subscribers and suppression-like status fields are preserved."}
	case canonical.SourceConstantContact,
		canonical.SourceAWeber,
		canonical.SourceDrip,
		canonical.SourceCampaignMonitor,
		canonical.SourceOmnisend,
		canonical.SourceLoops,
		canonical.SourceFlodesk,
		canonical.SourceBento:
		return []string{"This source is available as a migration-only CSV export flow. Moosewave imports subscribers and preserves source fields as profile attributes; segments, automations, and campaign history require a later native API adapter."}
	default:
		return []string{}
	}
}

func discoveryResourceMetadata(source canonical.SourcePlatform, rep adapter.DiscoveryReport) []canonical.ResourceCompleteness {
	return orchestrator.DiscoveryCompletenessForSource(source, rep)
}

func localDemoVerification(source canonical.SourcePlatform, rep adapter.DiscoveryReport) *canonical.VerificationReport {
	hasAutomations := source != canonical.SourceSubstack && source != canonical.SourceCustomerIO && !sourceUsesCSVUpload(source)
	hasPaidSubs := source == canonical.SourceConvertKit
	report := &canonical.VerificationReport{
		SubscribersImported:   rep.SubscribersTotal,
		SuppressionListSize:   187,
		SegmentsTranslated:    rep.SegmentsTotal,
		AutomationsTranslated: localDemoAutomationsTranslated(source, rep),
		PaidSubsImported:      0,
		ArchiveImported:       rep.ArchiveTotal,
		DiscoveryWarnings:     append([]string(nil), rep.Warnings...),
		DataLossEstimatePct:   0.3,
		CustomFieldsMapped: []canonical.CustomFieldMapping{
			{Source: "FNAME", Canonical: "first_name", Type: "string"},
			{Source: "LNAME", Canonical: "last_name", Type: "string"},
			{Source: "CITY", Canonical: "custom.city", Type: "string"},
			{Source: "COMPANY", Canonical: "company", Type: "string"},
			{Source: "SIGNUP_SOURCE", Canonical: "custom.signup_source", Type: "string"},
		},
		CustomFieldsUnmapped: []string{"MMERGE7", "INTEREST_GROUP_2"},
		SegmentsWithWarnings: localDemoSegmentWarnings(source),
	}
	if hasAutomations {
		report.AutomationsUnsupported = localDemoUnsupportedAutomations(source, rep)
	}
	if hasPaidSubs {
		report.PaidSubsImported = rep.PaidSubsTotal
	}
	if source == canonical.SourceActiveCampaign {
		report.SourceArchiveByResource = activeCampaignDemoSourceArchiveByResource(rep)
		report.SourceArchiveImported = sumIntMap(report.SourceArchiveByResource)
		report.SubscriberTagsImported = rep.GroupsTotal
	}
	if source == canonical.SourceBeehiiv {
		report.PremiumMembershipsObserved = rep.PaidSubsTotal
		report.SourceArchiveByResource = beehiivDemoSourceArchiveByResource(rep)
		report.SourceArchiveImported = sumIntMap(report.SourceArchiveByResource)
	}
	if source == canonical.SourceCustomerIO {
		report.TemplatesImported = rep.TemplatesTotal
		report.SourceArchiveByResource = customerIODemoSourceArchiveByResource(rep)
		report.SourceArchiveImported = sumIntMap(report.SourceArchiveByResource)
	}
	report.ResourceCompleteness = orchestrator.ResourceCompletenessForSource(source, rep, *report)
	return report
}

func localDemoAutomationsTranslated(source canonical.SourcePlatform, rep adapter.DiscoveryReport) int {
	if source == canonical.SourceActiveCampaign || source == canonical.SourceBeehiiv || source == canonical.SourceCustomerIO {
		return 0
	}
	return rep.AutomationsTotal
}

func localDemoUnsupportedAutomations(source canonical.SourcePlatform, rep adapter.DiscoveryReport) []canonical.AutomationUnsupported {
	if source == canonical.SourceActiveCampaign || source == canonical.SourceBeehiiv {
		out := make([]canonical.AutomationUnsupported, 0, rep.AutomationsTotal)
		for i := 1; i <= rep.AutomationsTotal; i++ {
			name := fmt.Sprintf("ActiveCampaign automation %d", i)
			reason := "ActiveCampaign automation source definitions are preserved for rebuild review; non-executable placeholders are not activated as Moosewave runtime automation rows."
			if source == canonical.SourceBeehiiv {
				name = fmt.Sprintf("Beehiiv automation %d", i)
				reason = "Beehiiv API v2 exposes metadata, email inventory, and statistics, but not an executable graph or message bodies. The definition is preserved for rebuild and is never activated as a Moosewave runtime automation."
			}
			out = append(out, canonical.AutomationUnsupported{
				Name:   name,
				Reason: reason,
			})
		}
		return out
	}
	return []canonical.AutomationUnsupported{
		{
			Name:   "Goal-based welcome",
			Reason: "Goal tracking is not supported directly. Recreate this branch with a tag-based trigger.",
		},
	}
}

func localDemoSegmentWarnings(source canonical.SourcePlatform) []canonical.SegmentWarning {
	warning := "Open events older than 30 days are not in the export; this segment will count future opens only."
	if source == canonical.SourceBeehiiv {
		warning = "Beehiiv API v2 does not expose the saved predicate. Current completed membership is frozen for cutover; rebuild and test the dynamic rule."
	} else if source == canonical.SourceCustomerIO {
		warning = "Customer.io membership is frozen at the final snapshot; rebuild or retire every dynamic segment and subscription-topic rule before cutover."
	}
	return []canonical.SegmentWarning{{Name: "Engaged + opened last 30 days", Warning: warning}}
}

func activeCampaignDemoSourceArchiveByResource(rep adapter.DiscoveryReport) map[string]int {
	return map[string]int{
		"activecampaign_message":              rep.TemplatesTotal,
		"activecampaign_form":                 rep.FormsTotal,
		"activecampaign_custom_field":         len(rep.CustomFields),
		"activecampaign_tag":                  rep.GroupsTotal,
		"crm_deal":                            rep.DealsTotal,
		"crm_pipeline":                        rep.PipelinesTotal,
		"activecampaign_custom_object_schema": rep.CustomObjectsTotal,
		"activecampaign_ecommerce_order":      rep.EcommerceTotal,
		"activecampaign_sms_broadcast":        rep.SMSCampaignsTotal,
	}
}

func beehiivDemoSourceArchiveByResource(rep adapter.DiscoveryReport) map[string]int {
	providerSegments := rep.SegmentsTotal - rep.GroupsTotal
	if providerSegments < 0 {
		providerSegments = 0
	}
	return map[string]int{
		"beehiiv_publication":                           1,
		"beehiiv_newsletter_list":                       rep.GroupsTotal,
		"beehiiv_newsletter_list_history_manifest":      rep.GroupsTotal,
		"beehiiv_automation":                            rep.AutomationsTotal,
		"beehiiv_automation_email_inventory_manifest":   rep.AutomationsTotal,
		"beehiiv_automation_journey_inventory_manifest": rep.AutomationsTotal,
		"beehiiv_segment":                               providerSegments,
		"beehiiv_condition_set":                         1,
		"beehiiv_condition_set_inventory_manifest":      1,
		"beehiiv_custom_field":                          len(rep.CustomFields),
		"beehiiv_premium_tier":                          2,
		"beehiiv_referral_milestone":                    1,
		"beehiiv_poll":                                  1,
		"beehiiv_poll_response":                         2,
		"beehiiv_post_template":                         1,
		"parity_gap:website_settings":                   1,
		"parity_gap:referrals_boosts":                   1,
		"parity_gap:ad_network":                         1,
	}
}

func customerIODemoSourceArchiveByResource(rep adapter.DiscoveryReport) map[string]int {
	return map[string]int{
		"customerio_campaign_workflow":     18,
		"customerio_broadcast_workflow":    10,
		"customerio_newsletter":            rep.CampaignsTotal - 28,
		"customerio_transactional_message": 8,
		"customerio_design_email_rebuild":  3,
		"customerio_subscription_topic":    4,
		"customerio_subscription_channel":  rep.SubscriptionChannelsTotal,
		"customerio_esp_suppression":       12,
		"customerio_channel_optout":        10,
		"customerio_object_type":           rep.CustomObjectsTotal,
		"customerio_migration_checklist":   customerIOStaticDemoChecklistCount,
	}
}

const customerIOStaticDemoChecklistCount = 8

func sumIntMap(values map[string]int) int {
	total := 0
	for _, value := range values {
		total += value
	}
	return total
}

func (h *Migration) completeDemoJob(ctx context.Context, job *canonical.MigrationJob, dryRun bool) {
	expected := job.Status
	rep := localDemoDiscovery(job.Source)
	job.Progress = canonical.MigrationProgress{
		SubscribersTotal:   rep.SubscribersTotal,
		SubscribersDone:    rep.SubscribersTotal,
		SegmentsTotal:      rep.SegmentsTotal,
		SegmentsDone:       rep.SegmentsTotal,
		AutomationsTotal:   rep.AutomationsTotal,
		AutomationsDone:    localDemoAutomationsTranslated(job.Source, rep),
		PaidSubsTotal:      rep.PaidSubsTotal,
		PaidSubsDone:       localDemoPaidSubsImported(job.Source, rep),
		ArchiveTotal:       rep.ArchiveTotal,
		ArchiveDone:        rep.ArchiveTotal,
		TemplatesTotal:     rep.TemplatesTotal,
		TemplatesDone:      rep.TemplatesTotal,
		SourceArchiveTotal: rep.SourceArchiveTotal,
		SourceArchiveDone:  rep.SourceArchiveTotal,
	}
	job.VerificationReport = localDemoVerification(job.Source, rep)
	now := time.Now()
	if dryRun {
		job.Status = canonical.MigAwaitingConfirmation
	} else {
		job.Status = canonical.MigCompleted
		job.CompletedAt = &now
		rollbackUntil := now.Add(migrationRollbackWindow(job.Source))
		job.RollbackUntil = &rollbackUntil
	}
	if isDeltaImportRun(job) {
		clearDeltaImportSnapshot(job)
		job.Error = nil
	}
	if err := h.transitionJob(ctx, job, expected); err != nil {
		slog.Warn("migration: persist local demo completion failed", "job_id", job.ID, "err", err)
	} else {
		h.clearTerminalVerifierObservations(ctx, job)
	}
}

func localDemoPaidSubsImported(source canonical.SourcePlatform, rep adapter.DiscoveryReport) int {
	if source == canonical.SourceSubstack || source == canonical.SourceConvertKit {
		return rep.PaidSubsTotal
	}
	return 0
}
