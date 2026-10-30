// SPDX-License-Identifier: AGPL-3.0-only
//
// Package preferences owns the preference-center / topics surface: per-tenant
// admin CRUD + per-subscriber opt-in state + a token-gated public hosted
// preference page. Lives in apps/api (gateway). The hosted page surface
// runs OUTSIDE tenant middleware (token IS the credential) and relies on
// permissive RLS policies in 0016_topics.sql.
package preferences

import (
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	publicPreferenceMaxTopics = 1000
	topicSlugMaxBytes         = 64
	topicNameMaxRunes         = 256
	topicNameMaxBytes         = 1024
	topicDescriptionMaxRunes  = 2048
	topicDescriptionMaxBytes  = 8192
	topicDisplayOrderMin      = -1_000_000
	topicDisplayOrderMax      = 1_000_000
)

var (
	topicSlugRE           = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	ErrInvalidTopicSlug   = errors.New("topic slug must be 1-64 bytes of lowercase kebab-case")
	ErrInvalidTopicName   = errors.New("topic name must be 1-256 characters without control text")
	ErrInvalidTopicDesc   = errors.New("topic description must be at most 2,048 characters without control text")
	ErrInvalidTopicOrder  = errors.New("topic display order is outside the supported range")
	ErrInvalidTopicChoice = errors.New("topic selection is invalid")
)

// Topic mirrors the topics table — each tenant maintains its own catalog.
type Topic struct {
	ID           string    `json:"id"`
	TenantID     string    `json:"tenantId"`
	Slug         string    `json:"slug"`
	Name         string    `json:"name"`
	Description  string    `json:"description,omitempty"`
	DefaultOptIn bool      `json:"defaultOptIn"`
	DisplayOrder int       `json:"displayOrder"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
	// Explicit opt-in / opt-out toggle counts from subscriber_topics
	// (SETA-038). Pointers + omitempty so they are populated only by the
	// admin ListTopics path and never leak onto the subscriber-facing
	// SubscriberTopicView, which embeds Topic. These count EXPLICIT
	// toggles only — subscribers who never touched the preference center
	// fall back to DefaultOptIn and have no row here.
	OptedInCount  *int64 `json:"optedInCount,omitempty"`
	OptedOutCount *int64 `json:"optedOutCount,omitempty"`
}

// SubscriberTopic is the per-(tenant,email,topic) opt-in row.
type SubscriberTopic struct {
	TenantID        string    `json:"tenantId"`
	SubscriberEmail string    `json:"subscriberEmail"`
	TopicID         string    `json:"topicId"`
	OptedIn         bool      `json:"optedIn"`
	At              time.Time `json:"at"`
}

// PreferenceToken is a short-lived bearer token that authenticates a single
// subscriber to the hosted preference page.
type PreferenceToken struct {
	Token           string    `json:"token"`
	TenantID        string    `json:"tenantId"`
	SubscriberEmail string    `json:"subscriberEmail"`
	ExpiresAt       time.Time `json:"expiresAt"`
	CreatedAt       time.Time `json:"createdAt"`
}

// CreateTopicInput is the body of POST /api/v1/topics.
type CreateTopicInput struct {
	Slug              string `json:"slug"`
	Name              string `json:"name"`
	Description       string `json:"description,omitempty"`
	DefaultOptIn      bool   `json:"defaultOptIn"`
	DefaultOptInSnake *bool  `json:"default_opt_in,omitempty"`
	DisplayOrder      int    `json:"displayOrder"`
	DisplayOrderSnake *int   `json:"display_order,omitempty"`
}

// UpdateTopicInput is the body of PATCH /api/v1/topics/{id}. All optional.
type UpdateTopicInput struct {
	Slug              *string `json:"slug,omitempty"`
	Name              *string `json:"name,omitempty"`
	Description       *string `json:"description,omitempty"`
	DefaultOptIn      *bool   `json:"defaultOptIn,omitempty"`
	DefaultOptInSnake *bool   `json:"default_opt_in,omitempty"`
	DisplayOrder      *int    `json:"displayOrder,omitempty"`
	DisplayOrderSnake *int    `json:"display_order,omitempty"`
}

// SubscriberTopicView is what the hosted preference page renders: one row
// per topic with the subscriber's current opt-in state pre-applied.
type SubscriberTopicView struct {
	Topic   Topic `json:"topic"`
	OptedIn bool  `json:"optedIn"`
}

// PublicTopic is the deliberately minimized topic projection returned from a
// token-gated hosted preference page. Tenant identifiers and internal
// creation/update timestamps are not needed to render or update a
// subscriber's choices and therefore never cross the public boundary.
type PublicTopic struct {
	ID           string `json:"id"`
	Slug         string `json:"slug"`
	Name         string `json:"name"`
	Description  string `json:"description,omitempty"`
	DefaultOptIn bool   `json:"defaultOptIn"`
	DisplayOrder int    `json:"displayOrder"`
}

// PublicSubscriberTopicView pairs the subscriber's resolved state with the
// minimized public catalog row.
type PublicSubscriberTopicView struct {
	Topic   PublicTopic `json:"topic"`
	OptedIn bool        `json:"optedIn"`
}

// PublicLookupResponse is the body of GET /api/public/preferences/{token}.
type PublicLookupResponse struct {
	Email               string                        `json:"email"`
	ExpiresAt           time.Time                     `json:"expiresAt"`
	Topics              []PublicSubscriberTopicView   `json:"topics"`
	FrequencyPreference FrequencyChoice               `json:"frequencyPreference"`
	PausedUntil         *time.Time                    `json:"pausedUntil,omitempty"`
	Customization       PublicPreferenceCustomization `json:"customization"`
	// GPC is the Global Privacy Control acknowledgement flag (SUB-043). When
	// true, the subscriber's browser sent a GPC signal; the hosted preference
	// page surfaces a notice that we honour it (mandatory in CA from
	// 2026-01-01). Defaults to false when no tracking prefs were recorded.
	GPC bool `json:"gpc"`
}

// PublicPreferenceCustomization is the bounded, subscriber-safe projection of
// the tenant's hosted preference-center theme. It intentionally contains no
// tenant identity or internal timestamps: possession of the preference token
// authorizes only presentation data and this subscriber's own choices.
type PublicPreferenceCustomization struct {
	LogoURL           string `json:"logo_url"`
	PrimaryColor      string `json:"primary_color"`
	FooterText        string `json:"footer_text"`
	ShowPostwaveBadge bool   `json:"show_postwave_badge"`
}

// PublicUpdateInput is the body of POST /api/public/preferences/{token}.
type PublicUpdateInput struct {
	Topics []TopicOptIn `json:"topics"`
}

// TopicOptIn is one opt-in toggle for the public update payload.
type TopicOptIn struct {
	TopicID string `json:"topicId"`
	OptedIn bool   `json:"optedIn"`
}

func validateCreateTopicInput(in *CreateTopicInput) error {
	in.Slug = strings.TrimSpace(in.Slug)
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	return validateTopicFields(in.Slug, in.Name, in.Description, in.DisplayOrder)
}

func validateUpdateTopicInput(in *UpdateTopicInput) error {
	if in.Slug != nil {
		trimmed := strings.TrimSpace(*in.Slug)
		in.Slug = &trimmed
		if !validTopicSlug(trimmed) {
			return ErrInvalidTopicSlug
		}
	}
	if in.Name != nil {
		trimmed := strings.TrimSpace(*in.Name)
		in.Name = &trimmed
		if !validTopicText(trimmed, topicNameMaxRunes, topicNameMaxBytes, false) {
			return ErrInvalidTopicName
		}
	}
	if in.Description != nil {
		trimmed := strings.TrimSpace(*in.Description)
		in.Description = &trimmed
		if !validTopicText(trimmed, topicDescriptionMaxRunes, topicDescriptionMaxBytes, true) {
			return ErrInvalidTopicDesc
		}
	}
	if in.DisplayOrder != nil && (*in.DisplayOrder < topicDisplayOrderMin || *in.DisplayOrder > topicDisplayOrderMax) {
		return ErrInvalidTopicOrder
	}
	return nil
}

func validateTopicFields(slug, name, description string, displayOrder int) error {
	if !validTopicSlug(slug) {
		return ErrInvalidTopicSlug
	}
	if !validTopicText(name, topicNameMaxRunes, topicNameMaxBytes, false) {
		return ErrInvalidTopicName
	}
	if !validTopicText(description, topicDescriptionMaxRunes, topicDescriptionMaxBytes, true) {
		return ErrInvalidTopicDesc
	}
	if displayOrder < topicDisplayOrderMin || displayOrder > topicDisplayOrderMax {
		return ErrInvalidTopicOrder
	}
	return nil
}

func isInvalidTopicError(err error) bool {
	return errors.Is(err, ErrInvalidTopicSlug) ||
		errors.Is(err, ErrInvalidTopicName) ||
		errors.Is(err, ErrInvalidTopicDesc) ||
		errors.Is(err, ErrInvalidTopicOrder)
}

func validTopicSlug(value string) bool {
	return len(value) > 0 && len(value) <= topicSlugMaxBytes && topicSlugRE.MatchString(value)
}

func validTopicText(value string, maxRunes, maxBytes int, allowEmpty bool) bool {
	if (!allowEmpty && value == "") || len(value) > maxBytes || utf8.RuneCountInString(value) > maxRunes {
		return false
	}
	for _, char := range value {
		if unicode.IsControl(char) || unicode.In(char, unicode.Cf, unicode.Cs) {
			return false
		}
	}
	return true
}

func validateTopicOptIns(items []TopicOptIn) error {
	if len(items) > publicPreferenceMaxTopics {
		return ErrInvalidTopicChoice
	}
	seen := make(map[string]struct{}, len(items))
	for index := range items {
		trimmed := strings.TrimSpace(items[index].TopicID)
		parsed, err := uuid.Parse(trimmed)
		if err != nil || parsed.String() != trimmed {
			return ErrInvalidTopicChoice
		}
		if _, duplicate := seen[trimmed]; duplicate {
			return ErrInvalidTopicChoice
		}
		seen[trimmed] = struct{}{}
		items[index].TopicID = trimmed
	}
	return nil
}
