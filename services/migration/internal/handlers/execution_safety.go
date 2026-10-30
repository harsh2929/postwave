package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/postwave/migrate/activecampaign"
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/beehiiv"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/customerio"
	"github.com/postwave/migrate/hubspot"
	"github.com/postwave/migrate/klaviyo"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

func (h *Migration) transitionJob(ctx context.Context, job *canonical.MigrationJob, expected ...canonical.MigrationStatus) error {
	store, ok := h.store.(jobstore.StatusTransitionJobStore)
	if !ok {
		return fmt.Errorf("migration job store does not support atomic status transitions")
	}
	return store.UpdateIfStatus(ctx, job, expected...)
}

func writeTransitionErr(w http.ResponseWriter, err error) {
	if errors.Is(err, jobstore.ErrStatusTransitionConflict) {
		writeErr(w, http.StatusConflict, fmt.Errorf("migration status changed concurrently; reload the job and retry"))
		return
	}
	writeJobStoreErr(w, err)
}

func (h *Migration) acquireJobExecution(ctx context.Context, tenantID, jobID string) (*orchestrator.MigrationExecutionLease, error) {
	return orchestrator.AcquireMigrationExecutionLease(ctx, h.db, tenantID, jobID)
}

// acquireSourceAccountSessionExecution must be called only after the caller
// owns the job execution lease. That consistent job-then-account order avoids
// deadlocks while serializing all token-bearing work for a provider account.
func (h *Migration) acquireSourceAccountSessionExecution(ctx context.Context, job *canonical.MigrationJob, sess adapter.Session) (*orchestrator.MigrationExecutionLease, error) {
	if job == nil || isLocalDemoSession(sess) {
		return nil, nil
	}
	switch job.Source {
	case canonical.SourceActiveCampaign:
		if err := requireActiveCampaignAccount(job, sess); err != nil {
			return nil, err
		}
		return orchestrator.AcquireActiveCampaignAccountExecutionLease(ctx, h.db, activeCampaignAccountFingerprint(sess))
	case canonical.SourceHubSpot:
		if err := requireHubSpotAccount(job, sess); err != nil {
			return nil, err
		}
		return orchestrator.AcquireHubSpotAccountExecutionLease(ctx, h.db, hubSpotAccountFingerprint(sess))
	case canonical.SourceBeehiiv:
		if err := requireBeehiivAccount(job, sess); err != nil {
			return nil, err
		}
		return orchestrator.AcquireBeehiivWorkspaceExecutionLease(ctx, h.db, beehiivWorkspaceFingerprint(sess))
	case canonical.SourceKlaviyo:
		if err := requireKlaviyoAccount(job, sess); err != nil {
			return nil, err
		}
		return orchestrator.AcquireKlaviyoAccountExecutionLease(ctx, h.db, klaviyoAccountFingerprint(sess))
	case canonical.SourceCustomerIO:
		if err := requireCustomerIOWorkspace(job, sess); err != nil {
			return nil, err
		}
		return orchestrator.AcquireCustomerIOWorkspaceExecutionLease(ctx, h.db, customerIOWorkspaceFingerprint(sess))
	default:
		return nil, nil
	}
}

// Retain the historical helper name for shadow/source-event paths while they
// share the generalized account guard. New call sites should use
// acquireSourceAccountSessionExecution.
func (h *Migration) acquireActiveCampaignSessionExecution(ctx context.Context, job *canonical.MigrationJob, sess adapter.Session) (*orchestrator.MigrationExecutionLease, error) {
	return h.acquireSourceAccountSessionExecution(ctx, job, sess)
}

// activeCampaignCredentialFingerprint derives the same opaque account
// identity as the adapter without sending the credential. This lets initial
// API-token authentication join the account lease before its single provider
// identity call, even though no migration job exists yet.
func activeCampaignCredentialFingerprint(body credentialRequest) (string, error) {
	extra := body.Extra
	apiURL := firstNonEmpty(
		extra["api_url"],
		extra["account_api_url"],
		extra["account_url"],
		extra["base_url"],
		body.AccountID,
	)
	if strings.TrimSpace(apiURL) == "" {
		return "", fmt.Errorf("ActiveCampaign account API URL required")
	}
	fingerprint, err := activecampaign.AccountFingerprintForCredentialAPIURL(apiURL)
	if err != nil {
		return "", fmt.Errorf("invalid ActiveCampaign account API URL: %w", err)
	}
	return fingerprint, nil
}

func activeCampaignExpectedAccountFingerprint(job *canonical.MigrationJob) string {
	if job == nil || job.Source != canonical.SourceActiveCampaign {
		return ""
	}
	fingerprint, _ := cursorString(job.Cursor, activeCampaignAccountCursorKey)
	return strings.TrimSpace(fingerprint)
}

func hubSpotExpectedAccountFingerprint(job *canonical.MigrationJob) string {
	if job == nil || job.Source != canonical.SourceHubSpot {
		return ""
	}
	fingerprint, _ := cursorString(job.Cursor, hubSpotAccountCursorKey)
	return strings.TrimSpace(fingerprint)
}

func hubSpotExpectedDataHostingLocation(job *canonical.MigrationJob) string {
	if job == nil || job.Source != canonical.SourceHubSpot {
		return ""
	}
	location, _ := cursorString(job.Cursor, hubSpotDataLocationCursorKey)
	return strings.ToLower(strings.TrimSpace(location))
}

func hubSpotAccountFingerprint(sess adapter.Session) string {
	return hubspot.AccountFingerprint(sess)
}

func requireHubSpotAccount(job *canonical.MigrationJob, sess adapter.Session) error {
	if job == nil || job.Source != canonical.SourceHubSpot || sess.Source != canonical.SourceHubSpot {
		return fmt.Errorf("HubSpot account does not match migration job")
	}
	expected := hubSpotExpectedAccountFingerprint(job)
	expectedLocation := hubSpotExpectedDataHostingLocation(job)
	actual := hubSpotAccountFingerprint(sess)
	actualLocation := strings.ToLower(strings.TrimSpace(sess.Extra[hubspot.DataHostingLocationExtraKey]))
	if expected == "" || expectedLocation == "" || actual == "" || actualLocation == "" ||
		expected != actual || expectedLocation != actualLocation {
		return fmt.Errorf("HubSpot account does not match migration job; reconnect the original account or start a new migration")
	}
	return nil
}

func beehiivExpectedAccountFingerprint(job *canonical.MigrationJob) string {
	if job == nil || job.Source != canonical.SourceBeehiiv {
		return ""
	}
	fingerprint, _ := cursorString(job.Cursor, beehiivAccountCursorKey)
	return strings.TrimSpace(fingerprint)
}

func beehiivExpectedWorkspaceFingerprint(job *canonical.MigrationJob) string {
	if job == nil || job.Source != canonical.SourceBeehiiv {
		return ""
	}
	fingerprint, _ := cursorString(job.Cursor, beehiivWorkspaceCursorKey)
	return strings.TrimSpace(fingerprint)
}

func beehiivExpectedPublicationID(job *canonical.MigrationJob) string {
	if job == nil || job.Source != canonical.SourceBeehiiv {
		return ""
	}
	publicationID, _ := cursorString(job.Cursor, beehiivPublicationCursorKey)
	return strings.TrimSpace(publicationID)
}

func klaviyoExpectedAccountFingerprint(job *canonical.MigrationJob) string {
	if job == nil || job.Source != canonical.SourceKlaviyo {
		return ""
	}
	fingerprint, _ := cursorString(job.Cursor, klaviyoAccountCursorKey)
	return strings.TrimSpace(fingerprint)
}

func klaviyoAccountFingerprint(sess adapter.Session) string {
	return klaviyo.AccountFingerprint(sess)
}

func customerIOExpectedWorkspaceFingerprint(job *canonical.MigrationJob) string {
	if job == nil || job.Source != canonical.SourceCustomerIO {
		return ""
	}
	fingerprint, _ := cursorString(job.Cursor, customerIOWorkspaceCursorKey)
	return strings.TrimSpace(fingerprint)
}

func customerIOExpectedWorkspaceID(job *canonical.MigrationJob) string {
	if job == nil || job.Source != canonical.SourceCustomerIO {
		return ""
	}
	workspaceID, _ := cursorString(job.Cursor, customerIOWorkspaceIDCursorKey)
	return strings.TrimSpace(workspaceID)
}

func customerIOExpectedRegion(job *canonical.MigrationJob) string {
	if job == nil || job.Source != canonical.SourceCustomerIO {
		return ""
	}
	region, _ := cursorString(job.Cursor, customerIORegionCursorKey)
	return strings.ToLower(strings.TrimSpace(region))
}

func customerIOWorkspaceFingerprint(sess adapter.Session) string {
	return customerio.AccountFingerprint(sess)
}

func requireCustomerIOWorkspace(job *canonical.MigrationJob, sess adapter.Session) error {
	if job == nil || job.Source != canonical.SourceCustomerIO || sess.Source != canonical.SourceCustomerIO {
		return fmt.Errorf("Customer.io region/workspace does not match migration job")
	}
	expected := customerIOExpectedWorkspaceFingerprint(job)
	expectedWorkspaceID := customerIOExpectedWorkspaceID(job)
	expectedRegion := customerIOExpectedRegion(job)
	actual := customerIOWorkspaceFingerprint(sess)
	actualWorkspaceID := strings.TrimSpace(sess.AccountID)
	actualRegion := strings.ToLower(strings.TrimSpace(sess.Extra[customerio.RegionExtraKey]))
	if expected == "" || expectedWorkspaceID == "" || expectedRegion == "" ||
		actual == "" || actualWorkspaceID == "" || actualRegion == "" ||
		expected != actual || expectedWorkspaceID != actualWorkspaceID || expectedRegion != actualRegion {
		return fmt.Errorf("Customer.io region/workspace does not match migration job; reconnect the original workspace or start a new migration")
	}
	return nil
}

func requireKlaviyoAccount(job *canonical.MigrationJob, sess adapter.Session) error {
	if job == nil || job.Source != canonical.SourceKlaviyo || sess.Source != canonical.SourceKlaviyo {
		return fmt.Errorf("Klaviyo account does not match migration job")
	}
	expected := klaviyoExpectedAccountFingerprint(job)
	actual := klaviyoAccountFingerprint(sess)
	if expected == "" || actual == "" || expected != actual {
		return fmt.Errorf("Klaviyo account does not match migration job; reconnect the original account or start a new migration")
	}
	return nil
}

func beehiivAccountFingerprint(sess adapter.Session) string {
	return beehiiv.AccountFingerprint(sess)
}

// beehiivWorkspaceFingerprint turns the provider workspace id into a stable,
// domain-separated opaque identity suitable for cursor persistence and global
// execution serialization. The raw work_* id never enters the lock registry.
func beehiivWorkspaceFingerprint(sess adapter.Session) string {
	workspaceID := strings.TrimSpace(sess.Extra[beehiiv.WorkspaceIDExtraKey])
	if workspaceID == "" {
		return ""
	}
	digest := sha256.Sum256([]byte("postwave:beehiiv-workspace:v1\x00" + workspaceID))
	return hex.EncodeToString(digest[:])
}

func beehiivPublicationID(sess adapter.Session) string {
	extraPublicationID := strings.TrimSpace(sess.Extra[beehiiv.PublicationIDExtraKey])
	accountID := strings.TrimSpace(sess.AccountID)
	if extraPublicationID != "" && accountID != "" && extraPublicationID != accountID {
		return ""
	}
	if extraPublicationID != "" {
		return extraPublicationID
	}
	return accountID
}

func beehiivDerivedAccountFingerprint(sess adapter.Session) string {
	workspaceID := strings.TrimSpace(sess.Extra[beehiiv.WorkspaceIDExtraKey])
	publicationID := beehiivPublicationID(sess)
	if workspaceID == "" || publicationID == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(workspaceID + "\x00" + publicationID))
	return hex.EncodeToString(digest[:])
}

func requireBeehiivAccount(job *canonical.MigrationJob, sess adapter.Session) error {
	if job == nil || job.Source != canonical.SourceBeehiiv || sess.Source != canonical.SourceBeehiiv {
		return fmt.Errorf("Beehiiv workspace/publication does not match migration job")
	}
	expectedAccount := beehiivExpectedAccountFingerprint(job)
	expectedWorkspace := beehiivExpectedWorkspaceFingerprint(job)
	expectedPublication := beehiivExpectedPublicationID(job)
	actualAccount := beehiivAccountFingerprint(sess)
	derivedAccount := beehiivDerivedAccountFingerprint(sess)
	actualWorkspace := beehiivWorkspaceFingerprint(sess)
	actualPublication := beehiivPublicationID(sess)
	if expectedAccount == "" || expectedWorkspace == "" || expectedPublication == "" ||
		actualAccount == "" || derivedAccount == "" || actualWorkspace == "" || actualPublication == "" ||
		actualAccount != derivedAccount ||
		expectedAccount != actualAccount || expectedWorkspace != actualWorkspace || expectedPublication != actualPublication {
		return fmt.Errorf("Beehiiv workspace/publication does not match migration job; reconnect the original publication or start a new migration")
	}
	return nil
}

func requireBoundSourceAccount(job *canonical.MigrationJob, sess adapter.Session) error {
	if job == nil {
		return fmt.Errorf("migration job is required")
	}
	// Demo sessions never carry a provider credential or issue provider
	// requests. Newly-created demos still persist deterministic fingerprints,
	// while this exemption preserves recovery of legacy local demo fixtures.
	if isLocalDemoSession(sess) {
		return nil
	}
	switch job.Source {
	case canonical.SourceBrevo:
		id, _ := cursorString(job.Cursor, brevoAccountCursorKey)
		if id == "" || sess.Source != canonical.SourceBrevo || sess.AccountID != id || sess.Extra["brevo_organization_id"] != id {
			return fmt.Errorf("Brevo organization does not match the migration; reconnect the original account")
		}
		return nil
	case canonical.SourceConvertKit:
		id, _ := cursorString(job.Cursor, kitAccountCursorKey)
		if id == "" || sess.AccountID != id || sess.Extra["api_version"] != "4" {
			return fmt.Errorf("Kit account does not match the migration; reconnect the original account")
		}
		return nil
	case canonical.SourceActiveCampaign:
		return requireActiveCampaignAccount(job, sess)
	case canonical.SourceHubSpot:
		return requireHubSpotAccount(job, sess)
	case canonical.SourceBeehiiv:
		return requireBeehiivAccount(job, sess)
	case canonical.SourceKlaviyo:
		return requireKlaviyoAccount(job, sess)
	case canonical.SourceCustomerIO:
		return requireCustomerIOWorkspace(job, sess)
	default:
		return nil
	}
}

func (h *Migration) failAcceptedTransition(ctx context.Context, job *canonical.MigrationJob, expected canonical.MigrationStatus, cause error) {
	if job == nil || cause == nil {
		return
	}
	job.Status = canonical.MigFailed
	message := sanitizeMigrationErrorText(job.Source, cause)
	job.Error = &message
	if err := h.transitionJob(ctx, job, expected); err != nil {
		// The caller still returns the setup failure. A transition conflict is
		// intentionally not overwritten because another lifecycle owner won.
		return
	}
}

func writeExecutionLeaseErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, orchestrator.ErrMigrationExecutionInProgress):
		writeErr(w, http.StatusConflict, err)
	case errors.Is(err, orchestrator.ErrMigrationExecutionLockUnavailable):
		writeErr(w, http.StatusServiceUnavailable, err)
	default:
		writeErr(w, http.StatusServiceUnavailable, err)
	}
}

func writeActiveCampaignAccountExecutionErr(w http.ResponseWriter, err error) {
	if errors.Is(err, orchestrator.ErrMigrationExecutionInProgress) || errors.Is(err, orchestrator.ErrMigrationExecutionLockUnavailable) {
		writeExecutionLeaseErr(w, err)
		return
	}
	writeErr(w, http.StatusConflict, sanitizeMigrationError(canonical.SourceActiveCampaign, err))
}

func writeSourceAccountExecutionErr(w http.ResponseWriter, source canonical.SourcePlatform, err error) {
	if errors.Is(err, orchestrator.ErrMigrationExecutionInProgress) || errors.Is(err, orchestrator.ErrMigrationExecutionLockUnavailable) {
		writeExecutionLeaseErr(w, err)
		return
	}
	writeErr(w, http.StatusConflict, sanitizeMigrationError(source, err))
}
