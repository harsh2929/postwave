// Package orchestrator — verification report builder.
//
// Given a completed (or dry-run) MigrationJob, BuildReport produces a
// canonical.VerificationReport summarising what was imported, what landed
// where, and how much fidelity we lost translating between source platform
// semantics and Moosewave's canonical schema.
//
// The verifier is intentionally pure: it takes already-collected canonical
// data + the job's progress counters and computes the report without any
// further IO. The orchestrator's resource loops feed it via the AccumulateX
// methods so the verifier doesn't have to re-walk the source.
package orchestrator

import (
	"reflect"
	"strings"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// VerifierInput is the bag of inputs BuildReport needs. It's populated
// incrementally during the run; orchestrator.Run feeds the resource loops'
// outputs in here before invoking BuildReport at the end.
type VerifierInput struct {
	Discovery adapter.DiscoveryReport

	// Subscriber-level totals from the source pull.
	SubscribersSeen            int
	SubscribersSkipped         int
	SubscribersErrored         int
	SuppressionListSize        int
	ConsentKnown               int
	ConsentUnknown             int
	SubscriberTagsSeen         int
	SubscriberTagsUnique       map[string]struct{}
	SubscriberTagCounts        map[string]int
	SubscriberSourceIDs        map[string]struct{}
	PremiumMembershipsObserved int
	StaticSegmentMemberships   int
	CustomFieldsSeen           map[string]string // raw source field name → observed type
	CustomFieldsCanonical      map[string]string // raw source field name → canonical name (set when classification succeeded)
	SubscriberFirstSeen        map[string]canonical.Subscriber
	SubscriberMergeConflicts   map[string]canonical.SubscriberMergeConflict

	// Segment-level translation outcomes.
	Segments             []canonical.Segment
	SegmentTranslateErrs map[string]string // segment name → warning message

	// Automation-level translation outcomes.
	Automations            []canonical.Automation
	AutomationsUnsupported []canonical.AutomationUnsupported

	// Counters from the orchestrator.
	PaidSubsImported      int
	ArchiveImported       int
	ArchiveWarnings       []canonical.ResourceWarning
	TemplatesImported     int
	TemplateWarnings      []canonical.ResourceWarning
	SourceArchiveImported int
	SourceArchiveWarnings []canonical.ResourceWarning
	SourceArchiveByType   map[string]int
	// Customer.io emits the same expected rebuild limitation on every record
	// in a source-archive category. Keep one top-level audit warning per
	// category/message so a large suppression or workflow inventory cannot
	// inflate the verification report linearly; each ledger item still retains
	// its own warning.
	customerIOSourceArchiveWarningKeys map[string]struct{}
}

// NewVerifierInput returns an empty input ready for the orchestrator to
// populate during a run.
func NewVerifierInput() *VerifierInput {
	return &VerifierInput{
		CustomFieldsSeen:         map[string]string{},
		CustomFieldsCanonical:    map[string]string{},
		SubscriberTagsUnique:     map[string]struct{}{},
		SubscriberTagCounts:      map[string]int{},
		SubscriberSourceIDs:      map[string]struct{}{},
		SubscriberFirstSeen:      map[string]canonical.Subscriber{},
		SubscriberMergeConflicts: map[string]canonical.SubscriberMergeConflict{},
		SegmentTranslateErrs:     map[string]string{},
		SourceArchiveByType:      map[string]int{},
	}
}

// ObserveSubscriber records a single subscriber's contribution to the
// verification stats. Called from the orchestrator's subscriber loop.
func (v *VerifierInput) ObserveSubscriber(s canonical.Subscriber) {
	v.SubscribersSeen++
	if sourceID := strings.TrimSpace(s.SourceID); sourceID != "" {
		if v.SubscriberSourceIDs == nil {
			v.SubscriberSourceIDs = map[string]struct{}{}
		}
		v.SubscriberSourceIDs[sourceID] = struct{}{}
	}
	if s.SourcePlatform == canonical.SourceBeehiiv {
		if provider, ok := s.CustomFields["beehiiv"].(map[string]interface{}); ok {
			if tier, _ := provider["subscription_tier"].(string); strings.EqualFold(strings.TrimSpace(tier), "premium") {
				v.PremiumMembershipsObserved++
			}
		}
	}
	if s.SourcePlatform == canonical.SourceSubstack {
		for _, tag := range s.Tags {
			switch strings.TrimSpace(tag) {
			case "substack:tier:paid", "substack:tier:founding", "substack:tier:gift", "substack:tier:comp":
				v.PremiumMembershipsObserved++
				goto substackTierCounted
			}
		}
	substackTierCounted:
	}
	v.observeSubscriberMerge(s)
	if s.Status == canonical.StatusDisabled || s.Status == canonical.StatusBlocklisted {
		v.SuppressionListSize++
	}
	// Count the presence of an explicit, nonzero source consent timestamp.
	// This does not verify legal sufficiency or infer an acquisition method.
	// A source may retain consent evidence even when the provider does not
	// expose whether acquisition used single or double opt-in. Mailchimp uses
	// ConsentUnknown for that mode-unknown case; treating it as no evidence
	// falsely reports timestamped subscribed members as unknown.
	if s.ConsentTimestamp != nil && !s.ConsentTimestamp.IsZero() {
		v.ConsentKnown++
	} else {
		v.ConsentUnknown++
	}
	for _, tag := range s.Tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		v.SubscriberTagsSeen++
		if strings.HasPrefix(tag, "beehiiv:segment:") || strings.HasPrefix(tag, "beehiiv:newsletter-list:") ||
			strings.HasPrefix(tag, "hubspot:list:") || strings.HasPrefix(tag, "hubspot:subscription:") ||
			strings.HasPrefix(tag, "klaviyo:list:") || strings.HasPrefix(tag, "klaviyo:segment:") ||
			strings.HasPrefix(tag, "customerio:segment:") || strings.HasPrefix(tag, "customerio:topic:") {
			if v.SubscriberTagCounts == nil {
				v.SubscriberTagCounts = map[string]int{}
			}
			v.SubscriberTagCounts[tag]++
		}
		if v.SubscriberTagsUnique == nil {
			v.SubscriberTagsUnique = map[string]struct{}{}
		}
		v.SubscriberTagsUnique[tag] = struct{}{}
		if strings.HasPrefix(tag, "mailchimp:list:") && strings.Contains(tag, ":segment:") {
			v.StaticSegmentMemberships++
		}
		if strings.HasPrefix(tag, "beehiiv:segment:") || strings.HasPrefix(tag, "hubspot:list:") || strings.HasPrefix(tag, "hubspot:subscription:") ||
			strings.HasPrefix(tag, "customerio:segment:") || strings.HasPrefix(tag, "customerio:topic:") {
			v.StaticSegmentMemberships++
		}
	}
	for k, val := range s.CustomFields {
		if _, ok := v.CustomFieldsSeen[k]; ok {
			continue
		}
		v.CustomFieldsSeen[k] = inferType(val)
		// Mailchimp-style merge tags map to canonical names through a small
		// rule table. Anything that doesn't match falls through to "unmapped".
		if canon, ok := classifyCustomField(k); ok {
			v.CustomFieldsCanonical[k] = canon
		}
	}
}

func (v *VerifierInput) observeSubscriberMerge(s canonical.Subscriber) {
	if v.SubscriberFirstSeen == nil {
		v.SubscriberFirstSeen = map[string]canonical.Subscriber{}
	}
	if v.SubscriberMergeConflicts == nil {
		v.SubscriberMergeConflicts = map[string]canonical.SubscriberMergeConflict{}
	}
	email := strings.ToLower(strings.TrimSpace(s.Email))
	if email == "" {
		return
	}
	first, ok := v.SubscriberFirstSeen[email]
	if !ok {
		v.SubscriberFirstSeen[email] = s
		return
	}
	conflict := v.SubscriberMergeConflicts[email]
	conflict.Email = s.Email
	conflict.SourceIDs = unionStrings(conflict.SourceIDs, first.SourceID, s.SourceID)
	conflict.Tags = unionStrings(conflict.Tags, append(first.Tags, s.Tags...)...)
	conflict.ConflictFields = unionStrings(conflict.ConflictFields, conflictingCustomFields(first.CustomFields, s.CustomFields)...)
	if len(conflict.SourceIDs) < 2 && len(conflict.Tags) == 0 && len(conflict.ConflictFields) == 0 {
		return
	}
	v.SubscriberMergeConflicts[email] = conflict
}

// ObserveSegment records the result of attempting to translate a segment.
// Pass nil translateErr to indicate a clean translation.
//
// Bookkeeping rule: a segment that translated cleanly lands in v.Segments
// (counted in segments_translated). A segment that failed lands ONLY in
// v.SegmentTranslateErrs (counted in segments_with_warnings). A segment
// that translated with adapter-level loss-of-fidelity counts as both — the
// SQL still works, but the user should know some conditions were dropped.
func (v *VerifierInput) ObserveSegment(seg canonical.Segment, translateErr error) {
	if translateErr != nil {
		v.SegmentTranslateErrs[seg.Name] = translateErr.Error()
		return
	}
	v.Segments = append(v.Segments, seg)
	if seg.SourceDefinition != "" && strings.Contains(seg.Description, "could not be translated") {
		v.SegmentTranslateErrs[seg.Name] = seg.Description
	}
}

// ObserveAutomation records the result of translating an automation. If the
// automation could not be ported at all, pass a non-empty unsupportedReason.
func (v *VerifierInput) ObserveAutomation(au canonical.Automation, unsupportedReason string) {
	if unsupportedReason != "" {
		v.AutomationsUnsupported = append(v.AutomationsUnsupported, canonical.AutomationUnsupported{
			Name:   au.Name,
			Reason: unsupportedReason,
		})
		return
	}
	if reason := automationUnsupportedReason(au); reason != "" {
		v.AutomationsUnsupported = append(v.AutomationsUnsupported, canonical.AutomationUnsupported{
			Name:   au.Name,
			Reason: reason,
		})
		return
	}
	v.Automations = append(v.Automations, au)
}

func automationUnsupportedReason(au canonical.Automation) string {
	for _, n := range au.Nodes {
		if n.Type == "send_email" && strings.TrimSpace(n.TemplateID) == "" {
			return "Automation send-email node has no destination template; manual review is required before activation."
		}
	}
	for _, n := range au.Nodes {
		switch n.Type {
		case "send_email", "send_sms", "webhook", "branch", "percentage_split", "goal", "wait", "wait_until", "wait_until_trigger":
			return ""
		case "action":
			if n.Action != nil && n.Action.Kind != "" {
				return ""
			}
		}
	}
	return "Automation has no executable journey nodes in canonical form; review source definition before activation."
}

func (v *VerifierInput) ObserveSourceArchiveItem(item canonical.SourceArchiveItem) {
	for _, warning := range item.Warnings {
		resource := firstNonEmptyString(sourceArchivePayloadString(item.Payload, "target_resource_type"), item.ResourceType, "source_archive")
		if item.SourcePlatform == canonical.SourceCustomerIO {
			if v.customerIOSourceArchiveWarningKeys == nil {
				v.customerIOSourceArchiveWarningKeys = make(map[string]struct{}, len(v.SourceArchiveWarnings))
				for _, existing := range v.SourceArchiveWarnings {
					v.customerIOSourceArchiveWarningKeys[strings.TrimSpace(existing.Resource)+"\x00"+strings.TrimSpace(existing.Warning)] = struct{}{}
				}
			}
			key := strings.TrimSpace(resource) + "\x00" + strings.TrimSpace(warning)
			if _, duplicate := v.customerIOSourceArchiveWarningKeys[key]; duplicate {
				continue
			}
			v.customerIOSourceArchiveWarningKeys[key] = struct{}{}
		}
		v.SourceArchiveWarnings = append(v.SourceArchiveWarnings, canonical.ResourceWarning{
			Resource: resource,
			SourceID: item.SourceID,
			Name:     item.Name,
			Warning:  warning,
		})
	}
	if sourceArchiveWarningOnly(item) {
		return
	}
	if v.SourceArchiveByType == nil {
		v.SourceArchiveByType = map[string]int{}
	}
	v.SourceArchiveByType[item.ResourceType]++
}

func sourceArchivePayloadString(payload map[string]interface{}, key string) string {
	if payload == nil {
		return ""
	}
	if value, ok := payload[key].(string); ok {
		return strings.TrimSpace(value)
	}
	return ""
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func (v *VerifierInput) ObserveCampaignArchive(c canonical.CampaignArchive) {
	for _, warning := range c.Warnings {
		v.ArchiveWarnings = append(v.ArchiveWarnings, canonical.ResourceWarning{
			Resource: "campaign_archive",
			SourceID: c.SourceID,
			Name:     c.Subject,
			Warning:  warning,
		})
	}
}

func (v *VerifierInput) ObserveTemplate(t canonical.EmailTemplate) {
	for _, warning := range t.Warnings {
		v.TemplateWarnings = append(v.TemplateWarnings, canonical.ResourceWarning{
			Resource: "template",
			SourceID: t.SourceID,
			Name:     t.Name,
			Warning:  warning,
		})
	}
}

// BuildReport materialises the report from the accumulated input plus the
// job's progress counters.
func BuildReport(in *VerifierInput, job *canonical.MigrationJob) canonical.VerificationReport {
	if in == nil {
		in = NewVerifierInput()
	}
	report := canonical.VerificationReport{
		SubscribersImported:        in.SubscribersSeen - in.SubscribersSkipped - in.SubscribersErrored,
		SuppressionListSize:        in.SuppressionListSize,
		ConsentKnown:               in.ConsentKnown,
		ConsentUnknown:             in.ConsentUnknown,
		DuplicateSubscribersMerged: len(in.SubscriberMergeConflicts),
		SubscriberMergeConflicts:   buildSubscriberMergeConflicts(in),
		CustomFieldsMapped:         buildMappings(in),
		CustomFieldsUnmapped:       buildUnmapped(in),
		SegmentsTranslated:         len(in.Segments),
		SegmentsWithWarnings:       buildSegmentWarnings(in),
		AutomationsTranslated:      len(in.Automations),
		AutomationsUnsupported:     in.AutomationsUnsupported,
		PaidSubsImported:           in.PaidSubsImported,
		PremiumMembershipsObserved: in.PremiumMembershipsObserved,
		ArchiveImported:            in.ArchiveImported,
		DiscoveryWarnings:          append([]string(nil), in.Discovery.Warnings...),
		CampaignArchiveWarnings:    in.ArchiveWarnings,
		TemplatesImported:          in.TemplatesImported,
		TemplateWarnings:           in.TemplateWarnings,
		SourceArchiveImported:      in.SourceArchiveImported,
		SourceArchiveWarnings:      in.SourceArchiveWarnings,
		SourceArchiveByResource:    cloneIntMap(in.SourceArchiveByType),
		SubscriberTagsImported:     len(in.SubscriberTagsUnique),
	}
	if report.SubscribersImported < 0 {
		report.SubscribersImported = 0
	}
	if len(in.SubscriberMergeConflicts) > 0 && len(in.SubscriberFirstSeen) > 0 {
		report.SubscribersImported = len(in.SubscriberFirstSeen) - in.SubscribersSkipped - in.SubscribersErrored
		if report.SubscribersImported < 0 {
			report.SubscribersImported = 0
		}
	}
	report.SampleSubscribers = buildSampleSubscribers(in)
	report.ResourceCompleteness = buildResourceCompleteness(in, job, report)
	report.DataLossEstimatePct = computeDataLoss(in, job)
	return report
}

func cloneIntMap(in map[string]int) map[string]int {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]int, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func buildResourceCompleteness(in *VerifierInput, job *canonical.MigrationJob, report canonical.VerificationReport) []canonical.ResourceCompleteness {
	source := canonical.SourcePlatform("")
	if job != nil {
		source = job.Source
	}
	return ResourceCompletenessForSource(source, in.Discovery, report)
}

// computeDataLoss is the weighted formula spec'd in plan.md Phase 3:
//
//	loss = (subscriber_loss * 0.6 + segment_loss * 0.2 + automation_loss * 0.2) * 100
//
// Each *_loss is a fraction in [0, 1].
func computeDataLoss(in *VerifierInput, job *canonical.MigrationJob) float64 {
	subLoss := 0.0
	if in.SubscribersSeen > 0 {
		dropped := in.SubscribersSkipped + in.SubscribersErrored
		subLoss = float64(dropped) / float64(in.SubscribersSeen)
	} else if job != nil && job.Progress.SubscribersTotal > 0 {
		// Fallback when verifier wasn't fed observations — approximate from
		// the job progress counters.
		dropped := job.Progress.SubscribersTotal - job.Progress.SubscribersDone
		if dropped < 0 {
			dropped = 0
		}
		subLoss = float64(dropped) / float64(job.Progress.SubscribersTotal)
	}

	segLoss := 0.0
	totalSegs := len(in.Segments) + len(in.SegmentTranslateErrs)
	if totalSegs > 0 {
		segLoss = float64(len(in.SegmentTranslateErrs)) / float64(totalSegs)
	}

	autoLoss := 0.0
	totalAuto := len(in.Automations) + len(in.AutomationsUnsupported)
	if totalAuto > 0 {
		autoLoss = float64(len(in.AutomationsUnsupported)) / float64(totalAuto)
	}

	loss := (subLoss*0.6 + segLoss*0.2 + autoLoss*0.2) * 100.0
	if loss < 0 {
		loss = 0
	}
	if loss > 100 {
		loss = 100
	}
	return roundTo(loss, 2)
}

func roundTo(v float64, places int) float64 {
	mult := 1.0
	for i := 0; i < places; i++ {
		mult *= 10
	}
	if v >= 0 {
		return float64(int64(v*mult+0.5)) / mult
	}
	return float64(int64(v*mult-0.5)) / mult
}

func buildMappings(in *VerifierInput) []canonical.CustomFieldMapping {
	out := make([]canonical.CustomFieldMapping, 0, len(in.CustomFieldsCanonical))
	// Stable order: walk CustomFieldsSeen alphabetically so the report is
	// deterministic from one run to the next.
	keys := make([]string, 0, len(in.CustomFieldsSeen))
	for k := range in.CustomFieldsSeen {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, k := range keys {
		canon, ok := in.CustomFieldsCanonical[k]
		if !ok {
			continue
		}
		out = append(out, canonical.CustomFieldMapping{
			Source:    k,
			Canonical: canon,
			Type:      in.CustomFieldsSeen[k],
		})
	}
	return out
}

func buildUnmapped(in *VerifierInput) []string {
	out := []string{}
	keys := make([]string, 0, len(in.CustomFieldsSeen))
	for k := range in.CustomFieldsSeen {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, k := range keys {
		if _, ok := in.CustomFieldsCanonical[k]; !ok {
			out = append(out, k)
		}
	}
	return out
}

func buildSegmentWarnings(in *VerifierInput) []canonical.SegmentWarning {
	out := make([]canonical.SegmentWarning, 0, len(in.SegmentTranslateErrs))
	keys := make([]string, 0, len(in.SegmentTranslateErrs))
	for k := range in.SegmentTranslateErrs {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, k := range keys {
		out = append(out, canonical.SegmentWarning{Name: k, Warning: in.SegmentTranslateErrs[k]})
	}
	return out
}

func buildSubscriberMergeConflicts(in *VerifierInput) []canonical.SubscriberMergeConflict {
	if len(in.SubscriberMergeConflicts) == 0 {
		return nil
	}
	keys := make([]string, 0, len(in.SubscriberMergeConflicts))
	for key := range in.SubscriberMergeConflicts {
		keys = append(keys, key)
	}
	sortStrings(keys)
	out := make([]canonical.SubscriberMergeConflict, 0, len(keys))
	for _, key := range keys {
		conflict := in.SubscriberMergeConflicts[key]
		sortStrings(conflict.SourceIDs)
		sortStrings(conflict.Tags)
		sortStrings(conflict.ConflictFields)
		out = append(out, conflict)
	}
	return out
}

// sampleSubscriberLimit bounds how many preview rows the dry-run report carries;
// sampleCustomFieldLimit caps custom fields per row. Both keep the preview small.
const (
	sampleSubscriberLimit  = 6
	sampleCustomFieldLimit = 4
)

// buildSampleSubscribers returns a small, deterministic, redacted preview of the
// subscribers that will land (MIGR-028). Deterministic = sorted by email so the
// same dry-run always shows the same rows. Email local-parts are masked and
// custom_fields are capped so the preview never becomes a data dump.
func buildSampleSubscribers(in *VerifierInput) []canonical.SubscriberSample {
	if len(in.SubscriberFirstSeen) == 0 {
		return nil
	}
	keys := make([]string, 0, len(in.SubscriberFirstSeen))
	for key := range in.SubscriberFirstSeen {
		keys = append(keys, key)
	}
	sortStrings(keys)
	if len(keys) > sampleSubscriberLimit {
		keys = keys[:sampleSubscriberLimit]
	}
	out := make([]canonical.SubscriberSample, 0, len(keys))
	for _, key := range keys {
		sub := in.SubscriberFirstSeen[key]
		tags := append([]string(nil), sub.Tags...)
		sortStrings(tags)
		out = append(out, canonical.SubscriberSample{
			Email:        maskEmail(sub.Email),
			Status:       sub.Status,
			Tags:         tags,
			SourceID:     sub.SourceID,
			CustomFields: sampleCustomFields(sub.CustomFields),
		})
	}
	return out
}

// maskEmail keeps the first character of the local part and the full domain so
// the preview is recognizable without exposing the whole address.
func maskEmail(email string) string {
	at := strings.IndexByte(email, '@')
	if at <= 0 {
		return email
	}
	return email[:1] + "***" + email[at:]
}

// sampleCustomFields returns up to sampleCustomFieldLimit fields, sorted by key,
// so the preview is bounded and deterministic.
func sampleCustomFields(fields map[string]interface{}) map[string]interface{} {
	if len(fields) == 0 {
		return nil
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sortStrings(keys)
	if len(keys) > sampleCustomFieldLimit {
		keys = keys[:sampleCustomFieldLimit]
	}
	out := make(map[string]interface{}, len(keys))
	for _, key := range keys {
		out[key] = fields[key]
	}
	return out
}

func conflictingCustomFields(a, b map[string]interface{}) []string {
	keys := map[string]struct{}{}
	for key := range a {
		keys[key] = struct{}{}
	}
	for key := range b {
		keys[key] = struct{}{}
	}
	out := make([]string, 0, len(keys))
	for key := range keys {
		av, aok := a[key]
		bv, bok := b[key]
		if aok && bok && !reflect.DeepEqual(av, bv) {
			out = append(out, key)
		}
	}
	sortStrings(out)
	return out
}

func unionStrings(existing []string, values ...string) []string {
	out := append([]string(nil), existing...)
	seen := map[string]struct{}{}
	for _, value := range out {
		seen[strings.ToLower(strings.TrimSpace(value))] = struct{}{}
	}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, value)
	}
	return out
}

// classifyCustomField is a small rule table that maps known source-platform
// merge-tag conventions to canonical field names. Returning false leaves the
// field "unmapped" — it'll appear in the amber section of the UI report.
//
// The list is intentionally conservative; we'd rather show "unmapped" than
// silently misclassify. Adapters that already produce canonical names (CSV
// importer, ConvertKit's normalised first_name/last_name) pass through here
// as identity matches.
func classifyCustomField(raw string) (string, bool) {
	r := strings.ToLower(raw)
	switch r {
	case "fname", "first_name", "firstname":
		return "first_name", true
	case "lname", "last_name", "lastname":
		return "last_name", true
	case "name", "full_name", "fullname":
		return "name", true
	case "company", "organisation", "organization":
		return "company", true
	case "city":
		return "custom.city", true
	case "country":
		return "custom.country", true
	case "phone":
		return "custom.phone", true
	case "tier", "subscription_tier", "plan":
		return "custom.tier", true
	case "stripe_customer_id":
		return "custom.stripe_customer_id", true
	case "signup_source":
		return "custom.signup_source", true
	}
	// Generic prefix conventions.
	if strings.HasPrefix(r, "custom.") {
		return raw, true
	}
	return "", false
}

func inferType(v interface{}) string {
	switch v.(type) {
	case string:
		return "string"
	case bool:
		return "boolean"
	case int, int32, int64, float32, float64:
		return "number"
	case []interface{}, []string:
		return "array"
	case map[string]interface{}:
		return "object"
	case nil:
		return "null"
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Slice, reflect.Array:
		return "array"
	case reflect.Map:
		return "object"
	default:
		return "string"
	}
}

// sortStrings is a tiny insertion sort to avoid pulling sort just for the
// report's stable output (keeps the package import surface minimal).
func sortStrings(ss []string) {
	for i := 1; i < len(ss); i++ {
		j := i
		for j > 0 && ss[j-1] > ss[j] {
			ss[j-1], ss[j] = ss[j], ss[j-1]
			j--
		}
	}
}
