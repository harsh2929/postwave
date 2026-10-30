package audiences

import "time"

// LookalikeModel is the metadata header for one generated lookalike audience
// (SUB-033, migration 0901). It records the seed segment, the requested size +
// confidence threshold, the realised member count, and a freeform model
// version. The materialised, ranked members live in lookalike_members and are
// fetched separately (GET .../members).
type LookalikeModel struct {
	ID                  string         `json:"id"`
	Name                string         `json:"name"`
	SeedSegmentID       string         `json:"seed_segment_id"`
	SizeRequested       int            `json:"size_requested"`
	MemberCount         int            `json:"member_count"`
	SeedCount           int            `json:"seed_count"`
	ConfidenceThreshold *float64       `json:"confidence_threshold,omitempty"`
	ModelVersion        string         `json:"model_version"`
	Status              string         `json:"status"`
	Payload             map[string]any `json:"payload"`
	Error               string         `json:"error,omitempty"`
	CreatedAt           time.Time      `json:"created_at"`
	UpdatedAt           time.Time      `json:"updated_at"`
}

// LookalikeMember is one ranked, modeled subscriber in a lookalike audience
// (migration 0902). similarity_score is the ranker's [0,1] output and rank is
// the 1-based position.
type LookalikeMember struct {
	SubscriberID    string         `json:"subscriber_id"`
	Email           string         `json:"email"`
	SimilarityScore float64        `json:"similarity_score"`
	Rank            int            `json:"rank"`
	Features        map[string]any `json:"features"`
}

// LookalikeMemberPage is the paginated GET .../members response.
type LookalikeMemberPage struct {
	Items       []LookalikeMember `json:"items"`
	Total       int               `json:"total"`
	Page        int               `json:"page"`
	PerPage     int               `json:"per_page"`
	PIIIncluded bool              `json:"pii_included"`
}

// CreateLookalikeInput is the POST /api/v1/audiences/lookalike body. The seed
// id and an explicit first-party data-use acknowledgement are required; size
// + confidence default at the repository boundary.
type CreateLookalikeInput struct {
	Name                string   `json:"name"`
	SeedSegmentID       string   `json:"seed_segment_id"`
	Size                int      `json:"size"`
	ConfidenceThreshold *float64 `json:"confidence_threshold"`
	DataUseAcknowledged bool     `json:"data_use_acknowledged"`
}

// Bounds for the requested audience size (Klaviyo/Mailchimp parity range).
const (
	MinLookalikeSize     = 100
	MaxLookalikeSize     = 10000
	DefaultLookalikeSize = 1000
	// MinLookalikeSeedMembers is enforced against live membership in the same
	// transaction as generation; cached UI counts are guidance, not authority.
	MinLookalikeSeedMembers = 50
	MinLookalikeConfidence  = 0.5
	LookalikeDataUseVersion = "first-party-lookalike-v1"
	// CandidatePoolCap bounds how many non-seed subscribers the ranker scores
	// in one synchronous request so a 5M-row tenant can't time out the create.
	CandidatePoolCap = 50000
	// SeedSampleCap bounds how many seed members feed the centroid so a huge
	// seed segment doesn't blow the request budget; the centroid is stable
	// well below this.
	SeedSampleCap = 20000
)
