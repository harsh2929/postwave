package handlers

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/convertkit"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/orchestrator"
	"github.com/stretchr/testify/require"
)

func TestKitSessionRefreshPersistsBothRotatedTokens(t *testing.T) {
	ctx := jobstore.WithTenantID(context.Background(), "tenant-kit-refresh")
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	sess := adapter.Session{Source: canonical.SourceConvertKit, AccountID: "42", AccessToken: "old-access", RefreshToken: "old-refresh", ExpiresAt: time.Now().Add(-time.Minute), Extra: map[string]string{"api_version": "4"}}
	id, err := h.createJob(ctx, "tenant-kit-refresh", canonical.SourceConvertKit, sess)
	require.NoError(t, err)
	var calls atomic.Int32
	h.kitSessionRefresher = func(_ context.Context, old adapter.Session) (adapter.Session, error) {
		calls.Add(1)
		require.Equal(t, "old-refresh", old.RefreshToken)
		old.AccessToken = "new-access"
		old.RefreshToken = "new-refresh"
		old.ExpiresAt = time.Now().Add(48 * time.Hour)
		return old, nil
	}
	updated, err := h.loadSession(ctx, "tenant-kit-refresh", id)
	require.NoError(t, err)
	require.Equal(t, "new-access", updated.AccessToken)
	stored, err := store.GetSession(ctx, "tenant-kit-refresh", id, time.Now())
	require.NoError(t, err)
	require.Equal(t, "new-refresh", stored.RefreshToken)
	_, err = h.loadSession(ctx, "tenant-kit-refresh", id)
	require.NoError(t, err)
	require.Equal(t, int32(1), calls.Load())
	_, err = h.loadSession(context.Background(), "other-tenant", id)
	require.Error(t, err)
}

func TestKitReconnectCannotSwitchAccounts(t *testing.T) {
	ctx := jobstore.WithTenantID(context.Background(), "tenant-kit-binding")
	h := NewMigration("", jobstore.NewMemoryJobStore())
	sess := adapter.Session{Source: canonical.SourceConvertKit, AccountID: "42", AccessToken: "token", Extra: map[string]string{"api_version": "4"}}
	id, err := h.createJob(ctx, "tenant-kit-binding", canonical.SourceConvertKit, sess)
	require.NoError(t, err)
	sess.AccountID = "43"
	_, err = h.completeOAuthJob(ctx, "tenant-kit-binding", canonical.SourceConvertKit, oauthStateForJob("state", id), sess)
	require.ErrorIs(t, err, errOAuthAccountMismatch)
	stored, err := h.loadSession(ctx, "tenant-kit-binding", id)
	require.NoError(t, err)
	require.Equal(t, "42", stored.AccountID)
}

func TestKitRotationLockPreventsCredentialReplacement(t *testing.T) {
	ctx := context.Background()
	h := NewMigration("", jobstore.NewMemoryJobStore())
	lease, err := orchestrator.AcquireMigrationSessionRefreshLease(ctx, nil, "tenant-kit-lock", "job-kit-lock")
	require.NoError(t, err)
	defer func() { _ = lease.Release() }()
	err = h.saveSourceSession(ctx, "job-kit-lock", "tenant-kit-lock", adapter.Session{Source: canonical.SourceConvertKit}, time.Now().Add(time.Hour))
	require.ErrorIs(t, err, orchestrator.ErrMigrationExecutionInProgress)
}

func TestKitRunningAdapterReloadsExpiredCredentialBetweenRequests(t *testing.T) {
	ctx := jobstore.WithTenantID(context.Background(), "tenant-kit-running")
	store := jobstore.NewMemoryJobStore()
	h := NewMigration("", store)
	sess := adapter.Session{Source: canonical.SourceConvertKit, AccountID: "42", AccessToken: "first", RefreshToken: "refresh-first", ExpiresAt: time.Now().Add(time.Hour), Extra: map[string]string{"api_version": "4"}}
	id, err := h.createJob(ctx, "tenant-kit-running", canonical.SourceConvertKit, sess)
	require.NoError(t, err)
	job, err := store.Get(ctx, id)
	require.NoError(t, err)
	ad := convertkit.New()
	h.configureSourceSessionResolver(ad, job)
	require.NotNil(t, ad.ResolveSession)
	first, err := ad.ResolveSession(ctx)
	require.NoError(t, err)
	require.Equal(t, "first", first.AccessToken)
	sess.ExpiresAt = time.Now().Add(-time.Second)
	require.NoError(t, store.SaveSession(ctx, id, job.TenantID, sess, time.Now().Add(time.Hour)))
	h.kitSessionRefresher = func(context.Context, adapter.Session) (adapter.Session, error) {
		sess.AccessToken = "rotated"
		sess.RefreshToken = "refresh-rotated"
		sess.ExpiresAt = time.Now().Add(48 * time.Hour)
		return sess, nil
	}
	next, err := ad.ResolveSession(ctx)
	require.NoError(t, err)
	require.Equal(t, "rotated", next.AccessToken)
	persisted, err := store.GetSession(ctx, job.TenantID, id, time.Now())
	require.NoError(t, err)
	require.Equal(t, next.RefreshToken, persisted.RefreshToken)
}

func TestKitTokenWithUnknownExpiryRotatesBeforeUse(t *testing.T) {
	sess := adapter.Session{Source: canonical.SourceConvertKit, RefreshToken: "refresh"}
	if !kitSessionNeedsRefresh(sess, time.Now()) {
		t.Fatal("unknown access-token expiry was treated as safe")
	}
	sess.RefreshToken = ""
	if kitSessionNeedsRefresh(sess, time.Now()) {
		t.Fatal("session without refresh token should require reconnect on auth failure")
	}
}
