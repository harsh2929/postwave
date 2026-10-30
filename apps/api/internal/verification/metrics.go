// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"errors"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Verification metrics intentionally omit tenant IDs and addresses. Provider,
// outcome, grade, and terminal state all use closed vocabularies, keeping both
// Prometheus cardinality and recipient privacy bounded.
var (
	verificationProviderBatches = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_email_verification_provider_batches_total",
		Help: "Metered verification provider batches by provider and closed outcome.",
	}, []string{"provider", "outcome"})
	verificationProviderAddresses = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_email_verification_provider_addresses_total",
		Help: "Addresses crossing the metered verification boundary by provider and closed outcome.",
	}, []string{"provider", "outcome"})
	verificationCreditsSpent = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_email_verification_credits_spent_total",
		Help: "Provider-reported billable verification results by provider.",
	}, []string{"provider"})
	verificationHealthDecisions = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_email_health_decisions_total",
		Help: "Materialized recipient health decisions by grade and evidence completeness.",
	}, []string{"grade", "evidence_complete"})
	verificationHealthUnavailable = promauto.NewCounter(prometheus.CounterOpts{
		Name: "postwave_email_health_evidence_unavailable_total",
		Help: "Verification results annotated fail-closed because tenant health evidence could not be read.",
	})
	verificationCachePurged = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_email_verification_evidence_purge_total",
		Help: "Expired cache, health-snapshot, and terminal job-item address-evidence rows processed by the janitor, partitioned by outcome.",
	}, []string{"outcome"})
	verificationJobTerminals = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_email_verification_jobs_terminal_total",
		Help: "Durable verification jobs entering a terminal state, partitioned by closed status and failure code.",
	}, []string{"status", "failure_code"})
	verificationUsagePersistenceFailures = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_email_verification_usage_persistence_failures_total",
		Help: "Verification usage-accounting persistence failures by closed caller surface.",
	}, []string{"surface"})
)

func verificationProviderLabel(provider string) string {
	switch provider {
	case ProviderZeroBounce, ProviderKickbox, ProviderLocal:
		return provider
	default:
		return "unknown"
	}
}

func verificationProviderOutcome(err error) string {
	switch {
	case err == nil:
		return "success"
	case errors.Is(err, ErrProviderPartialOutcome):
		return "ambiguous"
	case errors.Is(err, ErrProviderAccountRejected):
		return "account_rejected"
	case errors.Is(err, ErrNoCredits):
		return "no_credits"
	case errors.Is(err, ErrUnauthorized):
		return "unauthorized"
	case errors.Is(err, ErrNotConfigured):
		return "not_configured"
	case errors.Is(err, ErrProviderUnavailable):
		return "unavailable"
	default:
		return "error"
	}
}

func observeVerificationUsagePersistenceFailure(surface string) {
	switch surface {
	case "sync", "signup":
	default:
		surface = "unknown"
	}
	verificationUsagePersistenceFailures.WithLabelValues(surface).Inc()
}

func observeVerificationProviderBatch(provider string, addresses int, results []Result, err error) {
	provider = verificationProviderLabel(provider)
	outcome := verificationProviderOutcome(err)
	verificationProviderBatches.WithLabelValues(provider, outcome).Inc()
	if addresses > 0 {
		verificationProviderAddresses.WithLabelValues(provider, outcome).Add(float64(addresses))
	}
	if err != nil {
		return
	}
	credits := 0
	for _, result := range results {
		if result.Billable {
			credits++
		}
	}
	if credits > 0 {
		verificationCreditsSpent.WithLabelValues(provider).Add(float64(credits))
	}
}

func observeVerificationHealth(results []EmailHealth) {
	for _, result := range results {
		grade := string(result.Grade)
		if !result.Grade.Valid() {
			grade = "U"
		}
		complete := "true"
		if !result.EvidenceComplete {
			complete = "false"
		}
		verificationHealthDecisions.WithLabelValues(grade, complete).Inc()
	}
}

func observeVerificationHealthUnavailable(count int) {
	if count > 0 {
		verificationHealthUnavailable.Add(float64(count))
	}
}

func observeVerificationCachePurge(count int64, err error) {
	if err != nil {
		verificationCachePurged.WithLabelValues("error").Inc()
		return
	}
	if count > 0 {
		verificationCachePurged.WithLabelValues("deleted").Add(float64(count))
	} else {
		verificationCachePurged.WithLabelValues("empty").Inc()
	}
}

// observeVerificationJobTerminal must be called only after a durable terminal
// transition commits. Its fallback labels keep future failure codes bounded.
func observeVerificationJobTerminal(status, failureCode string) {
	switch status {
	case JobStatusCompleted, JobStatusFailed, JobStatusCanceled:
	default:
		status = JobStatusFailed
	}
	switch failureCode {
	case "", failureCodeOutcomeAmbiguous, "verification_no_credits",
		"verification_provider_unauthorized", "verification_provider_account_rejected", "provider_not_configured",
		"verification_provider_unavailable", "verification_job_failed", failureCodeRetentionTimeout:
	default:
		failureCode = "verification_job_failed"
	}
	if failureCode == "" {
		failureCode = "none"
	}
	verificationJobTerminals.WithLabelValues(status, failureCode).Inc()
}
