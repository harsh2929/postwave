// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	// Public form definitions are fetched by the web renderer. Many unrelated
	// visitors can therefore share one web-server egress IP at the API boundary.
	// Give that read-only surface a bounded but traffic-shaped budget instead of
	// charging it to the submission anti-abuse budget.
	publicFormRenderRequestsPerMinute = 600

	// Mutating/token-bearing surfaces each get an independent budget. Keeping
	// these buckets separate means a render spike cannot admit extra submissions,
	// and submission abuse cannot starve confirmations or upload preparation.
	// Confirmation links are also resolved by the web renderer and carry
	// high-entropy single-use credentials, so their egress-shaped ceiling is
	// intentionally higher than the email-submission budget.
	publicFormSubmitRequestsPerMinute  = 10
	publicFormConfirmRequestsPerMinute = 600
	publicFormUploadRequestsPerMinute  = 20

	// Public archive pages are rendered server-side by the hosted web tier the
	// same way form definitions are, so they collapse onto one API-visible
	// egress IP for the whole platform. A normal visit already costs two
	// requests (generateMetadata + the page body), so the render budget matches
	// the forms render ceiling rather than the 10/min human-form budget.
	archiveRenderRequestsPerMinute = 600
	// One ticket can be prefetched by several security/mail clients before the
	// recipient opens it. Isolate those high-entropy bearer lookups from the
	// legacy public-page bucket while retaining a distributed per-IP abuse cap.
	actionTicketRequestsPerMinute = 60
)

type publicFormsRateLimits struct {
	render  *middleware.RateLimit
	submit  *middleware.RateLimit
	confirm *middleware.RateLimit
	upload  *middleware.RateLimit
}

func newPublicFormsRateLimits(base middleware.RateLimitOptions) publicFormsRateLimits {
	return publicFormsRateLimits{
		render: middleware.NewRateLimitWithOptions(
			publicFormRenderRequestsPerMinute,
			time.Minute,
			publicFormsRateLimitOptions(base, "ip:forms-render"),
		),
		submit: middleware.NewRateLimitWithOptions(
			publicFormSubmitRequestsPerMinute,
			time.Minute,
			publicFormsRateLimitOptions(base, "ip:forms-submit"),
		),
		confirm: middleware.NewRateLimitWithOptions(
			publicFormConfirmRequestsPerMinute,
			time.Minute,
			publicFormsRateLimitOptions(base, "ip:forms-confirm"),
		),
		upload: middleware.NewRateLimitWithOptions(
			publicFormUploadRequestsPerMinute,
			time.Minute,
			publicFormsRateLimitOptions(base, "ip:forms-upload"),
		),
	}
}

func publicFormsRateLimitOptions(
	base middleware.RateLimitOptions,
	namespace string,
) middleware.RateLimitOptions {
	base.Namespace = namespace
	return base
}
