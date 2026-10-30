// SPDX-License-Identifier: MIT

package substack

import (
	"archive/zip"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestPrepareUpload_OfficialZIPJourney(t *testing.T) {
	dir := t.TempDir()
	zipPath := filepath.Join(dir, "publication.zip")
	writeSubstackZIP(t, zipPath, map[string]string{
		"export/email_list.example.csv": `email,status,subscription_type,created_at,subscription source (free)
paid@example.com,active,founding,2026-01-02T03:04:05Z,Substack app
off@example.com,email disabled,free,2025-02-03T04:05:06Z,Google
`,
		"export/posts.csv": `post_id,post_date,is_published,email_sent_at,inbox_sent_at,type,audience,title,subtitle,podcast_url
101,2026-01-10T10:00:00Z,true,2026-01-10T10:05:00Z,,newsletter,everyone,Hello,World,
102,2026-01-11T10:00:00Z,false,,,newsletter,everyone,Draft,,
`,
		"export/posts/101.hello.html":   `<article><h1>Hello</h1><p>Export body</p></article>`,
		"export/posts/101.delivers.csv": "email\na@example.com\nb@example.com\n",
		"export/posts/101.opens.csv":    "email\na@example.com\n",
		"export/posts/ignored.exe":      "not extracted",
	})

	extra, err := PrepareUpload(zipPath, dir, "publication.zip")
	require.NoError(t, err)
	require.FileExists(t, extra["subs_csv"])
	require.FileExists(t, extra["archive_csv"])
	require.FileExists(t, extra["bundle_manifest_path"])
	require.FileExists(t, extra["archive_stats_csv"])
	require.NoFileExists(t, filepath.Join(extra["archive_dir"], "export", "posts", "ignored.exe"))
	require.NoFileExists(t, filepath.Join(extra["archive_dir"], "export", "posts", "101.delivers.csv"))
	require.NoFileExists(t, filepath.Join(extra["archive_dir"], "export", "posts", "101.opens.csv"))

	a := New()
	sess, err := a.Authenticate(context.Background(), adapter.Credentials{Extra: extra})
	require.NoError(t, err)
	require.Contains(t, sess.AccountID, "substack-export:")

	discovery, err := a.Discover(context.Background(), sess)
	require.NoError(t, err)
	require.Equal(t, 2, discovery.SubscribersTotal)
	require.Equal(t, 1, discovery.PaidSubsTotal, "founding membership is review evidence, not a billing object")
	require.Equal(t, 1, discovery.ArchiveTotal, "draft without email-send evidence must not become sent history")
	require.Equal(t, 1, discovery.ReportsTotal)
	require.Equal(t, 1+len(substackParityGaps), discovery.SourceArchiveTotal)

	subs, next, err := a.ListSubscribers(context.Background(), sess, "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Equal(t, canonical.StatusUnconfirmed, subs[0].Status)
	require.Equal(t, []string{"substack:tier:founding"}, subs[0].Tags)
	require.Nil(t, subs[0].ConsentTimestamp)
	require.Equal(t, canonical.StatusDisabled, subs[1].Status)
	require.Equal(t, "Google", subs[1].CustomFields["substack_subscription_source_free"])

	posts, next, err := a.ListCampaignArchive(context.Background(), sess, "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, posts, 1)
	require.Equal(t, "101", posts[0].SourceID)
	require.Contains(t, posts[0].HTML, "Export body")
	require.Equal(t, 2, posts[0].RecipientsCount)
	require.Equal(t, 1, posts[0].Opens)
	require.Equal(t, "substack_export_recipient_statistics", posts[0].Report["source"])

	archiveItems, next, err := a.ListSourceArchive(context.Background(), sess, "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, archiveItems, discovery.SourceArchiveTotal)
	require.Equal(t, "substack_export_inventory", archiveItems[0].ResourceType)
}

func TestPostsCSV_IncludesDirectEmailWithFalsePublishedFlag(t *testing.T) {
	posts, err := parsePostsCSV(strings.NewReader(`post_id,post_date,is_published,email_sent_at,title
77,2026-01-10T10:00:00Z,false,2026-01-10T10:05:00Z,Direct email
`))
	require.NoError(t, err)
	require.Len(t, posts, 1)
	require.Equal(t, "77", posts[0].SourceID)
}

func TestPostsCSV_RejectsArchiveWithoutEmailSendEvidenceColumn(t *testing.T) {
	_, _, err := streamPostsCSV(strings.NewReader(`post_id,post_date,is_published,title
77,2026-01-10T10:00:00Z,true,Web-only post
`), 0, 100)
	require.ErrorContains(t, err, "missing email-send evidence")
}

func TestPrepareUpload_RejectsTraversalAndAmbiguousSubscriberCSVs(t *testing.T) {
	t.Run("traversal", func(t *testing.T) {
		dir := t.TempDir()
		zipPath := filepath.Join(dir, "bad.zip")
		writeSubstackZIP(t, zipPath, map[string]string{"../email_list.csv": "email,status\na@example.com,active\n"})
		_, err := PrepareUpload(zipPath, dir, "bad.zip")
		require.ErrorContains(t, err, "unsafe ZIP entry")
		require.NoFileExists(t, filepath.Join(dir, "email_list.csv"))
	})

	t.Run("ambiguous", func(t *testing.T) {
		dir := t.TempDir()
		zipPath := filepath.Join(dir, "ambiguous.zip")
		writeSubstackZIP(t, zipPath, map[string]string{
			"email_list.one.csv": "email,status\na@example.com,active\n",
			"email_list.two.csv": "email,status\nb@example.com,active\n",
		})
		_, err := PrepareUpload(zipPath, dir, "ambiguous.zip")
		require.ErrorContains(t, err, "multiple equally likely subscriber CSVs")
	})

	t.Run("duplicate paths", func(t *testing.T) {
		dir := t.TempDir()
		zipPath := filepath.Join(dir, "duplicate.zip")
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		for _, body := range []string{
			"email,status\na@example.com,active\n",
			"email,status\nb@example.com,active\n",
		} {
			w, err := zw.Create("email_list.csv")
			require.NoError(t, err)
			_, err = w.Write([]byte(body))
			require.NoError(t, err)
		}
		require.NoError(t, zw.Close())
		require.NoError(t, os.WriteFile(zipPath, buf.Bytes(), 0o600))
		_, err := PrepareUpload(zipPath, dir, "duplicate.zip")
		require.ErrorContains(t, err, "duplicate entry path")
	})

	t.Run("duplicate post statistics", func(t *testing.T) {
		dir := t.TempDir()
		zipPath := filepath.Join(dir, "duplicate-stats.zip")
		writeSubstackZIP(t, zipPath, map[string]string{
			"email_list.csv":          "email,status\na@example.com,active\n",
			"one/42.delivers.csv":     "email\na@example.com\n",
			"another/42.delivers.csv": "email\nb@example.com\n",
		})
		_, err := PrepareUpload(zipPath, dir, "duplicate-stats.zip")
		require.ErrorContains(t, err, "multiple deliveries files")
	})
}

func TestSubscriberCSV_StatusAliasConsentAndDuplicateSafety(t *testing.T) {
	csvData := `Email Address,Status,Subscription Type,Created At
same@example.com,active,paid,2026-01-01T00:00:00Z
same@example.com,complained,paid,2026-01-02T00:00:00Z
blank@example.com,,free,2026-01-03T00:00:00Z
`
	subs, err := parseSubscribersCSV(strings.NewReader(csvData))
	require.NoError(t, err)
	require.Len(t, subs, 2)
	require.Equal(t, canonical.StatusBlocklisted, subs[0].Status, "a later complaint must dominate an earlier active duplicate")
	require.Equal(t, canonical.StatusUnconfirmed, subs[1].Status, "missing status must never default to enabled")
	for _, sub := range subs {
		require.Nil(t, sub.ConsentTimestamp)
		require.Equal(t, canonical.ConsentUnknown, sub.ConsentSource)
	}
}

func TestSubscriberCSV_RejectsMissingInvalidAndAmbiguousIdentityRows(t *testing.T) {
	for name, csvData := range map[string]string{
		"missing email":          "email,status\n,active\n",
		"invalid email":          "email,status\nnot-an-email,active\n",
		"one id multiple emails": "subscriber_id,email,status\nsub_1,a@example.com,active\nsub_1,b@example.com,active\n",
		"one email multiple ids": "subscriber_id,email,status\nsub_1,a@example.com,active\nsub_2,a@example.com,disabled\n",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := parseSubscribersCSV(strings.NewReader(csvData))
			require.Error(t, err)
		})
	}
}

func TestSubscriberCSV_AcceptsTypeTierAlias(t *testing.T) {
	subs, err := parseSubscribersCSV(strings.NewReader("email,status,type\npaid@example.com,active,founding\n"))
	require.NoError(t, err)
	require.Len(t, subs, 1)
	require.Equal(t, []string{"substack:tier:founding"}, subs[0].Tags)
}

func TestSubstackCursorsRejectMalformedOrNegativeValues(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "subs.csv")
	require.NoError(t, os.WriteFile(path, []byte(subsCSVFixture), 0o600))
	sess, err := New().Authenticate(context.Background(), adapter.Credentials{Extra: map[string]string{"subs_csv": path}})
	require.NoError(t, err)
	for _, cursor := range []string{"garbage", "-1"} {
		_, _, err := New().ListSubscribers(context.Background(), sess, cursor)
		require.Error(t, err)
	}
	_, _, err = New().ListSourceArchive(context.Background(), sess, "unexpected")
	require.Error(t, err)
}

func writeSubstackZIP(t *testing.T, destination string, files map[string]string) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		require.NoError(t, err)
		_, err = w.Write([]byte(body))
		require.NoError(t, err)
	}
	require.NoError(t, zw.Close())
	require.NoError(t, os.WriteFile(destination, buf.Bytes(), 0o600))
}
