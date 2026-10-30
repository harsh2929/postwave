// SPDX-License-Identifier: AGPL-3.0-only
//
// zones.go — the curated DNSBL catalog. Each zone has:
//
//   • A query host (the suffix we append to a reversed IP for the DNS
//     lookup).
//   • A category: ip, domain, or both. Domain-only zones (DBL, SURBL)
//     take the bare domain; ip-only zones (Spamhaus Zen, SBL, XBL,
//     PBL, SORBS, Barracuda, …) take the reversed-octet form.
//   • A confidence weight (0.0–1.0). The aggregator uses this to
//     decide whether a hit should drive an action or just be
//     surfaced. Spamhaus Zen is 1.0 (gospel — receivers honour it
//     universally); ix.dnsbl.manitu.net is 0.5 (signal-with-noise);
//     UCEPROTECT-3 is 0.2 (escalation-class — too aggressive to
//     auto-act on, but useful for a "we noticed this too" panel).
//
// Adding a new zone: one entry here, no other code change required.
// The Client iterates Zones (DefaultZones for back-compat) and
// AllZones (the full catalog this file owns).
//
// Why an explicit weight per zone rather than "all hits are equal":
// the 2024 reality is that there are 200+ public DNSBLs and at
// least 40 of them have major false-positive rates (over-aggressive
// honeypots, expired listings, regional-language abuse signals
// that don't apply to all senders). Treating every hit as equal
// means a tenant on a "0 hits out of 80" list gets flagged for a
// hit on, e.g., DronesBL — which lists EVERY home IP that's ever
// rebooted a router. Weighting by confidence is the difference
// between a usable signal and noise.

package blacklist

// Zone describes one DNSBL entry.
type Zone struct {
	// Host is the DNS suffix the client queries. For an IP-based
	// zone, the client prepends the reversed-octet IP; for a
	// domain-based zone, it prepends the bare domain.
	Host string
	// Category is "ip", "domain", or "both" (Spamhaus DBL is the
	// only "both" — most lists are one or the other).
	Category string
	// Confidence is a 0-1 score for how reliable a hit on this
	// list is. Used by the aggregator's "act vs surface" decision
	// (see services/deliverability/internal/reputation/aggregator.go).
	Confidence float64
	// DisplayName is the customer-facing label ("Spamhaus Zen",
	// "Barracuda Reputation Block List"). Used in dashboard rows.
	DisplayName string
}

// AllZones is the full catalog. Order doesn't matter — the client
// fan-outs queries concurrently. Each row carries documentation about
// false-positive risk so future maintainers know why the weight is
// what it is.
//
// Sources for selection:
//   - https://www.dnsbl.info/dnsbl-list.php (canonical catalog)
//   - https://www.intra2net.com/en/support/antispam/blacklist_test.php
//   - Industry consensus (Spamhaus, SpamCop, Barracuda, SORBS = tier-1)
var AllZones = []Zone{
	// Tier 1 — Spamhaus family. Every major receiver honours these.
	{Host: "zen.spamhaus.org", Category: "ip", Confidence: 1.0, DisplayName: "Spamhaus Zen (composite)"},
	{Host: "sbl.spamhaus.org", Category: "ip", Confidence: 1.0, DisplayName: "Spamhaus SBL"},
	{Host: "xbl.spamhaus.org", Category: "ip", Confidence: 1.0, DisplayName: "Spamhaus XBL (exploits)"},
	{Host: "pbl.spamhaus.org", Category: "ip", Confidence: 0.9, DisplayName: "Spamhaus PBL (policy block — dynamic IPs)"},
	{Host: "dbl.spamhaus.org", Category: "domain", Confidence: 1.0, DisplayName: "Spamhaus DBL (domain block)"},
	{Host: "zrd.spamhaus.org", Category: "domain", Confidence: 0.8, DisplayName: "Spamhaus ZRD (zero-reputation domains)"},

	// Tier 1 — SpamCop, Barracuda, Composite Block List.
	{Host: "bl.spamcop.net", Category: "ip", Confidence: 0.95, DisplayName: "SpamCop"},
	{Host: "b.barracudacentral.org", Category: "ip", Confidence: 0.9, DisplayName: "Barracuda Reputation Block List"},
	{Host: "cbl.abuseat.org", Category: "ip", Confidence: 0.95, DisplayName: "Composite Blocking List (CBL)"},

	// Tier 1 — SORBS family.
	{Host: "dnsbl.sorbs.net", Category: "ip", Confidence: 0.85, DisplayName: "SORBS aggregate"},
	{Host: "spam.dnsbl.sorbs.net", Category: "ip", Confidence: 0.85, DisplayName: "SORBS spam"},
	{Host: "smtp.dnsbl.sorbs.net", Category: "ip", Confidence: 0.85, DisplayName: "SORBS misconfigured SMTP"},
	{Host: "web.dnsbl.sorbs.net", Category: "ip", Confidence: 0.75, DisplayName: "SORBS hijacked-web hosts"},
	{Host: "dul.dnsbl.sorbs.net", Category: "ip", Confidence: 0.7, DisplayName: "SORBS dynamic user IPs"},
	{Host: "zombie.dnsbl.sorbs.net", Category: "ip", Confidence: 0.8, DisplayName: "SORBS zombie/bot IPs"},
	{Host: "block.dnsbl.sorbs.net", Category: "ip", Confidence: 0.85, DisplayName: "SORBS block"},
	{Host: "escalations.dnsbl.sorbs.net", Category: "ip", Confidence: 0.8, DisplayName: "SORBS escalations"},
	{Host: "rhsbl.sorbs.net", Category: "domain", Confidence: 0.7, DisplayName: "SORBS RHSBL"},

	// Tier 1 — Mailspike, SURBL (URL block).
	{Host: "bl.mailspike.net", Category: "ip", Confidence: 0.85, DisplayName: "Mailspike Blacklist"},
	{Host: "z.mailspike.net", Category: "ip", Confidence: 0.85, DisplayName: "Mailspike Z (combined)"},
	{Host: "multi.surbl.org", Category: "domain", Confidence: 0.9, DisplayName: "SURBL Multi (URL block)"},

	// Tier 2 — Invaluement (paid; clients with API access only).
	// Listed for completeness; resolution requires a subscription.
	{Host: "ivmSIP.dnsbl.invaluement.com", Category: "ip", Confidence: 0.9, DisplayName: "Invaluement ivmSIP"},
	{Host: "ivmURI.dnsbl.invaluement.com", Category: "domain", Confidence: 0.9, DisplayName: "Invaluement ivmURI"},

	// Tier 2 — Reputable but narrower coverage.
	{Host: "psbl.surriel.com", Category: "ip", Confidence: 0.8, DisplayName: "Passive Spam Block List (PSBL)"},
	{Host: "truncate.gbudb.net", Category: "ip", Confidence: 0.75, DisplayName: "GBUdb Truncate"},
	{Host: "all.s5h.net", Category: "ip", Confidence: 0.75, DisplayName: "s5h.net aggregate"},
	{Host: "ix.dnsbl.manitu.net", Category: "ip", Confidence: 0.5, DisplayName: "ix.manitu.net (signal-with-noise)"},
	{Host: "dnsbl-1.uceprotect.net", Category: "ip", Confidence: 0.6, DisplayName: "UCEPROTECT Level 1 (IP)"},
	{Host: "dnsbl-2.uceprotect.net", Category: "ip", Confidence: 0.4, DisplayName: "UCEPROTECT Level 2 (range)"},
	{Host: "dnsbl-3.uceprotect.net", Category: "ip", Confidence: 0.2, DisplayName: "UCEPROTECT Level 3 (ASN — over-aggressive)"},
	{Host: "backscatterer.org", Category: "ip", Confidence: 0.5, DisplayName: "Backscatterer.org"},
	{Host: "dyna.spamrats.com", Category: "ip", Confidence: 0.7, DisplayName: "SpamRats Dyna (dynamic IPs)"},
	{Host: "noptr.spamrats.com", Category: "ip", Confidence: 0.6, DisplayName: "SpamRats NoPTR"},
	{Host: "spam.spamrats.com", Category: "ip", Confidence: 0.8, DisplayName: "SpamRats Spam"},

	// Tier 2 — European focus.
	{Host: "spamsources.fabel.dk", Category: "ip", Confidence: 0.7, DisplayName: "Spamsources Fabel"},
	{Host: "rbl.interserver.net", Category: "ip", Confidence: 0.65, DisplayName: "InterServer RBL"},
	{Host: "bl.blocklist.de", Category: "ip", Confidence: 0.7, DisplayName: "Blocklist.de"},
	{Host: "all.spamrats.com", Category: "ip", Confidence: 0.7, DisplayName: "SpamRats all"},
	{Host: "bl.score.senderscore.com", Category: "ip", Confidence: 0.85, DisplayName: "Validity SenderScore (low)"},
	{Host: "rbl.efnetrbl.org", Category: "ip", Confidence: 0.6, DisplayName: "EFnet RBL"},
	{Host: "tor.dan.me.uk", Category: "ip", Confidence: 0.7, DisplayName: "Tor exit nodes (Dan ME)"},
	{Host: "bl.suomispam.net", Category: "ip", Confidence: 0.5, DisplayName: "Suomispam.net (Finnish)"},
	{Host: "korea.services.net", Category: "ip", Confidence: 0.3, DisplayName: "Korea services (regional)"},
	{Host: "rbl.megarbl.net", Category: "ip", Confidence: 0.4, DisplayName: "MegaRBL"},
	{Host: "list.bbfh.org", Category: "ip", Confidence: 0.3, DisplayName: "BBFH List"},

	// Tier 2 — URL / domain reputation.
	{Host: "multi.uribl.com", Category: "domain", Confidence: 0.85, DisplayName: "URIBL Multi"},
	{Host: "black.uribl.com", Category: "domain", Confidence: 0.9, DisplayName: "URIBL Black"},
	{Host: "grey.uribl.com", Category: "domain", Confidence: 0.7, DisplayName: "URIBL Grey"},
	{Host: "red.uribl.com", Category: "domain", Confidence: 0.75, DisplayName: "URIBL Red"},
	{Host: "ws.surbl.org", Category: "domain", Confidence: 0.85, DisplayName: "SURBL ws"},
	{Host: "ph.surbl.org", Category: "domain", Confidence: 0.9, DisplayName: "SURBL Phishing"},
	{Host: "mw.surbl.org", Category: "domain", Confidence: 0.9, DisplayName: "SURBL Malware"},

	// Tier 3 — DroneBL, GoodMail, niche.
	{Host: "dnsbl.dronebl.org", Category: "ip", Confidence: 0.5, DisplayName: "DroneBL (botnets / drones)"},
	{Host: "spam.abuse.ch", Category: "ip", Confidence: 0.6, DisplayName: "abuse.ch spam"},
	{Host: "phish.abuse.ch", Category: "domain", Confidence: 0.85, DisplayName: "abuse.ch phishing"},
	{Host: "malware.abuse.ch", Category: "domain", Confidence: 0.9, DisplayName: "abuse.ch malware"},
	{Host: "drone.abuse.ch", Category: "ip", Confidence: 0.7, DisplayName: "abuse.ch drone"},
	{Host: "spambot.bls.digibase.ca", Category: "ip", Confidence: 0.6, DisplayName: "Digibase BLS spambot"},
	{Host: "bl.deadbeef.com", Category: "ip", Confidence: 0.4, DisplayName: "Deadbeef BL"},
	{Host: "fnrbl.fast.net", Category: "ip", Confidence: 0.5, DisplayName: "Fast.net RBL"},
	{Host: "hostkarma.junkemailfilter.com", Category: "ip", Confidence: 0.6, DisplayName: "HostKarma"},
	{Host: "ubl.unsubscore.com", Category: "ip", Confidence: 0.5, DisplayName: "Lashback UBL (unsubscribe abuse)"},
	{Host: "bl.spamcannibal.org", Category: "ip", Confidence: 0.5, DisplayName: "SpamCannibal"},
	{Host: "psky.me", Category: "ip", Confidence: 0.4, DisplayName: "Psky.me"},
	{Host: "0spam.fusionzero.com", Category: "ip", Confidence: 0.6, DisplayName: "0spam (FusionZero)"},
	{Host: "rbl.realtimeblacklist.com", Category: "ip", Confidence: 0.6, DisplayName: "Realtime BL"},
	{Host: "bl.fmb.la", Category: "ip", Confidence: 0.4, DisplayName: "FMB Cyber"},
	{Host: "list.dnswl.org", Category: "ip", Confidence: 0.0, DisplayName: "DNSWL (whitelist — informational)"},

	// Tier 3 — Honeypot / specialized.
	{Host: "exitlist.dnsbl.tor.dan.me.uk", Category: "ip", Confidence: 0.6, DisplayName: "Tor Exit List (Dan ME)"},
	{Host: "v4.fullbogons.cymru.com", Category: "ip", Confidence: 0.8, DisplayName: "Cymru Full Bogons"},
	{Host: "dnsbl.cyberlogic.net", Category: "ip", Confidence: 0.55, DisplayName: "Cyberlogic"},
	{Host: "dnsbl.kempt.net", Category: "ip", Confidence: 0.4, DisplayName: "Kempt"},
	{Host: "spam.pedantic.org", Category: "ip", Confidence: 0.45, DisplayName: "Pedantic Spam"},
	{Host: "ohps.dnsbl.net.au", Category: "ip", Confidence: 0.5, DisplayName: "OHPS Australia"},
	{Host: "omrs.dnsbl.net.au", Category: "ip", Confidence: 0.55, DisplayName: "OMRS Australia"},
	{Host: "osps.dnsbl.net.au", Category: "ip", Confidence: 0.5, DisplayName: "OSPS Australia"},
	{Host: "osrs.dnsbl.net.au", Category: "ip", Confidence: 0.55, DisplayName: "OSRS Australia"},
	{Host: "owfs.dnsbl.net.au", Category: "ip", Confidence: 0.5, DisplayName: "OWFS Australia"},
	{Host: "owps.dnsbl.net.au", Category: "ip", Confidence: 0.5, DisplayName: "OWPS Australia"},
	{Host: "probes.dnsbl.net.au", Category: "ip", Confidence: 0.6, DisplayName: "Probes Australia"},
	{Host: "proxy.bl.gweep.ca", Category: "ip", Confidence: 0.55, DisplayName: "Gweep Proxy"},
	{Host: "relays.bl.gweep.ca", Category: "ip", Confidence: 0.55, DisplayName: "Gweep Relays"},
	{Host: "ricn.dnsbl.net.au", Category: "ip", Confidence: 0.55, DisplayName: "RICN Australia"},
	{Host: "rmst.dnsbl.net.au", Category: "ip", Confidence: 0.55, DisplayName: "RMST Australia"},
	{Host: "spam.dnsbl.anonmails.de", Category: "ip", Confidence: 0.6, DisplayName: "AnonMails spam"},
	{Host: "ubl.lashback.com", Category: "ip", Confidence: 0.55, DisplayName: "Lashback UBL"},
	{Host: "bsb.spamlookup.net", Category: "ip", Confidence: 0.5, DisplayName: "SpamLookup BSB"},
	{Host: "cdl.anti-spam.org.cn", Category: "ip", Confidence: 0.4, DisplayName: "CDL China Anti-Spam"},
	{Host: "rbl.choon.net", Category: "ip", Confidence: 0.45, DisplayName: "Choon RBL"},
}

// ZoneByHost returns the catalog entry for a given host suffix, plus
// true when found. Useful when an aggregator wants to look up the
// weight of a zone that produced a hit.
func ZoneByHost(host string) (Zone, bool) {
	for _, z := range AllZones {
		if z.Host == host {
			return z, true
		}
	}
	return Zone{}, false
}

// IPZones returns just the zones the client should query against IPs.
// Helpful for the aggregator's "this zone is irrelevant for our
// IP-only check" filter.
func IPZones() []Zone {
	out := make([]Zone, 0, len(AllZones))
	for _, z := range AllZones {
		if z.Category == "ip" || z.Category == "both" {
			out = append(out, z)
		}
	}
	return out
}

// DomainZones returns just the zones the client should query against
// bare domain names.
func DomainZones() []Zone {
	out := make([]Zone, 0, len(AllZones))
	for _, z := range AllZones {
		if z.Category == "domain" || z.Category == "both" {
			out = append(out, z)
		}
	}
	return out
}

// HighConfidenceZones returns zones whose Confidence >= threshold.
// The continuous monitor uses HighConfidenceZones(0.8) so it only
// fires "act now" alerts on tier-1 hits — tier-2/3 hits are recorded
// but don't trigger auto-suppression. Receivers that consult
// Spamhaus directly will already have rejected the message; getting
// listed on DroneBL is information, not a deliverability emergency.
func HighConfidenceZones(threshold float64) []Zone {
	out := make([]Zone, 0, len(AllZones))
	for _, z := range AllZones {
		if z.Confidence >= threshold {
			out = append(out, z)
		}
	}
	return out
}
