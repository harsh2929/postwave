package convertkit

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestEachRequestUsesPersistedCredentialAndStopsOnRotationFailure(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		require.Equal(t, "Bearer rotated", r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"account":{"id":42}}`))
	}))
	defer server.Close()
	ad := New()
	ad.BaseURL = server.URL
	old := adapter.Session{Source: canonical.SourceConvertKit, AccountID: "42", AccessToken: "old", Extra: map[string]string{"api_version": "4"}}
	current := old
	current.AccessToken = "rotated"
	ad.ResolveSession = func(context.Context) (adapter.Session, error) { return current, nil }
	id, err := ad.accountID(context.Background(), old)
	require.NoError(t, err)
	require.Equal(t, "42", id)
	require.Equal(t, 1, calls)
	ad.ResolveSession = func(context.Context) (adapter.Session, error) {
		return adapter.Session{}, errors.New("credential persistence failed")
	}
	_, err = ad.accountID(context.Background(), old)
	require.ErrorContains(t, err, "persistence failed")
	require.Equal(t, 1, calls)
	current.AccountID = "43"
	ad.ResolveSession = func(context.Context) (adapter.Session, error) { return current, nil }
	_, err = ad.accountID(context.Background(), old)
	require.ErrorIs(t, err, adapter.ErrAuth)
	require.Equal(t, 1, calls)
}
