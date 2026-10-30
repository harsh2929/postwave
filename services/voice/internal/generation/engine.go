package generation

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/services/voice/internal/profile"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

// FidelityBreakdown is the per-component diagnostics from the evaluator.
// Mirrors fidelity.FidelityBreakdown so the engine doesn't have to import
// the fidelity package in its public surface.
type FidelityBreakdown struct {
	EmbeddingSimilarity float64 `json:"embedding_similarity"`
	StylisticDistance   float64 `json:"stylistic_distance"`
	VocabularyOverlap   float64 `json:"vocabulary_overlap"`
	StructuralMatch     float64 `json:"structural_match"`
	Combined            float64 `json:"combined"`
}

// FidelityEvaluator scores how closely generated prose matches the writer's
// voice profile.
type FidelityEvaluator interface {
	Score(ctx context.Context, generated string, prof profile.VoiceProfile) (float64, FidelityBreakdown, error)
}

// TemplateLookup is the slice of TemplateStore the engine actually needs.
// Defined here so callers can pass templates.MemoryStore directly without
// the engine importing templates' Create/Update/Delete contract.
type TemplateLookup interface {
	Get(ctx context.Context, idOrSlug string) (templates.Template, error)
}

// Engine generates and regenerates sequences. Construct with NewEngine.
type Engine struct {
	LLM       profile.LLMClient
	Templates TemplateLookup
	Fidelity  FidelityEvaluator
}

// NewEngine constructs an Engine. All three dependencies are required;
// callers should pass MockLLMClient + a mock evaluator in tests.
func NewEngine(llm profile.LLMClient, tmpls TemplateLookup, fid FidelityEvaluator) *Engine {
	return &Engine{LLM: llm, Templates: tmpls, Fidelity: fid}
}

// Generate produces a full Sequence.
//
// Flow:
//
//  1. Look up the template by ID/slug.
//  2. Build the system + user prompts (sequence_system.md + profile + samples
//     + template + variables + style controls).
//  3. Call LLM.Generate(...) and parse {emails: [...]}.
//  4. Substitute {{variable}} placeholders that the LLM left intact.
//  5. Score each email via FidelityEvaluator. If score < 60, regenerate
//     that single email once with a stronger prompt; if still <60, set
//     LowFidelityFlag and ship as-is.
//  6. Return the Sequence.
func (e *Engine) Generate(ctx context.Context, req GenerateRequest) (Sequence, error) {
	if e.LLM == nil || e.Templates == nil || e.Fidelity == nil {
		return Sequence{}, fmt.Errorf("generation: engine not fully constructed")
	}
	tmpl, err := e.Templates.Get(ctx, req.TemplateID)
	if err != nil {
		return Sequence{}, fmt.Errorf("generation: load template: %w", err)
	}

	system := SequenceSystemPrompt()
	user, err := buildSequenceUserPrompt(req.Profile, tmpl, req.Variables, req.StyleControls)
	if err != nil {
		return Sequence{}, fmt.Errorf("generation: build prompt: %w", err)
	}

	raw, err := e.LLM.Generate(ctx, system, user, "")
	if err != nil {
		return Sequence{}, fmt.Errorf("generation: llm: %w", err)
	}

	emails, err := parseSequenceJSON(raw)
	if err != nil {
		return Sequence{}, fmt.Errorf("generation: parse: %w", err)
	}

	// Reconcile email count + delays from the template — the LLM should
	// have respected them, but we treat the template as authoritative.
	emails = reconcileWithTemplate(emails, tmpl)
	for i := range emails {
		emails[i].Subject = substituteVars(emails[i].Subject, req.Variables)
		emails[i].Body = substituteVars(emails[i].Body, req.Variables)
	}

	now := time.Now().UTC()
	seq := Sequence{
		ID:         uuid.NewString(),
		TenantID:   req.TenantID,
		TemplateID: tmpl.ID,
		Name:       req.Name,
		Status:     "draft",
		Emails:     emails,
		CreatedAt:  now,
		UpdatedAt:  now,
	}

	// Score + auto-retry low-fidelity emails.
	for i := range seq.Emails {
		score, breakdown, err := e.Fidelity.Score(ctx, seq.Emails[i].Body, req.Profile)
		if err != nil {
			// Soft-fail scoring; ship the email with score 0 and a flag.
			seq.Emails[i].VoiceFidelityScore = 0
			seq.LowFidelityFlag = true
			continue
		}
		seq.Emails[i].VoiceFidelityScore = score
		seq.Emails[i].FidelityBreakdown = &breakdown
		if score < MinFidelityFloor {
			retried, rerr := e.regenerateOne(ctx, req.Profile, seq, tmpl, seq.Emails[i].Position, req.Variables, req.StyleControls, "")
			if rerr == nil {
				rscore, rbreakdown, _ := e.Fidelity.Score(ctx, retried.Body, req.Profile)
				retried.VoiceFidelityScore = rscore
				retried.FidelityBreakdown = &rbreakdown
				retried.RegenerationCount = seq.Emails[i].RegenerationCount + 1
				if rscore >= seq.Emails[i].VoiceFidelityScore {
					seq.Emails[i] = retried
				}
			}
			if seq.Emails[i].VoiceFidelityScore < MinFidelityFloor {
				seq.LowFidelityFlag = true
			}
		}
	}

	return seq, nil
}

// Regenerate produces a candidate replacement for one email in an existing
// Sequence. It never mutates or persists the supplied sequence; callers must
// review the candidate and persist it through an explicit, concurrency-guarded
// update operation.
func (e *Engine) Regenerate(ctx context.Context, seq Sequence, req RegenerateRequest, prof profile.VoiceProfile) (GeneratedEmail, error) {
	if e.LLM == nil || e.Templates == nil || e.Fidelity == nil {
		return GeneratedEmail{}, fmt.Errorf("generation: engine not fully constructed")
	}
	tmpl, err := e.Templates.Get(ctx, seq.TemplateID)
	if err != nil {
		return GeneratedEmail{}, fmt.Errorf("generation: load template: %w", err)
	}
	// Variables: caller may override via req.Variables. When nil/empty,
	// regenerateOne falls back to whatever variables were embedded in
	// the existing email at that position (the historical V1 behaviour).
	em, err := e.regenerateOne(ctx, prof, seq, tmpl, req.EmailPosition, req.Variables, req.StyleControls, req.UserHint)
	if err != nil {
		return GeneratedEmail{}, err
	}
	score, breakdown, err := e.Fidelity.Score(ctx, em.Body, prof)
	if err == nil {
		em.VoiceFidelityScore = score
		em.FidelityBreakdown = &breakdown
	}
	// Bump RegenerationCount based on the existing email at that slot.
	for _, ex := range seq.Emails {
		if ex.Position == req.EmailPosition {
			em.RegenerationCount = ex.RegenerationCount + 1
			break
		}
	}
	return em, nil
}

// regenerateOne is the shared single-email rewrite path used by both
// auto-retry and explicit Regenerate calls.
func (e *Engine) regenerateOne(ctx context.Context, prof profile.VoiceProfile, seq Sequence, tmpl templates.Template, position int, vars map[string]string, controls StyleControls, hint string) (GeneratedEmail, error) {
	system := RegenerateSystemPrompt()
	user, err := buildRegenerateUserPrompt(prof, seq, tmpl, position, vars, controls, hint)
	if err != nil {
		return GeneratedEmail{}, err
	}
	raw, err := e.LLM.Generate(ctx, system, user, "")
	if err != nil {
		return GeneratedEmail{}, err
	}
	em, err := parseSingleEmailJSON(raw)
	if err != nil {
		return GeneratedEmail{}, err
	}
	if vars != nil {
		em.Subject = substituteVars(em.Subject, vars)
		em.Body = substituteVars(em.Body, vars)
	}
	em.Position = position
	for _, t := range tmpl.Emails {
		if t.Position == position {
			em.DelaySeconds = t.DelaySeconds
			break
		}
	}
	return em, nil
}

// --- helpers ---

func parseSequenceJSON(raw json.RawMessage) ([]GeneratedEmail, error) {
	var env struct {
		Emails []struct {
			Position     int    `json:"position"`
			DelaySeconds int    `json:"delay_seconds"`
			Subject      string `json:"subject"`
			Body         string `json:"body"`
		} `json:"emails"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("decode sequence: %w", err)
	}
	if len(env.Emails) == 0 {
		return nil, fmt.Errorf("decode sequence: no emails returned")
	}
	out := make([]GeneratedEmail, 0, len(env.Emails))
	for _, e := range env.Emails {
		out = append(out, GeneratedEmail{
			Position:     e.Position,
			DelaySeconds: e.DelaySeconds,
			Subject:      e.Subject,
			Body:         e.Body,
		})
	}
	return out, nil
}

func parseSingleEmailJSON(raw json.RawMessage) (GeneratedEmail, error) {
	type emailPayload struct {
		Position     int    `json:"position"`
		DelaySeconds int    `json:"delay_seconds"`
		Subject      string `json:"subject"`
		Body         string `json:"body"`
	}
	var env struct {
		Email  emailPayload   `json:"email"`
		Emails []emailPayload `json:"emails"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return GeneratedEmail{}, fmt.Errorf("decode email: %w", err)
	}
	email := env.Email
	if email.Subject == "" && email.Body == "" && len(env.Emails) > 0 {
		email = env.Emails[0]
	}
	if email.Subject == "" && email.Body == "" {
		return GeneratedEmail{}, fmt.Errorf("decode email: empty")
	}
	return GeneratedEmail{
		Position:     email.Position,
		DelaySeconds: email.DelaySeconds,
		Subject:      email.Subject,
		Body:         email.Body,
	}, nil
}

// reconcileWithTemplate enforces template length and authoritative delays
// even when the LLM returns slightly different metadata.
func reconcileWithTemplate(emails []GeneratedEmail, tmpl templates.Template) []GeneratedEmail {
	byPos := map[int]GeneratedEmail{}
	for _, e := range emails {
		byPos[e.Position] = e
	}
	out := make([]GeneratedEmail, 0, len(tmpl.Emails))
	for _, t := range tmpl.Emails {
		em, ok := byPos[t.Position]
		if !ok {
			// Missing email — emit an empty placeholder; the fidelity
			// scorer will flag it.
			out = append(out, GeneratedEmail{
				Position:     t.Position,
				DelaySeconds: t.DelaySeconds,
				Subject:      "",
				Body:         "",
			})
			continue
		}
		em.Position = t.Position
		em.DelaySeconds = t.DelaySeconds
		out = append(out, em)
	}
	return out
}

// substituteVars replaces any literal {{key}} tokens the LLM emitted with
// the writer's variable values. Missing variables are left as-is — the
// caller surfaces them as warnings via fidelity scoring + the
// LowFidelityFlag.
func substituteVars(s string, vars map[string]string) string {
	if len(vars) == 0 {
		return s
	}
	out := s
	for k, v := range vars {
		out = strings.ReplaceAll(out, "{{"+k+"}}", v)
		out = strings.ReplaceAll(out, "{{ "+k+" }}", v)
	}
	return out
}
