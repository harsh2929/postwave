// SPDX-License-Identifier: AGPL-3.0-only
//
// domains.go — static signals used by the local tier.
//
// The disposable-domain corpus is a legacy snapshot without an authoritative
// provenance or refresh contract. Membership is therefore advisory: it may be
// surfaced to callers, but LocalVerifier does not turn it into a terminal
// verdict. Explicit LocalVerifier instances may add terminal ExtraDisposable
// overrides; production does not currently populate that field from tenant
// settings.

package verification

import "strings"

// isFreeMailDomain reports whether the domain is a consumer webmail
// provider. Not a quality signal on its own — it is context for
// B2B-oriented segmentation, and vendors report the same flag.
func isFreeMailDomain(domain string) bool {
	_, hit := freeMailDomains[domain]
	return hit
}

// IsDisposableDomain reports membership in the shipped advisory corpus. A hit
// is not proof that an address is undeliverable or disposable.
func IsDisposableDomain(domain string) bool {
	_, hit := disposableDomains[strings.ToLower(strings.TrimSpace(domain))]
	return hit
}

// IsRoleAccount reports whether a local-part is a shared-mailbox name.
func IsRoleAccount(local string) bool {
	l := strings.ToLower(strings.TrimSpace(local))
	if _, hit := roleAccountLocals[l]; hit {
		return true
	}
	_, hit := abuseLocals[l]
	return hit
}

func set(items ...string) map[string]struct{} {
	m := make(map[string]struct{}, len(items))
	for _, it := range items {
		m[it] = struct{}{}
	}
	return m
}

// abuseLocals are narrowly recognizable abuse/security desks. Broader shared
// names such as report@ and complaints@ remain advisory role accounts because
// they can be ordinary B2B inboxes.
var abuseLocals = set(
	"abuse", "abuse-desk", "phishing", "postmaster", "reportspam", "spam",
	"spamreport", "uce",
)

// roleAccountLocals are shared/functional mailboxes. They are advisory risk
// signals, not hard invalids: canonical consent/suppression remains authoritative
// and B2B teams legitimately use sales@, support@, finance@, and similar inboxes.
var roleAccountLocals = set(
	"accounting", "accounts", "admin", "administrator", "administration",
	"ads", "all", "billing", "board", "career", "careers", "compliance",
	"contact", "contactus", "customerservice", "customer-service", "dev",
	"devnull", "director", "enquiries", "enquiry", "everyone", "feedback",
	"finance", "ftp", "general", "help", "helpdesk", "hello", "hi", "hr",
	"hostmaster", "inbox", "info", "information", "inquiries", "inquiry",
	"invoice", "invoices", "it", "jobs", "legal", "list", "mail", "mailer",
	"mailer-daemon", "maildaemon", "marketing", "media", "newsletter",
	"noc", "noreply", "no-reply", "notification", "notifications", "office",
	"operations", "orders", "payments", "press", "privacy", "purchasing",
	"recruitment", "report", "root", "sales", "security", "service", "shop", "staff",
	"subscribe", "support", "sysadmin", "team", "tech", "unsubscribe",
	"webmaster", "whitelist", "www", "antispam", "anti-spam", "blacklist",
	"complaints",
)

// freeMailDomains are consumer webmail providers.
var freeMailDomains = set(
	"aim.com", "aol.com", "att.net", "bellsouth.net", "bigpond.com",
	"btinternet.com", "comcast.net", "cox.net", "earthlink.net", "email.com",
	"fastmail.com", "fastmail.fm", "free.fr", "freenet.de", "gmail.com",
	"gmx.at", "gmx.ch", "gmx.com", "gmx.de", "gmx.net", "googlemail.com",
	"hotmail.co.uk", "hotmail.com", "hotmail.de", "hotmail.es", "hotmail.fr",
	"hotmail.it", "hushmail.com", "icloud.com", "inbox.com", "juno.com",
	"laposte.net", "libero.it", "live.co.uk", "live.com", "live.com.au",
	"live.fr", "live.nl", "mac.com", "mail.com", "mail.ru", "me.com",
	"msn.com", "naver.com", "netzero.net", "onet.pl", "optonline.net",
	"orange.fr", "outlook.co.uk", "outlook.com", "outlook.de", "outlook.fr",
	"pm.me", "post.com", "proton.me", "protonmail.ch", "protonmail.com",
	"qq.com", "rambler.ru", "rediffmail.com", "rocketmail.com", "sbcglobal.net",
	"seznam.cz", "sfr.fr", "shaw.ca", "sky.com", "skynet.be", "t-online.de",
	"telenet.be", "tiscali.it", "tutanota.com", "tutanota.de", "tutamail.com",
	"verizon.net", "virgilio.it", "voila.fr", "wanadoo.fr", "web.de",
	"windowslive.com", "wp.pl", "xtra.co.nz", "yahoo.ca", "yahoo.co.id",
	"yahoo.co.in", "yahoo.co.jp", "yahoo.co.uk", "yahoo.com", "yahoo.com.ar",
	"yahoo.com.au", "yahoo.com.br", "yahoo.com.mx", "yahoo.com.sg",
	"yahoo.de", "yahoo.es", "yahoo.fr", "yahoo.in", "yahoo.it", "yandex.com",
	"yandex.ru", "ymail.com", "zoho.com", "zohomail.com",
)

// popularDomains is the typo-correction target corpus. Kept to
// genuinely high-volume providers only: suggesting a correction toward
// an obscure domain is worse than staying silent, and every entry here
// is one more chance to mis-correct a legitimate address.
var popularDomains = set(
	"aol.com", "comcast.net", "gmail.com", "googlemail.com", "hotmail.co.uk",
	"hotmail.com", "hotmail.fr", "icloud.com", "live.com", "mail.com",
	"me.com", "msn.com", "outlook.com", "proton.me", "protonmail.com",
	"qq.com", "sbcglobal.net", "verizon.net", "web.de", "yahoo.co.uk",
	"yahoo.com", "yahoo.fr", "yandex.ru", "ymail.com", "zoho.com",
)

// disposableDomains is a legacy throwaway/temp-mail signal. Hits are advisory.
var disposableDomains = set(
	"0-mail.com", "027168.com", "0clickemail.com", "10minutemail.co.za",
	"10minutemail.com", "10minutemail.net", "123-m.com", "1secmail.com",
	"1secmail.net", "1secmail.org", "20minutemail.com", "2prong.com",
	"30minutemail.com", "33mail.com", "3d-painting.com", "4warding.com",
	"60minutemail.com", "675hosting.com", "6paq.com", "75hosting.com",
	"7tags.com", "9ox.net", "a-bc.net", "amilegit.com", "anonbox.net",
	"anonmails.de", "anonymbox.com", "antispam.de", "armyspy.com",
	"beefmilk.com", "binkmail.com", "bobmail.info", "bofthew.com",
	"bootybay.de", "boun.cr", "bouncr.com", "brefmail.com", "bugmenot.com",
	"bumpymail.com", "burnermail.io", "byom.de", "cachedot.net",
	"casualdx.com", "chammy.info", "cheatmail.de", "chogmail.com",
	"cool.fr.nf", "correo.blogos.net", "cosmorph.com", "courriel.fr.nf",
	"crazymailing.com", "cuvox.de", "dacoolest.com", "dandikmail.com",
	"dayrep.com", "deadaddress.com", "despam.it", "devnullmail.com",
	"discard.email", "discardmail.com", "discardmail.de", "disposable.com",
	"disposableinbox.com", "dispose.it", "dispostable.com", "dodgeit.com",
	"dodgit.com", "dontreg.com", "dontsendmespam.de", "drdrb.net",
	"dropmail.me", "dumpandjunk.com", "dumpmail.de",
	"dumpyemail.com", "e4ward.com", "easytrashmail.com", "einrot.com",
	"email60.com", "emailias.com", "emailinfive.com", "emailmiser.com",
	"emailondeck.com", "emailsensei.com", "emailtemporanea.net",
	"emailtemporario.com.br", "emailthe.net", "emailtmp.com", "emailwarden.com",
	"emailx.at.hm", "emeil.in", "emeil.ir", "emz.net", "explodemail.com",
	"eyepaste.com", "fakeinbox.com", "fakemail.fr", "fakemailgenerator.com",
	"fakemailz.com", "fansworldwide.de", "fantasymail.de", "fightallspam.com",
	"filzmail.com", "fixmail.tk", "fleckens.hu", "fr33mail.info",
	"frapmail.com", "front14.org", "fux0ringduh.com", "garliclife.com",
	"get1mail.com", "get2mail.fr", "getairmail.com", "getnada.com",
	"getonemail.com", "ghosttexter.de", "girlsundertheinfluence.com",
	"gishpuppy.com", "gowikibooks.com", "grandmamail.com", "great-host.in",
	"greensloth.com", "grr.la", "guerillamail.biz", "guerillamail.com",
	"guerrillamail.biz", "guerrillamail.com", "guerrillamail.de",
	"guerrillamail.info", "guerrillamail.net", "guerrillamail.org",
	"guerrillamailblock.com", "harakirimail.com", "hat-geld.de",
	"hatespam.org", "herp.in", "hidemail.de", "hidzz.com", "hmamail.com",
	"hochsitze.com", "hotpop.com", "hulapla.de", "ieatspam.eu",
	"ieatspam.info", "ihateyoualot.info", "iheartspam.org", "imails.info",
	"inbax.tk", "inbox.si", "inboxalias.com", "inboxbear.com",
	"incognitomail.com", "incognitomail.net", "incognitomail.org",
	"insorg-mail.info", "instant-mail.de", "ipoo.org", "irish2me.com",
	"iwi.net", "jetable.com", "jetable.fr.nf", "jetable.net", "jetable.org",
	"jnxjn.com", "jourrapide.com", "junk1e.com", "kasmail.com",
	"kaspop.com", "keepmymail.com", "killmail.com", "killmail.net",
	"kir.ch.tc", "klassmaster.com", "klzlk.com", "koszmail.pl", "kurzepost.de",
	"lackmail.net", "lawlita.com", "letthemeatspam.com", "lhsdv.com",
	"lifebyfood.com", "link2mail.net", "litedrop.com", "lol.ovpn.to",
	"lookugly.com", "lortemail.dk", "lr78.com", "lroid.com", "luxusmail.org",
	"m4ilweb.info", "maboard.com", "mail-filter.com", "mail-temporaire.fr",
	"mail.by", "mail4trash.com", "mailbidon.com", "mailbiz.biz",
	"mailblocks.com", "mailbucket.org", "mailcat.biz", "mailcatch.com",
	"maildrop.cc", "maileater.com", "mailexpire.com", "mailfa.tk",
	"mailforspam.com", "mailfreeonline.com", "mailguard.me", "mailin8r.com",
	"mailinater.com", "mailinator.com", "mailinator.net", "mailinator.org",
	"mailinator2.com", "mailincubator.com", "mailismagic.com", "mailme.lv",
	"mailmetrash.com", "mailmoat.com", "mailms.com", "mailnator.com",
	"mailnesia.com", "mailnull.com", "mailorg.org", "mailpick.biz",
	"mailrock.biz", "mailscrap.com", "mailshell.com", "mailsiphon.com",
	"mailslapping.com", "mailtemp.info", "mailtome.de", "mailtothis.com",
	"mailtrash.net", "mailtv.net", "mailzilla.com", "mailzilla.org",
	"makemetheking.com", "manybrain.com", "mbx.cc", "mega.zik.dj",
	"meinspamschutz.de", "meltmail.com", "messagebeamer.de", "mierdamail.com",
	"mintemail.com", "moburl.com", "moncourrier.fr.nf", "monemail.fr.nf",
	"monmail.fr.nf", "msa.minsmail.com", "mt2009.com", "mt2014.com",
	"mycard.net.ua", "mycleaninbox.net", "myemailboxy.com", "mypacks.net",
	"mypartyclip.de", "myphantomemail.com", "mysamp.de", "mytemp.email",
	"mytempemail.com", "mytempmail.com", "mytrashmail.com", "nabuma.com",
	"neomailbox.com", "nepwk.com", "nervmich.net", "nervtmich.net",
	"netmails.com", "netmails.net", "neverbox.com", "nice-4u.com",
	"nincsmail.hu", "nnh.com", "no-spam.ws", "noblepioneer.com",
	"nomail.pw", "nomail.xl.cx", "nomail2me.com", "nomorespamemails.com",
	"nospam.ze.tc", "nospam4.us", "nospamfor.us", "nospammail.net",
	"notmailinator.com", "nowhere.org", "nowmymail.com", "nurfuerspam.de",
	"objectmail.com", "obobbo.com", "odnorazovoe.ru",
	"one-time.email", "oneoffemail.com", "onewaymail.com", "onlatedotcom.info",
	"online.ms", "opayq.com", "ordinaryamerican.net", "otherinbox.com",
	"ourklips.com", "outlawspam.com", "ovpn.to", "owlpic.com", "pancakemail.com",
	"pcusers.otherinbox.com", "pjjkp.com", "plexolan.de",
	"politikerclub.de", "poofy.org", "pookmail.com", "privacy.net",
	"proxymail.eu", "prtnx.com", "punkass.com",
	"putthisinyourspamdatabase.com", "quickinbox.com", "rcpt.at",
	"reallymymail.com", "recode.me", "recursor.net", "regbypass.com",
	"rejectmail.com", "reliable-mail.com", "rhyta.com", "rmqkr.net",
	"rppkn.com", "rtrtr.com", "s0ny.net", "safetymail.info",
	"safersignup.de", "sandelf.de", "saynotospams.com", "schafmail.de",
	"selfdestructingmail.com", "sendspamhere.com", "sharklasers.com",
	"shieldedmail.com", "shiftmail.com", "shitmail.me", "shitware.nl",
	"shortmail.net", "sibmail.com", "sinnlos-mail.de", "slapsfromlastnight.com",
	"slaskpost.se", "smashmail.de", "smellfear.com", "snakemail.com",
	"sneakemail.com", "snkmail.com", "sofimail.com", "sofort-mail.de",
	"sogetthis.com", "soodonims.com", "spam4.me", "spamail.de",
	"spamavert.com", "spambob.com", "spambob.net", "spambob.org",
	"spambog.com", "spambog.de", "spambog.ru", "spambox.info", "spambox.us",
	"spamcannon.com", "spamcannon.net", "spamcero.com", "spamcon.org",
	"spamcorptastic.com", "spamcowboy.com", "spamday.com", "spamex.com",
	"spamfree24.com", "spamfree24.de", "spamfree24.org", "spamgoes.in",
	"spamgourmet.com", "spamgourmet.net", "spamgourmet.org", "spamherelots.com",
	"spamhereplease.com", "spamhole.com", "spamify.com", "spaminator.de",
	"spamkill.info", "spaml.com", "spaml.de", "spammotel.com", "spamobox.com",
	"spamslicer.com", "spamspot.com", "spamthis.co.uk", "spamtroll.net",
	"speed.1s.fr", "spoofmail.de", "squizzy.de", "stuffmail.de",
	"super-auswahl.de", "supergreatmail.com", "supermailer.jp",
	"suremail.info", "teewars.org", "teleworm.com", "teleworm.us",
	"temp-mail.org", "temp-mail.ru", "tempalias.com", "tempe-mail.com",
	"tempemail.biz", "tempemail.com", "tempemail.net", "tempinbox.co.uk",
	"tempinbox.com", "tempmail.eu", "tempmail.it", "tempmail2.com",
	"tempmaildemo.com", "tempmailer.com", "tempmailer.de", "tempomail.fr",
	"temporarily.de", "temporarioemail.com.br", "temporaryemail.net",
	"temporaryforwarding.com", "temporaryinbox.com", "temporarymailaddress.com",
	"tempthe.net", "thanksnospam.info", "thankyou2010.com", "thc.st",
	"thelimestones.com", "thisisnotmyrealemail.com", "throam.com",
	"throwawayemailaddress.com", "throwawaymail.com", "tilien.com",
	"tittbit.in", "tmail.ws", "tmailinator.com", "toiea.com", "toomail.biz",
	"topranklist.de", "tradermail.info", "trash-amil.com", "trash-mail.at",
	"trash-mail.com", "trash-mail.de", "trash2009.com", "trashdevil.com",
	"trashemail.de", "trashmail.at", "trashmail.com", "trashmail.de",
	"trashmail.me", "trashmail.net", "trashmail.org", "trashmail.ws",
	"trashmailer.com", "trashymail.com", "trialmail.de", "trillianpro.com",
	"twinmail.de", "tyldd.com", "uggsrock.com", "upliftnow.com",
	"uplipht.com", "venompen.com", "veryrealemail.com", "viditag.com",
	"viralplays.com", "vpn.st", "vsimcard.com", "vubby.com", "walala.org",
	"walkmail.net", "wasteland.rfc822.org", "webemail.me", "weg-werf-email.de",
	"wegwerf-emails.de", "wegwerfadresse.de", "wegwerfemail.com",
	"wegwerfemail.de", "wegwerfmail.de", "wegwerfmail.info", "wegwerfmail.net",
	"wegwerfmail.org", "wetrainbayarea.com", "wh4f.org", "whyspam.me",
	"willhackforfood.biz", "willselfdestruct.com", "winemaven.info",
	"wronghead.com", "wuzup.net", "wuzupmail.net", "www.e4ward.com",
	"xagloo.com", "xemaps.com", "xents.com", "xmaily.com", "xoxy.net",
	"yapped.net", "yeah.net", "yep.it", "yogamaven.com", "yopmail.com",
	"yopmail.fr", "yopmail.net", "youmailr.com", "yourdomain.com",
	"yuurok.com", "zebins.com", "zebins.eu", "zehnminuten.de",
	"zehnminutenmail.de", "zippymail.info", "zoaxe.com", "zoemail.com",
	"zoemail.net", "zoemail.org", "zomg.info",
)
