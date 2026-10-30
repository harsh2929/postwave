// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// FetchRecorder persists one observed decoy fetch. It is an interface so the
// handler can be exercised without a database, and so that the only thing this
// endpoint can do is append evidence — there is no path from here into
// subscriber_events, and therefore none into click-through rate or lead
// scoring.
type FetchRecorder interface {
	RecordFetch(ctx context.Context, fetch Fetch) error
}

type Deps struct {
	Minter   *Minter
	Recorder FetchRecorder
	// TrustForwardedIPHeaders mirrors the deployment's proxy trust setting.
	// Resolution is delegated to middleware.ResolveClientIPString rather than
	// re-derived here: a second, subtly different implementation of proxy trust
	// is how a spoofable client IP gets into evidence.
	TrustForwardedIPHeaders bool
	Now                     func() time.Time
}

// MountPublicHoneypotRoutes registers the decoy endpoint. It belongs under the
// same public IP rate limit as the other /api/public routes.
// The path is a LITERAL here rather than DecoyPath+"/{token}". The route
// inventory that drives routeauth is produced by scanning this call, and it
// cannot evaluate a constant expression — a route it fails to see gets no
// capability, which makes routeauth answer 403 route_authorization_unclassified
// and fails startup validation outright. TestMountedPathMatchesDecoyPath keeps
// the literal and the constant from drifting apart.
func MountPublicHoneypotRoutes(r chi.Router, d *Deps) {
	r.Get("/api/public/engagement/hp/{token}", d.HandleDecoyFetch)
}

// HandleDecoyFetch records a fetch of a honeypot decoy.
//
// It answers 204 for every outcome — valid, forged, expired, or a failed
// write. That uniformity is deliberate. The endpoint is unauthenticated and
// the thing behind it is the corpus that certifies the classifier, so an
// observable difference between "bad signature" and "expired" would be an
// oracle for probing the signing scheme. There is nothing a caller can learn
// here, including whether their token was any good.
func (d *Deps) HandleDecoyFetch(w http.ResponseWriter, r *http.Request) {
	// Written before any branch, so the response is byte-identical on every
	// path out of this function.
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, private")
	w.Header().Set("Pragma", "no-cache")
	// A decoy is not a tracked link and must never send anyone anywhere: a
	// redirect would hand a destination to whoever reached it and would make
	// the endpoint useful as an open redirect.
	defer w.WriteHeader(http.StatusNoContent)

	if d == nil || d.Minter == nil || d.Recorder == nil {
		return
	}
	now := time.Now().UTC()
	if d.Now != nil {
		now = d.Now().UTC()
	}

	claim, err := d.Minter.Verify(chi.URLParam(r, "token"), now)
	if err != nil {
		return
	}

	fetch := Fetch{
		Claim:      claim,
		FetchedAt:  now,
		UserAgent:  r.UserAgent(),
		IP:         middleware.ResolveClientIPString(r, d.TrustForwardedIPHeaders),
		NetworkASN: nil,
	}
	// Bounded independently of the request context. A scanner that opens the
	// connection and walks away would otherwise cancel the write of evidence
	// we have already earned.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	// The error is deliberately swallowed. Answering 500 would tell the caller
	// their token was genuine, and would invite a retry storm from a scanner
	// that treats 5xx as retryable. Losing one label is the cheaper failure,
	// and the recorder logs its own errors.
	_ = d.Recorder.RecordFetch(ctx, fetch)
}
