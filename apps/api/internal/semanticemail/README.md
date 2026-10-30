# Semantic email v2

This package is the server-owned semantic source and projection foundation for
Campaign Assurance. It is intentionally independent of campaign persistence,
HTTP handlers, personalization stores, model inference, MIME composition, and
delivery transports.

## Contract

`DocumentV2` contains stable node IDs, closed node types and roles, typed
content, conditions, per-node localizations, and provenance. Arbitrary imported
HTML is not accepted as document content; legacy HTML crosses into the model
only through `ImportLegacyHTML`, which maps an explicit allowlist onto the same
closed union and refuses everything else (see "Legacy HTML import" below).

The canonical JSON boundary and typed entry points are:

```go
// For untrusted JSON at the authoring/freeze boundary:
normalized, diagnostics := semanticemail.DecodeAndValidateV2(rawDocumentJSON)

// Or, for an already typed in-process draft:
normalized, diagnostics = semanticemail.NormalizeAndValidateV2(draft)
result, diagnostics := semanticemail.CompileV2(normalized, semanticemail.CompileOptions{
    Locale: "en-IN",
    Slots: map[semanticemail.SlotID]string{
        "first_name": "Assurance fixture",
    },
    StructuredPolicy: semanticemail.StructuredPolicy{
        Gmail: semanticemail.GmailPolicy{
            RegisteredSender: true,
            Authenticated:    true,
            Promotions:       true,
        },
    },
})
```

Compilation returns no partial result on an error. Warnings can accompany a
valid result—for example, when valid Gmail markup is withheld because sender
eligibility has not been verified.

The HTML and plain-text projections are generated directly from the same typed
nodes. The text projection is not an HTML strip. Informative images require alt
text; decorative images render as `alt=""` and do not produce a synthetic text
line. One primary action is a role, while footer, preferences, unsubscribe, and
other secondary links remain representable.

Callers must freeze the normalized document, exact `CompileOptions` scenario,
compiler/renderer versions, and returned hashes. The MIME layer should pass the
returned text and HTML to `internal/mimecomposer`; transports must not re-render
them.

## Legacy HTML import (Foundations 2.2)

Every campaign authored before this model existed is `legacy_html`. Every check
that reads the semantic tree is therefore blind to the existing library until
those messages can be imported.

```go
result := semanticemail.ImportLegacyHTML(legacyHTML, semanticemail.ImportOptions{
    Language: "en-IN",
    SourceID: campaignRevisionID,
})
document, ok := result.Document() // ok == false for ANY lossy import
```

The importer is an **allowlist**, not a best effort, and it does not widen the
union. Anything outside the allowlist — including anything invented after the
importer was written — is refused and reported; a refused element is not
descended into, so its content never reaches the tree in some other shape.

**What happens to unmappable input.** `ImportLegacyHTML` always returns the full
report. Every construct with no representation appears in `Unmapped` with a
closed `Reason`, the element, and its position in the source. `Document()`
**refuses** to return a `DocumentV2` when anything was unmapped or when the
assembled tree failed v2 validation — there is no way to obtain a document from
a lossy import. `PartialNodes()` exists for a human review surface and is named
so no caller reaches for it believing it describes the message.

This matters because the alternative fails silently: an importer that turns an
unrepresentable construct into the nearest node that validates produces a tree
that claims to describe a message it does not describe, and every downstream
check then reports confidently about the wrong thing.

Refused, not approximated: quotations, tables that have not declared
`role="presentation"`, forms and buttons, embedded media, preformatted text,
nested lists, nested emphasis, images inside links, anchors that are relative or
`mailto:`/fragment-bearing, images with no `alt` attribute at all, content
hidden by an inline style or `aria-hidden`, stylesheets containing a rule that
can hide content, conditional comments, and active content.

Deliberately not guessed: the ROLE of an action (HTML cannot distinguish a
primary CTA from an unsubscribe link, so every anchor imports as an inline link,
never as an action node), whether an unlabelled table is layout or data, and
whether an image with no `alt` is informative or decorative.

Documented normalizations — each a decision about presentation, which the tree
excludes by construction: bare phrasing content inside a flow container becomes
one paragraph; empty and whitespace-only blocks are dropped as spacing (an
anchor with a URL and no text is refused instead, because dropping it would
discard a URL the message contains); a whitespace-only inline run is merged as a
single boundary into the run that follows it, because it cannot survive as its
own run and dropping it would join two words; image `width`/`height` survive
only as a pair; `<style>`, `<title>`, `<meta>`, `<link>`, `<base>` and
non-conditional comments are dropped.

Imported nodes carry `provenance.source = "migration"`, so an imported node can
always be told apart from one a person wrote.

## The canonical offer bridge (F15)

`OfferContent.canonical_offer_id` names the canonical offer entity that
`internal/offers` owns. It is a **reference, never a copy**. A semantic tree is
shared by every recipient of a message, so an inlined price, validity window or
inventory state would be one frozen answer handed to everybody — and a copy goes
stale silently: it stops being true without changing. A name can be re-resolved;
a copy cannot be un-staled.

The compiler does not resolve it — compilation has no clock, network or
persistence dependency — it projects it as a name
(`data-postwave-offer="<uuid>"`). Resolution belongs to
`offers.Repo.ResolveSemanticOffers`, which re-reads the entity and reports where
what the message printed disagrees with what the entity says. A localization may
translate an offer's words but validation forbids it from naming a different
entity.

## Structured-data boundary

The pinned `gmail.email-markup.2026-04-20` registry supports only these typed
declarations:

- Gmail Promotions `DiscountOffer`;
- Gmail Promotions `PromotionCard`;
- Gmail transactional `EventReservation`; and
- Gmail transactional `Order`.

Declarations reference visible semantic nodes rather than carrying copied
values or arbitrary JSON. This makes JSON-LD/visible-content parity structural.
The compiler emits markup only when external policy evidence confirms sender
registration, SPF/DKIM authentication, and the exact Promotions or
transactional use case. HTTPS is mandatory for structured action and image
references. Promotion cards also require known dimensions with a documented
4:5, 1:1, or 1.91:1 ratio.

`StructuredDataStatus` keeps five claims separate: schema validity, sender
eligibility, whether markup was emitted, observed provider display, and any
effect on AI comprehension. The latter two remain `unknown` and `unproven` in
this package.

The registry follows Google's official [email-markup
overview](https://developers.google.com/workspace/gmail/markup/overview),
[JSON-LD format](https://developers.google.com/workspace/gmail/markup/reference/formats/json-ld),
[Promotions reference](https://developers.google.com/workspace/gmail/promotab/reference),
[EventReservation reference](https://developers.google.com/workspace/gmail/markup/reference/event-reservation),
[Order reference](https://developers.google.com/workspace/gmail/markup/reference/order),
and [action security requirements](https://developers.google.com/workspace/gmail/markup/actions/securing-actions).
A registry update requires a new version constant and golden/certification
fixtures; “latest” is never accepted.

Side-effecting one-click/inline actions are deliberately absent from v2. The
only generated action object is an HTTPS `ViewAction` for an order, which is a
navigational projection of a visible action node. Confirm/RSVP/save actions
must wait for typed limited-use tokens, replay protection, idempotent handlers,
and a separate certified registry revision.

Asset URL validation here does not fetch images or prove their media signature.
The Campaign Assurance image broker still must enforce SSRF, redirect, byte,
pixel, frame, SVG, MIME-signature, and malware policies before certification.
