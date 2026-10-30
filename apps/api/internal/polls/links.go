// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

var opaqueRecipientReference = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// LinkMinter bridges immutable semantic poll identity to recipient-specific
// preview links. RecipientReference must be an opaque delivery-row identity,
// never an email address; only its tenant-bound hash reaches response storage.
type LinkMinter struct {
	Repo          *Repo
	PublicBaseURL string
}

func (m *LinkMinter) Validate() error {
	if m == nil || m.Repo == nil {
		return fmt.Errorf("%w: poll link minter requires repository", ErrInvalidConfiguration)
	}
	if err := m.Repo.Validate(); err != nil {
		return err
	}
	parsed, err := url.Parse(strings.TrimSpace(m.PublicBaseURL))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("%w: poll public base URL must be an absolute HTTPS URL without credentials, query, or fragment", ErrInvalidConfiguration)
	}
	return nil
}

func (m *LinkMinter) MintLinks(
	ctx context.Context,
	tenantID, campaignID, contentRevisionID, recipientReference string, issuedAt time.Time,
	document semanticemail.DocumentV2,
) (semanticemail.PollOptionLinks, error) {
	if err := m.Validate(); err != nil {
		return nil, err
	}
	recipientReference = strings.TrimSpace(recipientReference)
	if !opaqueRecipientReference.MatchString(recipientReference) {
		return nil, fmt.Errorf("%w: recipient reference must be opaque and must not be an email address", ErrInvalidInput)
	}
	parsedRevision, err := uuid.Parse(strings.TrimSpace(contentRevisionID))
	if err != nil || parsedRevision.String() != strings.TrimSpace(contentRevisionID) {
		return nil, fmt.Errorf("%w: content revision must be a canonical UUID", ErrInvalidInput)
	}
	if err := m.Repo.VerifyRevisionDocument(ctx, tenantID, campaignID, contentRevisionID, document); err != nil {
		return nil, err
	}
	issuedAt = issuedAt.UTC().Truncate(time.Second)
	if issuedAt.IsZero() || issuedAt.After(m.Repo.now().Add(maximumTokenClockSkew)) {
		return nil, fmt.Errorf("%w: poll token issued_at is invalid", ErrInvalidInput)
	}
	definitions, err := m.Repo.ListForCampaignRevision(ctx, tenantID, campaignID, contentRevisionID)
	if err != nil {
		return nil, err
	}
	byKey := make(map[string]Definition, len(definitions))
	for _, definition := range definitions {
		byKey[definition.PollKey] = definition
	}
	links := make(semanticemail.PollOptionLinks)
	for _, node := range document.Nodes {
		if node.Type != semanticemail.NodePoll || node.Content.Poll == nil {
			continue
		}
		poll := node.Content.Poll
		definition, ok := byKey[poll.PollID]
		if !ok {
			return nil, fmt.Errorf("%w: semantic poll %q has not been materialized", ErrNotFound, poll.PollID)
		}
		question, options, err := materializedContent(poll)
		if err != nil {
			return nil, err
		}
		if question != definition.Question || !sameDefinitionOptions(options, definition.Options) {
			return nil, fmt.Errorf("%w: semantic poll %q differs from its materialized response contract", ErrConflict, poll.PollID)
		}
		storageKey, err := campaignStorageKey(campaignID, poll.PollID)
		if err != nil {
			return nil, err
		}
		optionLinks := make(map[string]string, len(options))
		expiresAt := issuedAt.Add(m.Repo.TokenKeyring.TokenTTL)
		if definition.ClosesAt != nil && definition.ClosesAt.Before(expiresAt) {
			expiresAt = definition.ClosesAt.UTC().Truncate(time.Second)
		}
		if !expiresAt.After(issuedAt) {
			return nil, ErrPollClosed
		}
		for _, option := range options {
			token, err := m.Repo.MintToken(LinkTokenInput{
				TenantID: tenantID, PollKey: storageKey, OptionKey: option.OptionKey,
				RecipientReference: recipientReference, ContentRevisionID: contentRevisionID,
				IssuedAt: issuedAt, ExpiresAt: expiresAt,
			})
			if err != nil {
				return nil, err
			}
			optionURL, err := m.optionURL(tenantID, storageKey, option.OptionKey, recipientReference, token)
			if err != nil {
				return nil, err
			}
			optionLinks[option.OptionKey] = optionURL
		}
		links[poll.PollID] = optionLinks
	}
	return links, nil
}

func sameDefinitionOptions(left, right []DefinitionOption) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func (m *LinkMinter) optionURL(tenantID, pollKey, optionKey, recipientReference, token string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(m.PublicBaseURL))
	if err != nil {
		return "", err
	}
	target := base.JoinPath("api", "public", "polls", tenantID, pollKey, optionKey)
	query := target.Query()
	query.Set("r", recipientReference)
	query.Set("t", token)
	target.RawQuery = query.Encode()
	return target.String(), nil
}
