// SPDX-License-Identifier: MIT

package csv

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

const cleanCSV = `email,name,subscribed,signup_date,city
alice@example.com,Alice,true,2024-01-15,NYC
bob@example.com,Bob,false,2024-02-20,SF
charlie@example.com,Charlie,yes,2024-03-10,LA
`

const messyCSV = `User Email,Full Name,Status,Joined,Custom Tier
ALICE@example.com  ,Alice Smith,active,2024-01-15T10:00:00Z,gold
,Empty,active,2024-01-01T00:00:00Z,silver
bob@example.com,Bob Jones,unsubscribed,2024-02-20 08:30:00,bronze
`

const minimalCSV = `e-mail
alice@example.com
bob@example.com
`

func writeTemp(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "test.csv")
	require.NoError(t, os.WriteFile(p, []byte(body), 0o600))
	return p
}

func TestDetectMapping_Clean(t *testing.T) {
	mp, _, err := DetectMapping(strings.NewReader(cleanCSV))
	require.NoError(t, err)
	kinds := map[string]FieldKind{}
	for _, c := range mp.Columns {
		kinds[c.Name] = c.Kind
	}
	require.Equal(t, KindEmail, kinds["email"])
	require.Equal(t, KindName, kinds["name"])
	require.Equal(t, KindStatus, kinds["subscribed"])
	require.Equal(t, KindCustom, kinds["signup_date"])
	require.Equal(t, KindCustom, kinds["city"])
}

func TestDetectMapping_MessyHeaders(t *testing.T) {
	mp, _, err := DetectMapping(strings.NewReader(messyCSV))
	require.NoError(t, err)
	// "User Email" is not in the header allowlist; value-based detection
	// should still promote it to the email column.
	var emailCols int
	for _, c := range mp.Columns {
		if c.Kind == KindEmail {
			emailCols++
		}
	}
	require.Equal(t, 1, emailCols, "exactly one column should be classified as email")
}

func TestDetectMapping_Minimal(t *testing.T) {
	mp, _, err := DetectMapping(strings.NewReader(minimalCSV))
	require.NoError(t, err)
	require.Equal(t, KindEmail, mp.Columns[0].Kind)
}

func TestAuthenticateAndList_Clean(t *testing.T) {
	path := writeTemp(t, cleanCSV)
	a := New()
	sess, err := a.Authenticate(context.Background(), adapter.Credentials{
		Extra: map[string]string{"csv_path": path},
	})
	require.NoError(t, err)

	subs, next, err := a.ListSubscribers(context.Background(), sess, "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, subs, 3)

	require.Equal(t, "alice@example.com", subs[0].Email)
	require.Equal(t, canonical.StatusEnabled, subs[0].Status)
	require.Nil(t, subs[0].ConsentTimestamp, "signup is not opt-in evidence")
	require.Equal(t, "Alice", subs[0].CustomFields["name"])
	require.Equal(t, "NYC", subs[0].CustomFields["city"])

	require.Equal(t, canonical.StatusDisabled, subs[1].Status)
}

func TestAuthenticate_Messy_DropsEmptyEmailRow(t *testing.T) {
	path := writeTemp(t, messyCSV)
	a := New()
	sess, err := a.Authenticate(context.Background(), adapter.Credentials{
		Extra: map[string]string{"csv_path": path},
	})
	require.NoError(t, err)
	subs, _, err := a.ListSubscribers(context.Background(), sess, "")
	require.NoError(t, err)
	require.Len(t, subs, 2, "blank email row dropped")
	require.Equal(t, "alice@example.com", subs[0].Email)
}

func TestAuthenticateRejectsOversizedCSVFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "huge.csv")
	f, err := os.Create(path)
	require.NoError(t, err)
	require.NoError(t, f.Truncate(maxCSVFileBytes+1))
	require.NoError(t, f.Close())

	_, err = New().Authenticate(context.Background(), adapter.Credentials{
		Extra: map[string]string{"csv_path": path},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "file exceeds")
}

func TestUnsupportedResources(t *testing.T) {
	a := New()
	_, err := a.ListSegments(context.Background(), adapter.Session{})
	require.ErrorIs(t, err, adapter.ErrUnsupported)
	_, err = a.ListAutomations(context.Background(), adapter.Session{})
	require.ErrorIs(t, err, adapter.ErrUnsupported)
	_, _, err = a.ListCampaignArchive(context.Background(), adapter.Session{}, "")
	require.ErrorIs(t, err, adapter.ErrUnsupported)
	_, err = a.ListPaidSubs(context.Background(), adapter.Session{}, "")
	require.ErrorIs(t, err, adapter.ErrUnsupported)
}
