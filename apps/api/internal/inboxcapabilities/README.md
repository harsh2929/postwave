# Inbox capability registry

This package contains the immutable `2026-08-09.1` research snapshot used to
describe narrow mailbox/provider/client environments. A profile key includes
the mailbox provider, reading client, OS, device class, account tier, locale,
smart-feature settings, and named surface. Those dimensions are not
interchangeable: the Gmail mailbox in the Apple Mail profile is evidence about
Apple Mail, not Gemini.

Every profile explicitly records every required capability as:

- `available`: supported by the named evidence for this exact claim;
- `unavailable`: a known protocol or current-product boundary, not a transient
  collection error; or
- `unknown`: not established for this exact environment.

Evidence is separately classified as first-party documentation, a controlled
observation, a modeled prediction, a protocol boundary, or a research gap.
Controlled observations require a capture method, capture timestamp, and
evidence-object SHA-256. Predictions require a model/prompt/config receipt and
cannot carry observation fields. The embedded snapshot contains no controlled
observations and therefore makes no claim about what a live test account saw.

The registry deliberately states that standard IMAP and the documented Gmail
Message API do not return a client-rendered AI summary. It also keeps the
effect of email structured markup on AI summaries `unknown`: Gmail documents
markup for actions, cards, highlights, and promotions, not a guarantee that
markup will display or improve an AI summary.

`LoadEmbedded` performs bounded strict decoding, validates source and evidence
timestamps, requires the complete capability set, and returns a SHA-256 for
receipts. Unknown JSON fields, omitted capabilities, duplicate exact profiles,
and evidence-class masquerading fail closed.

`ReceiptForProfile` binds a future observation to the registry version and
hash plus the exact profile ID, revision, and profile hash; observations should
store that receipt with their frozen capability snapshot.

## Current launch status

Inbox Monster and Validity are recorded only as unevaluated candidates based
on vendor-published claims. The launch vendor is explicitly `not_selected`.
Selecting one requires a qualified controlled evaluation with its own evidence
hash. Consequently this foundation does **not** complete P0.7's launch-vendor
decision or P3.4's live Gmail/Apple/Outlook/Yahoo certification.

To change a claim, add or update its evidence, increment the profile revision,
and publish a new registry version. Never rewrite a prior snapshot in place.
