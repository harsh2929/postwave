// Package templates owns the Moosewave redistributable example sequence
// templates. A Template is a *skeleton*: subject lines and bodies contain
// {{variable}} placeholders that the generation engine fills in using the
// writer's voice profile + tenant variables.
//
// The library is seeded from JSON files embedded under embedded/. See seed.go
// for the runtime VOICE_TEMPLATES_PATH override loader.
package templates

import (
	"context"
	"errors"
	"time"
)

// TemplateCategory enumerates categories accepted by operator-supplied templates.
// The public distribution includes one uncalibrated welcome example.
type TemplateCategory string

const (
	CategoryWelcome          TemplateCategory = "welcome"
	CategoryCourseLaunch     TemplateCategory = "course_launch"
	CategoryProductLaunch    TemplateCategory = "product_launch"
	CategoryReEngagement     TemplateCategory = "re_engagement"
	CategoryNewsletterSeries TemplateCategory = "newsletter_series"
	CategorySaaSOnboarding   TemplateCategory = "saas_onboarding"
	CategoryPartnership      TemplateCategory = "partnership"
	CategoryYearInReview     TemplateCategory = "year_in_review"
	CategoryCrisis           TemplateCategory = "crisis"
	CategoryColdWarm         TemplateCategory = "cold_warm"
	CategorySales            TemplateCategory = "sales"
	CategoryCommunity        TemplateCategory = "community"
	CategoryMisc             TemplateCategory = "misc"
)

// AllCategories lists the supported TemplateCategory values in display order.
func AllCategories() []TemplateCategory {
	return []TemplateCategory{
		CategoryWelcome,
		CategoryCourseLaunch,
		CategoryProductLaunch,
		CategoryReEngagement,
		CategoryNewsletterSeries,
		CategorySaaSOnboarding,
		CategoryPartnership,
		CategoryYearInReview,
		CategoryCrisis,
		CategoryColdWarm,
		CategorySales,
		CategoryCommunity,
		CategoryMisc,
	}
}

// TemplateVariable describes a single placeholder a writer must supply when
// instantiating a template. Variables are referenced as {{key}} inside
// SubjectSkeleton / BodySkeleton.
type TemplateVariable struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Type        string `json:"type,omitempty"`
	Required    bool   `json:"required"`
	Example     string `json:"example"`
}

// TemplateEmail is one email slot inside a sequence template. The skeletons
// are short, opinionated drafts — the generation engine rewrites them in the
// writer's voice; what survives is the *intent* (purpose, ask, beat) of the
// email rather than its prose.
type TemplateEmail struct {
	Position        int    `json:"position"`
	DelaySeconds    int    `json:"delay_seconds"`
	SubjectSkeleton string `json:"subject_skeleton"`
	BodySkeleton    string `json:"body_skeleton"`
	Notes           string `json:"notes"`
}

// TemplatePerformance carries benchmark stats when the template has measured
// send history. Seed templates may have SampleSize=0 until analytics backfill
// supplies a cohort.
type TemplatePerformance struct {
	OpenRate       float64 `json:"open_rate"`
	ClickRate      float64 `json:"click_rate"`
	ConversionRate float64 `json:"conversion_rate"`
	SampleSize     int     `json:"sample_size"`
}

// Template is the full sequence template definition.
type Template struct {
	ID          string              `json:"id"`
	Slug        string              `json:"slug"`
	Category    TemplateCategory    `json:"category"`
	Name        string              `json:"name"`
	Description string              `json:"description"`
	Length      int                 `json:"length"`
	Variables   []TemplateVariable  `json:"variables"`
	Emails      []TemplateEmail     `json:"emails"`
	Tags        []string            `json:"tags"`
	Author      string              `json:"author"`
	Performance TemplatePerformance `json:"performance"`
	CreatedAt   time.Time           `json:"created_at,omitempty"`
	UpdatedAt   time.Time           `json:"updated_at,omitempty"`
}

// ErrNotFound is returned when a template ID/slug lookup misses.
var ErrNotFound = errors.New("templates: not found")

// ErrConflict is returned when a template slug already exists.
var ErrConflict = errors.New("templates: slug already exists")

// TemplateStore is the persistence contract. Local/test runs use MemoryStore
// seeded from embedded JSON; PostgresStore persists admin-authored templates
// when DATABASE_URL is configured.
type TemplateStore interface {
	Get(ctx context.Context, idOrSlug string) (Template, error)
	List(ctx context.Context, category TemplateCategory) ([]Template, error)
	Create(ctx context.Context, t Template) (Template, error)
	Update(ctx context.Context, t Template) (Template, error)
	Delete(ctx context.Context, id string) error
}
