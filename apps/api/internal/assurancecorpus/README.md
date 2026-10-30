# Campaign Assurance RFC 5322 benchmark corpus

`corpus/v1` is a versioned, synthetic-data-only `.eml` corpus for the F07,
F09, F10, and F11 deterministic finding families. It covers:

- valid multipart and a parseable HTML-only message;
- plain/HTML fact contradictions and a footer-link CTA trap;
- critical meaning carried only by an image;
- malformed and contradictory JSON-LD;
- the exact compiler-preheader allowlist shape;
- hidden, tiny, transparent, off-screen, and Unicode-obfuscated prompt text;
- malformed multipart boundaries; and
- Unicode copy with explicit date, IANA timezone, currency, and price facts.

`manifest.json` contains case-level required and forbidden finding codes,
primary-action traps, expected facts, and MIME validity. `taxonomy.json` binds
every referenced code to the exported `campaignchecks` detector catalog,
feature IDs, and dimension. The loader fails when that mapping drifts.
Each case also declares the exact SHA-256 of its CRLF `.eml` bytes; changing a
fixture without publishing matching versioned manifest evidence fails closed.
`ReceiptForCase` binds evaluation evidence to corpus, taxonomy, and exact
message hashes.

## Safety and integrity boundary

`LoadEmbedded` and `LoadFS` use strict, bounded JSON and RFC 5322/MIME parsing.
Files are base-name `.eml` paths, messages are capped at 4 MiB, MIME depth,
parts, and headers are bounded, and valid fixtures must use CRLF wire line
endings. Addresses and action/asset URLs use reserved example domains; the
only non-example URL allowed in message content is the fixed Schema.org
vocabulary context. The loader never resolves DNS, fetches a URL, renders HTML,
executes a script, or decodes an external-body resource.

The corpus does not bypass artifact integrity. Hand-authored `.eml` bytes are
not silently converted into a fake `campaignartifact.Revision` or
`campaigncompiler.Result`. `EvaluateReport` accepts only an already-produced,
version-matching `campaignchecks.Report` plus the exact corpus-message hash;
the normal analyzer must still verify
the immutable revision, compiler receipt, representation hashes, and exact
MIME bytes. The preheader case explicitly declares that its allowlist assertion
requires the matching compiler receipt.

This corpus establishes the versioned semantic/adversarial fixture and
expected-finding taxonomy. It does not establish model accuracy, provider UI
behavior, or a controlled-client calibration rate. Those require labeled
evaluation runs and live-client/vendor certification under later phases.

When a fixture or assertion changes, publish a new corpus and taxonomy version
rather than mutating the meaning of an existing receipt.
