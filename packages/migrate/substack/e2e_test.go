// SPDX-License-Identifier: MIT

package substack

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// Wide CSV with edge cases: comma-bearing tag, unicode, unsubscribed, blank
// email, extras column with quoted comma value.
const e2eSubsCSV = `email,created_at,state,source,name,paid_subscription_status
alice@example.com,2024-01-15T10:00:00Z,active,signup,Alice,active
bob@example.com,2024-02-20T08:30:00Z,canceled,referral,Bob,canceled
charlie@example.com,2024-03-10T12:00:00Z,pending,api,Charlie,
diana@example.com,2024-04-01T00:00:00Z,unsubscribed,api,Diana,
elena@example.com,2024-05-01 09:00:00,unsubscribed,api,Elena,
fyodor@example.com,2024-06-01T00:00:00Z,active,api,"Fyodor, Sr.",
unicode@example.com,2024-07-01T00:00:00Z,active,api,Дмитрий,
gus@example.com,2024-08-01T00:00:00Z,complained,api,Gus,
`

const e2ePostsCSV = `title,subtitle,published_at,sent_at,body_html,audience
Welcome,first post,2024-01-01T09:00:00Z,2024-01-01T10:00:00Z,<p>hi</p>,everyone
Update,,2024-02-01T09:00:00Z,2024-02-01T10:00:00Z,<p>news</p>,paid
Long Post,Some sub,2024-03-15T07:00:00Z,2024-03-15T08:00:00Z,"<p>html with, comma</p>",everyone
`

func writeFixture(t *testing.T) (subsPath, archivePath string) {
	dir := t.TempDir()
	subsPath = filepath.Join(dir, "subs.csv")
	archivePath = filepath.Join(dir, "posts.csv")
	require.NoError(t, os.WriteFile(subsPath, []byte(e2eSubsCSV), 0o600))
	require.NoError(t, os.WriteFile(archivePath, []byte(e2ePostsCSV), 0o600))
	return
}

func TestSubstackE2E_FullJourney(t *testing.T) {
	subsPath, archivePath := writeFixture(t)

	a := New()
	ctx := context.Background()

	sess, err := a.Authenticate(ctx, adapter.Credentials{
		Extra: map[string]string{
			"subs_csv":    subsPath,
			"archive_csv": archivePath,
		},
	})
	require.NoError(t, err)
	require.Equal(t, canonical.SourceSubstack, sess.Source)
	require.Contains(t, sess.AccountID, "substack-export:")

	// Discover counts file evidence; this fixture has no tier column.
	rep, err := a.Discover(ctx, sess)
	require.NoError(t, err)
	require.Equal(t, 8, rep.SubscribersTotal)
	require.Equal(t, 3, rep.ArchiveTotal)
	require.Equal(t, 3, rep.CampaignsTotal)
	require.Equal(t, 0, rep.PaidSubsTotal)

	// ListSubscribers across pages.
	var allSubs []canonical.Subscriber
	cursor := ""
	for i := 0; i < 5; i++ {
		batch, next, err := a.ListSubscribers(ctx, sess, cursor)
		require.NoError(t, err)
		allSubs = append(allSubs, batch...)
		if next == "" {
			break
		}
		cursor = next
	}
	require.Len(t, allSubs, 8)

	statusByEmail := map[string]canonical.SubscriberStatus{}
	for _, s := range allSubs {
		statusByEmail[s.Email] = s.Status
	}
	require.Equal(t, canonical.StatusUnconfirmed, statusByEmail["alice@example.com"])
	require.Equal(t, canonical.StatusDisabled, statusByEmail["bob@example.com"])
	require.Equal(t, canonical.StatusUnconfirmed, statusByEmail["charlie@example.com"])
	require.Equal(t, canonical.StatusDisabled, statusByEmail["diana@example.com"], "unsubscribed must map to disabled")
	require.Equal(t, canonical.StatusDisabled, statusByEmail["elena@example.com"], "alt timestamp + unsubscribed")
	require.Equal(t, canonical.StatusBlocklisted, statusByEmail["gus@example.com"], "complained must map to blocklisted")

	// Edge cases.
	for _, s := range allSubs {
		switch s.Email {
		case "fyodor@example.com":
			require.Equal(t, "Fyodor, Sr.", s.CustomFields["name"], "comma-quoted name preserved")
		case "unicode@example.com":
			require.Equal(t, "Дмитрий", s.CustomFields["name"], "unicode preserved")
		case "elena@example.com":
			require.Equal(t, "2024-05-01 09:00:00", s.CustomFields["substack_created_at"])
		}
		require.Equal(t, canonical.SourceSubstack, s.SourcePlatform)
		require.Equal(t, canonical.ConsentUnknown, s.ConsentSource)
		require.Nil(t, s.ConsentTimestamp)
	}

	// ListSegments / ListAutomations — ErrUnsupported.
	_, err = a.ListSegments(ctx, sess)
	require.True(t, errors.Is(err, adapter.ErrUnsupported))
	_, err = a.ListAutomations(ctx, sess)
	require.True(t, errors.Is(err, adapter.ErrUnsupported))

	// ListCampaignArchive.
	camps, next, err := a.ListCampaignArchive(ctx, sess, "")
	require.NoError(t, err)
	require.Equal(t, "", next)
	require.Len(t, camps, 3)
	require.Equal(t, "Welcome — first post", camps[0].Subject)
	require.Equal(t, "Update", camps[1].Subject, "no subtitle = no separator")
	require.Equal(t, "Long Post — Some sub", camps[2].Subject)
	require.Contains(t, camps[2].HTML, "comma", "comma-bearing HTML preserved")

	// Billing continuity is explicitly unsupported by the file adapter.
	_, err = a.ListPaidSubs(ctx, sess, "")
	require.Error(t, err)
	require.True(t, errors.Is(err, adapter.ErrUnsupported))
}

func TestSubstackE2E_AuthMissingExtras(t *testing.T) {
	a := New()
	_, err := a.Authenticate(context.Background(), adapter.Credentials{})
	require.Error(t, err)
	require.True(t, errors.Is(err, adapter.ErrAuth))
}

func TestSubstackE2E_AuthMissingSubsCSV(t *testing.T) {
	a := New()
	_, err := a.Authenticate(context.Background(), adapter.Credentials{
		Extra: map[string]string{},
	})
	require.Error(t, err)
	require.True(t, errors.Is(err, adapter.ErrAuth))
}

func TestSubstackE2E_AuthMissingFile(t *testing.T) {
	a := New()
	_, err := a.Authenticate(context.Background(), adapter.Credentials{
		Extra: map[string]string{"subs_csv": "/nonexistent/path/missing.csv"},
	})
	require.Error(t, err)
	require.True(t, errors.Is(err, adapter.ErrAuth))
}

func TestSubstackE2E_CursorIdempotency(t *testing.T) {
	subsPath, _ := writeFixture(t)
	a := New()
	sess, err := a.Authenticate(context.Background(), adapter.Credentials{
		Extra: map[string]string{"subs_csv": subsPath},
	})
	require.NoError(t, err)

	subs1, next1, err := a.ListSubscribers(context.Background(), sess, "0")
	require.NoError(t, err)
	subs2, next2, err := a.ListSubscribers(context.Background(), sess, "0")
	require.NoError(t, err)
	require.Equal(t, next1, next2)
	require.Equal(t, len(subs1), len(subs2))
	for i := range subs1 {
		require.Equal(t, subs1[i].Email, subs2[i].Email)
	}
}

func TestSubstackE2E_LargeFileSimulatedPagination(t *testing.T) {
	// Build a CSV with 2500 rows to force page boundaries (page size 1000).
	var b strings.Builder
	b.WriteString("email,created_at,state,name\n")
	for i := 0; i < 2500; i++ {
		b.WriteString("user")
		b.WriteString(itoa(i))
		b.WriteString("@example.com,2024-01-01T00:00:00Z,active,User\n")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "big.csv")
	require.NoError(t, os.WriteFile(path, []byte(b.String()), 0o600))

	a := New()
	sess, err := a.Authenticate(context.Background(), adapter.Credentials{
		Extra: map[string]string{"subs_csv": path},
	})
	require.NoError(t, err)

	cur := ""
	count := 0
	pages := 0
	for {
		batch, next, err := a.ListSubscribers(context.Background(), sess, cur)
		require.NoError(t, err)
		count += len(batch)
		pages++
		if next == "" {
			break
		}
		cur = next
		require.LessOrEqual(t, pages, 4, "must not paginate past data")
	}
	require.Equal(t, 2500, count)
	require.Equal(t, 3, pages, "1000+1000+500")
}

// tiny helper to avoid importing strconv just for one call.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
