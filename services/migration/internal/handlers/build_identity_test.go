package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBuildIdentityRejectsWrongCandidateBeforeMutation(t *testing.T) {
	digest := migrationBinaryDigest()
	require.Len(t, digest, 64)
	calls := 0
	handler := migrationBuildIdentity(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) }))
	for _, expected := range []string{digest, strings.Repeat("0", 64)} {
		r := httptest.NewRequest(http.MethodPost, "/commit", nil)
		r.Header.Set("X-Migration-Expected-Build-SHA256", expected)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		require.Equal(t, digest, w.Header().Get("X-Migration-Build-SHA256"))
		if expected == digest {
			require.Equal(t, 204, w.Code)
		} else {
			require.Equal(t, 409, w.Code)
		}
	}
	require.Equal(t, 1, calls)
}
