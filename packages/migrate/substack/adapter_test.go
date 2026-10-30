// SPDX-License-Identifier: MIT

package substack

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const subsCSVFixture = `email,created_at,state,source,name
alice@example.com,2024-01-15T10:00:00Z,active,signup,Alice
bob@example.com,2024-02-20T08:30:00Z,canceled,referral,Bob
charlie@example.com,2024-03-10T12:00:00Z,pending,api,Charlie
`

func TestParseSubscribersCSV(t *testing.T) {
	subs, err := parseSubscribersCSV(strings.NewReader(subsCSVFixture))
	require.NoError(t, err)
	require.Len(t, subs, 3)

	require.Equal(t, "alice@example.com", subs[0].Email)
	require.Equal(t, canonical.StatusUnconfirmed, subs[0].Status)
	require.Nil(t, subs[0].ConsentTimestamp)
	require.Equal(t, canonical.ConsentUnknown, subs[0].ConsentSource)
	require.Equal(t, "2024-01-15T10:00:00Z", subs[0].CustomFields["substack_created_at"])
	require.Equal(t, canonical.SourceSubstack, subs[0].SourcePlatform)
	require.Equal(t, "Alice", subs[0].CustomFields["name"])

	require.Equal(t, canonical.StatusDisabled, subs[1].Status)
	require.Equal(t, canonical.StatusUnconfirmed, subs[2].Status)
}

func TestStreamSubscribersCSVCursorPagesDeterministically(t *testing.T) {
	page1, next, err := streamSubscribersCSV(strings.NewReader(subsCSVFixture), 0, 2)
	require.NoError(t, err)
	require.Equal(t, 2, next)
	require.Equal(t, []string{"alice@example.com", "bob@example.com"}, []string{page1[0].Email, page1[1].Email})

	page2, next, err := streamSubscribersCSV(strings.NewReader(subsCSVFixture), next, 2)
	require.NoError(t, err)
	require.Zero(t, next)
	require.Len(t, page2, 1)
	require.Equal(t, "charlie@example.com", page2[0].Email)

	count, err := countSubscribersCSV(strings.NewReader(subsCSVFixture))
	require.NoError(t, err)
	require.Equal(t, 3, count)
}

const postsCSVFixture = `title,subtitle,published_at,sent_at,body_html,audience
Welcome,first post,2024-01-01T09:00:00Z,2024-01-01T10:00:00Z,<p>hi</p>,everyone
Update,,2024-02-01T09:00:00Z,2024-02-01T10:00:00Z,<p>news</p>,paid
`

func TestParsePostsCSV(t *testing.T) {
	posts, err := parsePostsCSV(strings.NewReader(postsCSVFixture))
	require.NoError(t, err)
	require.Len(t, posts, 2)
	require.Equal(t, "Welcome — first post", posts[0].Subject)
	require.Equal(t, "<p>hi</p>", posts[0].HTML)
	require.Equal(t, canonical.SourceSubstack, posts[0].SourcePlatform)
	require.False(t, posts[0].SentAt.IsZero())

	require.Equal(t, "Update", posts[1].Subject) // empty subtitle, no separator
}

func TestParsePostsCSV_OptionalStatsColumns(t *testing.T) {
	const enriched = `title,subtitle,published_at,sent_at,body_html,audience,recipients_count,unique_opens,unique_clicks
Launch,,2024-02-01T09:00:00Z,2024-02-01T10:00:00Z,<p>ship</p>,everyone,"1,250",600,42
`
	posts, err := parsePostsCSV(strings.NewReader(enriched))
	require.NoError(t, err)
	require.Len(t, posts, 1)
	require.Equal(t, 1250, posts[0].RecipientsCount)
	require.Equal(t, 600, posts[0].Opens)
	require.Equal(t, 42, posts[0].Clicks)
}

func TestListCampaignArchive_MergesArchiveStatsCSV(t *testing.T) {
	dir := t.TempDir()
	subsPath := filepath.Join(dir, "subscribers.csv")
	archivePath := filepath.Join(dir, "posts.csv")
	statsPath := filepath.Join(dir, "post_stats.csv")
	require.NoError(t, os.WriteFile(subsPath, []byte(subsCSVFixture), 0o600))
	require.NoError(t, os.WriteFile(archivePath, []byte(postsCSVFixture), 0o600))
	require.NoError(t, os.WriteFile(statsPath, []byte(`title,published_at,recipients,open_rate,click_rate,views,likes
Welcome,2024-01-01T10:00:00Z,"1,250",48%,3.2%,2000,17
`), 0o600))

	posts, next, err := New().ListCampaignArchive(context.Background(), adapter.Session{Extra: map[string]string{
		"archive_csv":       archivePath,
		"archive_stats_csv": statsPath,
	}}, "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, posts, 2)
	require.Equal(t, 1250, posts[0].RecipientsCount)
	require.Equal(t, 600, posts[0].Opens)
	require.Equal(t, 40, posts[0].Clicks)
	require.Equal(t, 2000, posts[0].Report["views"])
	require.Equal(t, 17, posts[0].Report["likes"])
	require.Equal(t, "archive_stats_csv", posts[0].Report["source"])
	require.Zero(t, posts[1].RecipientsCount)
}

func TestParsePostStatsCSV_MatchesByURLOrSlugKeys(t *testing.T) {
	stats, err := parsePostStatsCSV(strings.NewReader(`slug,url,subject,recipients_count,unique_opens,unique_clicks
launch-post,https://example.substack.com/p/launch-post,Launch,100,55,6
`))
	require.NoError(t, err)
	require.Len(t, stats, 1)

	posts := []canonical.CampaignArchive{{
		SourceID: "other",
		Subject:  "Something else",
		Report:   map[string]interface{}{"url": "https://example.substack.com/p/launch-post/"},
	}}
	applyPostStats(posts, stats)
	require.Equal(t, 100, posts[0].RecipientsCount)
	require.Equal(t, 55, posts[0].Opens)
	require.Equal(t, 6, posts[0].Clicks)
}

func TestStreamPostsCSVPaginatesWithoutMaterializingAllRows(t *testing.T) {
	page1, next, err := streamPostsCSV(strings.NewReader(postsCSVFixture), 0, 1)
	require.NoError(t, err)
	require.Equal(t, 1, next)
	require.Len(t, page1, 1)
	require.Equal(t, "Welcome — first post", page1[0].Subject)

	page2, next, err := streamPostsCSV(strings.NewReader(postsCSVFixture), next, 1)
	require.NoError(t, err)
	require.Zero(t, next)
	require.Len(t, page2, 1)
	require.Equal(t, "Update", page2[0].Subject)

	count, err := countPostsCSV(strings.NewReader(postsCSVFixture))
	require.NoError(t, err)
	require.Equal(t, 2, count)
}

func TestMapSubscriber_StatusMapping(t *testing.T) {
	cases := map[string]canonical.SubscriberStatus{
		"active":    canonical.StatusUnconfirmed,
		"canceled":  canonical.StatusDisabled,
		"cancelled": canonical.StatusDisabled,
		"expired":   canonical.StatusDisabled,
		"pending":   canonical.StatusUnconfirmed,
	}
	for state, want := range cases {
		t.Run(state, func(t *testing.T) {
			s := mapSubscriber(subsCSVRow{Email: "x@y.com", State: state, CreatedAt: "2024-01-01T00:00:00Z"})
			require.Equal(t, want, s.Status)
			require.Equal(t, canonical.ConsentUnknown, s.ConsentSource)
			require.Nil(t, s.ConsentTimestamp)
		})
	}
}

func TestCapabilities(t *testing.T) {
	caps := New().Capabilities()
	require.True(t, caps.Supports.Subscribers)
	require.False(t, caps.Supports.Segments)
	require.False(t, caps.Supports.Automations)
	require.True(t, caps.Supports.CampaignArchive)
	require.False(t, caps.Supports.PaidSubs)
	require.False(t, caps.Supports.ConsentTimestamps)
}

func TestAuthenticateStoresCSVPathsInSessionExtra(t *testing.T) {
	dir := t.TempDir()
	subsPath := filepath.Join(dir, "subscribers.csv")
	archivePath := filepath.Join(dir, "posts.csv")
	require.NoError(t, os.WriteFile(subsPath, []byte(subsCSVFixture), 0o600))
	require.NoError(t, os.WriteFile(archivePath, []byte(postsCSVFixture), 0o600))

	sess, err := New().Authenticate(context.Background(), adapter.Credentials{
		Extra: map[string]string{
			"subs_csv":    subsPath,
			"archive_csv": archivePath,
		},
	})
	require.NoError(t, err)
	require.Contains(t, sess.AccountID, "substack-export:")
	require.Equal(t, subsPath, sess.Extra["subs_csv"])
	require.Equal(t, archivePath, sess.Extra["archive_csv"])
	require.NotEmpty(t, sess.Extra["export_fingerprint"])

	gotSubs, gotArchive := pathsFromSession(sess)
	require.Equal(t, subsPath, gotSubs)
	require.Equal(t, archivePath, gotArchive)
}

func TestAuthenticateRejectsUnboundStripeReferences(t *testing.T) {
	dir := t.TempDir()
	subsPath := filepath.Join(dir, "subscribers.csv")
	require.NoError(t, os.WriteFile(subsPath, []byte(subsCSVFixture), 0o600))

	_, err := New().Authenticate(context.Background(), adapter.Credentials{Extra: map[string]string{
		"subs_csv":          subsPath,
		"stripe_account_id": "acct_unbound",
	}})
	require.ErrorContains(t, err, "cannot prove publication-bound billing ownership")
	require.ErrorIs(t, err, adapter.ErrAuth)
}

func TestAuthenticateRejectsBrowserSessionCredentials(t *testing.T) {
	dir := t.TempDir()
	subsPath := filepath.Join(dir, "subscribers.csv")
	require.NoError(t, os.WriteFile(subsPath, []byte(subsCSVFixture), 0o600))

	_, err := New().Authenticate(context.Background(), adapter.Credentials{Extra: map[string]string{
		"subs_csv":        subsPath,
		"substack_cookie": "unsupported-secret",
	}})
	require.ErrorContains(t, err, "user-owned export")
	require.ErrorIs(t, err, adapter.ErrAuth)
}
