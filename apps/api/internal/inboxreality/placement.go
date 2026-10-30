// SPDX-License-Identifier: AGPL-3.0-only
//
// placement.go — folder/label → Placement classification, mirrored from
// services/deliverability/internal/seedlist/categorizers/. We duplicate
// the rules here because:
//
//   - apps/api needs to validate / sanity-check inbound results before
//     persisting (the deliverability service is trusted but the
//     contract is via HTTP; sanity at the boundary is cheap insurance).
//   - The dashboard's "what does this folder mean" tooltip endpoint
//     can call this directly without a service hop.
//
// Keep the rule set in lockstep with the deliverability-service
// categorizers. The reference set:
//
//   gmail.go      labels-driven (CATEGORY_*)
//   outlook.go    folder-name driven (Junk Email, Focused/Other)
//   yahoo.go      folder-name driven (Bulk = spam)
//   apple.go      folder-name driven (Junk)
//   proton.go     folder-name driven (Spam)
//   gmx.go        folder-name driven (Spam)
//   mailru.go     folder-name driven (Спам)
//
// If a folder we don't recognise comes back, we return PlacementMissing
// so the dashboard treats it as "we lost track" rather than guessing.

package inboxreality

import "strings"

// Message is the minimal classifier input. Mirrors
// categorizers.Message in the deliverability service.
type Message struct {
	Folder  string
	Labels  []string
	Headers map[string]string
}

// Classify dispatches to the per-provider rule set. Unknown providers
// fall through to a folder-name heuristic so a brand-new provider
// added to the seedlist still produces a defensible placement until
// its categorizer ships.
func Classify(p Provider, m Message) Placement {
	switch p {
	case ProviderGmail:
		return classifyGmail(m)
	case ProviderOutlookCom, ProviderO365:
		return classifyOutlook(m)
	case ProviderYahoo:
		return classifyYahoo(m)
	case ProviderICloud:
		return classifyICloud(m)
	case ProviderProton:
		return classifyProton(m)
	case ProviderGMX:
		return classifyGMX(m)
	case ProviderMailRu:
		return classifyMailRu(m)
	}
	return classifyGeneric(m)
}

// classifyGmail mirrors the categorizer in
// services/deliverability/internal/seedlist/categorizers/gmail.go.
// Gmail attaches CATEGORY_* labels to every message; that's the
// only reliable signal. INBOX without a CATEGORY_* label is treated
// as PlacementPrimary.
func classifyGmail(m Message) Placement {
	has := labelLookup(m.Labels)
	switch {
	case has("SPAM"), has("CATEGORY_SPAM"):
		return PlacementSpam
	case has("CATEGORY_PROMOTIONS"):
		return PlacementPromotions
	case has("CATEGORY_UPDATES"):
		return PlacementUpdates
	case has("CATEGORY_SOCIAL"):
		return PlacementSocial
	case has("CATEGORY_PRIMARY"), has("INBOX"):
		return PlacementPrimary
	}
	return PlacementMissing
}

// classifyOutlook handles both outlook.com and Office 365 — same
// folder taxonomy. Junk Email is spam; Inbox/Focused is primary;
// anything else falls through to missing.
func classifyOutlook(m Message) Placement {
	f := strings.ToLower(strings.TrimSpace(m.Folder))
	switch f {
	case "inbox", "focused", "focused inbox":
		return PlacementPrimary
	case "other", "other inbox":
		// Outlook Focused/Other split: "Other" is still inbox-folder
		// from a deliverability perspective; provider-side spam goes
		// to Junk. We mark Other as Primary because the message DID
		// reach inbox-side delivery (the user can still see it).
		return PlacementPrimary
	case "junk", "junk email", "junk e-mail", "spam":
		return PlacementSpam
	case "deleted items", "deleted":
		// Outlook deletes messages that fail tenant rules; surface as
		// blocked so the dashboard distinguishes from spam-foldered.
		return PlacementBlocked
	}
	return PlacementMissing
}

// classifyYahoo: Inbox vs Bulk. Yahoo calls spam "Bulk Mail".
func classifyYahoo(m Message) Placement {
	f := strings.ToLower(strings.TrimSpace(m.Folder))
	switch f {
	case "inbox":
		return PlacementPrimary
	case "bulk", "bulk mail", "spam":
		return PlacementSpam
	case "trash":
		return PlacementBlocked
	}
	return PlacementMissing
}

// classifyICloud: Apple Mail / iCloud routes spam to Junk.
func classifyICloud(m Message) Placement {
	f := strings.ToLower(strings.TrimSpace(m.Folder))
	switch f {
	case "inbox":
		return PlacementPrimary
	case "junk":
		return PlacementSpam
	case "deleted messages", "trash":
		return PlacementBlocked
	}
	return PlacementMissing
}

// classifyProton: simple Inbox/Spam split.
func classifyProton(m Message) Placement {
	f := strings.ToLower(strings.TrimSpace(m.Folder))
	switch f {
	case "inbox":
		return PlacementPrimary
	case "spam":
		return PlacementSpam
	case "trash":
		return PlacementBlocked
	}
	return PlacementMissing
}

// classifyGMX: German mailbox provider. Spam = "Spam" or "Spamverdacht".
func classifyGMX(m Message) Placement {
	f := strings.ToLower(strings.TrimSpace(m.Folder))
	switch f {
	case "inbox", "posteingang":
		return PlacementPrimary
	case "spam", "spamverdacht":
		return PlacementSpam
	case "trash", "papierkorb":
		return PlacementBlocked
	}
	return PlacementMissing
}

// classifyMailRu: Russian provider. Spam = "Спам" (Cyrillic).
func classifyMailRu(m Message) Placement {
	f := strings.ToLower(strings.TrimSpace(m.Folder))
	switch f {
	case "inbox":
		return PlacementPrimary
	case "spam", "спам":
		return PlacementSpam
	case "trash", "корзина":
		return PlacementBlocked
	}
	return PlacementMissing
}

// classifyGeneric is the fallback for providers without a dedicated
// categorizer. The heuristic looks for the words "inbox" / "spam" /
// "junk" / "bulk" / "trash" as standalone tokens in the folder name.
func classifyGeneric(m Message) Placement {
	f := strings.ToLower(strings.TrimSpace(m.Folder))
	switch f {
	case "inbox":
		return PlacementPrimary
	}
	if strings.Contains(f, "spam") || strings.Contains(f, "junk") || strings.Contains(f, "bulk") {
		return PlacementSpam
	}
	if strings.Contains(f, "trash") || strings.Contains(f, "deleted") {
		return PlacementBlocked
	}
	return PlacementMissing
}

func labelLookup(labels []string) func(string) bool {
	set := make(map[string]struct{}, len(labels))
	for _, l := range labels {
		set[l] = struct{}{}
	}
	return func(want string) bool {
		_, ok := set[want]
		return ok
	}
}
