// SPDX-License-Identifier: AGPL-3.0-only
//
// Package predictive_clv implements the BG/NBD ("Beta-Geometric /
// Negative-Binomial-Distribution") buy-till-you-die model — the
// standard statistical model behind Klaviyo/Mailchimp-style predicted
// CLV — in pure Go, with no external ML/stats dependency.
//
// # Model
//
// Each customer is summarized by an RFM triple (x, t_x, T):
//
//   - x    — frequency: number of REPEAT transactions observed in
//     (0, T] (the first/initial purchase that starts the clock is not
//     counted).
//   - t_x  — recency: the time (since the initial purchase) at which
//     the last repeat transaction occurred, 0 <= t_x <= T.
//   - T    — the customer's total observation length since their
//     initial purchase.
//
// The model has four parameters:
//
//   - r, alpha — shape/rate of the Gamma(r, alpha) mixing distribution
//     for each customer's (unobserved, heterogeneous) transaction rate
//     lambda. E[lambda] = r/alpha.
//   - a, b     — shape parameters of the Beta(a, b) mixing distribution
//     for each customer's (unobserved, heterogeneous) per-transaction
//     "drop out" probability p. E[p] = a/(a+b).
//
// Given fitted (r, alpha, a, b), this package answers the two
// questions the vendor-parity CLV surface needs:
//
//   - PAlive: P(customer is still "alive" | their RFM history) — the
//     survival-style signal that feeds churn_risk_score.
//   - ConditionalExpectedTransactions: E[transactions in the next t
//     periods | RFM history] — combined with an average order value
//     via EstimatedCLV to produce clv_predicted_cents.
//
// # Fitting
//
// FitBGNBD estimates (r, alpha, a, b) by maximizing the BG/NBD
// log-likelihood (Fader, Hardie & Lee, 2005, "'Counting Your Customers'
// the Easy Way") over a slice of CustomerSummary via a from-scratch
// Nelder-Mead simplex search (optimize.go), seeded by
// MethodOfMomentsSeed. Both are pure Go — no cgo, no external
// optimizer/ML library.
//
// FitBGNBD returns an error instead of a fit whose parameters would be
// meaningless (fitguard.go). It rejects input for which the likelihood has
// no maximum: a repeat transaction at t_x = 0, or no repeat transactions at
// all. It also rejects an optimizer result whose likelihood is not finite,
// whose parameters lie beyond what float64 can resolve against the data, or
// whose likelihood exceeds the most any parameters can give the data. And
// it rejects a search that ran out of iterations while its simplex still
// spanned more likelihood than rounding error explains. A search that stops
// short of Nelder-Mead's tolerance only because the likelihood's rounding
// error exceeds that tolerance has settled, and is accepted. That is common
// when dropout is nearly the same for every customer: the fit then lies on
// a ridge toward the Beta distribution's point-mass limit. The error is a
// *FitError naming the reason. A caller should fall back to its heuristic
// on any error, and should record the reason, because each rejection
// silently changes the model its predictions come from.
//
// # Wiring
//
// internal/predictive is the caller. Its Repo.Recompute runs for every
// tenant from the sto_predictive_clv worker and the operational-maintenance
// recompute, and on POST /api/v1/predictive/recompute. It builds one
// summary per customer with an order history (predictive.SignalToSummary),
// fits once per tenant (predictive.FitTenantBGNBD) and forecasts each
// customer from that fit (predictive.BGNBDForecastFor). When the tenant has
// too few customers, or FitBGNBD rejects the fit, every forecast stays on
// the heuristic, and the run records why: predictive_model_runs.metrics
// carries clv_model, bgnbd_fallback_reason (a FitRejectReason, or
// too_few_customers) and bgnbd_fallback_error, and the fallback is logged
// with the tenant id, as a warning when the data could support a fit.
//
// This package intentionally has zero dependency on internal/db or any
// sto_predictive_clv type so it can be unit-tested without a database.
package predictive_clv
