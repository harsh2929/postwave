package views

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxTenantSearchRunes = 128

// TenantLister is the narrow read surface TenantsHandler needs. *Reader
// satisfies it; tests use a fake.
type TenantLister interface {
	ListTenants(ctx context.Context, search string, limit int) ([]TenantRow, error)
}

// TenantsHandler serves GET /api/internal/ops/views/tenants — the cross-tenant
// directory. Read-only. A read failure is a 500, never an empty 200: an empty
// ops surface reads as "all clear", which is exactly the failure mode the
// console exists to prevent.
func TenantsHandler(l TenantLister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		search := strings.TrimSpace(r.URL.Query().Get("search"))
		if !validTenantSearch(search) {
			writeViewError(w, http.StatusBadRequest, "invalid_tenant_search", "tenant search must be valid text whose escaped UTF-8 form is at most 128 bytes")
			return
		}
		limit := 200
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				limit = n
			}
		}
		limit = normalizeViewLimit(limit)
		rows, err := l.ListTenants(r.Context(), search, limit)
		if err != nil {
			writeViewError(w, http.StatusInternalServerError, "tenant_directory_unavailable", "the tenant directory is unavailable")
			return
		}
		writeViewJSON(w, map[string]any{"tenants": rows, "truncated": len(rows) >= limit})
	}
}

func validTenantSearch(search string) bool {
	if !utf8.ValidString(search) ||
		utf8.RuneCountInString(search) > maxTenantSearchRunes ||
		len(escapeLikePrefix(search)) > maxTenantSearchRunes {
		return false
	}
	for _, char := range search {
		if unicode.IsControl(char) {
			return false
		}
	}
	return true
}

// viewLimit parses the ?limit query param, defaulting to 200. Shared by view
// handlers so the bound is uniform.
func viewLimit(r *http.Request) int {
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return normalizeViewLimit(n)
		}
	}
	return defaultViewRows
}

func normalizeViewLimit(limit int) int {
	if limit < 1 || limit > maxViewRows {
		return defaultViewRows
	}
	return limit
}
