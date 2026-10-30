// SPDX-License-Identifier: AGPL-3.0-only

package factcontract

// SchemaVersion is the on-wire Fact Contract schema version.
type SchemaVersion int

const (
	// SchemaVersionV1 is the only schema understood by ContractV1.
	SchemaVersionV1 SchemaVersion = 1
)

// ContractV1 is the complete semantic oracle for one campaign content
// revision. All fields describe sender intent; none assert what a recipient or
// inbox provider actually observed.
type ContractV1 struct {
	SchemaVersion           SchemaVersion         `json:"schema_version"`
	PrimaryIntent           Intent                `json:"primary_intent"`
	AudienceContext         Audience              `json:"audience_context"`
	CoreClaim               Claim                 `json:"core_claim"`
	PrimaryAction           PrimaryAction         `json:"primary_action"`
	RequiredFacts           []RequiredFact        `json:"required_facts"`
	ForbiddenClaims         []ForbiddenClaim      `json:"forbidden_claims"`
	AllowedSecondaryActions []SecondaryActionRole `json:"allowed_secondary_actions"`
	Language                LanguageTag           `json:"language"`
}

// IntentKind is the sender's high-level purpose. The statement remains the
// authoritative natural-language description; the kind enables stable policy
// and reporting without asking a model to classify the brief first.
type IntentKind string

const (
	IntentInform        IntentKind = "inform"
	IntentInvite        IntentKind = "invite"
	IntentPromote       IntentKind = "promote"
	IntentRequestAction IntentKind = "request_action"
	IntentRemind        IntentKind = "remind"
	IntentSurvey        IntentKind = "survey"
	IntentTransact      IntentKind = "transact"
	IntentOnboard       IntentKind = "onboard"
	IntentRetain        IntentKind = "retain"
	IntentOther         IntentKind = "other"
)

// Intent is the campaign's single primary purpose.
type Intent struct {
	Kind      IntentKind `json:"kind"`
	Statement string     `json:"statement"`
}

// Audience describes who the copy is intended to address. TargetingReference
// may link to a frozen list/segment/fixture identifier, but audience targeting
// is not required to appear verbatim in the rendered message.
type Audience struct {
	Description        string `json:"description"`
	TargetingReference string `json:"targeting_reference,omitempty"`
}

// Claim is the single most important assertion the message must preserve.
// SourceBlockIDs are optional while a brief is authored and can be populated
// once semantic content blocks exist.
type Claim struct {
	Statement      string    `json:"statement"`
	SourceBlockIDs []BlockID `json:"source_block_ids,omitempty"`
}

// LanguageTag is a canonical BCP 47 language tag such as en-IN.
type LanguageTag string

// ActionID and BlockID are stable semantic identifiers, not array positions or
// URLs extracted from rendered HTML.
type ActionID string
type BlockID string
type FactID string
type ForbiddenClaimID string

// PrimaryActionRole captures the meaning of the one primary action. Every
// role except reply is link-backed in v1.
type PrimaryActionRole string

const (
	PrimaryActionNavigate PrimaryActionRole = "navigate"
	PrimaryActionRegister PrimaryActionRole = "register"
	PrimaryActionPurchase PrimaryActionRole = "purchase"
	PrimaryActionRSVP     PrimaryActionRole = "rsvp"
	PrimaryActionConfirm  PrimaryActionRole = "confirm"
	PrimaryActionDownload PrimaryActionRole = "download"
	PrimaryActionSurvey   PrimaryActionRole = "survey"
	PrimaryActionReply    PrimaryActionRole = "reply"
	PrimaryActionTrack    PrimaryActionRole = "track"
)

// PrimaryAction points to a canonical semantic action and its owning content
// block. CanonicalURL is the pre-tracking destination. It is intentionally not
// inferred by selecting the first link in HTML.
type PrimaryAction struct {
	ActionID     ActionID          `json:"action_id"`
	BlockID      BlockID           `json:"block_id"`
	Role         PrimaryActionRole `json:"role"`
	Label        string            `json:"label"`
	CanonicalURL string            `json:"canonical_url,omitempty"`
}

// SecondaryActionRole is an allow-list category for non-primary links. It
// makes "one primary CTA" compatible with mandatory and navigational links.
type SecondaryActionRole string

const (
	SecondaryActionUnsubscribe   SecondaryActionRole = "unsubscribe"
	SecondaryActionPreferences   SecondaryActionRole = "preferences"
	SecondaryActionViewInBrowser SecondaryActionRole = "view_in_browser"
	SecondaryActionSocial        SecondaryActionRole = "social"
	SecondaryActionLegal         SecondaryActionRole = "legal"
	SecondaryActionShare         SecondaryActionRole = "share"
	SecondaryActionContact       SecondaryActionRole = "contact"
	SecondaryActionReply         SecondaryActionRole = "reply"
)

// Criticality determines the consequence of failed recovery. Consumers should
// keep policy separate from the numeric comprehension score: a critical fact
// can block dispatch even when the aggregate score is high.
type Criticality string

const (
	CriticalityCritical   Criticality = "critical"
	CriticalityImportant  Criticality = "important"
	CriticalitySupporting Criticality = "supporting"
)

// FactType is the closed v1 set of required-fact representations.
type FactType string

const (
	FactTypeText       FactType = "text"
	FactTypeDateTime   FactType = "datetime"
	FactTypeMoney      FactType = "money"
	FactTypeLocation   FactType = "location"
	FactTypeCode       FactType = "code"
	FactTypePercentage FactType = "percentage"
	FactTypeQuantity   FactType = "quantity"
	FactTypeURL        FactType = "url"
)

// RequiredFact is a discriminated union. Exactly one value field must be set,
// and it must correspond to Type. Pointers preserve the difference between an
// omitted value and a present-but-empty value for precise validation errors.
type RequiredFact struct {
	ID             FactID         `json:"id"`
	Type           FactType       `json:"type"`
	DisplayValue   string         `json:"display_value"`
	Criticality    Criticality    `json:"criticality"`
	SourceBlockIDs []BlockID      `json:"source_block_ids"`
	TextValue      *string        `json:"text_value,omitempty"`
	DateTimeValue  *DateTimeValue `json:"datetime_value,omitempty"`
	MoneyValue     *MoneyValue    `json:"money_value,omitempty"`
	NumberValue    *NumberValue   `json:"number_value,omitempty"`
	URLValue       *string        `json:"url_value,omitempty"`
}

// DateTimeValue carries both a normalized RFC 3339 instant and the IANA time
// zone in which a recipient should interpret it. Validation confirms the
// encoded UTC offset agrees with the named zone at that instant, including DST.
type DateTimeValue struct {
	RFC3339  string `json:"rfc3339"`
	Timezone string `json:"timezone"`
}

// CurrencyCode is a canonical uppercase ISO 4217 designator.
type CurrencyCode string

// MoneyValue uses a decimal string rather than binary floating point. Amount
// is normalized without exponent notation; Currency is verified against the
// CLDR-backed ISO 4217 registry.
type MoneyValue struct {
	Amount   string       `json:"amount"`
	Currency CurrencyCode `json:"currency"`
}

// NumberValue represents percentages and quantities without floating-point
// loss. Percentage uses the implicit unit "%"; quantity requires an explicit
// human-readable unit such as seats, GB, or months.
type NumberValue struct {
	Value string `json:"value"`
	Unit  string `json:"unit,omitempty"`
}

// ForbiddenClaim is an assertion that extraction must never attribute to the
// campaign. A stable ID lets findings refer to it without embedding the claim
// text in identifiers or policy rules.
type ForbiddenClaim struct {
	ID        ForbiddenClaimID `json:"id"`
	Statement string           `json:"statement"`
}
