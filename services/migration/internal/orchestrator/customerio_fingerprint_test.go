package orchestrator

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

func TestCustomerIOSourceFingerprintDetectsSameCountSubscriberMutations(t *testing.T) {
	base := fingerprintTestCustomerIOSubscriber()
	tests := []struct {
		name   string
		mutate func(*canonical.Subscriber)
	}{
		{name: "status", mutate: func(value *canonical.Subscriber) { value.Status = canonical.StatusDisabled }},
		{name: "profile field", mutate: func(value *canonical.Subscriber) { value.CustomFields["first_name"] = "Grace" }},
		{name: "subscription preference", mutate: func(value *canonical.Subscriber) {
			provider := value.CustomFields["customerio_source"].(map[string]interface{})
			preferences := provider["topic_preferences"].(map[string]interface{})
			preferences["weekly"] = false
		}},
		{name: "segment membership", mutate: func(value *canonical.Subscriber) { value.Tags[0] = "customerio:segment:recent" }},
		{name: "topic membership", mutate: func(value *canonical.Subscriber) { value.Tags[1] = "customerio:topic:product" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			baselineAccumulator := newCustomerIOFingerprintAccumulator()
			require.NoError(t, baselineAccumulator.observeSubscriber(base))
			completeCustomerIOFingerprint(t, baselineAccumulator)
			baseline, err := baselineAccumulator.fingerprint()
			require.NoError(t, err)

			currentSubscriber := cloneCustomerIOFingerprintSubscriber(t, base)
			test.mutate(&currentSubscriber)
			currentAccumulator := newCustomerIOFingerprintAccumulator()
			require.NoError(t, currentAccumulator.observeSubscriber(currentSubscriber))
			completeCustomerIOFingerprint(t, currentAccumulator)
			current, err := currentAccumulator.fingerprint()
			require.NoError(t, err)

			changed, err := ChangedCustomerIOFingerprintComponents(baseline, current)
			require.NoError(t, err)
			require.Equal(t, []string{"subscribers"}, changed)
			require.Equal(t, baseline.Components["subscribers"].Count, current.Components["subscribers"].Count)
		})
	}
}

func TestCustomerIOSourceFingerprintDetectsEverySameCountCutoverSurfaceMutation(t *testing.T) {
	tests := []struct {
		component string
		observe   func(*customerIOFingerprintAccumulator, string) error
	}{
		{
			component: "profiles_without_email",
			observe: func(accumulator *customerIOFingerprintAccumulator, value string) error {
				return accumulator.observePrehashed("profiles_without_email", 1, fmt.Sprintf("%x", sha256.Sum256([]byte(value))))
			},
		},
		{
			component: "segments",
			observe: func(accumulator *customerIOFingerprintAccumulator, value string) error {
				return accumulator.observeSegment(canonical.Segment{Name: "VIP", SourceDefinition: `{"id":"7","state":"` + value + `"}`})
			},
		},
		{
			component: "editable_templates",
			observe: func(accumulator *customerIOFingerprintAccumulator, value string) error {
				return accumulator.observeTemplate(canonical.EmailTemplate{SourceID: "design:7", Name: "Welcome", HTML: value, SourcePlatform: canonical.SourceCustomerIO})
			},
		},
		{
			component: "sent_campaign_archive",
			observe: func(accumulator *customerIOFingerprintAccumulator, value string) error {
				return accumulator.observeCampaign(canonical.CampaignArchive{SourceID: "broadcast:7", Subject: value, SourcePlatform: canonical.SourceCustomerIO})
			},
		},
		{
			component: "source_archive",
			observe: func(accumulator *customerIOFingerprintAccumulator, value string) error {
				return accumulator.observeSourceArchive(canonical.SourceArchiveItem{
					SourceID:       "campaign:9:action:3",
					ResourceType:   "customerio_campaign_action",
					Status:         "preserved",
					Payload:        map[string]interface{}{"body": value},
					SourcePlatform: canonical.SourceCustomerIO,
				})
			},
		},
	}
	for _, test := range tests {
		t.Run(test.component, func(t *testing.T) {
			baselineAccumulator := newCustomerIOFingerprintAccumulator()
			require.NoError(t, test.observe(baselineAccumulator, "before"))
			completeCustomerIOFingerprint(t, baselineAccumulator)
			baseline, err := baselineAccumulator.fingerprint()
			require.NoError(t, err)

			currentAccumulator := newCustomerIOFingerprintAccumulator()
			require.NoError(t, test.observe(currentAccumulator, "after"))
			completeCustomerIOFingerprint(t, currentAccumulator)
			current, err := currentAccumulator.fingerprint()
			require.NoError(t, err)

			changed, err := ChangedCustomerIOFingerprintComponents(baseline, current)
			require.NoError(t, err)
			require.Equal(t, []string{test.component}, changed)
			require.Equal(t, baseline.Components[test.component].Count, current.Components[test.component].Count)
		})
	}
}

func TestCustomerIOSourceFingerprintSubscriberTagOrderIsNotSourceDrift(t *testing.T) {
	first := fingerprintTestCustomerIOSubscriber()
	second := cloneCustomerIOFingerprintSubscriber(t, first)
	second.Tags[0], second.Tags[1] = second.Tags[1], second.Tags[0]

	left := newCustomerIOFingerprintAccumulator()
	require.NoError(t, left.observeSubscriber(first))
	completeCustomerIOFingerprint(t, left)
	leftFingerprint, err := left.fingerprint()
	require.NoError(t, err)

	right := newCustomerIOFingerprintAccumulator()
	require.NoError(t, right.observeSubscriber(second))
	completeCustomerIOFingerprint(t, right)
	rightFingerprint, err := right.fingerprint()
	require.NoError(t, err)
	require.Equal(t, leftFingerprint, rightFingerprint)
}

func TestBuildCustomerIOSourceFingerprintTraversesEveryExactCutoverSurface(t *testing.T) {
	subscriber := fingerprintTestCustomerIOSubscriber()
	discovery := adapter.DiscoveryReport{
		SubscribersTotal:          1,
		ProfilesWithoutEmailTotal: 1,
		SegmentsTotal:             1,
		TemplatesTotal:            1,
		ArchiveTotal:              1,
		SourceArchiveTotal:        1,
		SnapshotMembershipCounts: map[string]int{
			"customerio:segment:vip":  1,
			"customerio:topic:weekly": 1,
		},
	}
	caps := canonical.AdapterCapabilities{Source: canonical.SourceCustomerIO}
	caps.Supports.Subscribers = true
	caps.Supports.Segments = true
	caps.Supports.CampaignArchive = true
	caps.Supports.Templates = true
	fixture := &fixtureAdapter{
		caps:        caps,
		discovery:   discovery,
		subscribers: [][]canonical.Subscriber{{subscriber}},
		segments: []canonical.Segment{{
			Name: "VIP", SourceDefinition: `{"source_id":"customerio:segment:vip","state":"active"}`,
		}},
		templates: [][]canonical.EmailTemplate{{{
			SourceID: "design:7", Name: "Welcome", HTML: "<p>Hello</p>", SourcePlatform: canonical.SourceCustomerIO,
		}}},
		archive: [][]canonical.CampaignArchive{{{
			SourceID: "broadcast:7", Subject: "Sent broadcast", SentAt: time.Unix(1, 0).UTC(), SourcePlatform: canonical.SourceCustomerIO,
		}}},
		sourceArchive: [][]canonical.SourceArchiveItem{{{
			SourceID:       "campaign:9:action:3",
			ResourceType:   "customerio_campaign_action",
			Payload:        map[string]interface{}{"body": "before"},
			SourcePlatform: canonical.SourceCustomerIO,
		}}},
		nonEmailIdentityCount:  1,
		nonEmailIdentityDigest: strings.Repeat("a", sha256.Size*2),
	}

	fingerprint, err := BuildCustomerIOSourceFingerprint(context.Background(), fixture, adapter.Session{Source: canonical.SourceCustomerIO}, discovery)
	require.NoError(t, err)
	for _, component := range customerIOFingerprintComponents {
		require.Equal(t, 1, fingerprint.Components[component].Count, component)
	}

	fixture.sourceArchive[0][0].Payload["body"] = "same count, changed source"
	current, err := BuildCustomerIOSourceFingerprint(context.Background(), fixture, adapter.Session{Source: canonical.SourceCustomerIO}, discovery)
	require.NoError(t, err)
	changed, err := ChangedCustomerIOFingerprintComponents(fingerprint, current)
	require.NoError(t, err)
	require.Equal(t, []string{"source_archive"}, changed)
}

func TestBuildCustomerIOSourceFingerprintDetectsSameCountNonEmailIdentityReplacement(t *testing.T) {
	discovery := adapter.DiscoveryReport{ProfilesWithoutEmailTotal: 1}
	caps := canonical.AdapterCapabilities{Source: canonical.SourceCustomerIO}
	caps.Supports.Segments = true
	caps.Supports.CampaignArchive = true
	caps.Supports.Templates = true
	fixture := &fixtureAdapter{
		caps:                   caps,
		nonEmailIdentityCount:  1,
		nonEmailIdentityDigest: strings.Repeat("a", sha256.Size*2),
	}

	baseline, err := BuildCustomerIOSourceFingerprint(context.Background(), fixture, adapter.Session{Source: canonical.SourceCustomerIO}, discovery)
	require.NoError(t, err)
	fixture.nonEmailIdentityDigest = strings.Repeat("b", sha256.Size*2)
	current, err := BuildCustomerIOSourceFingerprint(context.Background(), fixture, adapter.Session{Source: canonical.SourceCustomerIO}, discovery)
	require.NoError(t, err)
	changed, err := ChangedCustomerIOFingerprintComponents(baseline, current)
	require.NoError(t, err)
	require.Equal(t, []string{"profiles_without_email"}, changed)
}

func TestCustomerIOCommitPersistsNonEmailIdentityFingerprintAndShadowDetectsSameCountReplacement(t *testing.T) {
	discovery := adapter.DiscoveryReport{ProfilesWithoutEmailTotal: 1}
	caps := canonical.AdapterCapabilities{Source: canonical.SourceCustomerIO}
	caps.Supports.Subscribers = true
	caps.Supports.Segments = true
	caps.Supports.CampaignArchive = true
	caps.Supports.Templates = true
	fixture := &fixtureAdapter{
		caps:                   caps,
		discovery:              discovery,
		nonEmailIdentityCount:  1,
		nonEmailIdentityDigest: strings.Repeat("a", sha256.Size*2),
	}
	tenantID := "11111111-1111-1111-1111-111111111111"
	job := &canonical.MigrationJob{
		ID:       "22222222-2222-2222-2222-222222222222",
		TenantID: tenantID,
		Source:   canonical.SourceCustomerIO,
		Status:   canonical.MigImporting,
		Cursor:   map[string]*string{},
	}
	orchestrator := &Orchestrator{
		DB:       newCustomerIOFingerprintCommitTestDB(t),
		TenantID: tenantID,
		Listmonk: &listmonkx.Client{DedicatedTenant: true, DedicatedTenantID: tenantID},
	}

	require.NoError(t, orchestrator.Run(context.Background(), fixture, adapter.Session{Source: canonical.SourceCustomerIO}, job, nil))
	baseline, found, err := CustomerIOSourceFingerprintFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, 1, baseline.Components["profiles_without_email"].Count)
	_, found, err = CustomerIOImportEpochFromJob(job)
	require.NoError(t, err)
	require.True(t, found)

	expected, err := BuildCustomerIOSourceFingerprint(context.Background(), fixture, adapter.Session{Source: canonical.SourceCustomerIO}, discovery)
	require.NoError(t, err)
	require.Equal(t, expected, baseline, "commit and shadow traversals must fingerprint the same non-email identity evidence")

	fixture.nonEmailIdentityDigest = strings.Repeat("b", sha256.Size*2)
	current, err := BuildCustomerIOSourceFingerprint(context.Background(), fixture, adapter.Session{Source: canonical.SourceCustomerIO}, discovery)
	require.NoError(t, err)
	changed, err := ChangedCustomerIOFingerprintComponents(baseline, current)
	require.NoError(t, err)
	require.Equal(t, []string{"profiles_without_email"}, changed)
}

func TestBuildCustomerIOSourceFingerprintFailsClosedOnExactCountMismatch(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceCustomerIO}
	caps.Supports.Subscribers = true
	caps.Supports.Segments = true
	caps.Supports.CampaignArchive = true
	caps.Supports.Templates = true
	fixture := &fixtureAdapter{
		caps: caps,
		archive: [][]canonical.CampaignArchive{{
			{SourceID: "broadcast:1", SourcePlatform: canonical.SourceCustomerIO},
			{SourceID: "campaign:1", SourcePlatform: canonical.SourceCustomerIO},
		}},
	}
	discovery := adapter.DiscoveryReport{ArchiveTotal: 1}

	_, err := BuildCustomerIOSourceFingerprint(context.Background(), fixture, adapter.Session{Source: canonical.SourceCustomerIO}, discovery)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "returned 2 of 1")
}

func TestBuildCustomerIOSourceFingerprintBoundsSubscriberTraversal(t *testing.T) {
	caps := canonical.AdapterCapabilities{Source: canonical.SourceCustomerIO}
	caps.Supports.Subscribers = true
	caps.Supports.Segments = true
	caps.Supports.CampaignArchive = true
	caps.Supports.Templates = true
	fixture := &fixtureAdapter{
		caps: caps,
		subscriberFn: func(cursor string) ([]canonical.Subscriber, string, error) {
			return nil, cursor + "x", nil
		},
	}
	discovery := adapter.DiscoveryReport{SubscribersTotal: 1}

	_, err := BuildCustomerIOSourceFingerprint(context.Background(), fixture, adapter.Session{Source: canonical.SourceCustomerIO}, discovery)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "exceeded 2 page calls")
}

func TestCustomerIOSourceFingerprintRequiresCompleteTraversalAndPersistsOpaqueEpoch(t *testing.T) {
	incomplete := newCustomerIOFingerprintAccumulator()
	require.NoError(t, incomplete.observeSubscriber(fingerprintTestCustomerIOSubscriber()))
	_, err := incomplete.fingerprint()
	require.ErrorContains(t, err, "incomplete")

	complete := newCustomerIOFingerprintAccumulator()
	require.NoError(t, complete.observeSubscriber(fingerprintTestCustomerIOSubscriber()))
	completeCustomerIOFingerprint(t, complete)
	fingerprint, err := complete.fingerprint()
	require.NoError(t, err)
	job := &canonical.MigrationJob{Source: canonical.SourceCustomerIO, Cursor: map[string]*string{}}
	require.NoError(t, persistCustomerIOSourceFingerprint(job, fingerprint))
	require.Less(t, len(*job.Cursor[customerIOSourceFingerprintCursorKey]), maxCustomerIOFingerprintBytes)
	firstEpoch, found, err := CustomerIOImportEpochFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	require.Len(t, firstEpoch, sha256.Size*2)
	require.Equal(t, strings.ToLower(firstEpoch), firstEpoch)
	loaded, found, err := CustomerIOSourceFingerprintFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, fingerprint, loaded)

	require.NoError(t, persistCustomerIOSourceFingerprint(job, fingerprint))
	secondEpoch, found, err := CustomerIOImportEpochFromJob(job)
	require.NoError(t, err)
	require.True(t, found)
	require.NotEqual(t, firstEpoch, secondEpoch)

	tampered := fingerprint
	tampered.Components = make(map[string]CustomerIOSourceFingerprintComponent, len(fingerprint.Components))
	for name, component := range fingerprint.Components {
		tampered.Components[name] = component
	}
	component := tampered.Components["segments"]
	component.Count++
	tampered.Components["segments"] = component
	raw, err := json.Marshal(tampered)
	require.NoError(t, err)
	value := string(raw)
	job.Cursor[customerIOSourceFingerprintCursorKey] = &value
	_, found, err = CustomerIOSourceFingerprintFromJob(job)
	require.True(t, found)
	require.ErrorContains(t, err, "integrity check failed")
}

func completeCustomerIOFingerprint(t *testing.T, accumulator *customerIOFingerprintAccumulator) {
	t.Helper()
	for _, component := range customerIOFingerprintComponents {
		require.NoError(t, accumulator.complete(component))
	}
}

func fingerprintTestCustomerIOSubscriber() canonical.Subscriber {
	return canonical.Subscriber{
		Email:          "reader@example.com",
		Status:         canonical.StatusEnabled,
		ConsentSource:  canonical.ConsentImport,
		SourceID:       "cio-profile-one",
		SourcePlatform: canonical.SourceCustomerIO,
		CustomFields: map[string]interface{}{
			"first_name": "Ada",
			"customerio_source": map[string]interface{}{
				"publisher_id":        "publisher-one",
				"global_unsubscribed": false,
				"topic_preferences": map[string]interface{}{
					"weekly": true,
				},
			},
		},
		Tags: []string{"customerio:segment:vip", "customerio:topic:weekly"},
	}
}

func cloneCustomerIOFingerprintSubscriber(t *testing.T, value canonical.Subscriber) canonical.Subscriber {
	t.Helper()
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	var clone canonical.Subscriber
	require.NoError(t, json.Unmarshal(raw, &clone))
	return clone
}

func newCustomerIOFingerprintCommitTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db := sql.OpenDB(customerIOFingerprintCommitConnector{})
	t.Cleanup(func() { require.NoError(t, db.Close()) })
	return db
}

type customerIOFingerprintCommitConnector struct{}

func (customerIOFingerprintCommitConnector) Connect(context.Context) (driver.Conn, error) {
	return customerIOFingerprintCommitConn{}, nil
}

func (customerIOFingerprintCommitConnector) Driver() driver.Driver {
	return customerIOFingerprintCommitDriver{}
}

type customerIOFingerprintCommitDriver struct{}

func (customerIOFingerprintCommitDriver) Open(string) (driver.Conn, error) {
	return customerIOFingerprintCommitConn{}, nil
}

type customerIOFingerprintCommitConn struct{}

func (customerIOFingerprintCommitConn) Prepare(string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}

func (customerIOFingerprintCommitConn) Close() error { return nil }

func (customerIOFingerprintCommitConn) Begin() (driver.Tx, error) {
	return customerIOFingerprintCommitTx{}, nil
}

func (customerIOFingerprintCommitConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return customerIOFingerprintCommitTx{}, nil
}

func (customerIOFingerprintCommitConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(1), nil
}

func (customerIOFingerprintCommitConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	switch {
	case strings.Contains(query, "migration_verifier_subscriber_observations"):
		return &customerIOFingerprintCommitRows{columns: []string{"subscriber"}}, nil
	case strings.Contains(query, "SELECT max_custom_fields"):
		return &customerIOFingerprintCommitRows{
			columns: []string{"max_custom_fields", "custom_fields_mode"},
			values:  [][]driver.Value{{int64(100), "auto"}},
		}, nil
	case strings.Contains(query, "tenant_custom_fields"):
		return &customerIOFingerprintCommitRows{columns: []string{"key", "type"}}, nil
	case strings.Contains(query, "migration_imported_resources"):
		return &customerIOFingerprintCommitRows{columns: []string{
			"id", "tenant_id", "job_id", "resource_type", "source_platform",
			"source_id", "destination_type", "destination_id", "destination_metadata",
		}}, nil
	default:
		return nil, fmt.Errorf("unexpected Customer.io fingerprint commit test query: %s", strings.TrimSpace(query))
	}
}

type customerIOFingerprintCommitTx struct{}

func (customerIOFingerprintCommitTx) Commit() error   { return nil }
func (customerIOFingerprintCommitTx) Rollback() error { return nil }

type customerIOFingerprintCommitRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

func (r *customerIOFingerprintCommitRows) Columns() []string { return r.columns }
func (*customerIOFingerprintCommitRows) Close() error        { return nil }
func (r *customerIOFingerprintCommitRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	copy(dest, r.values[r.index])
	r.index++
	return nil
}
