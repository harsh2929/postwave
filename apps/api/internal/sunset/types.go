// SPDX-License-Identifier: AGPL-3.0-only
package sunset

import "time"

// Action is what the detector does to a candidate. String-typed to
// match the DB CHECK and stay grep-friendly across log lines.
type Action string

const (
	ActionSuppress Action = "suppress"
	ActionTag      Action = "tag"
	ActionWinback  Action = "winback"
	// ActionSkipped is recorded in sunset_executions when a candidate
	// matched the policy criteria but was excluded (e.g. because they
	// carry a VIP tag). Logging the skip lets the dashboard explain
	// why a candidate wasn't acted on.
	ActionSkipped Action = "skipped"
)

// IsValid reports whether a is one of the user-settable actions.
// ActionSkipped is detector-internal and not a valid policy choice.
func (a Action) IsValid() bool {
	switch a {
	case ActionSuppress, ActionTag, ActionWinback:
		return true
	}
	return false
}

// Policy is one tenant-defined rule.
type Policy struct {
	ID           string    `json:"id"`
	TenantID     string    `json:"tenantId"`
	Name         string    `json:"name"`
	InactiveDays int       `json:"inactiveDays"`
	Action       Action    `json:"action"`
	Enabled      bool      `json:"enabled"`
	ExcludedTags []string  `json:"excludedTags"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// Execution is one row of the audit log — what happened to which
// subscriber under which policy when the detector last ran.
type Execution struct {
	ID           string    `json:"id"`
	TenantID     string    `json:"tenantId"`
	PolicyID     string    `json:"policyId"`
	SubscriberID string    `json:"subscriberId"`
	ActionTaken  Action    `json:"actionTaken"`
	Reason       string    `json:"reason,omitempty"`
	ExecutedAt   time.Time `json:"executedAt"`
}

// Candidate is what the discovery query returns BEFORE the action is
// executed. The detector pipeline is: discover → filter (excluded
// tags) → execute → log.
type Candidate struct {
	SubscriberID string     `json:"subscriberId"`
	Email        string     `json:"email"`
	LastSeen     *time.Time `json:"lastSeen,omitempty"`
	InactiveDays int        `json:"inactiveDays"`
	Tags         []string   `json:"tags,omitempty"`
}

// RunSummary is the dashboard-facing return of a detector pass.
type RunSummary struct {
	PolicyID       string         `json:"policyId"`
	StartedAt      time.Time      `json:"startedAt"`
	CompletedAt    time.Time      `json:"completedAt"`
	CandidatesSeen int            `json:"candidatesSeen"`
	ByAction       map[Action]int `json:"byAction"`
	Errors         []string       `json:"errors,omitempty"`
}
