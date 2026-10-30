// Package predictive holds first-party similarity scoring for SUB-033
// lookalike audiences. It ranks candidate subscribers by how closely they
// resemble a SEED segment's members on first-party dimensions ONLY — email
// domain, signup source, engagement tier, and churn tier. No third-party
// cookies, data brokers, or external graph data are consulted; this mirrors
// the privacy-preserving lookalike pattern Klaviyo / Mailchimp ship.
//
// The model is a centroid-cosine: the seed members are summarised into a
// normalised feature centroid (the average feature vector), then each
// candidate's feature vector is scored by cosine similarity to that centroid.
// Cosine keeps the score in [0,1] (all features are non-negative) and is
// scale-stable, so a seed of 50 or 50,000 members yields comparable scores.
package predictive

import (
	"math"
	"sort"
	"strings"
)

// Profile is the minimal first-party feature source for one subscriber. The
// audiences package fills these from the subscribers row (email →
// EmailDomain, signup_source, engagement_score, churn_score). All fields are
// optional; an empty/zero value contributes a neutral feature.
type Profile struct {
	SubscriberID string
	Email        string
	EmailDomain  string
	SignupSource string
	// EngagementScore is the cached subscribers.engagement_score (0..100).
	EngagementScore float64
	// ChurnScore is the cached subscribers.churn_score (0..100). Higher = more
	// likely to churn, so it is inverted into a "retention" feature.
	ChurnScore float64
}

// FeatureVector is the dense, normalised representation a Profile is scored in.
// Keys are stable feature names so the explainability payload can name the
// contributing dimensions.
type FeatureVector map[string]float64

// Scored is one candidate with its similarity to the seed centroid and the
// feature snapshot that produced it.
type Scored struct {
	Profile    Profile
	Similarity float64
	Features   FeatureVector
}

// DomainOf extracts the lowercased domain from an email address. Returns ""
// when the address has no '@' or no domain part.
func DomainOf(email string) string {
	at := strings.LastIndex(email, "@")
	if at < 0 || at == len(email)-1 {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(email[at+1:]))
}

// vectorize turns a Profile into its normalised feature vector. The two
// categorical dimensions (domain, signup source) are emitted as one-hot
// features keyed by their value; the two numeric dimensions are scaled to
// [0,1]. domains/sources are passed in so categorical features share the same
// key space across the whole population (a candidate's domain only matters if
// it appears in the seed).
func vectorize(p Profile, seedDomains, seedSources map[string]bool) FeatureVector {
	v := FeatureVector{}
	dom := p.EmailDomain
	if dom == "" {
		dom = DomainOf(p.Email)
	}
	if dom != "" && seedDomains[dom] {
		v["domain:"+dom] = 1
	}
	if src := strings.ToLower(strings.TrimSpace(p.SignupSource)); src != "" && seedSources[src] {
		v["source:"+src] = 1
	}
	// Numeric features scaled into [0,1]. engagement is used directly;
	// churn is inverted into a retention signal so "low churn" pulls toward
	// a high-retention seed.
	v["engagement"] = clamp01(p.EngagementScore / 100.0)
	v["retention"] = clamp01(1.0 - (p.ChurnScore / 100.0))
	return v
}

// Centroid summarises the seed members into the average feature vector. The
// returned vector is NOT re-normalised to unit length here — cosine handles
// magnitude. Also returns the categorical key spaces the candidates must be
// vectorised against so a candidate is only credited for a domain/source the
// seed actually exhibits.
func Centroid(seed []Profile) (FeatureVector, map[string]bool, map[string]bool) {
	domains := map[string]bool{}
	sources := map[string]bool{}
	for _, p := range seed {
		dom := p.EmailDomain
		if dom == "" {
			dom = DomainOf(p.Email)
		}
		if dom != "" {
			domains[dom] = true
		}
		if src := strings.ToLower(strings.TrimSpace(p.SignupSource)); src != "" {
			sources[src] = true
		}
	}
	c := FeatureVector{}
	if len(seed) == 0 {
		return c, domains, sources
	}
	for _, p := range seed {
		for k, val := range vectorize(p, domains, sources) {
			c[k] += val
		}
	}
	inv := 1.0 / float64(len(seed))
	for k := range c {
		c[k] *= inv
	}
	return c, domains, sources
}

// Cosine returns the cosine similarity of two non-negative feature vectors in
// [0,1]. A zero-magnitude vector on either side yields 0 (no signal).
func Cosine(a, b FeatureVector) float64 {
	var dot, na, nb float64
	for k, av := range a {
		na += av * av
		if bv, ok := b[k]; ok {
			dot += av * bv
		}
	}
	for _, bv := range b {
		nb += bv * bv
	}
	if na == 0 || nb == 0 {
		return 0
	}
	sim := dot / (math.Sqrt(na) * math.Sqrt(nb))
	return clamp01(sim)
}

// Rank scores every candidate against the seed centroid and returns them
// sorted by descending similarity (ties broken by subscriber id for a stable
// order). Candidates whose similarity is below threshold are dropped; pass a
// threshold <= 0 to keep all. When limit > 0 the result is truncated to the
// top `limit`. Candidates that appear in the seed set (by subscriber id) are
// excluded — a lookalike is by definition a NON-seed member.
func Rank(seed, candidates []Profile, threshold float64, limit int) []Scored {
	// An empty seed has no centroid to match against — return no lookalikes
	// rather than a pool of meaningless similarity-0 rows.
	if len(seed) == 0 {
		return nil
	}
	centroid, domains, sources := Centroid(seed)
	seedIDs := make(map[string]bool, len(seed))
	for _, s := range seed {
		seedIDs[s.SubscriberID] = true
	}
	out := make([]Scored, 0, len(candidates))
	for _, cand := range candidates {
		if seedIDs[cand.SubscriberID] {
			continue
		}
		fv := vectorize(cand, domains, sources)
		sim := Cosine(centroid, fv)
		if sim < threshold {
			continue
		}
		out = append(out, Scored{Profile: cand, Similarity: sim, Features: fv})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Similarity != out[j].Similarity {
			return out[i].Similarity > out[j].Similarity
		}
		return out[i].Profile.SubscriberID < out[j].Profile.SubscriberID
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}
