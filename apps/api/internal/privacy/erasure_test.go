package privacy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestNewErasedPlaceholderIsUniquePerErasureAndNonIdentifying(t *testing.T) {
	a1, err := newErasedPlaceholder(bytes.NewReader(bytes.Repeat([]byte{0x11}, erasureNonceBytes)), "tenant-A")
	if err != nil {
		t.Fatalf("first placeholder: %v", err)
	}
	a2, err := newErasedPlaceholder(bytes.NewReader(bytes.Repeat([]byte{0x22}, erasureNonceBytes)), "tenant-A")
	if err != nil {
		t.Fatalf("second placeholder: %v", err)
	}
	if a1 == a2 {
		t.Fatalf("two erasure events reused placeholder %q", a1)
	}
	if !strings.HasSuffix(a1, "@"+erasedEmailDomain) {
		t.Fatalf("placeholder does not use RFC 6761 invalid TLD: %q", a1)
	}
	if !strings.HasPrefix(a1, "erased+") {
		t.Fatalf("placeholder missing erased+ prefix: %q", a1)
	}
	local, _, ok := strings.Cut(a1, "@")
	if !ok || len(local) > 64 {
		t.Fatalf("placeholder local part is not sequence-suffix safe: %q", a1)
	}
	if strings.Contains(a1, "abby") || strings.Contains(a1, "example") {
		t.Fatalf("placeholder leaks source-email material: %q", a1)
	}
}

func TestNewErasedPlaceholderDomainSeparatesTenants(t *testing.T) {
	nonce := bytes.Repeat([]byte{0x33}, erasureNonceBytes)
	a1, err := newErasedPlaceholder(bytes.NewReader(nonce), "tenant-A")
	if err != nil {
		t.Fatalf("tenant A placeholder: %v", err)
	}
	a2, err := newErasedPlaceholder(bytes.NewReader(nonce), "tenant-B")
	if err != nil {
		t.Fatalf("tenant B placeholder: %v", err)
	}
	if a1 == a2 {
		t.Fatalf("same nonce produced a cross-tenant-linkable placeholder: %q", a1)
	}
}

func TestErasedSuppressionIdentityIsStableAndTenantScoped(t *testing.T) {
	// The hash must be stable across tenants because it's the lookup
	// key the sending suppression check uses: "is the email-being-sent-to
	// hash-matched in any tenant suppression we own?" The address itself
	// is tenant-scoped (UNIQUE constraint) so it varies, but the hash
	// of the original plaintext must not.
	a1, h1 := erasedSuppressionIdentity("tenant-A", "abby@example.com")
	a1Again, h1Again := erasedSuppressionIdentity("tenant-A", "abby@example.com")
	a2, h2 := erasedSuppressionIdentity("tenant-B", "abby@example.com")
	if a1 != a1Again || h1 != h1Again {
		t.Fatalf("suppression identity is not retry-stable: %q/%q vs %q/%q", a1, h1, a1Again, h1Again)
	}
	if a1 == a2 {
		t.Fatalf("suppression placeholder is not tenant scoped: %q", a1)
	}
	if h1 != h2 {
		t.Fatalf("hash differs across tenants: %q vs %q", h1, h2)
	}
	if len(h1) != 64 {
		t.Fatalf("hash is not sha256-hex length: len=%d", len(h1))
	}
}

func TestNormalizeSubjectEmailLowersAndTrims(t *testing.T) {
	cases := map[string]string{
		" ABBY@Example.com ":  "abby@example.com",
		"already@lower.com":   "already@lower.com",
		"\tWith\twhitespace ": "with\twhitespace",
		"":                    "",
	}
	for in, want := range cases {
		if got := normalizeSubjectEmail(in); got != want {
			t.Errorf("normalizeSubjectEmail(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEraseStatsTotalAggregates(t *testing.T) {
	s := eraseStats{
		SubscribersAnonymized:         1,
		SubscriberEventsAnonymized:    5,
		ConsentReceiptsAnonymized:     3,
		SequenceFunnelAnonymized:      4,
		SequenceEnrollmentsAnonymized: 2,
		FrequencyCapEventsDeleted:     3,
		SubscriberSendLogDeleted:      5,
		IntelligentRetryEventsDeleted: 6,
		SubscriberNotesDeleted:        2,
		SuppressionsAffected:          1,
		ConversionsIdentityRedacted:   2,
		ConversionIdentityTouches:     3,
		ConversionCampaignLinks:       1,
		ConversionClickBindings:       4,
	}
	if s.total() != 42 {
		t.Fatalf("total = %d want 42", s.total())
	}
}

type erasureExecCall struct {
	sql  string
	args []any
}

type recordingErasureExecutor struct {
	calls []erasureExecCall
	rows  map[string]int64
}

type recordingErasureRow struct {
	values []any
}

func (r recordingErasureRow) Scan(dest ...any) error {
	values := r.values
	if values == nil {
		values = make([]any, len(dest))
	}
	if len(dest) != len(values) {
		return fmt.Errorf("recording erasure row: got %d destinations, want %d", len(dest), len(values))
	}
	for i := range dest {
		switch target := dest[i].(type) {
		case *int64:
			if values[i] == nil {
				*target = 0
				continue
			}
			value, ok := values[i].(int64)
			if !ok {
				return fmt.Errorf("recording erasure row: value %d is %T, want int64", i, values[i])
			}
			*target = value
		case *string:
			if values[i] == nil {
				*target = ""
				continue
			}
			value, ok := values[i].(string)
			if !ok {
				return fmt.Errorf("recording erasure row: value %d is %T, want string", i, values[i])
			}
			*target = value
		default:
			return fmt.Errorf("recording erasure row: destination %d is %T", i, dest[i])
		}
	}
	return nil
}

type failingEntropyReader struct{}

func (failingEntropyReader) Read([]byte) (int, error) {
	return 0, errors.New("entropy unavailable")
}

func TestEraseSubscriberDataFailsBeforeWritesWhenEntropyUnavailable(t *testing.T) {
	executor := &recordingErasureExecutor{}
	stats, err := eraseSubscriberDataWithEntropy(
		context.Background(), executor,
		"00000000-0000-0000-0000-000000000001", "person@example.com",
		failingEntropyReader{},
	)
	if err == nil || !strings.Contains(err.Error(), "entropy unavailable") {
		t.Fatalf("error = %v, want entropy failure", err)
	}
	if len(executor.calls) != 0 {
		t.Fatalf("entropy failure issued %d database writes", len(executor.calls))
	}
	if stats.Placeholder != "" || stats.total() != 0 {
		t.Fatalf("entropy failure returned non-empty stats: %+v", stats)
	}
}

func TestEraseSubscriberDataProductionEntryPointFailsClosedBeforeWrites(t *testing.T) {
	executor := &recordingErasureExecutor{}
	stats, err := eraseSubscriberData(
		context.Background(), executor,
		"00000000-0000-0000-0000-000000000001", "person@example.com",
	)
	if !errors.Is(err, ErrErasureCoverageIncomplete) {
		t.Fatalf("error = %v, want ErrErasureCoverageIncomplete", err)
	}
	if len(executor.calls) != 0 {
		t.Fatalf("fail-closed production entry point issued %d database writes", len(executor.calls))
	}
	if stats.Placeholder != "" || stats.total() != 0 {
		t.Fatalf("fail-closed production entry point returned non-empty stats: %+v", stats)
	}
}

func (r *recordingErasureExecutor) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	r.calls = append(r.calls, erasureExecCall{sql: sql, args: args})
	for table, rows := range r.rows {
		if strings.Contains(sql, table) {
			return pgconn.NewCommandTag(fmt.Sprintf("UPDATE %d", rows)), nil
		}
	}
	return pgconn.NewCommandTag("UPDATE 0"), nil
}

func (r *recordingErasureExecutor) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	r.calls = append(r.calls, erasureExecCall{sql: sql, args: args})
	if strings.Contains(sql, "conversion_subject_identity_privacy_erase") {
		return recordingErasureRow{values: []any{
			"00000000-0000-0000-0000-0000000000aa",
			r.rows["conversions_identity_redacted"],
			r.rows["conversion_identity_touches"],
			r.rows["conversion_campaign_links"],
			r.rows["conversion_click_bindings"],
		}}
	}
	for table, rows := range r.rows {
		if strings.Contains(sql, table) {
			return recordingErasureRow{values: []any{rows}}
		}
	}
	return recordingErasureRow{}
}

func TestEraseSubscriberDataFencesAndReceiptsConversionIdentityBeforeProfileRewrite(t *testing.T) {
	executor := &recordingErasureExecutor{rows: map[string]int64{
		"conversions_identity_redacted": 3,
		"conversion_identity_touches":   4,
		"conversion_campaign_links":     2,
		"conversion_click_bindings":     1,
	}}
	tenantID := "00000000-0000-0000-0000-000000000001"
	stats, err := eraseSubscriberDataWithEntropy(
		context.Background(), executor, tenantID, " Person@Example.com ",
		bytes.NewReader(bytes.Repeat([]byte{0x43}, erasureNonceBytes)),
	)
	if err != nil {
		t.Fatalf("eraseSubscriberDataWithEntropy: %v", err)
	}
	if stats.ConversionIdentityReceiptID == "" ||
		stats.ConversionsIdentityRedacted != 3 ||
		stats.ConversionIdentityTouches != 4 ||
		stats.ConversionCampaignLinks != 2 ||
		stats.ConversionClickBindings != 1 {
		t.Fatalf("conversion identity receipt stats = %+v", stats)
	}

	fenceAt, receiptAt, subscriberAt := -1, -1, -1
	for i, call := range executor.calls {
		switch {
		case strings.Contains(call.sql, "pg_advisory_xact_lock"):
			fenceAt = i
			if len(call.args) != 1 || call.args[0] != tenantID {
				t.Fatalf("conversion identity fence args = %#v", call.args)
			}
		case strings.Contains(call.sql, "conversion_subject_identity_privacy_erase"):
			receiptAt = i
			if len(call.args) != 4 || call.args[0] != tenantID ||
				call.args[1] != "person@example.com" || call.args[2] != stats.Placeholder {
				t.Fatalf("conversion identity erasure args = %#v", call.args)
			}
			requestID, ok := call.args[3].(string)
			if !ok || strings.TrimSpace(requestID) == "" {
				t.Fatalf("conversion identity request id = %#v", call.args[3])
			}
		case strings.Contains(call.sql, "UPDATE subscribers AS subscriber"):
			subscriberAt = i
		}
	}
	if fenceAt < 0 || receiptAt <= fenceAt || subscriberAt <= receiptAt {
		t.Fatalf("conversion identity cutover order fence=%d receipt=%d subscriber=%d", fenceAt, receiptAt, subscriberAt)
	}
}

func TestEraseSubscriberDataAnonymizesSequencePII(t *testing.T) {
	executor := &recordingErasureExecutor{rows: map[string]int64{
		"sequence_funnel_events": 4,
		"sequence_enrollments":   2,
	}}
	tenantID := "00000000-0000-0000-0000-000000000001"
	original := " Person@Example.com "
	normalized := "person@example.com"
	stats, err := eraseSubscriberDataWithEntropy(
		context.Background(), executor, tenantID, original,
		bytes.NewReader(bytes.Repeat([]byte{0x44}, erasureNonceBytes)),
	)
	if err != nil {
		t.Fatalf("eraseSubscriberData: %v", err)
	}
	placeholder := stats.Placeholder
	if placeholder == "" {
		t.Fatal("eraseSubscriberData returned an empty placeholder")
	}
	if stats.SequenceFunnelAnonymized != 4 || stats.SequenceEnrollmentsAnonymized != 2 {
		t.Fatalf("sequence stats = funnel:%d enrollments:%d, want 4/2", stats.SequenceFunnelAnonymized, stats.SequenceEnrollmentsAnonymized)
	}

	rowSuffixes := map[string]string{
		"sequence_funnel_events": "+f",
		"sequence_enrollments":   "+e",
	}
	for table, rowSuffix := range rowSuffixes {
		var matched *erasureExecCall
		for i := range executor.calls {
			if strings.Contains(executor.calls[i].sql, "UPDATE "+table) {
				matched = &executor.calls[i]
				break
			}
		}
		if matched == nil {
			t.Fatalf("missing erasure statement for %s", table)
		}
		if !strings.Contains(matched.sql, "tenant_id = $1::uuid") ||
			!strings.Contains(matched.sql, "lower(subscriber_email::text) IN (") ||
			!strings.Contains(matched.sql, "SELECT $2") {
			t.Fatalf("%s erasure is not tenant-and-subject scoped: %s", table, matched.sql)
		}
		if !strings.Contains(matched.sql, "split_part($3, '@', 1)") ||
			!strings.Contains(matched.sql, rowSuffix) ||
			!strings.Contains(matched.sql, "id::text") {
			t.Fatalf("%s erasure is not row-scoped against repeated-erasure uniqueness collisions: %s", table, matched.sql)
		}
		if len(matched.args) != 3 || matched.args[0] != tenantID || matched.args[1] != normalized || matched.args[2] != placeholder {
			t.Fatalf("%s erasure args = %#v, want tenant/normalized/placeholder", table, matched.args)
		}
	}
}

func TestEraseSubscriberDataUsesFreshRowIdentityAndStableSuppressionIdentity(t *testing.T) {
	tenantID := "00000000-0000-0000-0000-000000000001"
	email := "person@example.com"
	run := func(fill byte) (eraseStats, *recordingErasureExecutor) {
		t.Helper()
		executor := &recordingErasureExecutor{}
		stats, err := eraseSubscriberDataWithEntropy(
			context.Background(), executor, tenantID, email,
			bytes.NewReader(bytes.Repeat([]byte{fill}, erasureNonceBytes)),
		)
		if err != nil {
			t.Fatalf("eraseSubscriberDataWithEntropy: %v", err)
		}
		return stats, executor
	}

	first, firstExec := run(0x55)
	second, secondExec := run(0x66)
	if first.Placeholder == second.Placeholder {
		t.Fatalf("repeat erasure reused subscriber placeholder %q", first.Placeholder)
	}
	wantSuppression, _ := erasedSuppressionIdentity(tenantID, email)

	assertOperation := func(stats eraseStats, executor *recordingErasureExecutor) {
		t.Helper()
		for _, table := range []string{
			"subscribers", "subscriber_events", "consent_receipts",
			"sequence_funnel_events", "sequence_enrollments",
		} {
			var call *erasureExecCall
			for i := range executor.calls {
				if strings.Contains(executor.calls[i].sql, table) {
					call = &executor.calls[i]
					break
				}
			}
			if call == nil || len(call.args) < 3 || call.args[2] != stats.Placeholder {
				t.Fatalf("%s did not use operation placeholder %q: %#v", table, stats.Placeholder, call)
			}
		}

		var suppression *erasureExecCall
		for i := range executor.calls {
			if strings.Contains(executor.calls[i].sql, "INSERT INTO subscriber_suppressions") {
				suppression = &executor.calls[i]
				break
			}
		}
		if suppression == nil || len(suppression.args) != 3 || suppression.args[2] != wantSuppression {
			t.Fatalf("suppression did not use stable identity %q: %#v", wantSuppression, suppression)
		}
	}
	assertOperation(first, firstExec)
	assertOperation(second, secondExec)
}

func TestErasureScrubEngineCoversCurrentProfilePIIAndPlaintextSuppressions(t *testing.T) {
	executor := &recordingErasureExecutor{}
	stats, err := eraseSubscriberDataWithEntropy(
		context.Background(), executor,
		"00000000-0000-0000-0000-000000000001", "person@example.com",
		bytes.NewReader(bytes.Repeat([]byte{0x77}, erasureNonceBytes)),
	)
	if err != nil {
		t.Fatalf("eraseSubscriberDataWithEntropy: %v", err)
	}

	var subscriberUpdate string
	allSQL := strings.Builder{}
	for _, call := range executor.calls {
		allSQL.WriteString(call.sql)
		allSQL.WriteByte('\n')
		if strings.Contains(call.sql, "UPDATE subscribers AS subscriber") {
			subscriberUpdate = call.sql
		}
	}
	if subscriberUpdate == "" {
		t.Fatal("missing canonical subscribers scrub")
	}
	for _, contract := range []string{
		"primary_email = $3::citext",
		"custom_fields = '{}'::jsonb",
		"merge_fields = '{}'::jsonb",
		"tags = '{}'::text[]",
		"groups = '[]'::jsonb",
		"gdpr_permissions = '[]'::jsonb",
		"activity_summary = '{}'::jsonb",
		"gpp_sections = '{}'::jsonb",
		"first_name = ''",
		"last_name = ''",
		"full_name = ''",
		"display_name = ''",
		"signup_ip = NULL",
		"unsubscribe_reason = NULL",
		"source_id = NULL",
		"source_platform = NULL",
		"external_id = NULL",
		"phone_e164 = NULL",
		"timezone = NULL",
		"locale = NULL",
		"language = NULL",
		"country = NULL",
		"region = NULL",
		"account_id = NULL",
		"profile_id = gen_random_uuid()",
		"EXISTS (",
		"FROM subscriber_emails AS address",
	} {
		if !strings.Contains(subscriberUpdate, contract) {
			t.Errorf("canonical scrub missing current-schema contract %q", contract)
		}
	}

	combined := allSQL.String()
	// Every profile satellite must be erased, and each one names the statement
	// that proves it. A flat "DELETE FROM x" list was wrong for one table and
	// silently under-asserted for the rest: the proof is per-table because the
	// mechanism is per-table, and pairing them means a table cannot lose its
	// erasure by having the check quietly match something else.
	for _, satellite := range []struct {
		table string
		proof string
	}{
		{"subscriber_attribute_history", "DELETE FROM subscriber_attribute_history"},
		{"profile_aliases", "DELETE FROM profile_aliases"},
		{"subscriber_computed_traits", "DELETE FROM subscriber_computed_traits"},
		{"subscriber_channel_consents", "DELETE FROM subscriber_channel_consents"},
		{"subscriber_prediction_metadata", "DELETE FROM subscriber_prediction_metadata"},
		{"frequency_cap_events", "DELETE FROM frequency_cap_events"},
		{"subscriber_send_log", "DELETE FROM subscriber_send_log"},
		{"intelligent_retry_events", "DELETE FROM intelligent_retry_events"},
		// Not a DELETE, and deliberately so. `postwave_app` holds no delete
		// privilege on this table because a PII finding is evidence about the
		// tenant, and `pii_scanner` asserts the app role cannot remove it.
		// Migration 1913 moves the erasure behind a SECURITY DEFINER function,
		// so the proof that the subject's findings are erased is the call.
		{"subscriber_pii_findings", "subscriber_pii_findings_erase("},
		{"profile_predictions", "DELETE FROM profile_predictions"},
		{"profile_rfm_scores", "DELETE FROM profile_rfm_scores"},
		{"subscriber_emails", "DELETE FROM subscriber_emails"},
	} {
		if !strings.Contains(combined, satellite.proof) {
			t.Errorf("profile satellite %s is not erased (looked for %q)",
				satellite.table, satellite.proof)
		}
	}
	for _, table := range []string{"subscriber_suppressions", "suppressions", "email_suppressions"} {
		if !strings.Contains(combined, "DELETE FROM "+table) {
			t.Errorf("plaintext suppression store %s is not scrubbed", table)
		}
	}
	if stats.Placeholder == "" {
		t.Fatal("scrub engine did not return its per-erasure placeholder")
	}
}

func TestFrequencyCapEventErasureIsTenantAndAliasScoped(t *testing.T) {
	executor := &recordingErasureExecutor{rows: map[string]int64{
		"frequency_cap_events": 3,
	}}
	tenantID := "00000000-0000-0000-0000-000000000001"
	stats, err := eraseSubscriberDataWithEntropy(
		context.Background(), executor, tenantID, " Person@Example.com ",
		bytes.NewReader(bytes.Repeat([]byte{0x55}, erasureNonceBytes)),
	)
	if err != nil {
		t.Fatalf("erase subscriber data: %v", err)
	}
	if stats.FrequencyCapEventsDeleted != 3 {
		t.Fatalf("frequency-cap erasure count = %d, want 3", stats.FrequencyCapEventsDeleted)
	}
	for _, call := range executor.calls {
		if !strings.Contains(call.sql, "DELETE FROM frequency_cap_events") {
			continue
		}
		for _, required := range []string{
			"tenant_id = $1::uuid",
			"lower(btrim(subscriber_email))",
			"SELECT $2",
			"FROM subscriber_emails AS address",
			"subscriber.email = $3::citext",
		} {
			if !strings.Contains(call.sql, required) {
				t.Fatalf("frequency-cap erasure lacks %q: %s", required, call.sql)
			}
		}
		if len(call.args) != 3 || call.args[0] != tenantID ||
			call.args[1] != "person@example.com" || call.args[2] != stats.Placeholder {
			t.Fatalf("frequency-cap erasure args = %#v", call.args)
		}
		return
	}
	t.Fatal("frequency-cap erasure statement was not executed")
}

func TestSendingOperationalIdentityErasureIsTenantAndAliasScoped(t *testing.T) {
	executor := &recordingErasureExecutor{rows: map[string]int64{
		"subscriber_send_log":      7,
		"intelligent_retry_events": 5,
	}}
	tenantID := "00000000-0000-0000-0000-000000000001"
	stats, err := eraseSubscriberDataWithEntropy(
		context.Background(), executor, tenantID, " Person@Example.com ",
		bytes.NewReader(bytes.Repeat([]byte{0x56}, erasureNonceBytes)),
	)
	if err != nil {
		t.Fatalf("erase subscriber data: %v", err)
	}
	if stats.SubscriberSendLogDeleted != 7 || stats.IntelligentRetryEventsDeleted != 5 {
		t.Fatalf("sending identity erasure counts = send-log:%d retry:%d, want 7/5",
			stats.SubscriberSendLogDeleted, stats.IntelligentRetryEventsDeleted)
	}
	for _, table := range []string{"subscriber_send_log", "intelligent_retry_events"} {
		var matched *erasureExecCall
		for i := range executor.calls {
			if strings.Contains(executor.calls[i].sql, "DELETE FROM "+table) {
				matched = &executor.calls[i]
				break
			}
		}
		if matched == nil {
			t.Fatalf("missing subject erasure for %s", table)
		}
		for _, required := range []string{
			"tenant_id = $1::uuid",
			"lower(btrim(subscriber_email::text))",
			"SELECT $2",
			"FROM subscriber_emails AS address",
			"subscriber.email = $3::citext",
		} {
			if !strings.Contains(matched.sql, required) {
				t.Errorf("%s erasure lacks %q: %s", table, required, matched.sql)
			}
		}
		if len(matched.args) != 3 || matched.args[0] != tenantID ||
			matched.args[1] != "person@example.com" || matched.args[2] != stats.Placeholder {
			t.Errorf("%s erasure args = %#v", table, matched.args)
		}
	}
}

func TestErasureCryptoshredsWebhookSimulatorReceiptButPreservesFireFence(t *testing.T) {
	executor := &recordingErasureExecutor{rows: map[string]int64{
		"outbound_webhook_playground_fires": 3,
	}}
	stats, err := eraseSubscriberDataWithEntropy(
		context.Background(), executor,
		"00000000-0000-0000-0000-000000000001", "person@example.com",
		bytes.NewReader(bytes.Repeat([]byte{0x88}, erasureNonceBytes)),
	)
	if err != nil {
		t.Fatalf("eraseSubscriberDataWithEntropy: %v", err)
	}
	if stats.PlaygroundReceiptsShredded != 3 {
		t.Fatalf("playground receipts shredded = %d, want 3", stats.PlaygroundReceiptsShredded)
	}

	var statement string
	for _, call := range executor.calls {
		if strings.Contains(call.sql, "UPDATE outbound_webhook_playground_fires") {
			statement = call.sql
			break
		}
	}
	if statement == "" {
		t.Fatal("missing webhook simulator receipt erasure statement")
	}
	for _, contract := range []string{
		"state='receipt_expired'",
		"outcome=COALESCE(outcome, 'transport_ambiguous')",
		"receipt_envelope=NULL",
		"receipt_sha256=NULL",
		"subject_email_sha256s='{}'::text[]",
		"state IN ('pending','completed','ambiguous')",
		"subject_email_sha256s && ARRAY(",
	} {
		if !strings.Contains(statement, contract) {
			t.Errorf("webhook simulator erasure missing %q", contract)
		}
	}
	for _, forbidden := range []string{
		"SET fire_id", "SET request_sha256", "SET idempotency_key_sha256",
		"DELETE FROM outbound_webhook_playground_fires",
	} {
		if strings.Contains(statement, forbidden) {
			t.Errorf("webhook simulator erasure weakens permanent fence with %q", forbidden)
		}
	}
}

func TestBindDeletionTenantUsesTransactionLocalTenantGUC(t *testing.T) {
	executor := &recordingErasureExecutor{}
	tenantID := "00000000-0000-0000-0000-000000000002"

	if err := bindDeletionTenant(context.Background(), executor, tenantID); err != nil {
		t.Fatalf("bindDeletionTenant: %v", err)
	}
	if len(executor.calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(executor.calls))
	}
	call := executor.calls[0]
	if !strings.Contains(call.sql, "set_config('app.tenant_id', $1, true)") {
		t.Fatalf("tenant binding is not transaction-local: %s", call.sql)
	}
	if len(call.args) != 1 || call.args[0] != tenantID {
		t.Fatalf("tenant binding args = %#v, want %q", call.args, tenantID)
	}
}

func TestBuildFulfillmentJSONWithErasure(t *testing.T) {
	ts := time.Date(2026, 6, 2, 10, 30, 0, 0, time.UTC)
	body := buildFulfillmentJSON(ts, true, eraseStats{
		SubscribersAnonymized:         1,
		SubscriberEventsAnonymized:    4,
		SequenceFunnelAnonymized:      3,
		SequenceEnrollmentsAnonymized: 2,
		FrequencyCapEventsDeleted:     4,
		SubscriberSendLogDeleted:      5,
		IntelligentRetryEventsDeleted: 6,
		SuppressionsAffected:          1,
		PlaygroundReceiptsShredded:    2,
		ConversionIdentityReceiptID:   "00000000-0000-0000-0000-0000000000aa",
		ConversionsIdentityRedacted:   3,
		ConversionIdentityTouches:     2,
		ConversionCampaignLinks:       1,
		ConversionClickBindings:       1,
	})
	s := string(body)
	if !strings.Contains(s, `"ready_to_purge":false`) {
		t.Fatalf("erasure marker should set ready_to_purge=false, got: %s", s)
	}
	if !strings.Contains(s, `"erasure"`) {
		t.Fatalf("missing erasure object: %s", s)
	}
	if !strings.Contains(s, `"fulfilled_at":"2026-06-02T10:30:00Z"`) {
		t.Fatalf("missing fulfilled_at: %s", s)
	}
	if !strings.Contains(s, `"sequence_funnel_events_anonymized":3`) ||
		!strings.Contains(s, `"sequence_enrollments_anonymized":2`) {
		t.Fatalf("missing sequence PII erasure receipt counts: %s", s)
	}
	if !strings.Contains(s, `"webhook_simulator_receipts_shredded":2`) {
		t.Fatalf("missing webhook simulator cryptoshred receipt count: %s", s)
	}
	if !strings.Contains(s, `"frequency_cap_events_deleted":4`) {
		t.Fatalf("missing frequency-cap erasure receipt count: %s", s)
	}
	if !strings.Contains(s, `"subscriber_send_log_deleted":5`) ||
		!strings.Contains(s, `"intelligent_retry_events_deleted":6`) {
		t.Fatalf("missing sending operational identity erasure counts: %s", s)
	}
	if !strings.Contains(s, `"conversion_identity_receipt_id":"00000000-0000-0000-0000-0000000000aa"`) ||
		!strings.Contains(s, `"conversions_identity_redacted":3`) ||
		!strings.Contains(s, `"conversion_identity_touches_shredded":2`) ||
		!strings.Contains(s, `"conversion_campaign_links_severed":1`) ||
		!strings.Contains(s, `"conversion_click_bindings_deleted":1`) {
		t.Fatalf("missing conversion identity erasure receipt: %s", s)
	}
	if !strings.Contains(s, `"total_rows":35`) {
		t.Fatalf("total_rows should aggregate stats: %s", s)
	}
}

func TestBuildFulfillmentJSONWithoutErasure(t *testing.T) {
	ts := time.Date(2026, 6, 2, 10, 30, 0, 0, time.UTC)
	body := buildFulfillmentJSON(ts, false, eraseStats{})
	s := string(body)
	if !strings.Contains(s, `"ready_to_purge":true`) {
		t.Fatalf("no-erasure case must set ready_to_purge=true so operator picks it up, got: %s", s)
	}
	if strings.Contains(s, `"erasure"`) {
		t.Fatalf("no-erasure case must not include erasure stats, got: %s", s)
	}
}
