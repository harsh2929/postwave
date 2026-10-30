package segments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/customobjects"
	"github.com/postwave/postwave/apps/api/internal/segments/predicates"
)

// SegmentResolver loads the stored AST of a referenced segment so the
// composable in_segment / not_in_segment predicate (SUB-032) can splice
// it into a correlated subquery. Repo satisfies this via ASTForSegment.
//
// It is an interface (not *Repo) so the pure CompileAST path stays
// DB-free. Production population evaluation goes through CompilePopulation,
// which always supplies a resolver; CompileAST remains available to pure
// compiler/validation callers, where a segment_id predicate surfaces a clear
// "not supported here" error rather than a nil-pointer.
type SegmentResolver interface {
	// ASTForSegment returns the canonical query_ast JSON for the given
	// segment id, tenant-scoped. It MUST return ErrNotFound when the id
	// is unknown for the tenant.
	ASTForSegment(ctx context.Context, tenantID, segmentID string) (json.RawMessage, error)
}

// ErrComposableUnsupported is returned when a segment_id (in_segment /
// not_in_segment) predicate is compiled through the plain CompileAST
// path, which has no SegmentResolver wired. Use CompileASTWithResolver.
var ErrComposableUnsupported = errors.New("segments: segment_id predicate requires a resolver (use CompileASTWithResolver)")

// ErrReferencedSegmentUnavailable marks a compile that failed because a
// referenced segment's definition could not be read: a database or context
// failure, where every other compile error is about the definition itself. A
// referenced segment that no longer exists is a definition error, not this.
var ErrReferencedSegmentUnavailable = errors.New("segments: referenced segment could not be loaded")

// CompileAST compiles a canonical SegmentNode JSON blob into a parameterised
// SQL fragment that can be slotted into a query against the `subscribers`
// table:
//
//	SELECT count(*) FROM subscribers WHERE <fragment>
//
// The compiler mirrors services/migration/internal/translator/listmonk/segment.go;
// kept local to avoid importing the migrate Go module into apps/api (which
// would force a go.mod change in the gateway). The two implementations MUST
// stay behaviourally aligned — see SegmentNode in packages/schema/src/index.ts
// for the canonical shape.
//
// Supported field encoding:
//
//	"email"               -> subscribers.email
//	"status"              -> subscribers.status
//	"tag" / "tags"        -> membership against subscribers.tags
//	"consent_source"      -> subscribers.consent_source
//	"consent_timestamp"   -> subscribers.consent_timestamp
//	"last_opened_at"      -> max(opened) from subscriber_events
//	"last_clicked_at"     -> max(clicked) from subscriber_events
//	"last_event_at"       -> max(any engagement) from subscriber_events
//	"custom.<k>"          -> subscribers.custom_fields->>'<k>'
//	anything else         -> subscribers.custom_fields->>'<field>'
func CompileAST(raw json.RawMessage) (string, []any, error) {
	node, present, err := decodeAndValidateSegmentAST(raw)
	if err != nil {
		return "", nil, err
	}
	if !present {
		return "TRUE", nil, nil
	}
	c := &compiler{}
	frag, err := c.walk(node)
	if err != nil {
		return "", nil, err
	}
	return frag, c.args, nil
}

// CompileASTWithResolver is CompileAST with composable segment_id
// support (SUB-032). When the AST contains an in_segment /
// not_in_segment condition, the resolver loads the referenced segment's
// stored AST, recursively compiles it (carrying a depth counter that
// bails at predicates.MaxComposableDepth), and splices it into a
// correlated subquery via predicates.CompileComposable.
//
// ctx + tenantID are threaded so the resolver can run a tenant-scoped
// lookup. Production population consumers should use CompilePopulation so
// archive/status/consent scope cannot be omitted.
func CompileASTWithResolver(ctx context.Context, raw json.RawMessage, tenantID string, resolver SegmentResolver) (string, []any, error) {
	validationState := &segmentASTValidationState{}
	node, present, err := decodeAndValidateSegmentASTWithState(raw, validationState)
	if err != nil {
		return "", nil, err
	}
	if !present {
		return "TRUE", nil, nil
	}
	c := &compiler{
		ctx:                ctx,
		tenantID:           tenantID,
		resolver:           resolver,
		astValidationState: validationState,
	}
	frag, err := c.walk(node)
	if err != nil {
		return "", nil, err
	}
	return frag, c.args, nil
}

type astNode struct {
	Op         string          `json:"op"`
	Children   []astNode       `json:"children,omitempty"`
	Child      *astNode        `json:"child,omitempty"`
	Field      string          `json:"field,omitempty"`
	Comparator string          `json:"comparator,omitempty"`
	Value      json.RawMessage `json:"value,omitempty"`
}

type compiler struct {
	args []any
	// Composable (SUB-032) plumbing. These are zero/nil on the plain
	// CompileAST path, which makes a segment_id predicate surface
	// ErrComposableUnsupported instead of dereferencing a nil resolver.
	ctx      context.Context
	tenantID string
	resolver SegmentResolver
	// astValidationState is shared by composable child compilers so resolved
	// segment trees cannot multiply the canonical 64 KiB / 128-node budget.
	astValidationState *segmentASTValidationState
	// depth tracks how many in_segment hops deep we are so the
	// recursion bails at predicates.MaxComposableDepth.
	depth int
	// activeSegments is the current recursion stack. Unlike the depth guard,
	// this reports direct and indirect reference cycles deterministically while
	// still allowing the same segment to appear in independent sibling rules.
	activeSegments map[string]struct{}
}

func (c *compiler) placeholder(v any) string {
	c.args = append(c.args, v)
	return fmt.Sprintf("$%d", len(c.args))
}

func (c *compiler) walk(n astNode) (string, error) {
	switch strings.ToLower(n.Op) {
	case "and", "or":
		if len(n.Children) == 0 {
			return "TRUE", nil
		}
		parts := make([]string, 0, len(n.Children))
		for _, ch := range n.Children {
			sub, err := c.walk(ch)
			if err != nil {
				return "", err
			}
			parts = append(parts, "("+sub+")")
		}
		joiner := " AND "
		if strings.EqualFold(n.Op, "or") {
			joiner = " OR "
		}
		return strings.Join(parts, joiner), nil
	case "not":
		if n.Child == nil && len(n.Children) == 0 {
			return "TRUE", nil
		}
		var sub string
		var err error
		if n.Child != nil {
			sub, err = c.walk(*n.Child)
		} else {
			sub, err = c.walk(n.Children[0])
		}
		if err != nil {
			return "", err
		}
		return "NOT (" + sub + ")", nil
	case "condition":
		return c.condition(n)
	default:
		return "", fmt.Errorf("segments: unknown op %q", n.Op)
	}
}

func (c *compiler) condition(n astNode) (string, error) {
	if isTagField(n.Field) {
		return c.tagCondition(n)
	}
	if frag, handled, err := c.composableCondition(n); handled || err != nil {
		return frag, err
	}
	if frag, handled, err := c.consentCondition(n); handled || err != nil {
		return frag, err
	}
	if frag, handled, err := c.channelConsentCondition(n); handled || err != nil {
		return frag, err
	}
	if frag, handled, err := c.engagementDateCondition(n); handled || err != nil {
		return frag, err
	}
	if frag, handled, err := c.metricCondition(n); handled || err != nil {
		return frag, err
	}
	if frag, handled, err := c.customObjectCondition(n); handled || err != nil {
		return frag, err
	}
	col, isJSON := compileField(n.Field)

	switch strings.ToLower(n.Comparator) {
	case "is_null", "not_exists":
		return col + " IS NULL", nil
	case "is_not_null", "exists":
		return col + " IS NOT NULL", nil
	// `eq`/`neq` are the automation evaluator's historical spellings, accepted
	// here so the alias set is SYMMETRIC. That engine now accepts `equals`;
	// one-directional aliasing only relocates the divergence, because a
	// condition authored against the flow vocabulary would still fail to compile
	// into a segment. Applied at every comparator site rather than the first —
	// a partial alias is a new divergence wearing the fix's clothes.
	case "equals", "eq", "=":
		v, err := decodeScalar(n.Value, isJSON)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%s = %s", col, c.placeholder(v)), nil
	case "not_equals", "neq", "!=":
		v, err := decodeScalar(n.Value, isJSON)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%s <> %s", col, c.placeholder(v)), nil
	case "contains":
		s, _ := decodeString(n.Value)
		return fmt.Sprintf("%s ILIKE %s", col, c.placeholder("%"+s+"%")), nil
	case "not_contains":
		s, _ := decodeString(n.Value)
		return fmt.Sprintf("%s NOT ILIKE %s", col, c.placeholder("%"+s+"%")), nil
	case "starts_with":
		s, _ := decodeString(n.Value)
		return fmt.Sprintf("%s ILIKE %s", col, c.placeholder(s+"%")), nil
	case "ends_with":
		s, _ := decodeString(n.Value)
		return fmt.Sprintf("%s ILIKE %s", col, c.placeholder("%"+s)), nil
	case "gt", ">":
		if !isJSON {
			if fragment, handled, err := c.relativeDayComparison(col, ">", n.Value); handled || err != nil {
				return fragment, err
			}
		}
		v, err := decodeScalar(n.Value, false)
		if err != nil {
			return "", err
		}
		col = orderedJSONOperand(col, isJSON, v)
		return fmt.Sprintf("%s > %s", col, c.placeholder(v)), nil
	case "gte", ">=":
		if !isJSON {
			if fragment, handled, err := c.relativeDayComparison(col, ">=", n.Value); handled || err != nil {
				return fragment, err
			}
		}
		v, err := decodeScalar(n.Value, false)
		if err != nil {
			return "", err
		}
		col = orderedJSONOperand(col, isJSON, v)
		return fmt.Sprintf("%s >= %s", col, c.placeholder(v)), nil
	case "lt", "<":
		if !isJSON {
			if fragment, handled, err := c.relativeDayComparison(col, "<", n.Value); handled || err != nil {
				return fragment, err
			}
		}
		v, err := decodeScalar(n.Value, false)
		if err != nil {
			return "", err
		}
		col = orderedJSONOperand(col, isJSON, v)
		return fmt.Sprintf("%s < %s", col, c.placeholder(v)), nil
	case "lte", "<=":
		if !isJSON {
			if fragment, handled, err := c.relativeDayComparison(col, "<=", n.Value); handled || err != nil {
				return fragment, err
			}
		}
		v, err := decodeScalar(n.Value, false)
		if err != nil {
			return "", err
		}
		col = orderedJSONOperand(col, isJSON, v)
		return fmt.Sprintf("%s <= %s", col, c.placeholder(v)), nil
	case "in", "not_in":
		list, err := decodeList(n.Value)
		if err != nil {
			return "", err
		}
		if len(list) == 0 {
			if strings.ToLower(n.Comparator) == "in" {
				return "FALSE", nil
			}
			return "TRUE", nil
		}
		placeholders := make([]string, 0, len(list))
		for _, v := range list {
			placeholders = append(placeholders, c.placeholder(v))
		}
		op := "IN"
		if strings.ToLower(n.Comparator) == "not_in" {
			op = "NOT IN"
		}
		return fmt.Sprintf("%s %s (%s)", col, op, strings.Join(placeholders, ", ")), nil
	default:
		return "", fmt.Errorf("segments: unknown comparator %q", n.Comparator)
	}
}

func (c *compiler) tagCondition(n astNode) (string, error) {
	switch strings.ToLower(n.Comparator) {
	case "added_in_last_days":
		return c.tagLifecycleCondition(n, predicates.TagActionAdded)
	case "removed_in_last_days":
		return c.tagLifecycleCondition(n, predicates.TagActionRemoved)
	case "equals", "eq", "=":
		s, err := decodeString(n.Value)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%s = ANY(subscribers.tags)", c.placeholder(s)), nil
	case "not_equals", "neq", "!=":
		s, err := decodeString(n.Value)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("NOT (%s = ANY(subscribers.tags))", c.placeholder(s)), nil
	case "contains":
		s, err := decodeString(n.Value)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("EXISTS (SELECT 1 FROM unnest(subscribers.tags) AS tag WHERE tag ILIKE %s)", c.placeholder("%"+s+"%")), nil
	case "not_contains":
		s, err := decodeString(n.Value)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("NOT EXISTS (SELECT 1 FROM unnest(subscribers.tags) AS tag WHERE tag ILIKE %s)", c.placeholder("%"+s+"%")), nil
	case "starts_with":
		s, err := decodeString(n.Value)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("EXISTS (SELECT 1 FROM unnest(subscribers.tags) AS tag WHERE tag ILIKE %s)", c.placeholder(s+"%")), nil
	case "ends_with":
		s, err := decodeString(n.Value)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("EXISTS (SELECT 1 FROM unnest(subscribers.tags) AS tag WHERE tag ILIKE %s)", c.placeholder("%"+s)), nil
	case "in", "not_in":
		list, err := decodeList(n.Value)
		if err != nil {
			return "", err
		}
		if len(list) == 0 {
			if strings.ToLower(n.Comparator) == "in" {
				return "FALSE", nil
			}
			return "TRUE", nil
		}
		placeholders := make([]string, 0, len(list))
		for _, v := range list {
			placeholders = append(placeholders, c.placeholder(fmt.Sprint(v)))
		}
		expr := fmt.Sprintf("subscribers.tags && ARRAY[%s]::text[]", strings.Join(placeholders, ", "))
		if strings.ToLower(n.Comparator) == "not_in" {
			return "NOT (" + expr + ")", nil
		}
		return expr, nil
	default:
		return "", fmt.Errorf("segments: unsupported comparator %q for tags", n.Comparator)
	}
}

// JSONB ->> produces text. When an ordered rule carries a numeric value,
// compare against a guarded numeric projection instead of evaluating
// `text > double precision` or doing a lexical comparison. Dirty legacy
// values become NULL and do not match rather than aborting the query.
func orderedJSONOperand(col string, isJSON bool, value any) string {
	if !isJSON {
		return col
	}
	switch value.(type) {
	case float64, float32, int, int32, int64, uint, uint32, uint64:
		return fmt.Sprintf("(CASE WHEN %s ~ '^-?[0-9]+([.][0-9]+)?$' THEN (%s)::numeric END)", col, col)
	default:
		return col
	}
}

func compileField(f string) (col string, isJSONExtract bool) {
	switch strings.ToLower(f) {
	case "email":
		return "subscribers.email", false
	case "status":
		return "subscribers.status", false
	case "mailchimp_status":
		return "subscribers.mailchimp_status", false
	case "country":
		return "subscribers.country", false
	case "language":
		return "subscribers.language", false
	case "created_at":
		return "subscribers.created_at", false
	case "contact_rating":
		// Mailchimp-parity star rating (subscribers.rating SMALLINT 1..5, NULL =
		// unrated). A direct profile column, so numeric comparators + is_null
		// behave exactly like the RFM/predictive numeric predicates.
		return "subscribers.rating", false
	case "name":
		return "subscribers.custom_fields->>'name'", true
	case "consent_source":
		return "subscribers.consent_source", false
	case "consent_timestamp":
		return "subscribers.consent_timestamp", false
	case "last_opened_at":
		return "(SELECT max(e.at) FROM subscriber_events e WHERE e.tenant_id = subscribers.tenant_id AND e.subscriber_email = subscribers.email AND e.event_type = 'opened')", false
	case "last_clicked_at":
		return "(SELECT max(e.at) FROM subscriber_events e WHERE e.tenant_id = subscribers.tenant_id AND e.subscriber_email = subscribers.email AND e.event_type = 'clicked')", false
	case "last_event_at":
		return "(SELECT max(e.at) FROM subscriber_events e WHERE e.tenant_id = subscribers.tenant_id AND e.subscriber_email = subscribers.email)", false
	case "predictive.historic_clv_cents":
		return predictiveField("historic_clv_cents"), false
	case "predictive.predicted_clv_cents":
		return predictiveField("predicted_clv_cents"), false
	case "predictive.total_clv_cents":
		return predictiveField("total_clv_cents"), false
	case "predictive.churn_risk":
		return predictiveField("churn_risk"), false
	case "predictive.predicted_order_count":
		return predictiveField("predicted_order_count"), false
	case "predictive.average_days_between_orders":
		return predictiveField("average_days_between_orders"), false
	case "predictive.data_sufficiency":
		return predictiveField("data_sufficiency"), false
	case "rfm.segment_key":
		return rfmField("segment_key"), false
	case "rfm.recency_score":
		return rfmField("recency_score"), false
	case "rfm.frequency_score":
		return rfmField("frequency_score"), false
	case "rfm.monetary_score":
		return rfmField("monetary_score"), false
	case "rfm.recency_days":
		return rfmField("recency_days"), false
	case "rfm.frequency":
		return rfmField("frequency"), false
	case "rfm.monetary_cents":
		return rfmField("monetary_cents"), false
	}
	if strings.HasPrefix(strings.ToLower(f), "custom.") {
		key := f[len("custom."):]
		return fmt.Sprintf("subscribers.custom_fields->>'%s'", strings.ReplaceAll(key, "'", "''")), true
	}
	return fmt.Sprintf("subscribers.custom_fields->>'%s'", strings.ReplaceAll(f, "'", "''")), true
}

func predictiveField(column string) string {
	return fmt.Sprintf("(SELECT p.%s FROM profile_predictions p WHERE p.tenant_id = subscribers.tenant_id AND lower(p.email::text) = lower(subscribers.email::text) LIMIT 1)", column)
}

func rfmField(column string) string {
	return fmt.Sprintf("(SELECT r.%s FROM profile_rfm_scores r WHERE r.tenant_id = subscribers.tenant_id AND lower(r.email::text) = lower(subscribers.email::text) LIMIT 1)", column)
}

func isTagField(f string) bool {
	switch strings.ToLower(f) {
	case "tag", "tags":
		return true
	default:
		return false
	}
}

func decodeScalar(raw json.RawMessage, jsonExtract bool) (any, error) {
	if len(raw) == 0 {
		return nil, errors.New("segments: missing value")
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	if jsonExtract {
		// JSONB ->> always returns text; coerce non-strings.
		switch t := v.(type) {
		case string:
			return t, nil
		default:
			return fmt.Sprintf("%v", t), nil
		}
	}
	return v, nil
}

func decodeString(raw json.RawMessage) (string, error) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return "", err
	}
	switch t := v.(type) {
	case string:
		return t, nil
	default:
		return fmt.Sprintf("%v", t), nil
	}
}

// consentCondition routes consent.* predicate conditions through the
// dedicated consent vector helpers (see predicates/consent.go).
// Returns (fragment, handled, err) — handled=false means the caller
// should fall through to the generic field compiler.
func (c *compiler) consentCondition(n astNode) (string, bool, error) {
	field := strings.ToLower(strings.TrimSpace(n.Field))
	if !strings.HasPrefix(field, "consent.") {
		return "", false, nil
	}
	purpose := strings.TrimPrefix(field, "consent.")

	// consent.<purpose>_at → raw timestamptz column, all comparators
	// flow through the standard scalar path against subscribers.<col>.
	if strings.HasSuffix(purpose, "_at") {
		bare := strings.TrimSuffix(purpose, "_at")
		col, ok := predicates.ConsentTimestampColumn(bare)
		if !ok {
			return "", false, nil
		}
		frag, err := c.scalarCondition(col, false, n.Comparator, n.Value)
		if err != nil {
			return "", true, err
		}
		return frag, true, nil
	}

	// consent.<purpose> → boolean "currently consented" expression.
	boolExpr, err := predicates.ConsentBooleanFragment(purpose)
	if err != nil {
		// Unknown purpose: fall through so the generic compiler can
		// emit its JSONB extract (preserves backward compat with
		// arbitrary consent.* custom-field shapes).
		return "", false, nil
	}
	switch strings.ToLower(n.Comparator) {
	case "equals", "eq", "=":
		v, err := decodeScalar(n.Value, false)
		if err != nil {
			return "", true, err
		}
		return fmt.Sprintf("%s = %s", boolExpr, c.placeholder(v)), true, nil
	case "not_equals", "neq", "!=":
		v, err := decodeScalar(n.Value, false)
		if err != nil {
			return "", true, err
		}
		return fmt.Sprintf("%s <> %s", boolExpr, c.placeholder(v)), true, nil
	default:
		return "", true, fmt.Errorf("segments: unsupported comparator %q for consent boolean predicate", n.Comparator)
	}
}

// channelConsentCondition routes channel_consent.* predicate conditions
// through predicates.CompileChannelConsent (SUB-051). The field encodes
// the channel — channel_consent.email / channel_consent.sms /
// channel_consent.push — and the boolean value is the can-receive state:
//
//	{field:"channel_consent.email", comparator:"equals",     value:true}  → can receive on email
//	{field:"channel_consent.sms",   comparator:"not_equals", value:true}  → cannot receive on sms
//
// This is what the campaign send-guard injects at activation time to
// auto-exclude profiles lacking consent for the target channel. push has
// no consent-vector column yet, so the predicate compiles to a
// deterministic TRUE/FALSE (see CompileChannelConsent) rather than
// silently including the whole base.
//
// Returns (fragment, handled, err) — handled=false means the caller
// should fall through to the generic field compiler.
func (c *compiler) channelConsentCondition(n astNode) (string, bool, error) {
	field := strings.ToLower(strings.TrimSpace(n.Field))
	const prefix = "channel_consent."
	if !strings.HasPrefix(field, prefix) {
		return "", false, nil
	}
	channel := strings.TrimPrefix(field, prefix)

	// The value is the can-receive boolean; the comparator decides whether
	// we keep it (equals) or invert it (not_equals). Default-absent value
	// is treated as `true` so a bare channel_consent.email predicate means
	// "can receive on email".
	want := true
	if len(n.Value) > 0 {
		v, err := decodeScalar(n.Value, false)
		if err != nil {
			return "", true, err
		}
		b, ok := v.(bool)
		if !ok {
			return "", true, fmt.Errorf("segments: channel_consent value must be a boolean")
		}
		want = b
	}
	switch strings.ToLower(n.Comparator) {
	case "equals", "=", "":
		// keep want
	case "not_equals", "neq", "!=":
		want = !want
	default:
		return "", true, fmt.Errorf("segments: unsupported comparator %q for channel_consent predicate", n.Comparator)
	}

	frag, err := predicates.CompileChannelConsent(predicates.ChannelConsentInput{
		Channel:    channel,
		CanReceive: want,
	})
	if err != nil {
		return "", true, fmt.Errorf("segments: %w", err)
	}
	// CompileChannelConsent emits a static, arg-free SQL fragment (column
	// IS [NOT] NULL or a literal TRUE/FALSE), so there are no placeholders
	// to renumber through c.placeholder.
	return frag.SQL, true, nil
}

// engagementDateCondition implements the ergonomic comparator vocabulary
// advertised for last_opened_at / last_clicked_at / last_event_at. These are
// real correlated timestamp expressions, not custom-field fallbacks.
func (c *compiler) engagementDateCondition(n astNode) (string, bool, error) {
	field := strings.ToLower(strings.TrimSpace(n.Field))
	if field != "last_opened_at" && field != "last_clicked_at" && field != "last_event_at" {
		return "", false, nil
	}
	col, _ := compileField(field)
	switch strings.ToLower(strings.TrimSpace(n.Comparator)) {
	case "in_last_days":
		days, err := engagementWindowDays(n.Value)
		if err != nil {
			return "", true, err
		}
		return fmt.Sprintf("%s >= now() - make_interval(days => %s::int)", col, c.placeholder(days)), true, nil
	case "more_than_days_ago":
		days, err := engagementWindowDays(n.Value)
		if err != nil {
			return "", true, err
		}
		return fmt.Sprintf("(%s IS NULL OR %s < now() - make_interval(days => %s::int))", col, col, c.placeholder(days)), true, nil
	case "ever":
		return col + " IS NOT NULL", true, nil
	case "never":
		return col + " IS NULL", true, nil
	default:
		return "", false, nil
	}
}

func engagementWindowDays(raw json.RawMessage) (int, error) {
	if len(raw) == 0 {
		return 0, errors.New("segments: engagement window requires a positive day count")
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, fmt.Errorf("segments: decode engagement window: %w", err)
	}
	days := 0
	switch typed := value.(type) {
	case float64:
		if typed == float64(int(typed)) {
			days = int(typed)
		}
	case string:
		candidate := strings.ToLower(strings.TrimSpace(typed))
		if strings.HasPrefix(candidate, "now-") && strings.HasSuffix(candidate, "d") {
			candidate = strings.TrimSuffix(strings.TrimPrefix(candidate, "now-"), "d")
		}
		days, _ = strconv.Atoi(candidate)
	}
	if days <= 0 || days > 36500 {
		return 0, errors.New("segments: engagement window must be between 1 and 36500 days")
	}
	return days, nil
}

// relativeDayComparison turns the canonical now±Nd wire grammar into
// executable rolling-time SQL. Passing the raw token as a timestamptz
// parameter would make PostgreSQL reject values such as "now-7d".
func (c *compiler) relativeDayComparison(col, operator string, raw json.RawMessage) (string, bool, error) {
	var token string
	if err := json.Unmarshal(raw, &token); err != nil {
		return "", false, nil
	}
	token = strings.ToLower(strings.TrimSpace(token))
	if !strings.HasPrefix(token, "now") || !strings.HasSuffix(token, "d") {
		return "", false, nil
	}
	direction := token[3]
	if direction != '-' && direction != '+' {
		return "", false, nil
	}
	days, err := strconv.Atoi(strings.TrimSuffix(token[4:], "d"))
	if err != nil || days <= 0 || days > 36500 {
		return "", true, errors.New("segments: relative day window must be between 1 and 36500 days")
	}
	sign := "-"
	if direction == '+' {
		sign = "+"
	}
	return fmt.Sprintf("%s %s now() %s make_interval(days => %s::int)", col, operator, sign, c.placeholder(days)), true, nil
}

// scalarCondition is a column-agnostic version of condition()'s
// scalar-comparator dispatch — extracted so consentCondition can
// reuse the same comparator semantics against a synthetic column
// expression.
func (c *compiler) scalarCondition(col string, isJSON bool, comparator string, raw json.RawMessage) (string, error) {
	switch strings.ToLower(comparator) {
	case "is_null":
		return col + " IS NULL", nil
	case "is_not_null":
		return col + " IS NOT NULL", nil
	case "equals", "eq", "=":
		v, err := decodeScalar(raw, isJSON)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%s = %s", col, c.placeholder(v)), nil
	case "not_equals", "neq", "!=":
		v, err := decodeScalar(raw, isJSON)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%s <> %s", col, c.placeholder(v)), nil
	case "gt", ">":
		v, err := decodeScalar(raw, false)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%s > %s", col, c.placeholder(v)), nil
	case "gte", ">=":
		v, err := decodeScalar(raw, false)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%s >= %s", col, c.placeholder(v)), nil
	case "lt", "<":
		v, err := decodeScalar(raw, false)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%s < %s", col, c.placeholder(v)), nil
	case "lte", "<=":
		v, err := decodeScalar(raw, false)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%s <= %s", col, c.placeholder(v)), nil
	default:
		return "", fmt.Errorf("segments: unsupported comparator %q for column %s", comparator, col)
	}
}

// tagLifecycleCondition compiles "tag <action> in the last N days"
// against tag_history (migration 0292). Uses the value-parser from
// predicates/tag_lifecycle.go and renumbers the helper's $1..$3
// placeholders through c.placeholder so they align with the
// outer compiler's running args index.
func (c *compiler) tagLifecycleCondition(n astNode, action predicates.TagLifecycleAction) (string, error) {
	var raw any
	if len(n.Value) > 0 {
		if err := json.Unmarshal(n.Value, &raw); err != nil {
			return "", fmt.Errorf("segments: decode tag lifecycle value: %w", err)
		}
	}
	in, err := predicates.ParseLifecycleValue(raw)
	if err != nil {
		return "", err
	}
	frag, err := predicates.TagLifecycleFragment(action, in)
	if err != nil {
		return "", err
	}
	if frag.SQL == "FALSE" || frag.SQL == "TRUE" {
		return frag.SQL, nil
	}
	// Rewrite $1/$2/$3 → live placeholders bound through c.placeholder
	// so the parent compiler's running index stays correct.
	placeholders := make([]string, len(frag.Args))
	for i, a := range frag.Args {
		placeholders[i] = c.placeholder(a)
	}
	sql := frag.SQL
	for i := len(placeholders) - 1; i >= 0; i-- {
		sql = strings.ReplaceAll(sql, fmt.Sprintf("$%d", i+1), placeholders[i])
	}
	return sql, nil
}

// customObjectCondition compiles a {category: "custom_object"} predicate by
// delegating to the registered customobjects.BuildSegmentPredicate plug-in,
// scoped to the subscriber's profile_object_links (SUB-011). This is the
// resolver/evaluation path that makes profile object links queryable in
// segmentation — without it, custom_object.* fields fell through to the
// generic custom_fields JSONB extract and never reached the predicate
// registry / profile_object_links at all.
//
// Field encoding: "custom_object.<typeKey>.<property>" — e.g.
// "custom_object.order.total". A bare "custom_object.<typeKey>" (no
// property) compiles to an existence test on the comparator
// (exists/not_exists), so "subscriber is linked to any order" works.
//
// Returns (fragment, handled, err). handled=false means the field is not a
// custom_object field and the caller should fall through to the generic
// compiler.
func (c *compiler) customObjectCondition(n astNode) (string, bool, error) {
	field := strings.TrimSpace(n.Field)
	const prefix = "custom_object."
	if !strings.HasPrefix(strings.ToLower(field), prefix) {
		return "", false, nil
	}
	rest := field[len(prefix):]
	// Split typeKey.property — only the FIRST dot separates the type key
	// from the (possibly dotted) property path, so
	// "custom_object.order.shipping_address.country" yields
	// typeKey="order", property="shipping_address.country".
	typeKey := rest
	property := ""
	if dot := strings.IndexByte(rest, '.'); dot >= 0 {
		typeKey = rest[:dot]
		property = rest[dot+1:]
	}
	if typeKey == "" {
		return "", true, errors.New("segments: custom_object predicate requires a type key (custom_object.<type>.<property>)")
	}

	value, err := customObjectValue(n.Value)
	if err != nil {
		return "", true, err
	}

	spec := customobjects.PredicateSpec{
		ObjectTypeKey: typeKey,
		Property:      property,
		Comparator:    normalizeCustomObjectComparator(n.Comparator),
		Value:         value,
		// SUB-011: scope to the subscriber's linked records so the segment
		// resolves against profile_object_links, not every record in the
		// tenant.
		LinkedToProfile: true,
	}
	frag, err := customobjects.BuildSegmentPredicate(spec)
	if err != nil {
		return "", true, fmt.Errorf("segments: %w", err)
	}
	// not_exists predicates compile to a `NOT EXISTS (...)` fragment that is
	// already correctly inverted by BuildSegmentPredicate.

	// Renumber the plug-in's $1..$N placeholders through c.placeholder so the
	// parent compiler's running arg index stays correct (same technique as
	// tagLifecycleCondition).
	placeholders := make([]string, len(frag.Args))
	for i, a := range frag.Args {
		placeholders[i] = c.placeholder(a)
	}
	sql := frag.SQL
	for i := len(placeholders) - 1; i >= 0; i-- {
		sql = strings.ReplaceAll(sql, fmt.Sprintf("$%d", i+1), placeholders[i])
	}
	return sql, true, nil
}

// composableCondition compiles a segment-of-segments predicate (SUB-032):
// field "segment_id" with comparator "in_segment" / "not_in_segment".
// It loads the referenced segment's stored AST via the resolver,
// recursively compiles it (carrying the depth counter so nesting bails
// at predicates.MaxComposableDepth), then splices the inner fragment
// into a correlated subquery via predicates.CompileComposable.
//
// The value carries the referenced segment id — accepted either as a
// bare string ("seg-uuid") or as an object {"segment_id":"..."} so the
// visual builder can attach a label alongside the id.
//
// Returns (fragment, handled, err); handled=false means the field is not
// segment_id and the caller falls through to the generic compiler.
func (c *compiler) composableCondition(n astNode) (string, bool, error) {
	field := strings.ToLower(strings.TrimSpace(n.Field))
	if field != "segment_id" && field != "segment" {
		return "", false, nil
	}
	mode := strings.ToLower(strings.TrimSpace(n.Comparator))
	if mode == "" {
		mode = "in_segment"
	}
	switch mode {
	case "in_segment", "not_in_segment":
	default:
		return "", true, fmt.Errorf("segments: segment_id supports only in_segment / not_in_segment, got %q", n.Comparator)
	}
	if c.resolver == nil {
		return "", true, ErrComposableUnsupported
	}
	segID, err := composableSegmentID(n.Value)
	if err != nil {
		return "", true, err
	}
	if segID == "" {
		return "", true, errors.New("segments: segment_id predicate requires a referenced segment id in value")
	}
	if c.activeSegments == nil {
		c.activeSegments = make(map[string]struct{})
	}
	if _, active := c.activeSegments[segID]; active {
		return "", true, fmt.Errorf("segments: composable segment reference cycle at %q", segID)
	}
	// Depth guard: each in_segment hop increments depth. Check for a cycle
	// first so a short A -> B -> A loop is diagnosed as such rather than as
	// generic excessive nesting.
	if c.depth+1 > predicates.MaxComposableDepth {
		return "", true, fmt.Errorf("segments: composable segment nesting exceeds max depth %d", predicates.MaxComposableDepth)
	}
	c.activeSegments[segID] = struct{}{}
	defer delete(c.activeSegments, segID)

	ctx := c.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	innerAST, err := c.resolver.ASTForSegment(ctx, c.tenantID, segID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return "", true, fmt.Errorf("segments: referenced segment %q not found", segID)
		}
		return "", true, fmt.Errorf("%w (%q): %w", ErrReferencedSegmentUnavailable, segID, err)
	}

	// Recursively compile the referenced segment's AST with an
	// independent inner compiler that shares the resolver/tenant and an
	// incremented depth. We start its placeholders at $1 and let
	// CompileComposable shift them past the parent's already-bound args.
	inner := &compiler{
		ctx:                ctx,
		tenantID:           c.tenantID,
		resolver:           c.resolver,
		astValidationState: c.astValidationState,
		depth:              c.depth + 1,
		activeSegments:     c.activeSegments,
	}
	validationState := c.astValidationState
	if validationState == nil {
		validationState = &segmentASTValidationState{}
		inner.astValidationState = validationState
	}
	innerNode, present, err := decodeAndValidateSegmentASTWithState(innerAST, validationState)
	if err != nil {
		return "", true, fmt.Errorf("segments: validate referenced segment %q ast: %w", segID, err)
	}
	innerSQL := "TRUE"
	if present {
		innerSQL, err = inner.walk(innerNode)
		if err != nil {
			return "", true, fmt.Errorf("segments: compile referenced segment %q: %w", segID, err)
		}
	}

	frag, err := predicates.CompileComposable(predicates.ComposableInput{
		SegmentID:         segID,
		Mode:              mode,
		PlaceholderOffset: len(c.args),
		InnerSQL:          innerSQL,
		InnerArgs:         inner.args,
	})
	if err != nil {
		return "", true, fmt.Errorf("segments: %w", err)
	}
	// CompileComposable shifted its inner placeholders past the parent args,
	// so register only the executable inner arguments in order.
	c.args = append(c.args, frag.Args...)
	return frag.SQL, true, nil
}

// composableSegmentID extracts the referenced segment id from a
// segment_id predicate value. Accepts a bare JSON string or an object
// {"segment_id":"...","id":"..."}.
func composableSegmentID(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return strings.TrimSpace(s), nil
	}
	var obj struct {
		SegmentID string `json:"segment_id"`
		ID        string `json:"id"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil {
		if obj.SegmentID != "" {
			return strings.TrimSpace(obj.SegmentID), nil
		}
		return strings.TrimSpace(obj.ID), nil
	}
	return "", fmt.Errorf("segments: cannot decode segment_id value %q", string(raw))
}

// metricCondition compiles a metric.* event-aggregate predicate
// (SUB-028) by delegating to predicates.CompileAggregate, which emits a
// correlated subquery over product_events scoped to the subscriber.
//
// Field encoding: "metric.<source>.<event>.<aggregation>" — e.g. the
// registry-advertised "metric.track.added_to_cart.count". The trailing
// token is the aggregation (count|sum|avg|min|max); the segment between
// the source token and the aggregation token is the event-name slug.
// Because the registry slug is lossy (non-alnum → "_"), the AST value
// SHOULD carry the canonical event_name; we use the slug only as a
// fallback when the value omits it.
//
// Value formats (any of):
//   - a bare number — all-time aggregate, e.g. value: 3
//   - {"count": N}                 — all-time (count alias)
//   - {"value": N, "days": D}      — windowed: aggregate over last D days
//   - {"count": N, "days": D, "event_name": "...", "aggregation": "sum",
//     "property": "total"} — fully specified
//
// Comparators: the existing numeric set (equals/not_equals/gt/gte/lt/lte)
// plus the time-window aliases in_last_days / more_than_days_ago, which
// are sugar for ">= 1 occurrence within / outside the window" — they
// pin aggregation=count and force the comparator to gte/equals against a
// threshold of 1.
//
// Returns (fragment, handled, err); handled=false means the field is not
// a metric.* field and the caller falls through to the generic compiler.
func (c *compiler) metricCondition(n astNode) (string, bool, error) {
	field := strings.TrimSpace(n.Field)
	const prefix = "metric."
	if !strings.HasPrefix(strings.ToLower(field), prefix) {
		return "", false, nil
	}
	rest := field[len(prefix):] // e.g. "track.added_to_cart.count"

	// Aggregation = last dotted token; event slug = middle. With fewer
	// than 3 tokens (e.g. "metric.opened") default aggregation=count and
	// take the remainder as the slug.
	tokens := strings.Split(rest, ".")
	aggFromKey := "count"
	slug := rest
	if len(tokens) >= 3 {
		aggFromKey = tokens[len(tokens)-1]
		slug = strings.Join(tokens[1:len(tokens)-1], ".")
	} else if len(tokens) == 2 {
		// "<source>.<event>" with no aggregation suffix.
		slug = tokens[1]
	}

	mv, err := parseMetricValue(n.Value)
	if err != nil {
		return "", true, err
	}

	// value.event_name names the event exactly. Without it the key's slug
	// stands for every event whose name has that slug: the registry offers
	// "Placed Order" as metric.track.placed_order.count, and rules saved,
	// or sent by API, MCP or desktop clients, with only the key must count
	// those events rather than ones literally called placed_order.
	if strings.TrimSpace(mv.EventName) == "" && strings.TrimSpace(slug) == "" {
		return "", true, errors.New("segments: metric predicate requires an event name (in the field slug or value.event_name)")
	}

	aggregation := mv.Aggregation
	if aggregation == "" {
		aggregation = aggFromKey
	}

	comparator := strings.ToLower(strings.TrimSpace(n.Comparator))
	threshold := mv.Value
	windowDays := mv.Days
	switch comparator {
	case "in_last_days":
		// "did at least once in the last N days". The threshold value
		// supplies the window when days is absent.
		aggregation = "count"
		if windowDays <= 0 {
			windowDays = numFromAny(threshold)
		}
		comparator = "gte"
		threshold = 1
	case "more_than_days_ago":
		// "has NOT happened in the last N days" — count over the window
		// equals zero.
		aggregation = "count"
		if windowDays <= 0 {
			windowDays = numFromAny(threshold)
		}
		comparator = "equals"
		threshold = 0
	}

	in := predicates.AggregateInput{
		EventName:         mv.EventName,
		EventSlug:         slug,
		Aggregation:       aggregation,
		PropertyPath:      mv.Property,
		WindowDays:        windowDays,
		Comparator:        comparator,
		Value:             threshold,
		PlaceholderOffset: len(c.args) + 1,
	}
	frag, err := predicates.CompileAggregate(in)
	if err != nil {
		return "", true, fmt.Errorf("segments: %w", err)
	}
	// CompileAggregate already numbered its placeholders starting at
	// PlaceholderOffset, so we only need to register the bound args in
	// order — no string rewrite required.
	c.args = append(c.args, frag.Args...)
	return frag.SQL, true, nil
}

// metricValue is the decoded metric.* AST value.
type metricValue struct {
	EventName   string
	Aggregation string
	Property    string
	Days        int
	Value       any
}

// parseMetricValue normalizes the polymorphic metric value (bare number
// or an object) into a metricValue. A bare number is the all-time
// threshold; an object may carry count/value/days/event_name/
// aggregation/property.
func parseMetricValue(raw json.RawMessage) (metricValue, error) {
	out := metricValue{Value: 0}
	if len(raw) == 0 {
		return out, nil
	}
	// Try object first.
	var obj struct {
		Count       *json.Number `json:"count,omitempty"`
		Value       *json.Number `json:"value,omitempty"`
		Days        *json.Number `json:"days,omitempty"`
		EventName   string       `json:"event_name,omitempty"`
		Aggregation string       `json:"aggregation,omitempty"`
		Property    string       `json:"property,omitempty"`
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&obj); err == nil && (obj.Count != nil || obj.Value != nil || obj.Days != nil || obj.EventName != "" || obj.Aggregation != "" || obj.Property != "") {
		out.EventName = strings.TrimSpace(obj.EventName)
		out.Aggregation = strings.ToLower(strings.TrimSpace(obj.Aggregation))
		out.Property = strings.TrimSpace(obj.Property)
		if obj.Days != nil {
			out.Days = numFromJSON(*obj.Days)
		}
		switch {
		case obj.Value != nil:
			out.Value = numAnyFromJSON(*obj.Value)
		case obj.Count != nil:
			out.Value = numAnyFromJSON(*obj.Count)
		}
		return out, nil
	}
	// Fall back to a bare scalar (number).
	var num json.Number
	d2 := json.NewDecoder(strings.NewReader(string(raw)))
	d2.UseNumber()
	if err := d2.Decode(&num); err == nil {
		out.Value = numAnyFromJSON(num)
		return out, nil
	}
	return out, fmt.Errorf("segments: cannot decode metric value %q", string(raw))
}

// numFromJSON parses a json.Number into an int (truncating), 0 on error.
func numFromJSON(n json.Number) int {
	if i, err := n.Int64(); err == nil {
		return int(i)
	}
	if f, err := n.Float64(); err == nil {
		return int(f)
	}
	return 0
}

// numAnyFromJSON keeps integral numbers as int64 and fractional as
// float64 so the bound arg drives a clean ::numeric comparison.
func numAnyFromJSON(n json.Number) any {
	if i, err := n.Int64(); err == nil {
		return i
	}
	if f, err := n.Float64(); err == nil {
		return f
	}
	return 0
}

// numFromAny coerces an already-decoded value into an int window/days.
func numFromAny(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case int64:
		return int(t)
	case float64:
		return int(t)
	case json.Number:
		return numFromJSON(t)
	}
	return 0
}

// normalizeCustomObjectComparator maps the segment AST comparator vocabulary
// (equals/=, not_equals/!=, etc.) onto the customobjects predicate
// vocabulary (eq, neq, gt, gte, ...).
func normalizeCustomObjectComparator(c string) string {
	switch strings.ToLower(strings.TrimSpace(c)) {
	case "equals", "=", "eq":
		return "eq"
	case "not_equals", "!=", "neq":
		return "neq"
	case "gt", ">":
		return "gt"
	case "gte", ">=":
		return "gte"
	case "lt", "<":
		return "lt"
	case "lte", "<=":
		return "lte"
	case "contains":
		return "contains"
	case "not_contains":
		return "not_contains"
	case "in":
		return "in"
	case "not_in":
		return "not_in"
	case "exists":
		return "exists"
	case "not_exists":
		return "not_exists"
	default:
		// Pass through; BuildSegmentPredicate rejects unknown comparators.
		return strings.ToLower(strings.TrimSpace(c))
	}
}

// customObjectValue normalizes the AST value into the string form
// BuildSegmentPredicate expects. A JSON array (for in/not_in) is joined with
// commas; scalars are stringified; an absent value is "".
func customObjectValue(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", nil
	}
	// Try array first (in/not_in).
	var arr []any
	if err := json.Unmarshal(raw, &arr); err == nil {
		parts := make([]string, 0, len(arr))
		for _, v := range arr {
			parts = append(parts, fmt.Sprintf("%v", v))
		}
		return strings.Join(parts, ","), nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return "", fmt.Errorf("segments: decode custom_object value: %w", err)
	}
	if s, ok := v.(string); ok {
		return s, nil
	}
	return fmt.Sprintf("%v", v), nil
}

func decodeList(raw json.RawMessage) ([]any, error) {
	var arr []any
	if err := json.Unmarshal(raw, &arr); err != nil {
		// Tolerate a single comma-separated string for convenience.
		var s string
		if err2 := json.Unmarshal(raw, &s); err2 == nil {
			parts := strings.Split(s, ",")
			out := make([]any, 0, len(parts))
			for _, p := range parts {
				p = strings.TrimSpace(p)
				if p != "" {
					out = append(out, p)
				}
			}
			return out, nil
		}
		return nil, err
	}
	return arr, nil
}
