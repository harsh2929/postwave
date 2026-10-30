// Package bounceclass converts an SMTP/ESP bounce report into a
// canonical BounceClass enum. Every downstream decision — whether to
// retry, whether to suppress the address, whether to count the bounce
// against deliverability — keys off this single classification, so the
// mapping table here is the source of truth.
//
// Why a separate package:
//
//   - Several callers need the same logic: the campaign worker reads
//     SES bounce webhooks; the SMTP relay reads upstream MTA reject
//     codes; the inbound-email parser reads MAILER-DAEMON DSN replies;
//     the suppressions service reads historical bounces when promoting
//     a soft-bounce streak to hard. One classifier shared by all four
//     means a single source of truth for retry policy.
//
//   - The mapping is mostly RFC 3463 (Enhanced Mail System Status
//     Codes) but with carefully chosen ESP overrides — Mailgun and
//     Postmark each return 5.7.1 for several different reasons that
//     deserve different downstream handling.
//
//   - Tests pin every classification with a real-world bounce string
//     so the regex/match rules can't silently drift.
//
// The canonical classes:
//
//   - ClassHard          mailbox doesn't exist / domain doesn't exist;
//     suppress permanently
//   - ClassSoftMailbox   mailbox temporarily full or unavailable;
//     retry with backoff; suppress after streak
//   - ClassSoftDNS       temporary DNS failure; retry; do NOT suppress
//   - ClassPolicyReject  recipient policy refusal (corporate firewall,
//     sender allowlist); usually retry once then stop
//   - ClassContentReject content tripped a filter; suppress this message
//     only, retry the next one
//   - ClassReputation    sender reputation problem (rate-limit, RBL hit);
//     slow down sending, NOT a per-recipient issue
//   - ClassChallenge     challenge-response system (rare); do NOT auto-retry
//   - ClassUnsubscribe   the recipient unsubscribed via the bounce path;
//     suppress immediately
//   - ClassUnknown       parse failed; defer to default retry policy
package bounceclass
