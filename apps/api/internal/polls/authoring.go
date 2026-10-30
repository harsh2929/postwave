// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

var (
	ErrNotFound     = errors.New("polls: not found")
	ErrConflict     = errors.New("polls: conflict")
	ErrInvalidInput = errors.New("polls: invalid input")
)

// CreateInput contains only poll runtime settings. Question and option truth
// are selected by PollKey from the campaign's canonical semantic v2 tree; the
// API deliberately has no duplicate question/options input.
type CreateInput struct {
	ContentRevisionID string     `json:"content_revision_id"`
	PollKey           string     `json:"poll_key"`
	TwoStepRequired   *bool      `json:"two_step_required,omitempty"`
	ClosesAt          *time.Time `json:"closes_at,omitempty"`
}

type Definition struct {
	ID                        string             `json:"id"`
	CampaignID                string             `json:"campaign_id"`
	ContentRevisionID         string             `json:"content_revision_id"`
	ContentRevisionSourceHash string             `json:"content_revision_source_hash"`
	PollContractSHA256        string             `json:"poll_contract_sha256"`
	PollKey                   string             `json:"poll_key"`
	Question                  string             `json:"question"`
	TwoStepRequired           bool               `json:"two_step_required"`
	ClosesAt                  *time.Time         `json:"closes_at,omitempty"`
	Options                   []DefinitionOption `json:"options"`
	CreatedAt                 time.Time          `json:"created_at"`
}

type DefinitionOption struct {
	OptionKey string `json:"option_key"`
	Label     string `json:"label"`
	Position  int    `json:"position"`
}

// campaignStorageKey namespaces semantic poll identity by campaign without a
// second content model or a schema change. campaign_polls.poll_key is
// tenant-unique in migration 1945; semantic PollID is only document-unique.
func campaignStorageKey(campaignID, pollKey string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(campaignID))
	if err != nil || parsed.String() != strings.TrimSpace(campaignID) {
		return "", fmt.Errorf("%w: campaign_id must be a canonical UUID", ErrInvalidInput)
	}
	pollKey = strings.TrimSpace(pollKey)
	if pollKey == "" {
		return "", fmt.Errorf("%w: poll_key is required", ErrInvalidInput)
	}
	return parsed.String() + ":" + pollKey, nil
}

func semanticKey(campaignID, storageKey string) string {
	return strings.TrimPrefix(storageKey, strings.TrimSpace(campaignID)+":")
}

// CreateFromCampaign materializes one semantic poll node into the existing
// response store. The transaction reads the canonical campaign tree and never
// accepts caller-authored copies of the question or options.
func (r *Repo) CreateFromCampaign(ctx context.Context, tenantID, campaignID string, input CreateInput) (*Definition, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	storageKey, err := campaignStorageKey(campaignID, input.PollKey)
	if err != nil {
		return nil, err
	}
	if input.ClosesAt != nil && !input.ClosesAt.After(r.now()) {
		return nil, fmt.Errorf("%w: closes_at must be in the future", ErrInvalidInput)
	}
	parsedRevision, err := uuid.Parse(strings.TrimSpace(input.ContentRevisionID))
	if err != nil || parsedRevision.String() != strings.TrimSpace(input.ContentRevisionID) {
		return nil, fmt.Errorf("%w: content_revision_id must be a canonical UUID", ErrInvalidInput)
	}
	twoStep := true
	if input.TwoStepRequired != nil {
		twoStep = *input.TwoStepRequired
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var sourceMode, sourceHash string
	var schemaVersion int
	var rawTree json.RawMessage
	if err := tx.QueryRow(ctx, `
SELECT source_mode, content_schema_version, semantic_tree, source_hash
  FROM campaign_content_revisions
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND id = $3::uuid`,
		tenantID, campaignID, input.ContentRevisionID).
		Scan(&sourceMode, &schemaVersion, &rawTree, &sourceHash); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if sourceMode != campaignartifact.SourceModeSemantic || schemaVersion != semanticemail.SchemaVersionV2 {
		return nil, fmt.Errorf("%w: campaign must use semantic content schema v2", ErrInvalidInput)
	}
	normalizedTree, _, err := campaignartifact.NormalizeSemanticTreeV2(rawTree, schemaVersion)
	if err != nil {
		return nil, fmt.Errorf("%w: campaign semantic tree is invalid: %v", ErrInvalidInput, err)
	}
	node, err := findPollNode(normalizedTree, strings.TrimSpace(input.PollKey))
	if err != nil {
		return nil, err
	}
	question, options, err := materializedContent(node.Content.Poll)
	if err != nil {
		return nil, err
	}
	contractHash, err := pollContractHash(question, options)
	if err != nil {
		return nil, err
	}

	definition := &Definition{
		CampaignID: campaignID, PollKey: strings.TrimSpace(input.PollKey), Question: question,
		ContentRevisionID:         input.ContentRevisionID,
		ContentRevisionSourceHash: sourceHash, PollContractSHA256: contractHash,
		TwoStepRequired: twoStep, ClosesAt: input.ClosesAt, Options: options,
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO campaign_polls
	    (tenant_id, campaign_id, content_revision_id,
	     content_revision_source_hash, poll_contract_sha256,
	     poll_key, question, two_step_required, closes_at,
	     token_version, accepting_responses)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, 3, true)
RETURNING id::text, created_at`,
		tenantID, campaignID, input.ContentRevisionID, sourceHash, contractHash,
		storageKey, question, twoStep, input.ClosesAt).
		Scan(&definition.ID, &definition.CreatedAt); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrConflict
		}
		return nil, err
	}
	for _, option := range options {
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_poll_options
    (tenant_id, poll_id, option_key, label, position)
VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
			tenantID, definition.ID, option.OptionKey, option.Label, option.Position); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return definition, nil
}

func findPollNode(raw json.RawMessage, pollKey string) (semanticemail.Node, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var nodes []semanticemail.Node
	if err := decoder.Decode(&nodes); err != nil {
		return semanticemail.Node{}, fmt.Errorf("%w: decode semantic poll: %v", ErrInvalidInput, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return semanticemail.Node{}, fmt.Errorf("%w: trailing semantic poll data", ErrInvalidInput)
	}
	found := semanticemail.Node{}
	for _, node := range nodes {
		if node.Type != semanticemail.NodePoll || node.Content.Poll == nil || node.Content.Poll.PollID != pollKey {
			continue
		}
		if found.Content.Poll != nil {
			return semanticemail.Node{}, fmt.Errorf("%w: poll_key is duplicated in the semantic tree", ErrInvalidInput)
		}
		found = node
	}
	if found.Content.Poll == nil {
		return semanticemail.Node{}, ErrNotFound
	}
	return found, nil
}

func materializedContent(poll *semanticemail.PollContent) (string, []DefinitionOption, error) {
	if poll == nil {
		return "", nil, fmt.Errorf("%w: semantic poll content is required", ErrInvalidInput)
	}
	question, err := fixedRichText(poll.Question)
	if err != nil {
		return "", nil, fmt.Errorf("%w: poll question: %v", ErrInvalidInput, err)
	}
	options := make([]DefinitionOption, 0, len(poll.Options))
	for position, source := range poll.Options {
		label, err := fixedRichText(source.Label)
		if err != nil {
			return "", nil, fmt.Errorf("%w: poll option %q: %v", ErrInvalidInput, source.OptionID, err)
		}
		options = append(options, DefinitionOption{
			OptionKey: source.OptionID, Label: label, Position: position,
		})
	}
	return question, options, nil
}

func pollContractHash(question string, options []DefinitionOption) (string, error) {
	payload := struct {
		Version  int                `json:"version"`
		Question string             `json:"question"`
		Options  []DefinitionOption `json:"options"`
	}{Version: 1, Question: question, Options: options}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func fixedRichText(rich semanticemail.RichText) (string, error) {
	var out strings.Builder
	for _, run := range rich.Runs {
		switch run.Kind {
		case semanticemail.InlineText, semanticemail.InlineStrong,
			semanticemail.InlineEmphasis, semanticemail.InlineLink:
			out.WriteString(run.Text)
			out.WriteByte(' ')
		case semanticemail.InlineLineBreak:
			out.WriteByte(' ')
		case semanticemail.InlineSlot:
			return "", errors.New("personalized question/option text cannot be response-store identity")
		default:
			return "", fmt.Errorf("unsupported inline kind %q", run.Kind)
		}
	}
	value := strings.Join(strings.Fields(out.String()), " ")
	if value == "" {
		return "", errors.New("text is empty")
	}
	return value, nil
}

// VerifyRevisionDocument binds send-time link projection to the exact immutable
// semantic revision selected by the queue receipt. It prevents a caller from
// pairing a valid campaign poll with a different in-memory document.
func (r *Repo) VerifyRevisionDocument(
	ctx context.Context, tenantID, campaignID, contentRevisionID string,
	document semanticemail.DocumentV2,
) error {
	if err := r.Validate(); err != nil {
		return err
	}
	if _, err := campaignStorageKey(campaignID, "probe"); err != nil {
		return err
	}
	parsedRevision, err := uuid.Parse(strings.TrimSpace(contentRevisionID))
	if err != nil || parsedRevision.String() != strings.TrimSpace(contentRevisionID) {
		return fmt.Errorf("%w: content revision must be a canonical UUID", ErrInvalidInput)
	}
	encoded, err := json.Marshal(document.Nodes)
	if err != nil {
		return fmt.Errorf("%w: encode semantic poll document: %v", ErrInvalidInput, err)
	}
	want, _, err := campaignartifact.NormalizeSemanticTreeV2(encoded, semanticemail.SchemaVersionV2)
	if err != nil {
		return fmt.Errorf("%w: semantic poll document is invalid: %v", ErrInvalidInput, err)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var sourceMode string
	var schemaVersion int
	var raw json.RawMessage
	if err := tx.QueryRow(ctx, `
SELECT source_mode, content_schema_version, semantic_tree
  FROM campaign_content_revisions
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND id = $3::uuid`,
		tenantID, campaignID, contentRevisionID).Scan(&sourceMode, &schemaVersion, &raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if sourceMode != campaignartifact.SourceModeSemantic || schemaVersion != semanticemail.SchemaVersionV2 {
		return fmt.Errorf("%w: content revision is not semantic v2", ErrInvalidInput)
	}
	got, _, err := campaignartifact.NormalizeSemanticTreeV2(raw, schemaVersion)
	if err != nil {
		return fmt.Errorf("%w: stored semantic revision is invalid: %v", ErrInvalidInput, err)
	}
	if !bytes.Equal(got, want) {
		return fmt.Errorf("%w: poll projection document differs from immutable content revision", ErrConflict)
	}
	return tx.Commit(ctx)
}
