package exportcsv_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/migrate/adapter"
	_ "github.com/postwave/migrate/aweber"
	_ "github.com/postwave/migrate/bento"
	_ "github.com/postwave/migrate/campaignmonitor"
	"github.com/postwave/migrate/canonical"
	_ "github.com/postwave/migrate/constantcontact"
	_ "github.com/postwave/migrate/csv"
	_ "github.com/postwave/migrate/drip"
	_ "github.com/postwave/migrate/flodesk"
	_ "github.com/postwave/migrate/loops"
	_ "github.com/postwave/migrate/omnisend"
	_ "github.com/postwave/migrate/sendy"
	"github.com/stretchr/testify/require"
)

func TestSyntheticPlatformExportsPreserveRestrictionsAndSource(t *testing.T) {
	b, err := os.ReadFile("testdata/manifest.json")
	require.NoError(t, err)
	var manifest struct {
		Profiles []struct {
			Source   canonical.SourcePlatform
			File     string
			Statuses []canonical.SubscriberStatus
		}
	}
	require.NoError(t, json.Unmarshal(b, &manifest))
	require.Len(t, manifest.Profiles, 10)
	for _, profile := range manifest.Profiles {
		t.Run(string(profile.Source), func(t *testing.T) {
			ad, err := adapter.Get(profile.Source)
			require.NoError(t, err)
			sess, err := ad.Authenticate(context.Background(), adapter.Credentials{Extra: map[string]string{"csv_path": filepath.Join("testdata", profile.File), "list_id": "original-list", "audience_id": "original-audience"}})
			require.NoError(t, err)
			discovery, err := ad.Discover(context.Background(), sess)
			require.NoError(t, err)
			require.Equal(t, len(profile.Statuses), discovery.SubscribersTotal)
			// Reconstruct the worker and session to exercise durable profile encoding.
			encoded, err := json.Marshal(sess)
			require.NoError(t, err)
			require.NoError(t, json.Unmarshal(encoded, &sess))
			ad, err = adapter.Get(profile.Source)
			require.NoError(t, err)
			rows, next, err := ad.ListSubscribers(context.Background(), sess, "")
			require.NoError(t, err)
			require.Empty(t, next)
			require.Len(t, rows, len(profile.Statuses))
			for i, row := range rows {
				require.Equal(t, profile.Statuses[i], row.Status, "row %d", i)
				require.Equal(t, profile.Source, row.SourcePlatform)
				if profile.Source != canonical.SourceCSV && profile.Source != canonical.SourceSendy {
					require.Equal(t, "original-list", row.CustomFields["source_list_id"])
				}
				if profile.Source == canonical.SourceSendy {
					require.Equal(t, "original-list", row.CustomFields["sendy_list_id"])
				}
				if i > 0 || (profile.Source != canonical.SourceDrip && profile.Source != canonical.SourceConstantContact && profile.Source != canonical.SourceOmnisend) {
					require.Nil(t, row.ConsentTimestamp)
				} else {
					require.NotNil(t, row.ConsentTimestamp)
				}
			}
			if profile.Source == canonical.SourceBento {
				require.Equal(t, "000123", rows[0].SourceID)
				require.Equal(t, "000123", rows[0].CustomFields["subscriber_id"])
			}
			if profile.Source == canonical.SourceAWeber || profile.Source == canonical.SourceCSV {
				require.Equal(t, "00123", rows[0].CustomFields["postal_code"])
			}
			if profile.Source == canonical.SourceFlodesk {
				require.ElementsMatch(t, []string{"VIP", "Newsletter"}, rows[0].Tags)
			}
		})
	}
}

func TestAllExportProfilesResumeAcrossPageBoundary(t *testing.T) {
	for _, source := range []canonical.SourcePlatform{canonical.SourceCSV, canonical.SourceSendy, canonical.SourceAWeber, canonical.SourceBento, canonical.SourceCampaignMonitor, canonical.SourceConstantContact, canonical.SourceDrip, canonical.SourceFlodesk, canonical.SourceLoops, canonical.SourceOmnisend} {
		t.Run(string(source), func(t *testing.T) {
			var b strings.Builder
			b.WriteString("\ufeffEmail,Email subscription status,unsubscribed,external_id\r\n")
			for i := 0; i < 1002; i++ {
				fmt.Fprintf(&b, "person%d@example.com,subscribed,%t,000%d\r\n", i, i == 1000, i)
			}
			path := filepath.Join(t.TempDir(), "export.csv")
			require.NoError(t, os.WriteFile(path, []byte(b.String()), 0600))
			ad, err := adapter.Get(source)
			require.NoError(t, err)
			sess, err := ad.Authenticate(context.Background(), adapter.Credentials{Extra: map[string]string{"csv_path": path}})
			require.NoError(t, err)
			first, next, err := ad.ListSubscribers(context.Background(), sess, "")
			require.NoError(t, err)
			require.Len(t, first, 1000)
			require.NotEmpty(t, next)
			ad, err = adapter.Get(source)
			require.NoError(t, err)
			last, next, err := ad.ListSubscribers(context.Background(), sess, next)
			require.NoError(t, err)
			require.Len(t, last, 2)
			require.Empty(t, next)
			require.Equal(t, canonical.StatusDisabled, last[0].Status)
			require.Equal(t, canonical.StatusEnabled, last[1].Status)
			require.Equal(t, "person1000@example.com", last[0].Email)
			require.Equal(t, "0001000", last[0].CustomFields["external_id"])
		})
	}
}
