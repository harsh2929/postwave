// SPDX-License-Identifier: AGPL-3.0-only
//
// Package safety implements the pre-send safety eval. Three layered checks
// run in order:
//
//  1. Static rules (no LLM): banned-term scan, unsubscribe link presence,
//     List-Unsubscribe-Post header presence, body-to-image ratio guard,
//     non-tenant `mailto:` link guard.
//  2. AUP regex check: matches against the categories enumerated in
//     apps/web/src/app/(marketing)/legal/aup/page.tsx.
//  3. Optional Claude Haiku rubric (skippable via SAFETY_LLM_ENABLED=false).
//     Cached by content fingerprint for 24h.
//
// The package is safe for concurrent use.
package safety

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Verdict is the trinary outcome.
type Verdict string

const (
	VerdictPass Verdict = "pass"
	VerdictWarn Verdict = "warn"
	VerdictFail Verdict = "fail"
)

// DraftToCheck is the input to Check.
type DraftToCheck struct {
	Subject               string `json:"subject"`
	BodyHTML              string `json:"body_html"`
	BodyText              string `json:"body_text"`
	IntendedAudienceCount int    `json:"intended_audience_count"`
	// TenantDomain narrows the `mailto:` non-tenant guard. When empty, the
	// guard is skipped (we cannot tell which addresses are first-party).
	TenantDomain string `json:"tenant_domain,omitempty"`
	// HasListUnsubscribePost should be true when the sending pipeline will
	// attach a List-Unsubscribe-Post header. Static rules use this to avoid
	// flagging drafts that the pipeline guarantees to fix at send time.
	HasListUnsubscribePost bool `json:"has_list_unsubscribe_post,omitempty"`
}

// SafetyVerdict is the output of Check.
type SafetyVerdict struct {
	Verdict Verdict  `json:"verdict"`
	Reasons []string `json:"reasons"`
}

// LLMClient is the optional Claude wrapper. Implementations are responsible
// for invoking the rubric prompt and returning the raw model JSON.
type LLMClient interface {
	Check(ctx context.Context, system, user string) (string, error)
}

// Service is the package-facing struct. Construct with NewService.
type Service struct {
	LLM        LLMClient
	LLMEnabled bool
	cacheTTL   time.Duration
	cacheMu    sync.Mutex
	cache      map[string]cacheEntry
	now        func() time.Time
}

type cacheEntry struct {
	at time.Time
	v  SafetyVerdict
}

// NewService returns a configured Service. When llm is nil the LLM stage is
// skipped regardless of LLMEnabled.
func NewService(llm LLMClient) *Service {
	return &Service{
		LLM:        llm,
		LLMEnabled: os.Getenv("SAFETY_LLM_ENABLED") != "false",
		cacheTTL:   24 * time.Hour,
		cache:      map[string]cacheEntry{},
		now:        time.Now,
	}
}

//go:embed data/banned_terms.json
var bannedTermsBlob []byte

//go:embed prompts/rubric.md
var rubricPrompt string

// Rubric returns the LLM rubric prompt. Exposed for tests + diagnostics.
func Rubric() string { return rubricPrompt }

var (
	loadOnce    sync.Once
	bannedTerms []string

	unsubLinkRE = regexp.MustCompile(`(?i)(unsubscribe|opt[- ]?out|manage preferences)`)
	mailtoRE    = regexp.MustCompile(`(?i)mailto:([^"'>\s]+)`)
	imgTagRE    = regexp.MustCompile(`(?i)<img\b`)
	textTagRE   = regexp.MustCompile(`(?i)<(p|li|h[1-6]|blockquote)\b`)

	// AUP regexes — prohibited categories from
	// apps/web/src/app/(marketing)/legal/aup/page.tsx (§1.3 + §1.7).
	aupCategories = []struct {
		tag string
		re  *regexp.Regexp
	}{
		{"aup_gambling", regexp.MustCompile(`(?i)\b(casino|sportsbook|sports betting|poker( site)?|roulette|baccarat|online betting|wager(ing)? bonus)\b`)},
		{"aup_adult", regexp.MustCompile(`(?i)\b(porn(ography)?|escort service|cam( ?girl| ?model)|onlyfans payout|adult cams?)\b`)},
		{"aup_crypto_promo", regexp.MustCompile(`(?i)\b(ico|token launch|airdrop|presale (allocation|whitelist)|nft drop|memecoin|pump( and| &) dump|moonshot|10x gem)\b`)},
		{"aup_get_rich", regexp.MustCompile(`(?i)\b(get rich quick|guaranteed return|risk[- ]free profit|double your (money|investment)|matrix (cycler|program))\b`)},
		{"aup_mlm", regexp.MustCompile(`(?i)\b(mlm|multi[- ]level marketing|pyramid scheme|downline recruitment|matrix recruitment)\b`)},
	}
)

func loadStaticData() {
	loadOnce.Do(func() {
		var blob struct {
			Terms []string `json:"terms"`
		}
		if err := json.Unmarshal(bannedTermsBlob, &blob); err == nil {
			bannedTerms = blob.Terms
		}
	})
}

// Check runs the layered eval. Returns a non-nil verdict on success.
//
// LLM errors degrade gracefully: when the LLM stage fails, Check returns the
// strongest verdict produced by stages 1 + 2 plus a `_reasons` tag noting
// the LLM was unavailable. Callers see this as an `eval_partial` row in the
// audit log.
func (s *Service) Check(ctx context.Context, draft DraftToCheck) (*SafetyVerdict, error) {
	loadStaticData()

	fp := fingerprint(draft)
	if hit, ok := s.cacheGet(fp); ok {
		return &hit, nil
	}

	v := SafetyVerdict{Verdict: VerdictPass, Reasons: []string{}}
	v = mergeVerdict(v, runStaticRules(draft))
	v = mergeVerdict(v, runAUPRules(draft))

	if s.LLMEnabled && s.LLM != nil && v.Verdict != VerdictFail {
		llmVerdict, err := s.runLLM(ctx, draft)
		if err == nil {
			v = mergeVerdict(v, llmVerdict)
		} else {
			v.Reasons = append(v.Reasons, "llm_unavailable")
		}
	}

	s.cachePut(fp, v)
	return &v, nil
}

// --- stage 1: static rules ---

func runStaticRules(d DraftToCheck) SafetyVerdict {
	out := SafetyVerdict{Verdict: VerdictPass, Reasons: []string{}}
	body := d.BodyText
	if body == "" {
		body = stripHTML(d.BodyHTML)
	}
	combined := strings.ToLower(d.Subject + "\n" + body)

	for _, term := range bannedTerms {
		if term == "" {
			continue
		}
		if strings.Contains(combined, strings.ToLower(term)) {
			out = bumpFail(out, "banned_term_present")
			break
		}
	}

	if !unsubLinkRE.MatchString(d.BodyHTML) && !unsubLinkRE.MatchString(d.BodyText) {
		out = bumpWarn(out, "missing_unsubscribe_link")
	}
	if !d.HasListUnsubscribePost {
		out = bumpWarn(out, "missing_list_unsubscribe_post")
	}

	if r := imageToTextRatio(d.BodyHTML); r > 3.0 {
		out = bumpWarn(out, "image_heavy_body")
	}

	if d.TenantDomain != "" {
		for _, m := range mailtoRE.FindAllStringSubmatch(d.BodyHTML+"\n"+d.BodyText, -1) {
			addr := strings.ToLower(strings.TrimSpace(m[1]))
			// strip query string (mailto:foo@bar?subject=…)
			if q := strings.IndexByte(addr, '?'); q >= 0 {
				addr = addr[:q]
			}
			at := strings.LastIndexByte(addr, '@')
			if at < 0 {
				continue
			}
			host := addr[at+1:]
			td := strings.ToLower(d.TenantDomain)
			if host != td && !strings.HasSuffix(host, "."+td) {
				out = bumpWarn(out, "non_tenant_mailto_link")
				break
			}
		}
	}
	return out
}

func stripHTML(s string) string {
	// Cheap stripper: remove anything between < and >. Good enough for
	// ratio + length heuristics.
	var b strings.Builder
	in := false
	for _, r := range s {
		switch r {
		case '<':
			in = true
		case '>':
			in = false
		default:
			if !in {
				b.WriteRune(r)
			}
		}
	}
	return b.String()
}

func imageToTextRatio(html string) float64 {
	if html == "" {
		return 0
	}
	imgs := len(imgTagRE.FindAllString(html, -1))
	texts := len(textTagRE.FindAllString(html, -1))
	if texts == 0 && imgs == 0 {
		return 0
	}
	if texts == 0 {
		return float64(imgs)
	}
	return float64(imgs) / float64(texts)
}

// --- stage 2: AUP regex ---

func runAUPRules(d DraftToCheck) SafetyVerdict {
	out := SafetyVerdict{Verdict: VerdictPass, Reasons: []string{}}
	body := d.BodyText
	if body == "" {
		body = stripHTML(d.BodyHTML)
	}
	hay := d.Subject + "\n" + body
	for _, c := range aupCategories {
		if c.re.MatchString(hay) {
			out = bumpFail(out, c.tag)
		}
	}
	// URL-encoded payloads sometimes hide `mailto:` etc. — defensive decode.
	if dec, err := url.QueryUnescape(hay); err == nil && dec != hay {
		for _, c := range aupCategories {
			if c.re.MatchString(dec) && !contains(out.Reasons, c.tag) {
				out = bumpFail(out, c.tag)
			}
		}
	}
	return out
}

// --- stage 3: LLM rubric ---

func (s *Service) runLLM(ctx context.Context, d DraftToCheck) (SafetyVerdict, error) {
	user, err := json.Marshal(d)
	if err != nil {
		return SafetyVerdict{}, err
	}
	raw, err := s.LLM.Check(ctx, rubricPrompt, string(user))
	if err != nil {
		return SafetyVerdict{}, err
	}
	var v SafetyVerdict
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return SafetyVerdict{}, fmt.Errorf("safety: parse llm json: %w", err)
	}
	if v.Verdict == "" {
		v.Verdict = VerdictPass
	}
	if v.Reasons == nil {
		v.Reasons = []string{}
	}
	return v, nil
}

// --- helpers ---

func mergeVerdict(a, b SafetyVerdict) SafetyVerdict {
	out := SafetyVerdict{Verdict: stronger(a.Verdict, b.Verdict)}
	out.Reasons = append(out.Reasons, a.Reasons...)
	for _, r := range b.Reasons {
		if !contains(out.Reasons, r) {
			out.Reasons = append(out.Reasons, r)
		}
	}
	return out
}

func stronger(a, b Verdict) Verdict {
	rank := map[Verdict]int{VerdictPass: 0, VerdictWarn: 1, VerdictFail: 2}
	if rank[a] >= rank[b] {
		return a
	}
	return b
}

func bumpFail(v SafetyVerdict, reason string) SafetyVerdict {
	if !contains(v.Reasons, reason) {
		v.Reasons = append(v.Reasons, reason)
	}
	v.Verdict = stronger(v.Verdict, VerdictFail)
	return v
}

func bumpWarn(v SafetyVerdict, reason string) SafetyVerdict {
	if !contains(v.Reasons, reason) {
		v.Reasons = append(v.Reasons, reason)
	}
	v.Verdict = stronger(v.Verdict, VerdictWarn)
	return v
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func fingerprint(d DraftToCheck) string {
	h := sha256.New()
	_, _ = h.Write([]byte(d.Subject))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(d.BodyHTML))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(d.BodyText))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(d.TenantDomain))
	return hex.EncodeToString(h.Sum(nil))
}

func (s *Service) cacheGet(fp string) (SafetyVerdict, bool) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	if e, ok := s.cache[fp]; ok && s.now().Sub(e.at) < s.cacheTTL {
		return e.v, true
	}
	return SafetyVerdict{}, false
}

func (s *Service) cachePut(fp string, v SafetyVerdict) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	if len(s.cache) > 4096 {
		s.cache = map[string]cacheEntry{}
	}
	s.cache[fp] = cacheEntry{at: s.now(), v: v}
}
