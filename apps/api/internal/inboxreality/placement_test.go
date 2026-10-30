// SPDX-License-Identifier: AGPL-3.0-only
package inboxreality

import "testing"

func TestClassify_Gmail(t *testing.T) {
	cases := []struct {
		name   string
		labels []string
		want   Placement
	}{
		{"primary by INBOX label", []string{"INBOX", "CATEGORY_PRIMARY"}, PlacementPrimary},
		{"primary by INBOX alone", []string{"INBOX"}, PlacementPrimary},
		{"promotions", []string{"INBOX", "CATEGORY_PROMOTIONS"}, PlacementPromotions},
		{"updates wins over promotions when both? — promotions first in switch", []string{"INBOX", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES"}, PlacementPromotions},
		{"updates", []string{"INBOX", "CATEGORY_UPDATES"}, PlacementUpdates},
		{"social", []string{"INBOX", "CATEGORY_SOCIAL"}, PlacementSocial},
		{"spam via SPAM label", []string{"SPAM"}, PlacementSpam},
		{"spam via CATEGORY_SPAM", []string{"CATEGORY_SPAM"}, PlacementSpam},
		{"missing on unknown labels only", []string{"CATEGORY_FORUMS"}, PlacementMissing},
		{"missing when no labels", nil, PlacementMissing},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Classify(ProviderGmail, Message{Labels: c.labels})
			if got != c.want {
				t.Errorf("Classify(Gmail, %v) = %s, want %s", c.labels, got, c.want)
			}
		})
	}
}

func TestClassify_OutlookFolderNames(t *testing.T) {
	cases := []struct {
		folder string
		want   Placement
	}{
		{"Inbox", PlacementPrimary},
		{"INBOX", PlacementPrimary},
		{"Focused", PlacementPrimary},
		{"Other", PlacementPrimary}, // still inbox-folder; only Junk is spam
		{"Junk Email", PlacementSpam},
		{"Junk", PlacementSpam},
		{"Deleted Items", PlacementBlocked},
		{"Drafts", PlacementMissing},
		{"", PlacementMissing},
	}
	for _, c := range cases {
		t.Run(c.folder, func(t *testing.T) {
			got := Classify(ProviderOutlookCom, Message{Folder: c.folder})
			if got != c.want {
				t.Errorf("Classify(OutlookCom, %q) = %s, want %s", c.folder, got, c.want)
			}
		})
	}
}

func TestClassify_O365MatchesOutlook(t *testing.T) {
	if Classify(ProviderO365, Message{Folder: "Junk Email"}) != PlacementSpam {
		t.Errorf("O365 should share Outlook taxonomy")
	}
	if Classify(ProviderO365, Message{Folder: "Focused"}) != PlacementPrimary {
		t.Errorf("O365 Focused should be Primary")
	}
}

func TestClassify_YahooBulkIsSpam(t *testing.T) {
	if Classify(ProviderYahoo, Message{Folder: "Bulk"}) != PlacementSpam {
		t.Errorf("Yahoo Bulk should map to spam")
	}
	if Classify(ProviderYahoo, Message{Folder: "Bulk Mail"}) != PlacementSpam {
		t.Errorf("Yahoo Bulk Mail should map to spam")
	}
	if Classify(ProviderYahoo, Message{Folder: "Inbox"}) != PlacementPrimary {
		t.Errorf("Yahoo Inbox should map to primary")
	}
}

func TestClassify_ICloudJunkIsSpam(t *testing.T) {
	if Classify(ProviderICloud, Message{Folder: "Junk"}) != PlacementSpam {
		t.Errorf("iCloud Junk should map to spam")
	}
}

func TestClassify_ProtonSimpleSplit(t *testing.T) {
	if Classify(ProviderProton, Message{Folder: "Spam"}) != PlacementSpam {
		t.Errorf("Proton Spam should be spam")
	}
	if Classify(ProviderProton, Message{Folder: "Inbox"}) != PlacementPrimary {
		t.Errorf("Proton Inbox should be primary")
	}
}

func TestClassify_GMXGermanFolders(t *testing.T) {
	if Classify(ProviderGMX, Message{Folder: "Posteingang"}) != PlacementPrimary {
		t.Errorf("GMX Posteingang (German for Inbox) should be primary")
	}
	if Classify(ProviderGMX, Message{Folder: "Spamverdacht"}) != PlacementSpam {
		t.Errorf("GMX Spamverdacht should be spam")
	}
}

func TestClassify_MailRuCyrillic(t *testing.T) {
	if Classify(ProviderMailRu, Message{Folder: "Спам"}) != PlacementSpam {
		t.Errorf("Mail.ru Cyrillic Спам should be spam")
	}
	if Classify(ProviderMailRu, Message{Folder: "Корзина"}) != PlacementBlocked {
		t.Errorf("Mail.ru Корзина (Trash) should be blocked")
	}
}

func TestClassify_GenericFallback(t *testing.T) {
	// Pass an unknown provider — should still classify on folder name.
	if Classify(Provider("imaginary"), Message{Folder: "Spam"}) != PlacementSpam {
		t.Errorf("generic fallback should catch spam")
	}
	if Classify(Provider("imaginary"), Message{Folder: "Some Trash Bin"}) != PlacementBlocked {
		t.Errorf("generic fallback should catch trash")
	}
	if Classify(Provider("imaginary"), Message{Folder: "Inbox"}) != PlacementPrimary {
		t.Errorf("generic fallback should catch inbox")
	}
}

func TestPlacement_IsKnown(t *testing.T) {
	for _, p := range AllPlacements {
		if !p.IsKnown() {
			t.Errorf("%q should be known", p)
		}
	}
	if Placement("nonsense").IsKnown() {
		t.Errorf("nonsense should not be known")
	}
}

func TestProvider_IsKnown_AndDisplayName(t *testing.T) {
	for _, p := range AllProviders {
		if !p.IsKnown() {
			t.Errorf("%q should be known", p)
		}
		if p.DisplayName() == "" || p.DisplayName() == string(p) {
			t.Errorf("provider %q has missing or fallback display name: %q", p, p.DisplayName())
		}
	}
	if Provider("unknown").DisplayName() != "unknown" {
		t.Errorf("unknown provider should fall back to raw string")
	}
}
