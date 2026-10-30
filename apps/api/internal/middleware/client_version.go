// SPDX-License-Identifier: AGPL-3.0-only
//
// Client-version fabric (Apple-level integration blueprint, dimension 10 —
// version/compatibility, previously graded F: no client-version or
// force-upgrade contract existed at all). First-party clients now send an
// X-Postwave-Version header (alongside the existing X-Postwave-Client); this
// middleware lets an operator enforce a per-client MINIMUM version so a stale
// build receives a clear, structured "please update" (426 Upgrade Required)
// instead of silently mis-parsing a newer response shape.
//
// Enforcement is OPT-IN and fail-open by construction: with no minimum
// configured for a client (the default), every request passes; a request that
// omits the version, sends a malformed version, or is not a recognised
// first-party client also passes. Only a *valid* client version that is
// strictly below a *valid* configured minimum is rejected — so a header bug can
// never lock users out, and external SDK/API-key callers (which send neither
// header) are never affected.

package middleware

import (
	"net/http"
	"strconv"
	"strings"

	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// ClientVersion enforces per-client minimum versions. `minVersions` maps a
// normalized X-Postwave-Client value (e.g. "web", "desktop", "mobile") to the
// minimum acceptable semver. A nil/empty map disables all enforcement.
func ClientVersion(minVersions map[string]string) func(http.Handler) http.Handler {
	// Pre-parse the configured minimums once; drop any that don't parse so a
	// misconfigured floor fails open rather than 426-ing every client.
	floors := make(map[string]semver, len(minVersions))
	for client, min := range minVersions {
		if v, ok := parseSemver(min); ok {
			floors[normalizeClient(client)] = v
		}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if len(floors) == 0 {
				next.ServeHTTP(w, r)
				return
			}
			client := normalizeClient(r.Header.Get("X-Postwave-Client"))
			floor, enforced := floors[client]
			if !enforced {
				next.ServeHTTP(w, r) // no minimum for this (or an unknown) client
				return
			}
			raw := strings.TrimSpace(r.Header.Get("X-Postwave-Version"))
			cur, ok := parseSemver(raw)
			if !ok {
				next.ServeHTTP(w, r) // missing/malformed version → fail open
				return
			}
			if compareSemver(cur, floor) < 0 {
				httperror.WriteProblemJSON(w, httperror.Problem{
					Status: http.StatusUpgradeRequired, // 426
					Title:  "Upgrade required",
					Code:   "upgrade_required",
					Detail: "This app version is no longer supported. Please update to continue.",
					Extras: map[string]any{
						"min_version":     floor.String(),
						"current_version": cur.String(),
						"client":          client,
						"request_id":      chimiddleware.GetReqID(r.Context()),
					},
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func normalizeClient(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// semver is a minimal major.minor.patch triple. Pre-release / build metadata
// is intentionally ignored (we compare release lines, not pre-releases).
type semver struct{ major, minor, patch int }

func (v semver) String() string {
	return strconv.Itoa(v.major) + "." + strconv.Itoa(v.minor) + "." + strconv.Itoa(v.patch)
}

// parseSemver parses "1.2.3" (optionally "v1.2.3", or with a trailing
// "-prerelease"/"+build" that is discarded). Returns ok=false on anything that
// isn't at least three dotted non-negative integers, so callers can fail open.
func parseSemver(s string) (semver, bool) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "v")
	if s == "" {
		return semver{}, false
	}
	// Drop pre-release / build metadata.
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) < 3 {
		return semver{}, false
	}
	nums := make([]int, 3)
	for i := 0; i < 3; i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil || n < 0 {
			return semver{}, false
		}
		nums[i] = n
	}
	return semver{nums[0], nums[1], nums[2]}, true
}

// compareSemver returns -1 if a<b, 0 if equal, +1 if a>b.
func compareSemver(a, b semver) int {
	for _, d := range []int{a.major - b.major, a.minor - b.minor, a.patch - b.patch} {
		if d < 0 {
			return -1
		}
		if d > 0 {
			return 1
		}
	}
	return 0
}
