// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	DefaultCampaignPollListLimit = 100
	MaxCampaignPollListLimit     = 100
	MaxCampaignPollCursorBytes   = 512

	campaignPollCursorPrefix = "pwcp1"
	campaignPollCursorDomain = "postwave.campaign-poll-list.cursor.v1"
	// A semantic document cannot approach this boundary under the campaign
	// write-body limit. It is an additional fail-closed guard for internal
	// send-time callers that intentionally walk every bounded page.
	maxCampaignPollDefinitions = 10_000
)

// CampaignPollListInput is one bounded page request. Limit zero selects the
// documented default. Cursor is copied exactly from the preceding response.
type CampaignPollListInput struct {
	Limit  int
	Cursor string
}

// CampaignPollListPage is a stable, campaign-scoped keyset page. A terminal
// response omits next_cursor instead of returning an ambiguous empty token.
type CampaignPollListPage struct {
	Items      []Definition `json:"items"`
	NextCursor string       `json:"next_cursor,omitempty"`
}

type campaignPollCursorClaims struct {
	Version        int    `json:"v"`
	CreatedAtMicro int64  `json:"ts"`
	ID             string `json:"id"`
}

type campaignPollCursorBoundary struct {
	CreatedAt time.Time
	ID        string
}

// ListForCampaignPage reads at most 100 immutable poll definitions plus one
// look-ahead key. Options are joined only for that bounded definition set.
func (r *Repo) ListForCampaignPage(
	ctx context.Context, tenantID, campaignID string, input CampaignPollListInput,
) (*CampaignPollListPage, error) {
	return r.listCampaignPollPage(ctx, tenantID, campaignID, "", input)
}

// ListForCampaign remains an internal compatibility helper. It walks bounded
// pages and has an absolute safety ceiling; the authenticated HTTP route uses
// ListForCampaignPage directly and can never issue an unbounded query.
func (r *Repo) ListForCampaign(
	ctx context.Context, tenantID, campaignID string,
) ([]Definition, error) {
	return r.listAllCampaignPollPages(ctx, tenantID, campaignID, "")
}

// ListForCampaignRevision is used by exact-revision send-time link projection.
// Its cursor is also revision-bound, so it cannot be replayed into another
// immutable campaign revision.
func (r *Repo) ListForCampaignRevision(
	ctx context.Context, tenantID, campaignID, contentRevisionID string,
) ([]Definition, error) {
	contentRevisionID, err := canonicalPollUUID(contentRevisionID, "content revision")
	if err != nil {
		return nil, err
	}
	return r.listAllCampaignPollPages(ctx, tenantID, campaignID, contentRevisionID)
}

func (r *Repo) listAllCampaignPollPages(
	ctx context.Context, tenantID, campaignID, contentRevisionID string,
) ([]Definition, error) {
	definitions := make([]Definition, 0)
	cursor := ""
	for {
		page, err := r.listCampaignPollPage(ctx, tenantID, campaignID, contentRevisionID,
			CampaignPollListInput{Limit: MaxCampaignPollListLimit, Cursor: cursor})
		if err != nil {
			return nil, err
		}
		definitions = append(definitions, page.Items...)
		if len(definitions) > maxCampaignPollDefinitions {
			return nil, fmt.Errorf("%w: campaign contains too many materialized polls", ErrConflict)
		}
		if page.NextCursor == "" {
			return definitions, nil
		}
		if page.NextCursor == cursor {
			return nil, fmt.Errorf("%w: campaign poll pagination did not advance", ErrConflict)
		}
		cursor = page.NextCursor
	}
}

func (r *Repo) listCampaignPollPage(
	ctx context.Context, tenantID, campaignID, contentRevisionID string,
	input CampaignPollListInput,
) (*CampaignPollListPage, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	tenantID, err := canonicalPollUUID(tenantID, "tenant")
	if err != nil {
		return nil, err
	}
	campaignID, err = canonicalPollUUID(campaignID, "campaign")
	if err != nil {
		return nil, err
	}
	if contentRevisionID != "" {
		contentRevisionID, err = canonicalPollUUID(contentRevisionID, "content revision")
		if err != nil {
			return nil, err
		}
	}
	limit := input.Limit
	if limit == 0 {
		limit = DefaultCampaignPollListLimit
	}
	if limit < 1 || limit > MaxCampaignPollListLimit {
		return nil, fmt.Errorf("%w: campaign poll list limit must be between 1 and %d",
			ErrInvalidInput, MaxCampaignPollListLimit)
	}

	var boundary *campaignPollCursorBoundary
	if input.Cursor != "" {
		boundary, err = r.decodeCampaignPollCursor(
			input.Cursor, tenantID, campaignID, contentRevisionID,
		)
		if err != nil {
			return nil, err
		}
	}

	args := []any{tenantID, campaignID}
	where := `
 WHERE p.tenant_id = $1::uuid
   AND p.campaign_id = $2::uuid
   AND p.content_revision_id IS NOT NULL`
	if contentRevisionID != "" {
		args = append(args, contentRevisionID)
		where += "\n   AND p.content_revision_id = $" + strconv.Itoa(len(args)) + "::uuid"
	}
	if boundary != nil {
		args = append(args, boundary.CreatedAt, boundary.ID)
		where += "\n   AND (p.created_at, p.id) > ($" + strconv.Itoa(len(args)-1) +
			"::timestamptz, $" + strconv.Itoa(len(args)) + "::uuid)"
	}
	args = append(args, limit+1)
	query := `
WITH selected AS MATERIALIZED (
    SELECT p.id, p.created_at
      FROM campaign_polls p` + where + `
     ORDER BY p.created_at, p.id
     LIMIT $` + strconv.Itoa(len(args)) + `
)
SELECT p.id::text, p.poll_key, p.content_revision_id::text,
       p.content_revision_source_hash, p.poll_contract_sha256,
       p.question, p.two_step_required, p.closes_at,
       p.created_at, o.option_key, o.label, o.position
  FROM selected s
  JOIN campaign_polls p
    ON p.id = s.id AND p.tenant_id = $1::uuid
  LEFT JOIN campaign_poll_options o
    ON o.tenant_id = p.tenant_id AND o.poll_id = p.id
 ORDER BY p.created_at, p.id, o.position, o.option_key`

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	definitions := make([]Definition, 0, limit+1)
	byID := make(map[string]int, limit+1)
	for rows.Next() {
		var definition Definition
		var optionKey, label *string
		var position *int
		if err := rows.Scan(&definition.ID, &definition.PollKey,
			&definition.ContentRevisionID, &definition.ContentRevisionSourceHash,
			&definition.PollContractSHA256, &definition.Question,
			&definition.TwoStepRequired, &definition.ClosesAt, &definition.CreatedAt,
			&optionKey, &label, &position); err != nil {
			return nil, err
		}
		index, ok := byID[definition.ID]
		if !ok {
			definition.CampaignID = campaignID
			definition.PollKey = semanticKey(campaignID, definition.PollKey)
			definition.CreatedAt = definition.CreatedAt.UTC()
			definition.Options = []DefinitionOption{}
			definitions = append(definitions, definition)
			index = len(definitions) - 1
			byID[definition.ID] = index
		}
		if optionKey != nil && label != nil && position != nil {
			definitions[index].Options = append(definitions[index].Options, DefinitionOption{
				OptionKey: *optionKey, Label: *label, Position: *position,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	page := &CampaignPollListPage{Items: definitions}
	if len(definitions) > limit {
		page.Items = definitions[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor, err = r.encodeCampaignPollCursor(
			tenantID, campaignID, contentRevisionID, last.CreatedAt, last.ID,
		)
		if err != nil {
			return nil, err
		}
	}
	return page, nil
}

func canonicalPollUUID(value, label string) (string, error) {
	value = strings.TrimSpace(value)
	parsed, err := uuid.Parse(value)
	if err != nil || parsed.String() != value {
		return "", fmt.Errorf("%w: %s must be a canonical UUID", ErrInvalidInput, label)
	}
	return value, nil
}

func (r *Repo) encodeCampaignPollCursor(
	tenantID, campaignID, contentRevisionID string, createdAt time.Time, id string,
) (string, error) {
	key, err := r.TokenKeyring.mintKey(r.now())
	if err != nil {
		return "", err
	}
	id, err = canonicalPollUUID(id, "campaign poll cursor id")
	if err != nil || createdAt.IsZero() {
		return "", fmt.Errorf("%w: invalid campaign poll cursor boundary", ErrInvalidInput)
	}
	claims := campaignPollCursorClaims{
		Version: 1, CreatedAtMicro: createdAt.UTC().UnixMicro(), ID: id,
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	encodedKeyID := base64.RawURLEncoding.EncodeToString([]byte(key.ID))
	signature := campaignPollCursorMAC(
		key.Secret, tenantID, campaignID, contentRevisionID, key.ID, encodedPayload,
	)
	cursor := campaignPollCursorPrefix + "." + encodedKeyID + "." + encodedPayload + "." +
		base64.RawURLEncoding.EncodeToString(signature)
	if len(cursor) > MaxCampaignPollCursorBytes {
		return "", fmt.Errorf("%w: campaign poll cursor exceeds %d bytes",
			ErrInvalidConfiguration, MaxCampaignPollCursorBytes)
	}
	return cursor, nil
}

func (r *Repo) decodeCampaignPollCursor(
	cursor, tenantID, campaignID, contentRevisionID string,
) (*campaignPollCursorBoundary, error) {
	invalid := func() (*campaignPollCursorBoundary, error) {
		return nil, fmt.Errorf("%w: invalid or stale campaign poll cursor", ErrInvalidInput)
	}
	if cursor == "" || len(cursor) > MaxCampaignPollCursorBytes || strings.TrimSpace(cursor) != cursor {
		return invalid()
	}
	parts := strings.Split(cursor, ".")
	if len(parts) != 4 || parts[0] != campaignPollCursorPrefix {
		return invalid()
	}
	keyIDBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || base64.RawURLEncoding.EncodeToString(keyIDBytes) != parts[1] {
		return invalid()
	}
	keyID := string(keyIDBytes)
	if !tokenKeyIDPattern.MatchString(keyID) {
		return invalid()
	}
	key, ok := r.TokenKeyring.keyByID(keyID)
	if !ok || !keyCanVerifyAt(key, r.now()) {
		return invalid()
	}
	wantSignature := campaignPollCursorMAC(
		key.Secret, tenantID, campaignID, contentRevisionID, keyID, parts[2],
	)
	gotSignature, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil || base64.RawURLEncoding.EncodeToString(gotSignature) != parts[3] ||
		len(gotSignature) != sha256.Size || !hmac.Equal(gotSignature, wantSignature) {
		return invalid()
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || base64.RawURLEncoding.EncodeToString(payload) != parts[2] {
		return invalid()
	}
	var claims campaignPollCursorClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return invalid()
	}
	canonical, err := json.Marshal(claims)
	if err != nil || !bytes.Equal(payload, canonical) || claims.Version != 1 ||
		claims.CreatedAtMicro <= 0 {
		return invalid()
	}
	id, err := canonicalPollUUID(claims.ID, "campaign poll cursor id")
	if err != nil {
		return invalid()
	}
	return &campaignPollCursorBoundary{
		CreatedAt: time.UnixMicro(claims.CreatedAtMicro).UTC(), ID: id,
	}, nil
}

func campaignPollCursorMAC(
	secret []byte, tenantID, campaignID, contentRevisionID, keyID, encodedPayload string,
) []byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(campaignPollCursorDomain))
	for _, field := range []string{tenantID, campaignID, contentRevisionID, keyID, encodedPayload} {
		_, _ = mac.Write([]byte{0})
		_, _ = mac.Write([]byte(field))
	}
	return mac.Sum(nil)
}
