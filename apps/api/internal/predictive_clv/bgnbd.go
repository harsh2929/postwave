// SPDX-License-Identifier: AGPL-3.0-only
package predictive_clv

import (
	"math"
)

// Params holds the four BG/NBD parameters.
//
//   - R, Alpha — shape/rate of the Gamma(R, Alpha) mixing distribution
//     over each customer's latent transaction rate lambda.
//   - A, B     — shape parameters of the Beta(A, B) mixing distribution
//     over each customer's latent per-transaction dropout probability p.
type Params struct {
	R     float64
	Alpha float64
	A     float64
	B     float64
}

// Valid reports whether every parameter is strictly positive, the
// domain the BG/NBD likelihood is defined over.
func (p Params) Valid() bool {
	return p.R > 0 && p.Alpha > 0 && p.A > 0 && p.B > 0 &&
		!math.IsNaN(p.R) && !math.IsNaN(p.Alpha) && !math.IsNaN(p.A) && !math.IsNaN(p.B) &&
		!math.IsInf(p.R, 0) && !math.IsInf(p.Alpha, 0) && !math.IsInf(p.A, 0) && !math.IsInf(p.B, 0)
}

// CustomerSummary is the per-customer RFM sufficient statistic the
// BG/NBD model is fit and scored against.
//
//   - X      frequency: number of repeat transactions observed in (0, T].
//   - Tx     recency: elapsed time (since the initial transaction) of
//     the last repeat transaction. 0 when X == 0.
//   - T      total observation length since the initial transaction.
//   - Weight optional replication count when many customers share an
//     identical (X, Tx, T) triple (common once frequencies get large in
//     a real book of business). Zero/negative is treated as 1.
type CustomerSummary struct {
	X      float64
	Tx     float64
	T      float64
	Weight float64
}

func (s CustomerSummary) weight() float64 {
	if s.Weight <= 0 {
		return 1
	}
	return s.Weight
}

// lnGamma is math.Lgamma without the sign return — every call site in
// this package operates on strictly positive arguments (r+x, alpha,
// a+b, etc. are all sums of positive parameters and non-negative
// counts), so Gamma is always positive and the sign is always +1.
func lnGamma(x float64) float64 {
	v, _ := math.Lgamma(x)
	return v
}

// logBeta returns ln(B(a, b)) = lnGamma(a) + lnGamma(b) - lnGamma(a+b),
// computed in log-space to stay finite for the large arguments that
// show up once x (repeat frequency) gets into the hundreds.
func logBeta(a, b float64) float64 {
	return lnGamma(a) + lnGamma(b) - lnGamma(a+b)
}

// logSumExp returns ln(exp(a) + exp(b)) without overflowing/underflowing
// for the wide dynamic range the BG/NBD log-likelihood terms can span.
func logSumExp(a, b float64) float64 {
	if math.IsInf(a, -1) && math.IsInf(b, -1) {
		return math.Inf(-1)
	}
	m := math.Max(a, b)
	return m + math.Log(math.Exp(a-m)+math.Exp(b-m))
}

// invOnePlusExp returns 1 / (1 + exp(z)) — the logistic-sigmoid form
// used by PAlive — computed so neither branch ever evaluates exp of a
// large positive number.
func invOnePlusExp(z float64) float64 {
	if z >= 0 {
		e := math.Exp(-z)
		return e / (1 + e)
	}
	e := math.Exp(z)
	return 1 / (1 + e)
}

// LogLikelihoodSingle returns the BG/NBD log-likelihood of a single
// customer's RFM summary (x, tx, T) under params p.
//
// This is the numerically-stable A1/A2/A3/A4 decomposition from Fader
// & Hardie's technical note "Overcoming the BG/NBD Model's #NUM! Error
// Problem" (2013), which is algebraically identical to the closed form
// in the original 2005 paper (eq. 3/4) but avoids computing the raw
// (possibly astronomically large or small) Gamma/Beta ratios directly:
//
//	A1 = lnGamma(r+x) - lnGamma(r) + r*ln(alpha)
//	A2 = lnGamma(a+b) + lnGamma(b+x) - lnGamma(b) - lnGamma(a+b+x)
//	   = ln( B(a, b+x) / B(a, b) )
//	A3 = -(r+x) * ln(alpha+T)
//	A4 = ln(a) - ln(b+x-1) - (r+x) * ln(alpha+tx)     [only when x > 0]
//
//	ln L = A1 + A2 + ln( exp(A3) + 1{x>0} * exp(A4) )
func LogLikelihoodSingle(p Params, x, tx, T float64) float64 {
	r, alpha, a, b := p.R, p.Alpha, p.A, p.B

	a1 := lnGamma(r+x) - lnGamma(r) + r*math.Log(alpha)
	a2 := lnGamma(a+b) + lnGamma(b+x) - lnGamma(b) - lnGamma(a+b+x)
	a3 := -(r + x) * math.Log(alpha+T)

	if x <= 0 {
		return a1 + a2 + a3
	}

	a4 := math.Log(a) - math.Log(b+x-1) - (r+x)*math.Log(alpha+tx)
	return a1 + a2 + logSumExp(a3, a4)
}

// LogLikelihood sums LogLikelihoodSingle over a customer base, honoring
// per-row Weight as a replication count (so a caller can pass an
// already-aggregated frequency table instead of one row per customer).
func LogLikelihood(p Params, summaries []CustomerSummary) float64 {
	var total float64
	for _, s := range summaries {
		total += s.weight() * LogLikelihoodSingle(p, s.X, s.Tx, s.T)
	}
	return total
}

// PAlive returns P(customer with this RFM history is still "alive" —
// has not yet permanently dropped out — as of T).
//
//	P(alive) = 1                                                     if x == 0
//	P(alive) = 1 / (1 + (a/(b+x-1)) * ((alpha+T)/(alpha+tx))^(r+x))  if x >  0
//
// (Fader, Hardie & Lee 2005, eq. 8; the x==0 branch is the well-known
// limiting property of BG/NBD that a customer who has never repeated is
// treated by the model as still active until proven otherwise.)
func PAlive(p Params, x, tx, T float64) float64 {
	if x <= 0 {
		return 1
	}
	r, alpha, a, b := p.R, p.Alpha, p.A, p.B
	logP1 := math.Log(a) - math.Log(b+x-1) + (r+x)*(math.Log(alpha+T)-math.Log(alpha+tx))
	return invOnePlusExp(logP1)
}

// hyp2f1 evaluates the Gaussian hypergeometric function 2F1(a,b;c;z) by
// direct series summation:
//
//	2F1(a,b;c;z) = sum_{n=0}^inf  [(a)_n (b)_n / (c)_n / n!] * z^n
//
// computed via the term-to-term ratio
//
//	term_{n+1} = term_n * (a+n)(b+n) / ((c+n)(n+1)) * z
//
// which keeps every intermediate value O(1)-ish (no raw factorials or
// Pochhammer products), rather than the closed-form-per-term approach.
// Valid for the |z| < 1 domain ConditionalExpectedTransactions calls it
// with (z = t/(alpha+T+t) is always in [0,1)).
func hyp2f1(a, b, c, z float64) float64 {
	if z == 0 {
		return 1
	}
	const maxIter = 20000
	const tol = 1e-15

	term := 1.0
	sum := 1.0
	for n := 0.0; n < maxIter; n++ {
		denom := (c + n) * (n + 1)
		if math.Abs(denom) < 1e-300 {
			// c hit a non-positive integer — a measure-zero
			// degeneracy for continuously-fit parameters. Bail
			// out with the partial sum rather than dividing by
			// (near) zero.
			break
		}
		term *= (a + n) * (b + n) / denom * z
		sum += term
		if math.Abs(term) < tol*math.Abs(sum) {
			break
		}
	}
	return sum
}

// ConditionalExpectedTransactions returns E[Y(t) | r, alpha, a, b, x,
// tx, T] — the expected number of transactions a customer with RFM
// history (x, tx, T) will make in the next t time periods.
//
// This is the standard BG/NBD conditional expectation (Fader, Hardie &
// Lee 2005, eq. 10):
//
//	E[Y(t)|...] = [(a+b+x-1)/(a-1)] *
//	              [1 - ((alpha+T)/(alpha+T+t))^(r+x) * 2F1(r+x, b+x; a+b+x-1; t/(alpha+T+t))] *
//	              P(alive | x, tx, T)
//
// (the classic presentation divides by the denominator
// 1 + 1{x>0}(a/(b+x-1))((alpha+T)/(alpha+tx))^(r+x) instead of
// multiplying by P(alive); the two are algebraically identical since
// PAlive is exactly the reciprocal of that denominator — multiplying
// lets this function reuse PAlive's numerically-stable sigmoid form).
//
// a == 1 is a removable singularity of the closed form (the (a-1)
// denominator vanishes exactly where the bracketed term also vanishes).
// Continuously-fit parameters essentially never land exactly on it; as
// a defensive measure this function nudges a by a relative 1e-8 when it
// is within that tolerance of 1, which keeps the ratio finite and
// accurate to within the perturbation.
func ConditionalExpectedTransactions(p Params, t, x, tx, T float64) float64 {
	if t <= 0 {
		return 0
	}
	r, alpha, a, b := p.R, p.Alpha, p.A, p.B
	if math.Abs(a-1) < 1e-8 {
		a += 1e-8
	}

	z := t / (alpha + T + t)
	ratio := (alpha + T) / (alpha + T + t)
	h := hyp2f1(r+x, b+x, a+b+x-1, z)

	firstTerm := (a + b + x - 1) / (a - 1)
	secondTerm := 1 - math.Pow(ratio, r+x)*h

	return firstTerm * secondTerm * PAlive(p, x, tx, T)
}

// EstimatedCLV combines the conditional expected transaction count
// over horizonPeriods with an average per-transaction monetary value to
// produce a predicted CLV figure (e.g. horizonPeriods in weeks and
// avgMonetaryValue in cents-per-order yields clv_predicted_cents).
//
// This intentionally does not layer in a Gamma-Gamma monetary-value
// model (Fader & Hardie's usual BG/NBD companion for CLV) — callers
// pass in whatever average order value estimate they already trust
// (simple historical mean, trimmed mean, etc.), keeping this function a
// pure multiplier the caller controls.
func EstimatedCLV(p Params, s CustomerSummary, horizonPeriods, avgMonetaryValue float64) float64 {
	return ConditionalExpectedTransactions(p, horizonPeriods, s.X, s.Tx, s.T) * avgMonetaryValue
}
