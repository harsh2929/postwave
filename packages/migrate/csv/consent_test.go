package csv

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestSubscriptionStatesFailClosed(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  canonical.SubscriberStatus
	}{
		{"subscribed", canonical.StatusEnabled}, {"true", canonical.StatusEnabled},
		{"Unsubscribed", canonical.StatusDisabled}, {"false", canonical.StatusDisabled},
		{"bounced", canonical.StatusBlocklisted}, {"hard-bounced", canonical.StatusBlocklisted},
		{"spam", canonical.StatusBlocklisted}, {"suppressed", canonical.StatusBlocklisted},
		{"unconfirmed", canonical.StatusUnconfirmed}, {"pending", canonical.StatusUnconfirmed},
		{"mystery", canonical.StatusUnconfirmed}, {"", canonical.StatusUnconfirmed},
	} {
		t.Run(tc.value, func(t *testing.T) {
			mapping, rows, err := DetectMapping(strings.NewReader("email,status\na@example.com," + tc.value + "\n"))
			require.NoError(t, err)
			sub, ok := applyRow(rows[0], mapping)
			require.True(t, ok)
			require.Equal(t, tc.want, sub.Status)
			require.Nil(t, sub.ConsentTimestamp)
		})
	}
}

func TestDatesAndBooleanCustomFieldsDoNotInventConsentOrStatus(t *testing.T) {
	body := "\ufeffEmail,created_at,subscribed_at,signup_date,birthday,vip,Opted In At\na@example.com,2024-01-01,2024-01-01,2024-01-01,2024-01-01,true,2024-02-03T04:05:06Z\n"
	mp, rows, err := DetectMapping(strings.NewReader(body))
	require.NoError(t, err)
	for _, col := range mp.Columns[1:6] {
		require.Equal(t, KindCustom, col.Kind, col.Name)
	}
	sub, ok := applyRow(rows[0], mp)
	require.True(t, ok)
	require.Equal(t, canonical.StatusUnconfirmed, sub.Status)
	require.NotNil(t, sub.ConsentTimestamp)
	require.Equal(t, canonical.ConsentImport, sub.ConsentSource, "a timestamp alone must not claim single/double opt-in")
}

func TestMissingStatusIsUnconfirmed(t *testing.T) {
	mp, rows, err := DetectMapping(strings.NewReader("email\na@example.com\n"))
	require.NoError(t, err)
	sub, ok := applyRow(rows[0], mp)
	require.True(t, ok)
	require.Equal(t, canonical.StatusUnconfirmed, sub.Status)
}

func TestMalformedMappingAndCursorDoNotRestartImport(t *testing.T) {
	a := New()
	creds := adapter.Credentials{Extra: map[string]string{"csv_path": writeTemp(t, minimalCSV), "mapping": "{"}}
	_, err := a.Authenticate(context.Background(), creds)
	require.ErrorContains(t, err, "invalid mapping")
	delete(creds.Extra, "mapping")
	sess, err := a.Authenticate(context.Background(), creds)
	require.NoError(t, err)
	for _, cursor := range []string{"oops", "-1"} {
		_, _, err = a.ListSubscribers(context.Background(), sess, cursor)
		require.ErrorContains(t, err, "invalid row cursor")
	}
}

func TestCSVRejectsUnusableEncodingAndAmbiguousHeaders(t *testing.T) {
	for _, body := range []string{"\xff\xfeE\x00m\x00a\x00i\x00l\x00", "Email,status\na@example.com,\xff\n", "Email,Status,status\na@example.com,active,inactive\n"} {
		_, err := New().Authenticate(context.Background(), adapter.Credentials{Extra: map[string]string{"csv_path": writeTemp(t, body)}})
		require.Error(t, err)
	}
}

func TestCSVDiscoveryCountsOnlyUsableEmailsAndRejectsForgedMapping(t *testing.T) {
	path := writeTemp(t, "email,status,unsubscribed\nada@example.com,active,true\n,active,false\nnot-an-email,active,false\n")
	ad := New()
	sess, err := ad.Authenticate(context.Background(), adapter.Credentials{Extra: map[string]string{"csv_path": path}})
	require.NoError(t, err)
	rep, err := ad.Discover(context.Background(), sess)
	require.NoError(t, err)
	require.Equal(t, 1, rep.SubscribersTotal)
	require.Equal(t, 2, rep.ProfilesWithoutEmailTotal)
	mp, err := DecodeMapping(sess.AccessToken)
	require.NoError(t, err)
	mp.Headers[2] = "unrelated"
	mp.Columns[2].Name = "unrelated"
	forged, err := EncodeMapping(mp)
	require.NoError(t, err)
	_, err = ad.Authenticate(context.Background(), adapter.Credentials{Extra: map[string]string{"csv_path": path, "mapping": forged}})
	require.ErrorContains(t, err, "headers differ")
	mp.Columns[0].Index = -1
	forged, err = EncodeMapping(mp)
	require.NoError(t, err)
	_, err = DecodeMapping(forged)
	require.Error(t, err)
}
