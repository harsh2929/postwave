// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import "encoding/json"

const (
	// SchemaVersionV2 is the on-wire semantic document schema version.
	SchemaVersionV2 = 2
	// NodeVersionV2 is the only node representation understood by this package.
	NodeVersionV2 = 2
	// CompilerVersion identifies condition/localization resolution and the
	// orchestration of all projections.
	CompilerVersion = "postwave.semantic-email.compiler.v2"
	// HTMLRendererVersion identifies the canonical HTML projection.
	HTMLRendererVersion = "postwave.semantic-email.html.v2"
	// TextRendererVersion identifies the canonical plain-text projection.
	TextRendererVersion = "postwave.semantic-email.text.v2"
	// GmailRegistryVersion pins the provider schema allowlist implemented here.
	// The date matches the reviewed official Gmail email-markup reference.
	GmailRegistryVersion = "gmail.email-markup.2026-04-20"
)

// DocumentV2 is a complete semantic-native email content tree. Subject and
// preview text remain revision metadata outside this body tree.
type DocumentV2 struct {
	SchemaVersion int       `json:"schema_version"`
	Language      string    `json:"language"`
	Direction     Direction `json:"direction"`
	Nodes         []Node    `json:"nodes"`
}

// Direction controls the document's base reading direction.
type Direction string

const (
	DirectionLTR  Direction = "ltr"
	DirectionRTL  Direction = "rtl"
	DirectionAuto Direction = "auto"
)

type NodeID string
type ActionID string
type SlotID string
type ConditionID string

// NodeType is the closed set of v2 block-level semantic node types.
type NodeType string

const (
	NodeHeading         NodeType = "heading"
	NodeParagraph       NodeType = "paragraph"
	NodeList            NodeType = "list"
	NodeAnswer          NodeType = "answer"
	NodeLegal           NodeType = "legal"
	NodeAction          NodeType = "action"
	NodeImage           NodeType = "image"
	NodeDateTime        NodeType = "datetime"
	NodeMoney           NodeType = "money"
	NodeDeadline        NodeType = "deadline"
	NodeOffer           NodeType = "offer"
	NodeLocation        NodeType = "location"
	NodeProduct         NodeType = "product"
	NodeFact            NodeType = "fact"
	NodePersonalization NodeType = "personalization"
	NodeStructuredData  NodeType = "structured_data"
	// NodeDivider is a structural separator carrying no content.
	//
	// It exists as a node rather than as styling because the plain-text and
	// JSON-LD projections must be able to DROP it: a divider is meaningful to a
	// reader looking at rendered HTML and is noise to anything parsing the
	// message, and a tree that cannot say "this is decoration" has to guess.
	NodeDivider NodeType = "divider"
	// NodePoll is a question with mutually exclusive options.
	//
	// The node holds the question and the options; the per-(recipient, option)
	// URLs are minted at send time and never stored in the tree, because a tree
	// is shared across every recipient by construction.
	NodePoll NodeType = "poll"
)

// NodeRole states why a node exists. Role is independent of visual styling and
// lets action extraction distinguish a primary CTA from legal/footer links.
type NodeRole string

const (
	RoleHeading             NodeRole = "heading"
	RoleBody                NodeRole = "body"
	RoleAnswer              NodeRole = "answer"
	RoleLegal               NodeRole = "legal"
	RoleFooter              NodeRole = "footer"
	RolePrimaryAction       NodeRole = "primary_action"
	RoleSecondaryAction     NodeRole = "secondary_action"
	RoleUnsubscribe         NodeRole = "unsubscribe"
	RolePreferences         NodeRole = "preferences"
	RoleViewInBrowser       NodeRole = "view_in_browser"
	RoleSocial              NodeRole = "social"
	RoleContact             NodeRole = "contact"
	RoleInformativeImage    NodeRole = "informative_image"
	RoleDecorativeImage     NodeRole = "decorative_image"
	RoleEventDateTime       NodeRole = "event_datetime"
	RolePrice               NodeRole = "price"
	RoleDeadline            NodeRole = "deadline"
	RoleOffer               NodeRole = "offer"
	RoleLocation            NodeRole = "location"
	RoleProduct             NodeRole = "product"
	RoleProductFact         NodeRole = "product_fact"
	RolePersonalizationSlot NodeRole = "personalization_slot"
	RoleStructuredData      NodeRole = "structured_data"
	RoleDivider             NodeRole = "divider"
	RolePoll                NodeRole = "poll"
)

// Node is one stable, addressable semantic block. Localizations override only
// Content; identity, role, conditions, and provenance stay invariant.
type Node struct {
	ID            NodeID                 `json:"id"`
	Type          NodeType               `json:"type"`
	Role          NodeRole               `json:"role"`
	Version       int                    `json:"version"`
	Content       NodeContent            `json:"content"`
	Conditions    []Condition            `json:"conditions"`
	Localizations map[string]NodeContent `json:"localizations"`
	Provenance    Provenance             `json:"provenance"`
}

// SourceKind records how a node entered the semantic tree.
//
// "imported_html" is intentionally not a member. Legacy HTML crosses into the
// model only through ImportLegacyHTML, which maps an explicit allowlist onto
// this same closed union and REFUSES to produce a document at all when anything
// could not be represented — so a node that arrived that way is a fully mapped
// node, and it is marked SourceMigration. Arbitrary HTML is still never
// silently represented as lossless semantic content.
type SourceKind string

const (
	SourceUser      SourceKind = "user"
	SourceTemplate  SourceKind = "template"
	SourceGenerated SourceKind = "generated"
	SourceMigration SourceKind = "migration"
)

type Provenance struct {
	Source   SourceKind `json:"source"`
	SourceID string     `json:"source_id,omitempty"`
}

// NodeContent is a discriminated union. Exactly one pointer must be non-nil
// and it must match Node.Type. This explicit form keeps ordinary encoding/json
// decoding closed; unknown model-generated fields never become projections.
type NodeContent struct {
	Heading         *HeadingContent         `json:"heading,omitempty"`
	Paragraph       *ParagraphContent       `json:"paragraph,omitempty"`
	List            *ListContent            `json:"list,omitempty"`
	Answer          *AnswerContent          `json:"answer,omitempty"`
	Legal           *LegalContent           `json:"legal,omitempty"`
	Action          *ActionContent          `json:"action,omitempty"`
	Image           *ImageContent           `json:"image,omitempty"`
	DateTime        *DateTimeContent        `json:"datetime,omitempty"`
	Money           *MoneyContent           `json:"money,omitempty"`
	Deadline        *DateTimeContent        `json:"deadline,omitempty"`
	Offer           *OfferContent           `json:"offer,omitempty"`
	Location        *LocationContent        `json:"location,omitempty"`
	Product         *ProductContent         `json:"product,omitempty"`
	Fact            *FactContent            `json:"fact,omitempty"`
	Personalization *PersonalizationContent `json:"personalization,omitempty"`
	StructuredData  *StructuredDataContent  `json:"structured_data,omitempty"`
	Divider         *DividerContent         `json:"divider,omitempty"`
	Poll            *PollContent            `json:"poll,omitempty"`
}

// DividerContent is deliberately empty.
//
// Presence is the whole content. A divider with fields would invite styling to
// be encoded in the semantic tree, which is the boundary this model exists to
// hold: the tree says what something IS, the projections decide how it looks.
type DividerContent struct{}

// PollContent is a question and its mutually exclusive options.
type PollContent struct {
	// PollID is stable across revisions so responses collected before an edit
	// still belong to the same poll.
	PollID   string       `json:"poll_id"`
	Question RichText     `json:"question"`
	Options  []PollOption `json:"options"`
}

// PollOption is one answer a recipient can choose.
type PollOption struct {
	// OptionID is what a response records. It must be stable for the same
	// reason PollID is, and unique within the poll or two options collapse into
	// one tally.
	OptionID string   `json:"option_id"`
	Label    RichText `json:"label"`
}

type RichText struct {
	Runs []InlineRun `json:"runs"`
}

type InlineKind string

const (
	InlineText      InlineKind = "text"
	InlineStrong    InlineKind = "strong"
	InlineEmphasis  InlineKind = "emphasis"
	InlineLink      InlineKind = "link"
	InlineSlot      InlineKind = "slot"
	InlineLineBreak InlineKind = "line_break"
)

// InlineRun is a closed inline union. Text is used by text/strong/emphasis/link;
// URL only by link; Slot only by slot; line_break has no payload.
type InlineRun struct {
	Kind            InlineKind     `json:"kind"`
	Text            string         `json:"text,omitempty"`
	URL             string         `json:"url,omitempty"`
	AccessibleLabel string         `json:"accessible_label,omitempty"`
	Slot            *SlotReference `json:"slot,omitempty"`
}

type SlotSemanticClass string

const (
	SlotName       SlotSemanticClass = "name"
	SlotIdentifier SlotSemanticClass = "identifier"
	SlotText       SlotSemanticClass = "text"
	SlotCode       SlotSemanticClass = "code"
)

// SlotReference declares a bounded runtime substitution. Required slots with
// no fixture value or fallback make compilation fail closed.
type SlotReference struct {
	ID            SlotID            `json:"id"`
	SemanticClass SlotSemanticClass `json:"semantic_class"`
	Required      bool              `json:"required"`
	Fallback      string            `json:"fallback,omitempty"`
}

type HeadingContent struct {
	Level int      `json:"level"`
	Text  RichText `json:"text"`
}

type ParagraphContent struct {
	Text RichText `json:"text"`
}

type ListContent struct {
	Ordered bool       `json:"ordered"`
	Items   []RichText `json:"items"`
}

type AnswerContent struct {
	Question RichText `json:"question"`
	Answer   RichText `json:"answer"`
}

type LegalContent struct {
	Text RichText `json:"text"`
}

type ActionContent struct {
	ActionID              ActionID `json:"action_id"`
	Label                 string   `json:"label"`
	CanonicalURL          string   `json:"canonical_url"`
	AccessibleDescription string   `json:"accessible_description,omitempty"`
}

type ImageContent struct {
	URL    string `json:"url"`
	Alt    string `json:"alt"`
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
}

type DateTimeContent struct {
	DisplayValue string `json:"display_value"`
	RFC3339      string `json:"rfc3339"`
	Timezone     string `json:"timezone"`
}

// MoneyContent uses an exact base-10 decimal string, never floating point.
type MoneyContent struct {
	DisplayValue string `json:"display_value"`
	Amount       string `json:"amount"`
	Currency     string `json:"currency"`
}

type OfferContent struct {
	Description RichText `json:"description"`
	Code        string   `json:"code,omitempty"`
	Terms       RichText `json:"terms"`
	// AvailabilityStarts/Ends are what the MESSAGE SAYS. They are authored copy
	// and they can be wrong; CanonicalOfferID is how anything downstream finds
	// out that they are.
	AvailabilityStarts *DateTimeContent `json:"availability_starts,omitempty"`
	AvailabilityEnds   *DateTimeContent `json:"availability_ends,omitempty"`

	// CanonicalOfferID names the canonical offer entity this block presents
	// (PRD F15). It is the bridge between the in-email node and the record an
	// agent can resolve.
	//
	// A REFERENCE, never a copy, for two independent reasons.
	//
	// First, a semantic tree is shared by EVERY recipient of the message by
	// construction — that is why per-recipient poll links are compiler input
	// rather than tree content. A snapshot of price, validity window or
	// inventory inlined here would be one frozen answer handed to everybody, and
	// the tree has no way to say when it was taken.
	//
	// Second, and worse, a snapshot goes stale silently. The canonical entity
	// changes when the price changes, when stock runs out, when the window is
	// extended; a copy in the tree does not. An agent that resolved the copy and
	// an agent that resolved the entity would disagree, both confidently, and
	// neither would be able to tell which was current. A name can be re-resolved
	// at read time; a copy cannot be un-staled.
	//
	// The compiler deliberately does not resolve it. Compilation is
	// side-effect free and has no clock, network or persistence dependency, so
	// resolution belongs to the layer that has all three
	// (internal/offers.Repo.ResolveSemanticOffers).
	CanonicalOfferID string `json:"canonical_offer_id,omitempty"`
}

type PostalAddress struct {
	StreetAddress   string `json:"street_address"`
	AddressLocality string `json:"address_locality"`
	AddressRegion   string `json:"address_region,omitempty"`
	PostalCode      string `json:"postal_code,omitempty"`
	AddressCountry  string `json:"address_country"`
}

type LocationContent struct {
	Name    string        `json:"name"`
	Address PostalAddress `json:"address"`
}

type ProductContent struct {
	Name         string `json:"name"`
	SKU          string `json:"sku,omitempty"`
	CanonicalURL string `json:"canonical_url,omitempty"`
	ImageURL     string `json:"image_url,omitempty"`
}

type FactContent struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type PersonalizationContent struct {
	Label string        `json:"label,omitempty"`
	Slot  SlotReference `json:"slot"`
}

type ConditionOperator string

const (
	ConditionPresent   ConditionOperator = "present"
	ConditionAbsent    ConditionOperator = "absent"
	ConditionEquals    ConditionOperator = "equals"
	ConditionNotEquals ConditionOperator = "not_equals"
)

// Condition is an ANDed inclusion predicate over a declared fixture/runtime
// slot. Coverage enumeration belongs to the send-plan layer; CompileV2 resolves
// one exact scenario and errors when equality cannot be evaluated.
type Condition struct {
	ID       ConditionID       `json:"id"`
	SlotID   SlotID            `json:"slot_id"`
	Operator ConditionOperator `json:"operator"`
	Value    string            `json:"value,omitempty"`
}

// Structured-data declarations only reference visible semantic nodes. They do
// not carry arbitrary JSON or duplicate fact values that can drift from copy.
type StructuredDataContent struct {
	Enabled         bool                  `json:"enabled"`
	Provider        Provider              `json:"provider"`
	RegistryVersion string                `json:"registry_version"`
	UseCase         StructuredDataUseCase `json:"use_case"`
	Kind            StructuredDataKind    `json:"kind"`
	Declaration     StructuredDeclaration `json:"declaration"`
}

type Provider string

const ProviderGmail Provider = "gmail"

type StructuredDataUseCase string

const (
	UseCaseGmailPromotion   StructuredDataUseCase = "gmail_promotion"
	UseCaseGmailTransaction StructuredDataUseCase = "gmail_transaction"
)

type StructuredDataKind string

const (
	StructuredDiscountOffer    StructuredDataKind = "discount_offer"
	StructuredPromotionCard    StructuredDataKind = "promotion_card"
	StructuredEventReservation StructuredDataKind = "event_reservation"
	StructuredOrder            StructuredDataKind = "order"
)

type StructuredDeclaration struct {
	DiscountOffer    *DiscountOfferDeclaration    `json:"discount_offer,omitempty"`
	PromotionCard    *PromotionCardDeclaration    `json:"promotion_card,omitempty"`
	EventReservation *EventReservationDeclaration `json:"event_reservation,omitempty"`
	Order            *OrderDeclaration            `json:"order,omitempty"`
}

type DiscountOfferDeclaration struct {
	OfferNodeID NodeID `json:"offer_node_id"`
}

type PromotionCardDeclaration struct {
	ImageNodeID         NodeID `json:"image_node_id"`
	ActionNodeID        NodeID `json:"action_node_id"`
	HeadlineNodeID      NodeID `json:"headline_node_id,omitempty"`
	PriceNodeID         NodeID `json:"price_node_id,omitempty"`
	DiscountValueNodeID NodeID `json:"discount_value_node_id,omitempty"`
	Position            int    `json:"position,omitempty"`
}

type ReservationStatus string

const (
	ReservationConfirmed ReservationStatus = "confirmed"
	ReservationPending   ReservationStatus = "pending"
	ReservationCancelled ReservationStatus = "cancelled"
)

type EventReservationDeclaration struct {
	ReservationNumberNodeID NodeID            `json:"reservation_number_node_id"`
	UnderNameNodeID         NodeID            `json:"under_name_node_id"`
	EventNameNodeID         NodeID            `json:"event_name_node_id"`
	StartDateTimeNodeID     NodeID            `json:"start_datetime_node_id"`
	LocationNodeID          NodeID            `json:"location_node_id"`
	StatusNodeID            NodeID            `json:"status_node_id"`
	Status                  ReservationStatus `json:"status"`
	ActionNodeID            NodeID            `json:"action_node_id,omitempty"`
}

type OrderDeclaration struct {
	MerchantNodeID    NodeID         `json:"merchant_node_id"`
	OrderNumberNodeID NodeID         `json:"order_number_node_id"`
	TotalNodeID       NodeID         `json:"total_node_id"`
	Items             []OrderItemRef `json:"items"`
	ActionNodeID      NodeID         `json:"action_node_id,omitempty"`
}

type OrderItemRef struct {
	ProductNodeID  NodeID `json:"product_node_id"`
	PriceNodeID    NodeID `json:"price_node_id"`
	QuantityNodeID NodeID `json:"quantity_node_id"`
}

// CompileOptions selects one exact locale/condition/personalization scenario.
// Slots are synthetic fixture values for assurance and recipient values at
// dispatch. Provider policy is external evidence and is never authored into
// the semantic document.
type CompileOptions struct {
	Locale           string            `json:"locale"`
	Slots            map[SlotID]string `json:"slots"`
	StructuredPolicy StructuredPolicy  `json:"structured_policy"`
	// PollOptionLinks carries recipient-specific links minted at send time.
	// The semantic tree deliberately contains only stable poll/option identity;
	// putting bearer links in that shared tree would send one recipient's
	// credential to everybody. A nil map keeps synthetic assurance projections
	// recipient-free. A non-empty map must cover every poll option exactly.
	PollOptionLinks PollOptionLinks `json:"-"`
	// HoneypotDecoys carries recipient-specific F01 decoy markup minted at send
	// time, on the same footing as PollOptionLinks: never authored into the
	// semantic revision, never part of a stored assurance artifact, and nil for
	// every synthetic projection so those stay recipient-free.
	//
	// The entries are rendered verbatim into the HTML alternative and into
	// nothing else. They must never reach text/plain, where nothing can be
	// hidden: the decoy URL would sit in the body for a human to read and
	// click, and the first curious recipient would be certified as a machine.
	HoneypotDecoys []string `json:"-"`
}

// PollOptionLinks maps semantic PollContent.PollID -> PollOption.OptionID ->
// the recipient-specific HTTPS preview URL. It is compiler input, never
// persisted campaign content.
type PollOptionLinks map[string]map[string]string

type StructuredPolicy struct {
	Gmail GmailPolicy `json:"gmail"`
	// DeclaredSendSurface is the provider surface the SENDER SAYS this campaign
	// targets ("promotions" or "transactional").
	//
	// Distinct from GmailPolicy.Promotions/Transactions, which say whether the
	// TENANT may use those annotations at all. Both are needed: a tenant with
	// Promotions enabled sending a receipt should not emit a DiscountOffer,
	// which would be valid, eligible, emitted and inert because Gmail ignores
	// it there.
	//
	// A declaration, never an observation — Gmail decides the tab and we learn
	// it afterwards from placement capture. Empty means the sender declared
	// nothing, which leaves the pre-existing enablement behaviour untouched
	// rather than disabling structured data for every existing caller.
	DeclaredSendSurface string `json:"declared_send_surface,omitempty"`
}

type GmailPolicy struct {
	RegisteredSender bool `json:"registered_sender"`
	Authenticated    bool `json:"authenticated"`
	Promotions       bool `json:"promotions"`
	Transactions     bool `json:"transactions"`
}

type Eligibility string

const (
	EligibilityDisabled   Eligibility = "disabled"
	EligibilityUnverified Eligibility = "unverified"
	EligibilityEligible   Eligibility = "eligible"
)

// StructuredDataStatus deliberately does not conflate schema validity with
// sender eligibility, provider display, or AI comprehension.
type StructuredDataStatus struct {
	NodeID              NodeID             `json:"node_id"`
	Provider            Provider           `json:"provider"`
	RegistryVersion     string             `json:"registry_version"`
	Kind                StructuredDataKind `json:"kind"`
	Valid               bool               `json:"valid"`
	Eligibility         Eligibility        `json:"eligibility"`
	Emitted             bool               `json:"emitted"`
	ObservedDisplay     string             `json:"observed_display"`
	ComprehensionEffect string             `json:"comprehension_effect"`
	EligibilityReason   string             `json:"eligibility_reason,omitempty"`
}

type ProjectionHashes struct {
	HTML   string `json:"html"`
	Text   string `json:"text"`
	JSONLD string `json:"json_ld,omitempty"`
}

// Result contains projections for one exact scenario. JSONLD is the canonical
// object/array embedded in HTML; StructuredPayloads retain declaration-level
// objects for parity checks and receipts.
type Result struct {
	HTML               string                 `json:"html"`
	Text               string                 `json:"text"`
	JSONLD             json.RawMessage        `json:"json_ld,omitempty"`
	StructuredPayloads []json.RawMessage      `json:"structured_payloads,omitempty"`
	StructuredStatuses []StructuredDataStatus `json:"structured_statuses"`
	IncludedNodeIDs    []NodeID               `json:"included_node_ids"`
	Hashes             ProjectionHashes       `json:"hashes"`
	CompilerVersion    string                 `json:"compiler_version"`
	HTMLVersion        string                 `json:"html_version"`
	TextVersion        string                 `json:"text_version"`
	RegistryVersion    string                 `json:"registry_version"`
}
