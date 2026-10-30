// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"net/http"
	"testing"
)

func TestDeviceGrantJanitorBoundsSensitiveMetadataRetention(t *testing.T) {
	f := newDeviceGrantFixture(t)

	expiredPending := f.start(t, `{"grant_kind":"session"}`)
	expiredPendingCode := expiredPending["device_code"].(string)
	updateGrantRetentionTimes(t, f, expiredPendingCode, `
		UPDATE cli_device_grants SET expires_at = now() - interval '2 hours'
		 WHERE device_code_hash = $1`)

	recentPending := f.start(t, `{"grant_kind":"session"}`)
	recentPendingCode := recentPending["device_code"].(string)

	expiredProvisional := f.start(t, `{"grant_kind":"session"}`)
	expiredProvisionalCode := expiredProvisional["device_code"].(string)
	f.approve(t, expiredProvisional["user_code"].(string))
	if polled := f.token(t, expiredProvisionalCode, uaWinEdge); polled.Code != http.StatusOK {
		t.Fatalf("provisional poll = %d %s", polled.Code, polled.Body.String())
	}
	updateGrantRetentionTimes(t, f, expiredProvisionalCode, `
		UPDATE cli_device_grants
		   SET session_confirmation_expires_at = now() - interval '2 hours'
		 WHERE device_code_hash = $1`)

	oldConfirmed := f.start(t, `{"grant_kind":"session"}`)
	oldConfirmedCode := oldConfirmed["device_code"].(string)
	f.approve(t, oldConfirmed["user_code"].(string))
	oldPoll := f.token(t, oldConfirmedCode, uaWinEdge)
	oldCookie := deviceGrantTestSessionCookie(t, oldPoll)
	if confirmed := f.confirm(t, oldConfirmedCode, uaWinEdge, oldCookie); confirmed.Code != http.StatusOK {
		t.Fatalf("old confirm = %d %s", confirmed.Code, confirmed.Body.String())
	}
	updateGrantRetentionTimes(t, f, oldConfirmedCode, `
		UPDATE cli_device_grants
		   SET session_confirmed_at = now() - interval '32 days'
		 WHERE device_code_hash = $1`)

	recentConfirmed := f.start(t, `{"grant_kind":"session"}`)
	recentConfirmedCode := recentConfirmed["device_code"].(string)
	f.approve(t, recentConfirmed["user_code"].(string))
	recentPoll := f.token(t, recentConfirmedCode, uaWinEdge)
	recentCookie := deviceGrantTestSessionCookie(t, recentPoll)
	if confirmed := f.confirm(t, recentConfirmedCode, uaWinEdge, recentCookie); confirmed.Code != http.StatusOK {
		t.Fatalf("recent confirm = %d %s", confirmed.Code, confirmed.Body.String())
	}

	if _, err := f.repo.CleanupExpiredDeviceGrants(context.Background(), deviceGrantCleanupBatch); err != nil {
		t.Fatalf("cleanup device grants: %v", err)
	}
	for name, code := range map[string]string{
		"expired pending":     expiredPendingCode,
		"expired provisional": expiredProvisionalCode,
		"old confirmed":       oldConfirmedCode,
	} {
		if deviceGrantExists(t, f, code) {
			t.Errorf("%s grant survived retention cleanup", name)
		}
	}
	for name, code := range map[string]string{
		"recent pending":   recentPendingCode,
		"recent confirmed": recentConfirmedCode,
	} {
		if !deviceGrantExists(t, f, code) {
			t.Errorf("%s grant was deleted too early", name)
		}
	}
}

func updateGrantRetentionTimes(t *testing.T, f *deviceGrantFixture, deviceCode, query string) {
	t.Helper()
	hash := sha256hex(deviceCode)
	tx, err := beginDeviceGrantSecretScope(context.Background(), f.repo.Pool, hash)
	if err != nil {
		t.Fatalf("begin grant retention update: %v", err)
	}
	if _, err := tx.Exec(context.Background(), query, hash); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("update grant retention time: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit grant retention time: %v", err)
	}
}

func deviceGrantExists(t *testing.T, f *deviceGrantFixture, deviceCode string) bool {
	t.Helper()
	hash := sha256hex(deviceCode)
	tx, err := beginDeviceGrantSecretScope(context.Background(), f.repo.Pool, hash)
	if err != nil {
		t.Fatalf("begin grant existence lookup: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var exists bool
	if err := tx.QueryRow(context.Background(), `
		SELECT EXISTS (
		    SELECT 1 FROM cli_device_grants WHERE device_code_hash = $1
		)`, hash).Scan(&exists); err != nil {
		t.Fatalf("lookup grant existence: %v", err)
	}
	return exists
}

func deviceGrantTestSessionCookie(t *testing.T, response interface {
	Result() *http.Response
}) *http.Cookie {
	t.Helper()
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == SessionCookieName {
			return cookie
		}
	}
	t.Fatal("response omitted session cookie")
	return nil
}
