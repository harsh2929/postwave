// SPDX-License-Identifier: AGPL-3.0-only

// Package polls records poll and RSVP responses that survive link prefetching.
//
// The whole difficulty of this feature is one sentence from the PRD: a security
// gateway that fetches every link will register a vote for EVERY option,
// silently corrupting the data. "Silently" is the operative word — the poll
// still returns a tally, the tally looks plausible, and somebody makes a
// decision from it. That is worse than the feature not existing.
//
// All three mitigations are implemented, because each catches what the others
// miss:
//
//	Two-step confirmation  eliminates prefetch entirely, at the cost of one
//	                       interaction. Only mitigation that PREVENTS rather
//	                       than detects. Reserved for high-stakes polls.
//	Classification gating  attributes a response to human or machine traffic
//	                       using F01. Catches an automated confirm that a
//	                       one-step poll would otherwise count.
//	Multi-option void      catches the scanner both others miss: a real person
//	                       picks one option, a fetcher picks all of them.
package polls

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Response states. Rows move between these and are never deleted: a deleted
// response cannot be re-counted when the classifier improves, and
// reclassification is a first-class operation here.
const (
	// StatePreviewed is retained only for quarantined v2 history. The v3 GET
	// path is side-effect-free and never creates this state.
	StatePreviewed = "previewed"
	// StateCounted is a confirmed, human-classified, uncontaminated response.
	StateCounted = "counted"
	// StateMachineExcluded is confirmed but classified as machine traffic.
	StateMachineExcluded = "machine_excluded"
	// StateUnclassifiedExcluded is confirmed but was not explicitly classified
	// as human. Unknown evidence is retained, but it must never inflate a tally.
	StateUnclassifiedExcluded = "unclassified_excluded"
	// StateVoidedMultiOption is one of several options the same recipient hit.
	StateVoidedMultiOption = "voided_multi_option"
	// StateSupersededChoice is an older deliberate response replaced outside
	// the scanner-contamination window. It is evidence but is no longer a vote.
	StateSupersededChoice = "superseded_choice"
)

// multiOptionWindow is how close two option hits must be to void each other.
//
// Generous on purpose. A scanner fetches every link in one pass, within
// milliseconds; a person who genuinely changes their mind does so minutes or
// hours later, and their second click UPDATES their single row rather than
// creating a second one. So this window only ever catches multiple DISTINCT
// options, and a wide window costs nothing while a narrow one misses a slow
// crawler.
const multiOptionWindow = 30 * time.Minute

// confirmationValidity bounds the one-time challenge created by a preview.
// The original emailed token alone cannot confirm a two-step poll.
const confirmationValidity = 15 * time.Minute

var (
	// ErrUnknownToken covers an absent, malformed or already-void token. One
	// error, because distinguishing them lets a caller probe which tokens exist.
	ErrUnknownToken = errors.New("polls: token not recognised")
	// ErrPollClosed is returned after closes_at.
	ErrPollClosed = errors.New("polls: this poll has closed")
	// ErrConfirmationRequired is returned when a two-step poll receives a
	// record attempt that did not come through the confirm step.
	ErrConfirmationRequired = errors.New("polls: this poll requires confirmation")
	// ErrInvalidConfiguration keeps an empty process secret from degenerating a
	// bearer token into a publicly forgeable hash.
	ErrInvalidConfiguration = errors.New("polls: invalid runtime configuration")
)

// MinTokenSecretBytes is the minimum key material accepted for poll HMACs.
const MinTokenSecretBytes = 32

// Repo is the poll store.
type Repo struct {
	Pool         *db.Pool
	TokenKeyring TokenKeyring
	Now          func() time.Time
}

// Validate checks the security boundary required by every public operation.
func (r *Repo) Validate() error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("%w: database pool is required", ErrInvalidConfiguration)
	}
	return r.validateTokenKeyring()
}

func (r *Repo) validateTokenKeyring() error {
	if r == nil {
		return fmt.Errorf("%w: poll token keyring is required", ErrInvalidConfiguration)
	}
	return r.TokenKeyring.Validate(r.now())
}

func (r *Repo) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// PreviewTarget is what a GET on a poll link resolves to.
type PreviewTarget struct {
	PollID            string
	PollKey           string
	Question          string
	OptionID          string
	OptionLabel       string
	ContentRevisionID string
	TwoStepRequired   bool
	// ConfirmationToken is a short-lived one-time credential emitted only by a
	// successful preview and required by a two-step POST.
	ConfirmationToken string
}

// Preview validates the capability and returns what to render.
//
// A GET has no durable side effect. The two-step credential is self-contained,
// randomly nonced, signed, short-lived, and consumed by the append-only POST
// receipt fence. A gateway can fetch every link without creating even a
// preview row.
func (r *Repo) Preview(ctx context.Context, tenantID, pollKey, optionKey, recipientID, token string) (*PreviewTarget, error) {
	claims, err := r.verifyLinkToken(strings.TrimSpace(token), LinkTokenInput{
		TenantID: tenantID, PollKey: pollKey, OptionKey: optionKey,
		RecipientReference: recipientID,
	})
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var target PreviewTarget
	var closesAt *time.Time
	if err := tx.QueryRow(ctx, `
	SELECT p.id::text, p.poll_key, p.question, p.content_revision_id::text,
	       p.two_step_required, p.closes_at, o.id::text, o.label
	  FROM campaign_polls p
  JOIN campaign_poll_options o
    ON o.poll_id = p.id AND o.tenant_id = p.tenant_id
	 WHERE p.tenant_id = $1::uuid AND p.poll_key = $2 AND o.option_key = $3
	   AND p.content_revision_id = $4::uuid
	   AND p.token_version = 3 AND p.accepting_responses`,
		tenantID, pollKey, optionKey, claims.ContentRevisionID).Scan(
		&target.PollID, &target.PollKey, &target.Question, &target.ContentRevisionID,
		&target.TwoStepRequired, &closesAt, &target.OptionID, &target.OptionLabel); err != nil {
		return nil, ErrUnknownToken
	}
	if closesAt != nil && r.now().After(*closesAt) {
		return nil, ErrPollClosed
	}
	if target.TwoStepRequired {
		target.ConfirmationToken, err = r.mintConfirmationToken(token, claims)
		if err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &target, nil
}

// ConfirmResult reports what a confirmation did.
type ConfirmResult struct {
	State         string `json:"state"`
	ReceiptID     string `json:"receipt_id"`
	Replayed      bool   `json:"replayed"`
	ChoiceChanged bool   `json:"choice_changed"`
	// VoidedOptions is how many of this recipient's option rows were voided by
	// the multi-option guard, including this one.
	VoidedOptions int
}

// Confirm records the response.
//
// Runs all three mitigations in the order that makes each meaningful:
//
//	the token proves the (recipient, option) pair,
//	the classification decides whether the response counts,
//	the multi-option guard decides whether ANY of this recipient's responses do.
//
// The guard runs last because it can overturn a response that passed the other
// two — a scanner that produces a human-looking confirm on every option is still
// a scanner, and the pattern across options is the only thing that reveals it.
func (r *Repo) Confirm(
	ctx context.Context,
	tenantID, pollKey, optionKey, recipientID, token string,
	confirmationToken string, decision ClassificationDecision,
) (*ConfirmResult, error) {
	token = strings.TrimSpace(token)
	claims, err := r.verifyLinkToken(token, LinkTokenInput{
		TenantID: tenantID, PollKey: pollKey, OptionKey: optionKey,
		RecipientReference: recipientID,
	})
	if err != nil {
		return nil, err
	}
	recipient := pollRecipientHash(claims.TenantID, claims.PollKey,
		claims.ContentRevisionID, strings.TrimSpace(recipientID))
	decision = normalizeClassificationDecision(decision)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var pollID, optionID, sourceHash, contractHash string
	var twoStepRequired bool
	var closesAt *time.Time
	if err := tx.QueryRow(ctx, `
	SELECT p.id::text, o.id::text, p.two_step_required, p.closes_at,
	       p.content_revision_source_hash, p.poll_contract_sha256
	  FROM campaign_polls p
  JOIN campaign_poll_options o
    ON o.poll_id = p.id AND o.tenant_id = p.tenant_id
	 WHERE p.tenant_id = $1::uuid AND p.poll_key = $2 AND o.option_key = $3
	   AND p.content_revision_id = $4::uuid
	   AND p.token_version = 3 AND p.accepting_responses`,
		tenantID, pollKey, optionKey, claims.ContentRevisionID).Scan(
		&pollID, &optionID, &twoStepRequired, &closesAt, &sourceHash, &contractHash); err != nil {
		return nil, ErrUnknownToken
	}
	if closesAt != nil && r.now().After(*closesAt) {
		return nil, ErrPollClosed
	}

	// Serialize every response for this tenant/poll/recipient before inspecting
	// preview state or other options. Otherwise two concurrent confirmations can
	// each observe only itself and both commit as counted.
	// PostgreSQL text values cannot contain NUL bytes. Keep the tuple
	// unambiguous with a domain-separated digest, and pass only its printable
	// hexadecimal form to hashtextextended. The previous NUL-delimited text was
	// valid in Go but made every real confirmation fail at the database boundary
	// with SQLSTATE 22021.
	lockDigest := sha256.Sum256([]byte(
		"postwave:poll-recipient-lock:v1\x00" + tenantID + "\x00" + pollID + "\x00" + recipient,
	))
	lockIdentity := hex.EncodeToString(lockDigest[:])
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockIdentity); err != nil {
		return nil, err
	}

	confirmationToken = strings.TrimSpace(confirmationToken)
	if twoStepRequired {
		if err := r.verifyConfirmationToken(confirmationToken, token, claims); err != nil {
			return nil, err
		}
	}

	// Mitigation 2: only an explicit human decision counts. The full bounded
	// classifier provenance is persisted in an append-only receipt below.
	state := StateUnclassifiedExcluded
	switch decision.Classification {
	case "human":
		state = StateCounted
	case "machine":
		state = StateMachineExcluded
	default:
		// Only an explicit human verdict may count. Missing, unknown, and invalid
		// classifier output is normalized to visible-but-excluded evidence.
		decision.Classification = "unknown"
	}

	submissionKey := tokenHash(token)
	confirmationHash := ""
	if twoStepRequired {
		confirmationHash = tokenHash(confirmationToken)
		submissionKey = confirmationHash
	}
	// The receipt uniqueness fence is checked under the same recipient lock as
	// projection updates. Replaying an identical POST returns the first result
	// and performs no second write.
	var replayReceiptID string
	if err := tx.QueryRow(ctx, `
	SELECT id::text
	  FROM campaign_poll_response_receipts
	 WHERE tenant_id = $1::uuid AND poll_id = $2::uuid
	   AND submission_key_sha256 = $3`, tenantID, pollID, submissionKey).Scan(&replayReceiptID); err == nil {
		var currentState string
		if err := tx.QueryRow(ctx, `
	SELECT state FROM campaign_poll_responses
	 WHERE tenant_id = $1::uuid AND poll_id = $2::uuid
	   AND option_id = $3::uuid AND recipient_hash = $4`,
			tenantID, pollID, optionID, recipient).Scan(&currentState); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &ConfirmResult{State: currentState, ReceiptID: replayReceiptID, Replayed: true}, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	rulesJSON, err := json.Marshal(decision.Rules)
	if err != nil {
		return nil, err
	}
	conflictsJSON, err := json.Marshal(decision.Conflicts)
	if err != nil {
		return nil, err
	}
	confirmedAt := r.now()
	var receiptID string
	if err := tx.QueryRow(ctx, `
	INSERT INTO campaign_poll_response_receipts (
	    tenant_id, poll_id, option_id, content_revision_id,
	    content_revision_source_hash, poll_contract_sha256, recipient_hash,
	    link_token_sha256, link_token_key_id, token_issued_at, token_expires_at,
	    confirmation_token_sha256, submission_key_sha256, initial_state,
	    classification, upstream_classification, machine_subtype, stable_reason,
	    calibration_band, classifier_version, methodology_version, registry_version,
	    configuration_hash, classifier_status, explicit_browser_decision,
	    evidence_sha256, rules, conflicts, shadow_mode, confirmed_at)
	VALUES (
	    $1::uuid, $2::uuid, $3::uuid, $4::uuid,
	    $5, $6, $7, $8, $9, $10, $11,
	    NULLIF($12, ''), $13, $14, $15, $16, NULLIF($17, ''), $18,
	    NULLIF($19, ''), NULLIF($20, ''), NULLIF($21, ''), NULLIF($22, ''),
	    NULLIF($23, ''), $24, $25, $26, $27::jsonb, $28::jsonb, $29, $30)
	RETURNING id::text`,
		tenantID, pollID, optionID, claims.ContentRevisionID,
		sourceHash, contractHash, recipient, tokenHash(token), claims.KeyID,
		time.Unix(claims.IssuedAt, 0).UTC(), time.Unix(claims.ExpiresAt, 0).UTC(),
		confirmationHash, submissionKey, state, decision.Classification,
		decision.UpstreamClassification, decision.MachineSubtype, decision.StableReason,
		decision.CalibrationBand, decision.ClassifierVersion, decision.MethodologyVersion,
		decision.RegistryVersion, decision.ConfigurationHash, decision.ClassifierStatus,
		decision.ExplicitBrowserDecision, decision.EvidenceSHA256,
		string(rulesJSON), string(conflictsJSON), decision.ShadowMode, confirmedAt,
	).Scan(&receiptID); err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `
	INSERT INTO campaign_poll_responses
	    (tenant_id, poll_id, option_id, content_revision_id, recipient_hash,
	     token_hash, token_key_id, token_issued_at, token_expires_at,
	     active_receipt_id, state, classification, previewed_at, confirmed_at)
	VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9,
	        $10::uuid, $11, $12, NULL, $13)
	ON CONFLICT (tenant_id, poll_id, recipient_hash, option_id) DO UPDATE
	   SET state          = $11,
	       token_hash     = EXCLUDED.token_hash,
	       token_key_id   = EXCLUDED.token_key_id,
	       token_issued_at = EXCLUDED.token_issued_at,
	       token_expires_at = EXCLUDED.token_expires_at,
	       content_revision_id = EXCLUDED.content_revision_id,
	       active_receipt_id = EXCLUDED.active_receipt_id,
	       classification = EXCLUDED.classification,
	       confirmed_at   = EXCLUDED.confirmed_at,
	       updated_at     = EXCLUDED.confirmed_at`,
		tenantID, pollID, optionID, claims.ContentRevisionID, recipient,
		tokenHash(token), claims.KeyID, time.Unix(claims.IssuedAt, 0).UTC(),
		time.Unix(claims.ExpiresAt, 0).UTC(), receiptID, state,
		decision.Classification, confirmedAt); err != nil {
		return nil, err
	}

	// Mitigation 3: multi-option void.
	//
	// Counts DISTINCT options this recipient has CONFIRMED inside the window. A
	// person who changes their mind updates one row and never trips this; a
	// fetcher that walked every link has confirmed several, and all of them are
	// voided rather than picking one to trust.
	var recentDifferentOptions int
	if err := tx.QueryRow(ctx, `
	SELECT count(DISTINCT option_id)
	  FROM campaign_poll_responses
	 WHERE tenant_id = $1::uuid AND poll_id = $2::uuid AND recipient_hash = $3
	   AND option_id <> $4::uuid
	   AND confirmed_at IS NOT NULL
	   AND confirmed_at >= $5`,
		tenantID, pollID, recipient, optionID, confirmedAt.Add(-multiOptionWindow),
	).Scan(&recentDifferentOptions); err != nil {
		return nil, err
	}

	result := &ConfirmResult{State: state, ReceiptID: receiptID}
	if recentDifferentOptions > 0 {
		tag, err := tx.Exec(ctx, `
	UPDATE campaign_poll_responses
	   SET state = $5, updated_at = $4::timestamptz
	 WHERE tenant_id = $1::uuid AND poll_id = $2::uuid AND recipient_hash = $3
	   AND confirmed_at IS NOT NULL
	   AND confirmed_at >= $4::timestamptz - $6::interval`,
			tenantID, pollID, recipient, confirmedAt, StateVoidedMultiOption,
			fmt.Sprintf("%d seconds", int(multiOptionWindow.Seconds())))
		if err != nil {
			return nil, err
		}
		result.State = StateVoidedMultiOption
		result.VoidedOptions = int(tag.RowsAffected())
	} else {
		tag, err := tx.Exec(ctx, `
	UPDATE campaign_poll_responses
	   SET state = $6, updated_at = $5
	 WHERE tenant_id = $1::uuid AND poll_id = $2::uuid AND recipient_hash = $3
	   AND option_id <> $4::uuid
	   AND state IN ('counted', 'machine_excluded', 'unclassified_excluded')`,
			tenantID, pollID, recipient, optionID, confirmedAt, StateSupersededChoice)
		if err != nil {
			return nil, err
		}
		result.ChoiceChanged = tag.RowsAffected() > 0
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

// Tally is a poll's result, with every excluded population visible.
type Tally struct {
	PollID            string        `json:"poll_id"`
	PollKey           string        `json:"poll_key"`
	ContentRevisionID string        `json:"content_revision_id"`
	Question          string        `json:"question"`
	Options           []OptionTally `json:"options"`

	// The three exclusions are reported, never folded into the totals. A poll
	// whose result rests on 40 counted responses out of 900 fetched links is a
	// different finding from one with 900 counted, and the tally is the only
	// place a reader can learn which they have.
	MachineExcluded      int `json:"machine_excluded"`
	UnclassifiedExcluded int `json:"unclassified_excluded"`
	VoidedMulti          int `json:"voided_multi_option"`
	SupersededChoices    int `json:"superseded_choices"`
	PreviewedOnly        int `json:"previewed_only"`
	SubmissionReceipts   int `json:"submission_receipts"`
}

// OptionTally is one option's counted votes.
type OptionTally struct {
	OptionKey string `json:"option_key"`
	Label     string `json:"label"`
	Counted   int    `json:"counted"`
}

// TallyFor returns the result with every exclusion stated.
func (r *Repo) TallyFor(ctx context.Context, tenantID, pollKey string) (*Tally, error) {
	return r.tallyFor(ctx, tenantID, "", "", pollKey)
}

// TallyForCampaign resolves the public/storage key from the campaign's
// semantic poll identity and proves the poll belongs to that campaign.
func (r *Repo) TallyForCampaign(ctx context.Context, tenantID, campaignID, pollKey string) (*Tally, error) {
	storageKey, err := campaignStorageKey(campaignID, pollKey)
	if err != nil {
		return nil, err
	}
	out, err := r.tallyFor(ctx, tenantID, campaignID, "", storageKey)
	if err != nil {
		return nil, err
	}
	out.PollKey = strings.TrimSpace(pollKey)
	return out, nil
}

// TallyForCampaignRevision is the unambiguous provenance-bearing report. The
// legacy campaign route may still select the newest materialized revision for
// compatibility, but all new clients should pass the revision explicitly.
func (r *Repo) TallyForCampaignRevision(
	ctx context.Context, tenantID, campaignID, contentRevisionID, pollKey string,
) (*Tally, error) {
	storageKey, err := campaignStorageKey(campaignID, pollKey)
	if err != nil {
		return nil, err
	}
	out, err := r.tallyFor(ctx, tenantID, campaignID, contentRevisionID, storageKey)
	if err != nil {
		return nil, err
	}
	out.PollKey = strings.TrimSpace(pollKey)
	return out, nil
}

func (r *Repo) tallyFor(ctx context.Context, tenantID, campaignID, contentRevisionID, pollKey string) (*Tally, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &Tally{PollKey: pollKey, Options: []OptionTally{}}
	if err := tx.QueryRow(ctx, `
	SELECT id::text, COALESCE(content_revision_id::text, ''), question FROM campaign_polls
		WHERE tenant_id = $1::uuid AND poll_key = $2
		  AND ($3 = '' OR campaign_id = NULLIF($3, '')::uuid)
		  AND ($4 = '' OR content_revision_id = NULLIF($4, '')::uuid)
		ORDER BY created_at DESC, id DESC
		LIMIT 1`, tenantID, pollKey, campaignID, contentRevisionID).
		Scan(&out.PollID, &out.ContentRevisionID, &out.Question); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	rows, err := tx.Query(ctx, `
SELECT o.option_key, o.label,
	       count(res.id) FILTER (
	           WHERE res.state = 'counted' AND res.classification = 'human'
	       )::int
  FROM campaign_poll_options o
  LEFT JOIN campaign_poll_responses res
    ON res.option_id = o.id AND res.tenant_id = o.tenant_id
 WHERE o.tenant_id = $1::uuid AND o.poll_id = $2::uuid
 GROUP BY o.option_key, o.label, o.position
 ORDER BY o.position, o.option_key`, tenantID, out.PollID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var option OptionTally
		if err := rows.Scan(&option.OptionKey, &option.Label, &option.Counted); err != nil {
			return nil, err
		}
		out.Options = append(out.Options, option)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if err := tx.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE state = 'machine_excluded')::int,
		       count(*) FILTER (WHERE state = 'unclassified_excluded')::int,
		       count(*) FILTER (WHERE state = 'voided_multi_option')::int,
	       count(*) FILTER (WHERE state = 'superseded_choice')::int,
	       count(*) FILTER (WHERE state = 'previewed')::int,
	       (SELECT count(*)::int FROM campaign_poll_response_receipts receipt
	         WHERE receipt.tenant_id = $1::uuid AND receipt.poll_id = $2::uuid)
	  FROM campaign_poll_responses
	 WHERE tenant_id = $1::uuid AND poll_id = $2::uuid`, tenantID, out.PollID).
		Scan(&out.MachineExcluded, &out.UnclassifiedExcluded,
			&out.VoidedMulti, &out.SupersededChoices, &out.PreviewedOnly,
			&out.SubmissionReceipts); err != nil {
		return nil, err
	}
	return out, nil
}
