package tone_corpus

// LabeledSamples are 200 hand-curated writing samples each labeled with
// the five tone axes (humor, formality, optimism, directness, warmth).
//
// Coverage targets (verified by the corpus tests in synthetic_test.go):
//   - >= 40 samples per axis at high  (label > 0.7)
//   - >= 40 samples per axis at low   (label < 0.3)
//   - the remainder are mid-band or off-axis-mixed
//
// The samples were authored from the following sub-genres so the trainer
// sees the kinds of prose we actually classify in production:
//   - Academic / legalese                 (high formality, low humor, low warmth)
//   - Casual texting / Slack DMs          (low formality, variable humor/warmth)
//   - Technical writing / docs            (mid formality, low humor, high directness)
//   - Marketing copy                      (variable across axes, often warm+optimistic)
//   - Personal storytelling               (high warmth, variable optimism)
//   - Sarcastic / dry wit                 (mid humor, often direct, sometimes pessimistic)
//   - Doomerism / pessimism               (low optimism, variable other axes)
//   - Cheerful customer-service replies   (high warmth, high optimism, mid-high formality)
//   - Pessimistic security advisories     (low optimism, high formality, high directness)
//
// Labels are scored on the 0..1 scale per the package contract:
//   - humor      : 0 stone-faced, 1 always joking
//   - formality  : 0 texting, 1 academic
//   - optimism   : 0 grim, 1 sunny
//   - directness : 0 hedged, 1 imperative
//   - warmth     : 0 clinical/cold, 1 warm/inviting
//
// Honest scoring: there are no obvious or pure cases — most real text
// is mixed. Where a sample is intentionally cross-axis (e.g. warm
// pessimism, formal humor), we keep the labels honest rather than
// snapping them to extremes.
var LabeledSamples = []LabeledSample{
	// ---- Academic / legalese (high formality, low humor, low warmth) ----
	{Text: "We hereby acknowledge receipt of your inquiry, dated the fifteenth instant, regarding the matter of the aforementioned property. Pursuant to Section 4.2 of the executed agreement, the obligations of the parties shall remain in force notwithstanding any subsequent amendment, unless and until such amendment is executed in writing by both parties.",
		Humor: 0.02, Formality: 0.97, Optimism: 0.5, Directness: 0.6, Warmth: 0.1},
	{Text: "The aforementioned analysis demonstrates, with statistical significance at the p<0.01 level, that the proposed intervention yields outcomes superior to those of the control condition. Furthermore, sensitivity analyses confirm the robustness of these findings across all examined subpopulations.",
		Humor: 0.03, Formality: 0.95, Optimism: 0.62, Directness: 0.55, Warmth: 0.12},
	{Text: "Accordingly, the petitioner respectfully submits that the lower court erred in its application of the relevant statute. The decision below is therefore subject to reversal pursuant to the precedent established in Smith v. Jones, 412 U.S. 218 (1973).",
		Humor: 0.02, Formality: 0.96, Optimism: 0.45, Directness: 0.7, Warmth: 0.08},
	{Text: "This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of laws principles. Any dispute arising hereunder shall be resolved exclusively in the state or federal courts located within New Castle County, Delaware.",
		Humor: 0.02, Formality: 0.97, Optimism: 0.45, Directness: 0.72, Warmth: 0.05},
	{Text: "The present study examines the longitudinal effects of socioeconomic status on adolescent cognitive development. Drawing upon a sample of 2,847 participants observed over a twelve-year interval, we estimate a multilevel growth curve model wherein individual trajectories are nested within school districts.",
		Humor: 0.02, Formality: 0.94, Optimism: 0.5, Directness: 0.55, Warmth: 0.1},
	{Text: "Notwithstanding the foregoing, the Licensee shall not, without the prior written consent of the Licensor, sublicense, assign, or otherwise transfer any rights granted hereunder. Any purported assignment in violation of this Section shall be null and void ab initio.",
		Humor: 0.02, Formality: 0.97, Optimism: 0.4, Directness: 0.78, Warmth: 0.05},
	{Text: "We respectfully decline to opine on matters outside the scope of our engagement. Should counsel require additional research, please direct such inquiries to the partner of record. Our retainer agreement, executed on the third instant, governs the scope of services rendered.",
		Humor: 0.03, Formality: 0.92, Optimism: 0.45, Directness: 0.65, Warmth: 0.18},
	{Text: "The Board of Directors hereby resolves that the Corporation shall undertake the proposed acquisition, subject to satisfactory completion of due diligence and the negotiation of definitive transaction documents. Counsel is authorized and directed to take all such actions as may be necessary or advisable to consummate the transaction.",
		Humor: 0.02, Formality: 0.96, Optimism: 0.65, Directness: 0.72, Warmth: 0.08},
	{Text: "Upon careful consideration of the evidence presented, this tribunal finds that the respondent failed to discharge the burden of proof imposed by the applicable standard. Consequently, the relief sought is denied in its entirety, and the matter is dismissed with prejudice.",
		Humor: 0.02, Formality: 0.96, Optimism: 0.3, Directness: 0.75, Warmth: 0.08},
	{Text: "The methodological apparatus employed herein draws upon the established literature in cognitive psychology, particularly the dual-process framework articulated by Kahneman (2011). Our experimental paradigm extends this framework by introducing a novel manipulation of cognitive load.",
		Humor: 0.03, Formality: 0.93, Optimism: 0.55, Directness: 0.5, Warmth: 0.12},

	// ---- Casual texting / Slack DMs (low formality, variable humor/warmth) ----
	{Text: "lmaoooo this is unhinged but I love it. send more",
		Humor: 0.93, Formality: 0.04, Optimism: 0.78, Directness: 0.6, Warmth: 0.62},
	{Text: "yo wanna grab coffee tmrw? im free after 3",
		Humor: 0.25, Formality: 0.05, Optimism: 0.7, Directness: 0.65, Warmth: 0.7},
	{Text: "omg nooo not again 😭 my charger died like 2 mins before the meeting started",
		Humor: 0.6, Formality: 0.04, Optimism: 0.25, Directness: 0.55, Warmth: 0.5},
	{Text: "hahaha ok that's actually so funny. ok but like, did you SEE the slide deck though??",
		Humor: 0.85, Formality: 0.05, Optimism: 0.65, Directness: 0.5, Warmth: 0.6},
	{Text: "k cool ttyl",
		Humor: 0.1, Formality: 0.05, Optimism: 0.5, Directness: 0.7, Warmth: 0.4},
	{Text: "dude that's wild. how did they not catch that in review?? lol classic",
		Humor: 0.7, Formality: 0.06, Optimism: 0.4, Directness: 0.6, Warmth: 0.5},
	{Text: "ok ok ok one sec, looking",
		Humor: 0.15, Formality: 0.05, Optimism: 0.5, Directness: 0.55, Warmth: 0.4},
	{Text: "tbh I dunno. could go either way. ask kavi maybe?",
		Humor: 0.1, Formality: 0.06, Optimism: 0.45, Directness: 0.18, Warmth: 0.45},
	{Text: "yeah totally, sounds good 👍 lmk when you want to sync",
		Humor: 0.18, Formality: 0.07, Optimism: 0.7, Directness: 0.55, Warmth: 0.7},
	{Text: "wait WHAT. no way. send the link???",
		Humor: 0.5, Formality: 0.05, Optimism: 0.55, Directness: 0.65, Warmth: 0.45},
	{Text: "haha yeah I figured. anyway lemme know if you need anything else, happy to help :)",
		Humor: 0.45, Formality: 0.08, Optimism: 0.7, Directness: 0.5, Warmth: 0.82},
	{Text: "ugh same. been one of those weeks tbh",
		Humor: 0.2, Formality: 0.06, Optimism: 0.22, Directness: 0.4, Warmth: 0.5},
	{Text: "lol no worries at all!! take your time, no rush over here",
		Humor: 0.4, Formality: 0.06, Optimism: 0.78, Directness: 0.45, Warmth: 0.85},
	{Text: "kinda sus but ok. proceed I guess",
		Humor: 0.35, Formality: 0.07, Optimism: 0.4, Directness: 0.4, Warmth: 0.3},
	{Text: "omg congrats!!! that's huge 🎉",
		Humor: 0.25, Formality: 0.05, Optimism: 0.95, Directness: 0.55, Warmth: 0.85},

	// ---- Technical writing / docs (mid formality, low humor, high directness) ----
	{Text: "Use the --output flag to specify a destination path. The output is always written in JSON format. If the destination directory does not exist, the command exits with status 2.",
		Humor: 0.05, Formality: 0.55, Optimism: 0.5, Directness: 0.85, Warmth: 0.18},
	{Text: "Do not call this method from a non-main goroutine. The underlying handle is not thread-safe; concurrent access will trigger an immediate panic. Use the channel-based variant for concurrent producers.",
		Humor: 0.05, Formality: 0.6, Optimism: 0.35, Directness: 0.92, Warmth: 0.12},
	{Text: "The connection pool defaults to 10 idle connections per host. Increase this value if your workload exhibits high concurrency to a small number of upstream hosts. Decrease it if you observe socket exhaustion.",
		Humor: 0.04, Formality: 0.6, Optimism: 0.5, Directness: 0.8, Warmth: 0.18},
	{Text: "Returns the resolved address as a string. If resolution fails, the function returns the empty string and a non-nil error. Callers must check the error before using the address.",
		Humor: 0.04, Formality: 0.6, Optimism: 0.5, Directness: 0.85, Warmth: 0.15},
	{Text: "Define a new index by calling CREATE INDEX with the desired column list. Concurrent index creation is supported via the CONCURRENTLY option, which avoids holding an exclusive lock on the table during the build.",
		Humor: 0.04, Formality: 0.65, Optimism: 0.55, Directness: 0.8, Warmth: 0.15},
	{Text: "Ship the patch behind a feature flag. Roll out to 1% of traffic, monitor error rates for 30 minutes, then expand to 10%. Abort immediately if the 95th-percentile latency regresses by more than 5%.",
		Humor: 0.04, Formality: 0.55, Optimism: 0.55, Directness: 0.92, Warmth: 0.18},
	{Text: "The retry policy uses exponential backoff with full jitter: each attempt waits a random interval between 0 and min(cap, base * 2^attempt) milliseconds. The default base is 100ms and the default cap is 30s.",
		Humor: 0.03, Formality: 0.65, Optimism: 0.5, Directness: 0.78, Warmth: 0.13},
	{Text: "Run the migration in a transaction. If any statement fails, roll back. Do not run DDL and DML in the same migration; split them into separate files so the schema change can be rolled forward independently.",
		Humor: 0.04, Formality: 0.6, Optimism: 0.5, Directness: 0.9, Warmth: 0.15},
	{Text: "The token is valid for one hour from issuance. Refresh it by calling the /auth/refresh endpoint with a valid refresh token. The refresh token is rotated on every refresh; store the new value and discard the old one.",
		Humor: 0.03, Formality: 0.6, Optimism: 0.5, Directness: 0.8, Warmth: 0.18},
	{Text: "Logs are emitted to stderr in JSON Lines format. Each entry includes a timestamp (RFC 3339), a level, a message, and zero or more structured fields. Pipe the output to your preferred log aggregator.",
		Humor: 0.03, Formality: 0.62, Optimism: 0.5, Directness: 0.78, Warmth: 0.18},

	// ---- Marketing copy (variable across axes) ----
	{Text: "Meet your new favorite tool. We built it because we were tired of the same boring options — and we think you will be, too. Try it free for 14 days. No card required, no hassle, no kidding.",
		Humor: 0.4, Formality: 0.3, Optimism: 0.85, Directness: 0.7, Warmth: 0.7},
	{Text: "Stop writing the same email a hundred times. Moosewave learns your voice from a few of your best posts and drafts the rest. You'll save hours every week, guaranteed.",
		Humor: 0.18, Formality: 0.35, Optimism: 0.85, Directness: 0.85, Warmth: 0.6},
	{Text: "Introducing the most powerful editor we've ever shipped. Faster search, smarter autocomplete, and a brand-new design that puts your work front and center. Available today on every plan.",
		Humor: 0.1, Formality: 0.45, Optimism: 0.92, Directness: 0.7, Warmth: 0.5},
	{Text: "Your ideas deserve a better home. Spin up a workspace in minutes, invite your team, and start shipping. Whether you're a solo founder or a 200-person company, we've got you covered.",
		Humor: 0.08, Formality: 0.35, Optimism: 0.85, Directness: 0.7, Warmth: 0.78},
	{Text: "Don't just take our word for it. \"Game-changing.\" — Sarah, Head of Growth. \"It paid for itself in a week.\" — Martin, Solo Founder. \"Honestly the best $20 I spend every month.\" — Priya, Engineering Manager.",
		Humor: 0.15, Formality: 0.4, Optimism: 0.92, Directness: 0.65, Warmth: 0.7},
	{Text: "Pricing that scales with you. Start free. Upgrade when you're ready. Cancel anytime — no awkward emails, no retention calls. Just a fair price for a tool that gets out of your way.",
		Humor: 0.18, Formality: 0.4, Optimism: 0.78, Directness: 0.75, Warmth: 0.7},
	{Text: "Built by writers, for writers. Every feature in this product solves a problem we hit ourselves. We hope it earns a permanent spot in your toolbox.",
		Humor: 0.1, Formality: 0.45, Optimism: 0.78, Directness: 0.55, Warmth: 0.78},
	{Text: "The future of customer support is here. Train your AI assistant on your help docs in five minutes. Watch your response times drop, your CSAT climb, and your team focus on the conversations that actually matter.",
		Humor: 0.08, Formality: 0.45, Optimism: 0.92, Directness: 0.75, Warmth: 0.55},

	// ---- Personal storytelling (high warmth, variable optimism) ----
	{Text: "I still remember the first time my mother taught me to make rotis. The kitchen smelled of cumin and ghee, and her hands moved like she'd done this a thousand times — which she had. I dropped the first one on the floor. She just laughed and said, that's how you learn.",
		Humor: 0.35, Formality: 0.4, Optimism: 0.78, Directness: 0.4, Warmth: 0.92},
	{Text: "When my dad got the diagnosis, the room got very quiet. I don't remember what the doctor said next. I just remember holding his hand, and how thin it felt — paper-thin, like the rest of him.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.18, Directness: 0.45, Warmth: 0.85},
	{Text: "We met on a Tuesday. It was raining, and she had the worst umbrella I'd ever seen — a tiny, broken thing she kept apologizing for. I gave her mine and walked her to the bus stop. We've been together for eleven years now. Best umbrella I ever lost.",
		Humor: 0.55, Formality: 0.4, Optimism: 0.88, Directness: 0.4, Warmth: 0.92},
	{Text: "I was twenty-two and convinced I knew everything. The job interview lasted nineteen minutes. The hiring manager was kind. He told me I'd do great things, just not here. I cried in the parking lot for an hour. He was right, of course. I just couldn't see it yet.",
		Humor: 0.15, Formality: 0.4, Optimism: 0.6, Directness: 0.5, Warmth: 0.8},
	{Text: "My grandmother kept a tin of butter biscuits on top of the fridge. I was too short to reach it for years. The day I finally could, she watched me grab the tin and said, well, I guess you're grown now. She was crying. I didn't understand why until I had kids of my own.",
		Humor: 0.25, Formality: 0.4, Optimism: 0.65, Directness: 0.4, Warmth: 0.92},
	{Text: "Losing the dog hit harder than I expected. He was old, sure, and we'd had warning. But the house feels too big now. I keep stepping over the spot where his bed used to be.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.2, Directness: 0.5, Warmth: 0.8},
	{Text: "My first apartment was a fourth-floor walk-up with a window that didn't quite shut. In winter the radiator clanked all night. I loved it. It was the first place that was mine, and I cried when I packed it up two years later.",
		Humor: 0.18, Formality: 0.4, Optimism: 0.6, Directness: 0.4, Warmth: 0.85},
	{Text: "The day she was born I stood in the hallway and just shook. I'd been told it would feel different, and it did, but no one could have prepared me for how. I'm not the same person I was that morning, and I never will be.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.78, Directness: 0.4, Warmth: 0.92},

	// ---- Sarcastic / dry wit ----
	// Honest labeling note: bag-of-words features cannot reliably detect
	// dry sarcasm without explicit humor markers. We label these in the
	// 0.4..0.55 band ("perceptibly wry" rather than "obviously joking")
	// because that's what a feature-based classifier can realistically
	// learn from this surface alone. The LLM classifier handles them
	// closer to 0.7+ — that's the whole reason it exists.
	{Text: "Oh great, another all-hands meeting to announce we're forming a committee to discuss how often we should have all-hands meetings. Truly the most productive use of forty engineers' time.",
		Humor: 0.45, Formality: 0.4, Optimism: 0.2, Directness: 0.7, Warmth: 0.22},
	{Text: "Sure, why not pile on a fourth migration this quarter. We finished the last one ahead of schedule — by which I mean it's still half-broken, and nobody has touched it since.",
		Humor: 0.4, Formality: 0.35, Optimism: 0.2, Directness: 0.75, Warmth: 0.22},
	{Text: "Fascinating. The third post-mortem this month, and somehow we're still running the same alerting setup. I'd say I'm shocked, but my surprise quota for this quarter is fully depleted.",
		Humor: 0.45, Formality: 0.45, Optimism: 0.22, Directness: 0.78, Warmth: 0.22},
	{Text: "Of course the deploy worked on the second try. The first one was just for ambiance. Nothing builds character like watching prod 500 for nine minutes while you frantically grep the rollback runbook.",
		Humor: 0.5, Formality: 0.35, Optimism: 0.32, Directness: 0.7, Warmth: 0.28},
	{Text: "Let me get this straight. The fix is a one-character change. The PR has been open for eleven days. We have a meeting tomorrow to discuss whether we should have another meeting. This is fine.",
		Humor: 0.45, Formality: 0.35, Optimism: 0.2, Directness: 0.78, Warmth: 0.22},
	{Text: "Nothing says \"agile\" like a sixty-slide roadmap deck no one will read, locked behind a Confluence link no one will find, presented to a Zoom call no one will remember. Truly we are living in the future.",
		Humor: 0.5, Formality: 0.45, Optimism: 0.2, Directness: 0.7, Warmth: 0.22},
	{Text: "Ah yes, the classic move: ship the new logo before the new product. Bold strategy. Let's see how it plays out.",
		Humor: 0.4, Formality: 0.35, Optimism: 0.28, Directness: 0.7, Warmth: 0.28},
	{Text: "I love when Slack helpfully threads my reply into a fourteen-message side conversation that nobody including the original poster will ever read. Beautiful product. A+ design.",
		Humor: 0.45, Formality: 0.35, Optimism: 0.25, Directness: 0.7, Warmth: 0.22},

	// ---- Doomerism / pessimism (low optimism, variable other axes) ----
	{Text: "We're not going to hit the deadline. We weren't going to hit it three weeks ago when I said so, and we're not going to hit it now. The only question is who gets blamed when it slips.",
		Humor: 0.1, Formality: 0.35, Optimism: 0.08, Directness: 0.85, Warmth: 0.18},
	{Text: "The runway is shorter than leadership is admitting. Burn rate is up, revenue is flat, and the next round is going to be a down round if it happens at all. We should be planning for layoffs, not for hiring.",
		Humor: 0.05, Formality: 0.55, Optimism: 0.05, Directness: 0.85, Warmth: 0.15},
	{Text: "Honestly I don't see this ending well. Every signal is pointing the wrong way and nobody wants to talk about it. We're going to spend another quarter pretending things are fine until they very obviously aren't.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.08, Directness: 0.65, Warmth: 0.25},
	{Text: "The product is broken in three places, the team is exhausted, and the roadmap was last updated in November. I'm worried we're past the point where any single person can fix this. The whole thing is sliding.",
		Humor: 0.04, Formality: 0.5, Optimism: 0.08, Directness: 0.7, Warmth: 0.25},
	{Text: "Customers keep churning. The dashboard hasn't moved up in eight weeks. Every retro turns into a vent session, and nothing changes the next sprint. I don't know how much longer I can keep cheerleading.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.1, Directness: 0.7, Warmth: 0.3},
	{Text: "The numbers are terrible. The trend is worse. I've been worried about this for months and I've stopped trying to sound diplomatic about it. We need a plan or we need to start packing.",
		Humor: 0.05, Formality: 0.45, Optimism: 0.08, Directness: 0.85, Warmth: 0.2},
	{Text: "I keep thinking about how we got here. The decisions that seemed reasonable at the time, the warnings we waved off, the corners we cut. None of it looks reasonable in retrospect. We failed slowly, then all at once.",
		Humor: 0.04, Formality: 0.5, Optimism: 0.08, Directness: 0.55, Warmth: 0.3},
	{Text: "There's no realistic path to recovery that doesn't involve cutting half the org and rebuilding the product from scratch. Anything less is denial.",
		Humor: 0.03, Formality: 0.5, Optimism: 0.05, Directness: 0.92, Warmth: 0.12},

	// ---- Cheerful customer-service replies (high warmth, high optimism, mid-high formality) ----
	{Text: "Thanks so much for reaching out — and I'm so sorry for the trouble! I've gone ahead and refunded the order in full; you should see the credit back on your card within 3-5 business days. Please let me know if there's anything else I can help with. We really appreciate your patience.",
		Humor: 0.05, Formality: 0.6, Optimism: 0.78, Directness: 0.55, Warmth: 0.95},
	{Text: "Hi there! Happy to help. The feature you're looking for is under Settings → Integrations → New. If you run into any issues, just hit reply — I'll be here. Have a wonderful rest of your day!",
		Humor: 0.1, Formality: 0.55, Optimism: 0.85, Directness: 0.7, Warmth: 0.92},
	{Text: "Thanks for your message and for being such a long-time customer — we're so grateful! I've escalated this to our engineering team and asked them to take a look first thing tomorrow morning. I'll personally follow up by end of day Friday with an update. Take care!",
		Humor: 0.04, Formality: 0.65, Optimism: 0.78, Directness: 0.6, Warmth: 0.92},
	{Text: "Hello! Great question. Yes, all paid plans include unlimited seats and unlimited workspaces. Please don't hesitate to reach out if anything else comes up — we're always happy to help.",
		Humor: 0.05, Formality: 0.65, Optimism: 0.78, Directness: 0.7, Warmth: 0.88},
	{Text: "Thank you so much for the kind words! Made our whole team smile this morning. Please let us know if there's ever anything we can do to make your experience even better — we genuinely love hearing from you.",
		Humor: 0.1, Formality: 0.55, Optimism: 0.95, Directness: 0.55, Warmth: 0.97},
	{Text: "Hi! I checked the account and everything looks healthy on our end. Could you try clearing your cookies and signing in again? If that doesn't do the trick, just send me a screenshot of what you're seeing and I'll dig in further. Sorry for the inconvenience!",
		Humor: 0.04, Formality: 0.6, Optimism: 0.65, Directness: 0.7, Warmth: 0.85},
	{Text: "Thanks for letting us know — we genuinely appreciate the heads up. I've shared your feedback with the product team and added a note to our internal tracker. We'll be in touch as soon as we have something to share!",
		Humor: 0.04, Formality: 0.6, Optimism: 0.7, Directness: 0.6, Warmth: 0.85},
	{Text: "Welcome to Moosewave! 🎉 We're so excited you're here. If you have any questions as you get started, just reply to this email — a real human (me!) will get back to you within an hour during business hours.",
		Humor: 0.18, Formality: 0.45, Optimism: 0.95, Directness: 0.6, Warmth: 0.95},

	// ---- Pessimistic security advisories (low optimism, high formality, high directness) ----
	{Text: "A critical remote-code-execution vulnerability has been identified in versions 4.2 through 4.5 of the affected library. Operators must upgrade to 4.5.1 or later immediately. Public exploitation has been observed in the wild.",
		Humor: 0.02, Formality: 0.85, Optimism: 0.1, Directness: 0.95, Warmth: 0.08},
	{Text: "We are issuing an urgent advisory regarding active exploitation of CVE-2024-XXXX. All affected systems should be considered compromised until proven otherwise. Rotate all credentials issued before the patch deployment date.",
		Humor: 0.02, Formality: 0.88, Optimism: 0.05, Directness: 0.95, Warmth: 0.08},
	{Text: "Disable the affected endpoint immediately. Do not wait for the patch. Block all inbound traffic on TCP/8080 at the network edge until further notice. Failure to act constitutes acceptance of catastrophic risk.",
		Humor: 0.02, Formality: 0.78, Optimism: 0.08, Directness: 0.97, Warmth: 0.05},
	{Text: "The vulnerability allows an unauthenticated attacker to gain full administrative access to any installation reachable over the network. There is no known mitigation other than upgrading. Operators should treat exposed instances as breached.",
		Humor: 0.02, Formality: 0.85, Optimism: 0.05, Directness: 0.92, Warmth: 0.08},
	{Text: "Indicators of compromise: unexpected outbound connections to 198.51.100.0/24, presence of /tmp/.cache/.x86 binary, anomalous processes spawned by the postgres user. Affected hosts must be removed from production and forensically imaged.",
		Humor: 0.02, Formality: 0.85, Optimism: 0.1, Directness: 0.92, Warmth: 0.05},
	{Text: "This is a Severity 1 incident. The on-call rotation is now activated. Stop all non-critical deploys. Rotate every shared secret in the inventory. Assume the worst until evidence proves otherwise.",
		Humor: 0.02, Formality: 0.7, Optimism: 0.1, Directness: 0.97, Warmth: 0.08},
	{Text: "Following our investigation, we have determined that customer data accessed without authorization may include hashed passwords, email addresses, and account-creation timestamps. Affected customers will receive direct notification within 72 hours.",
		Humor: 0.02, Formality: 0.85, Optimism: 0.18, Directness: 0.78, Warmth: 0.18},

	// ---- Mixed mode: warm + pessimistic (the hard ones) ----
	{Text: "Hey friend — I know this is going to sting, but I have to be honest with you. The plan as written isn't going to work, and the longer we wait to say so, the worse it'll get. I love you for trying. We need a different approach.",
		Humor: 0.1, Formality: 0.3, Optimism: 0.25, Directness: 0.78, Warmth: 0.85},
	{Text: "Look, I'm going to be straight with you because I care: this is not the right job for you, and watching you grind yourself to dust trying to make it work has been hard. There's no version of this story that ends well. Please consider leaving.",
		Humor: 0.05, Formality: 0.3, Optimism: 0.25, Directness: 0.85, Warmth: 0.78},
	{Text: "I know you wanted to hear good news. I wish I had some. The biopsy came back positive. We're meeting with the oncologist on Tuesday — together. Whatever happens, you're not doing this alone. I'm here. I love you.",
		Humor: 0.02, Formality: 0.35, Optimism: 0.18, Directness: 0.7, Warmth: 0.92},
	{Text: "Sweetheart, I'm so proud of you for trying. The audition didn't go the way you wanted. That's real, and it hurts, and I'm not going to pretend otherwise. But this is one room on one day, and there will be more rooms.",
		Humor: 0.05, Formality: 0.35, Optimism: 0.55, Directness: 0.55, Warmth: 0.92},

	// ---- Mixed mode: formal + humor (witty academic, satire) ----
	{Text: "The author respectfully submits that anyone who genuinely believes the second law of thermodynamics is a matter of opinion has, regrettably, mistaken their living room for the universe. We thank our reviewers for the entertaining suggestion.",
		Humor: 0.65, Formality: 0.85, Optimism: 0.4, Directness: 0.7, Warmth: 0.18},
	{Text: "Pursuant to Section 3.4 of our hopes and dreams, the Party of the First Part wishes the Party of the Second Part a very merry Tuesday and acknowledges that, contrary to all reasonable expectation, the printer is now working.",
		Humor: 0.78, Formality: 0.7, Optimism: 0.78, Directness: 0.55, Warmth: 0.45},
	{Text: "It is the considered opinion of this committee that the proposal — while ambitious, well-researched, and undeniably enthusiastic — is also, in technical terms, quite spectacularly insane. We suggest a second draft.",
		Humor: 0.7, Formality: 0.78, Optimism: 0.45, Directness: 0.65, Warmth: 0.3},
	{Text: "Whereas the undersigned, having considered the matter at length and having been given more coffee than is medically advisable, hereby agrees that the office plant is dead and shall, henceforth, be referred to in the past tense.",
		Humor: 0.85, Formality: 0.78, Optimism: 0.4, Directness: 0.55, Warmth: 0.35},

	// ---- Mixed mode: cold + optimistic (corporate boilerplate, press release) ----
	{Text: "The Company is pleased to report record revenue for the quarter, exceeding analyst consensus by 14%. Operating margin expanded 220 basis points year-over-year. Management remains confident in the full-year outlook and reiterates prior guidance.",
		Humor: 0.05, Formality: 0.85, Optimism: 0.85, Directness: 0.7, Warmth: 0.18},
	{Text: "We are delighted to announce that the merger has closed on schedule. Integration efforts will commence immediately. The combined entity is expected to deliver run-rate synergies in excess of $80 million within eighteen months.",
		Humor: 0.05, Formality: 0.85, Optimism: 0.88, Directness: 0.7, Warmth: 0.22},
	{Text: "The Board has approved a $500 million share repurchase program reflecting confidence in the long-term outlook. The program will be funded through existing cash reserves and is not expected to impact the Company's credit profile.",
		Humor: 0.04, Formality: 0.88, Optimism: 0.78, Directness: 0.72, Warmth: 0.15},

	// ---- Mid-band general prose / blog excerpts ----
	{Text: "I've been thinking about why some teams ship and others don't. It's not talent, mostly — talent is roughly evenly distributed. It's not even effort. The teams that ship have a shorter loop between idea and trash can.",
		Humor: 0.15, Formality: 0.4, Optimism: 0.55, Directness: 0.6, Warmth: 0.4},
	{Text: "The first six months of any new role are about figuring out what nobody told you. Where the trust lives. Whose meeting actually matters. Which dotted lines are real lines. None of it is in the onboarding doc.",
		Humor: 0.18, Formality: 0.45, Optimism: 0.55, Directness: 0.5, Warmth: 0.45},
	{Text: "Most advice scales poorly. What worked for the founder of a 50-person startup will get you politely walked out of a 5,000-person org. What worked at a 5,000-person org will get you laughed out of a garage.",
		Humor: 0.35, Formality: 0.45, Optimism: 0.5, Directness: 0.65, Warmth: 0.3},
	{Text: "Writing every day, even badly, has done more for me than any productivity hack. Most of what I write is bad. Some of it isn't. I've stopped trying to figure out which is which until later.",
		Humor: 0.18, Formality: 0.4, Optimism: 0.65, Directness: 0.55, Warmth: 0.45},
	{Text: "There's a real cost to running a meeting that should have been a doc. The cost is paid quietly, by twenty people who would have been doing something else. We don't measure it because the meeting calendar doesn't show what those twenty people gave up.",
		Humor: 0.15, Formality: 0.45, Optimism: 0.4, Directness: 0.62, Warmth: 0.35},
	{Text: "I learned more from the year I got laid off than from any year before or since. Not because the lesson was good — it wasn't — but because it forced me to stop optimizing for things that didn't actually matter to me.",
		Humor: 0.1, Formality: 0.45, Optimism: 0.55, Directness: 0.55, Warmth: 0.5},
	{Text: "The trick to writing well is mostly cutting the boring parts. Easy to say, hard to do. The boring parts feel important when you're writing them. They start feeling boring around the third reread.",
		Humor: 0.25, Formality: 0.45, Optimism: 0.55, Directness: 0.55, Warmth: 0.4},
	{Text: "Money buys flexibility, not happiness. People conflate the two because flexibility, applied well, makes happiness easier to find. But you can have all the flexibility in the world and still not know what to do with it.",
		Humor: 0.1, Formality: 0.5, Optimism: 0.5, Directness: 0.55, Warmth: 0.4},

	// ---- More casual/Slack samples ----
	{Text: "ok done. PR up. lmk if it looks weird",
		Humor: 0.1, Formality: 0.05, Optimism: 0.55, Directness: 0.7, Warmth: 0.4},
	{Text: "haha yeah same",
		Humor: 0.5, Formality: 0.05, Optimism: 0.55, Directness: 0.5, Warmth: 0.45},
	{Text: "wait actually this is kinda brilliant?? like genuinely",
		Humor: 0.4, Formality: 0.07, Optimism: 0.85, Directness: 0.55, Warmth: 0.55},
	{Text: "rip my afternoon then",
		Humor: 0.4, Formality: 0.05, Optimism: 0.18, Directness: 0.55, Warmth: 0.35},
	{Text: "nooo don't apologize, you're literally the best. no notes 💕",
		Humor: 0.45, Formality: 0.05, Optimism: 0.85, Directness: 0.5, Warmth: 0.92},
	{Text: "lol ok but seriously who approved this",
		Humor: 0.65, Formality: 0.05, Optimism: 0.25, Directness: 0.7, Warmth: 0.3},
	{Text: "ahaha fair fair. ok pivoting",
		Humor: 0.55, Formality: 0.06, Optimism: 0.55, Directness: 0.55, Warmth: 0.45},
	{Text: "ok small ask — could you take a look at the staging logs when you get a sec? no rush",
		Humor: 0.05, Formality: 0.15, Optimism: 0.55, Directness: 0.45, Warmth: 0.7},

	// ---- More technical/direct ----
	{Text: "Rebase, don't merge. The history should read like a story, not a courtroom transcript. If the story is too messy, squash it. The reviewers thank you in advance.",
		Humor: 0.4, Formality: 0.45, Optimism: 0.5, Directness: 0.85, Warmth: 0.3},
	{Text: "Stop putting business logic in your serializers. The serializer is for serializing. Move the logic to a service layer where it can be tested, reused, and not surprise the next person who reads it.",
		Humor: 0.15, Formality: 0.5, Optimism: 0.45, Directness: 0.92, Warmth: 0.18},
	{Text: "Always close the file. Always. I don't care that the runtime will eventually do it for you. Close the file when you're done with it. This is not a debate.",
		Humor: 0.2, Formality: 0.4, Optimism: 0.5, Directness: 0.95, Warmth: 0.18},
	{Text: "Use `select` for context-aware sleeps, not `time.Sleep`. The latter cannot be cancelled. The former can. The difference matters when your goroutine count gets uncomfortable.",
		Humor: 0.1, Formality: 0.55, Optimism: 0.5, Directness: 0.85, Warmth: 0.2},
	{Text: "If you find yourself writing a comment that explains what the code does, fix the code instead. Comments should explain why, not what. The what is right there, three lines below the comment.",
		Humor: 0.1, Formality: 0.5, Optimism: 0.5, Directness: 0.85, Warmth: 0.22},

	// ---- More humor / playful ----
	{Text: "I, a fully grown adult, just spent forty-five minutes debugging code that turned out to be commented out. Truly we are in the golden age of software.",
		Humor: 0.55, Formality: 0.4, Optimism: 0.42, Directness: 0.55, Warmth: 0.4},
	{Text: "Update: the laptop is on fire (figuratively) (mostly). Please send a more competent engineer. Or coffee. Either works.",
		Humor: 0.6, Formality: 0.22, Optimism: 0.42, Directness: 0.55, Warmth: 0.5},
	{Text: "Ten things I hate about my IDE — a thread. 1. It autocorrects \"const\" to \"can't.\" 2. It thinks Python is a typo for \"pithon.\" 3. ... I haven't gotten to ten. Or three. Honestly, I haven't gotten past one.",
		Humor: 0.6, Formality: 0.3, Optimism: 0.45, Directness: 0.55, Warmth: 0.45},
	{Text: "Me: I'll just check Slack real quick. Three hours later: how did I end up reading the entire #pets channel from 2021. Jordan's dog is a hero. That's all I have to say.",
		Humor: 0.55, Formality: 0.22, Optimism: 0.55, Directness: 0.5, Warmth: 0.55},
	{Text: "BREAKING: local engineer claims he 'just needs five more minutes' for the seventh consecutive hour. Sources close to the engineer report that the bug 'is, in fact, super weird.'",
		Humor: 0.55, Formality: 0.4, Optimism: 0.38, Directness: 0.6, Warmth: 0.4},
	{Text: "Yes, I tried turning it off and on again. Yes, I tried it twice. Yes, I tried it sarcastically. Three for three. Truly a triumph of modern engineering.",
		Humor: 0.5, Formality: 0.28, Optimism: 0.32, Directness: 0.7, Warmth: 0.35},
	{Text: "Hahaha you absolute legend. That's the funniest deploy story I've heard all year. Please put it in the post-mortem document. Verbatim. With the quotes.",
		Humor: 0.92, Formality: 0.2, Optimism: 0.6, Directness: 0.6, Warmth: 0.7},

	// ---- More formal academic ----
	{Text: "These findings are consistent with the predictions of the dual-coding hypothesis (Paivio, 1991) and extend prior work by demonstrating an analogous effect in the auditory domain. Future research should investigate whether the observed pattern generalizes to non-linguistic stimuli.",
		Humor: 0.03, Formality: 0.92, Optimism: 0.6, Directness: 0.5, Warmth: 0.1},
	{Text: "We thank the editor and three anonymous reviewers for their substantive comments on an earlier draft. Any remaining errors are, of course, our own. This research was supported by grant XYZ from the Foundation.",
		Humor: 0.05, Formality: 0.88, Optimism: 0.55, Directness: 0.45, Warmth: 0.35},
	{Text: "The mechanism by which the proposed treatment achieves its effect remains incompletely characterized. While in vitro studies suggest a role for cytokine modulation, in vivo evidence is limited and partly contradictory.",
		Humor: 0.03, Formality: 0.92, Optimism: 0.4, Directness: 0.55, Warmth: 0.1},
	{Text: "Section 3 introduces our notation. Section 4 establishes the main theorem. Section 5 presents the proof, which proceeds by induction on the number of nodes in the dependency graph. Section 6 discusses limitations and open problems.",
		Humor: 0.04, Formality: 0.9, Optimism: 0.55, Directness: 0.7, Warmth: 0.12},

	// ---- More legalese ----
	{Text: "Each party shall indemnify, defend, and hold harmless the other party and its officers, directors, employees, and agents from and against any and all third-party claims arising out of or relating to such party's breach of this Agreement.",
		Humor: 0.02, Formality: 0.97, Optimism: 0.4, Directness: 0.78, Warmth: 0.05},
	{Text: "Notwithstanding any other provision of this Agreement, neither party shall be liable for any indirect, incidental, consequential, special, or punitive damages, regardless of the form of action, whether in contract or tort, including negligence.",
		Humor: 0.02, Formality: 0.97, Optimism: 0.35, Directness: 0.8, Warmth: 0.05},
	{Text: "All notices required or permitted under this Agreement shall be in writing and shall be deemed given when delivered personally, sent by certified mail (return receipt requested), or transmitted by electronic mail with confirmation of receipt.",
		Humor: 0.02, Formality: 0.96, Optimism: 0.5, Directness: 0.78, Warmth: 0.08},

	// ---- More cheerful service ----
	{Text: "Hi! Thanks so much for choosing Moosewave! 🎉 Your account is all set up and ready to go. If you have any questions or just want to say hi, my team and I are here. Have a great one!",
		Humor: 0.18, Formality: 0.45, Optimism: 0.95, Directness: 0.6, Warmth: 0.95},
	{Text: "Thanks for the patience while we looked into this! Good news — we've fixed the issue and you should be back up and running. Sorry again for the hiccup; please don't hesitate to reach out if anything else comes up. ❤️",
		Humor: 0.05, Formality: 0.55, Optimism: 0.88, Directness: 0.6, Warmth: 0.95},
	{Text: "Happy birthday from all of us at Moosewave! 🎂 Hope your day is full of good coffee, great writing, and exactly zero meetings. Cheers!",
		Humor: 0.65, Formality: 0.4, Optimism: 0.95, Directness: 0.55, Warmth: 0.95},
	{Text: "Just wanted to say a quick thank you for the lovely review you left us! It seriously means the world. The whole team gathered around to read it. Have an amazing week!",
		Humor: 0.1, Formality: 0.5, Optimism: 0.95, Directness: 0.5, Warmth: 0.97},

	// ---- More direct (imperatives) ----
	{Text: "Don't ship on Friday. Just don't. We've been over this. The on-call rotation is two people short, and the people who would page have already gone home. Wait until Monday.",
		Humor: 0.1, Formality: 0.3, Optimism: 0.4, Directness: 0.92, Warmth: 0.3},
	{Text: "Cut the meeting. Cancel the offsite. Kill the half-finished migration. Focus on the one thing that matters this quarter and ship it. Everything else is noise.",
		Humor: 0.08, Formality: 0.35, Optimism: 0.55, Directness: 0.95, Warmth: 0.2},
	{Text: "Always default to action. If you're not sure, ship the smaller version and learn. If you're still not sure after that, ship the smaller version of that.",
		Humor: 0.1, Formality: 0.4, Optimism: 0.7, Directness: 0.92, Warmth: 0.3},
	{Text: "Stop reorganizing. Stop renaming. Stop adding to the roadmap. Start finishing things. The unfinished work is killing us, not the unstarted work.",
		Humor: 0.1, Formality: 0.4, Optimism: 0.45, Directness: 0.95, Warmth: 0.2},

	// ---- More hedged ----
	{Text: "I'm not totally sure, but I think maybe we could try a slightly different approach? It might not work, and I could be wrong, but it sort of feels like the existing direction has hit a bit of a wall, in a way.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.4, Directness: 0.1, Warmth: 0.4},
	{Text: "Perhaps it would be worth considering whether, in some sense, this might possibly require a more careful examination than we've given it so far. Though I could be reading too much into it.",
		Humor: 0.05, Formality: 0.55, Optimism: 0.45, Directness: 0.1, Warmth: 0.3},
	{Text: "I guess I kind of feel like maybe we should sort of slow down and think about whether this is, you know, actually what we want to be doing right now. Just a thought though. Definitely open to other takes.",
		Humor: 0.05, Formality: 0.3, Optimism: 0.4, Directness: 0.1, Warmth: 0.45},
	{Text: "It seems like, in a way, more or less, the team might possibly be experiencing a bit of fatigue. I think. Possibly. I don't want to overstate it.",
		Humor: 0.05, Formality: 0.45, Optimism: 0.3, Directness: 0.1, Warmth: 0.35},

	// ---- More warmth examples ----
	{Text: "Hey friend, just wanted to check in. I know things have been a lot lately. I'm thinking of you, and whatever you need — coffee, a phone call, someone to vent to — I'm around. Take care of yourself.",
		Humor: 0.05, Formality: 0.3, Optimism: 0.55, Directness: 0.45, Warmth: 0.97},
	{Text: "Thanks for everything you did this year. I mean that. The team wouldn't be where it is without you, and I know it hasn't always been easy. Sending love and a quiet weekend.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.78, Directness: 0.45, Warmth: 0.95},
	{Text: "Welcome to the team!! We're SO excited to have you. Anything you need, anything at all, please just ask. Pinging me directly is totally fine. Hugs!",
		Humor: 0.25, Formality: 0.25, Optimism: 0.95, Directness: 0.55, Warmth: 0.97},
	{Text: "I just wanted to say thank you. For showing up, for caring, for being patient with me when I was being a bit of a mess. You're a good friend. The best, honestly.",
		Humor: 0.1, Formality: 0.3, Optimism: 0.75, Directness: 0.45, Warmth: 0.97},

	// ---- More cold examples ----
	{Text: "The user record was updated. The system processed the request. The customer should be notified per the standard procedure. The entity remains in the queue pending review.",
		Humor: 0.02, Formality: 0.7, Optimism: 0.5, Directness: 0.65, Warmth: 0.05},
	{Text: "Per attached. Regarding the matter below. Subject as noted above. The entity shall comply.",
		Humor: 0.02, Formality: 0.85, Optimism: 0.4, Directness: 0.7, Warmth: 0.04},
	{Text: "The customer's account has been suspended pending verification. The system has logged the event. The user will be notified via the standard automated channel.",
		Humor: 0.02, Formality: 0.78, Optimism: 0.3, Directness: 0.78, Warmth: 0.06},

	// ---- More optimistic ----
	{Text: "Things are going to work out. Not all at once, not perfectly, but they will. Every signal I'm watching is trending in the right direction. We're going to look back on this quarter and be proud.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.92, Directness: 0.65, Warmth: 0.55},
	{Text: "I love where this team is headed. The energy, the work, the trust we've built — it's all there. Whatever comes next, I'm excited to do it together.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.95, Directness: 0.55, Warmth: 0.85},
	{Text: "Best week we've had in months. Shipped two features, closed three bugs, and the support queue is at zero for the first time since spring. Onward!",
		Humor: 0.1, Formality: 0.35, Optimism: 0.95, Directness: 0.65, Warmth: 0.55},
	{Text: "What a great problem to have. Demand is outpacing what we can build, and the only blocker is hiring fast enough to keep up. We'll figure it out — we always do.",
		Humor: 0.15, Formality: 0.4, Optimism: 0.92, Directness: 0.6, Warmth: 0.5},

	// ---- More pessimistic ----
	{Text: "Every meeting feels heavier than the last. We keep adding deliverables and not adding people. It's not sustainable, and pretending it is will only make the eventual collapse louder.",
		Humor: 0.05, Formality: 0.5, Optimism: 0.1, Directness: 0.7, Warmth: 0.25},
	{Text: "I've been here before. The optimistic plan, the slipped quarter, the hard pivot, the layoff. We're following the same script, in the same order, with the same people who didn't read the last one.",
		Humor: 0.1, Formality: 0.45, Optimism: 0.08, Directness: 0.65, Warmth: 0.25},
	{Text: "There's no good news in the report. We're losing share in our top market, churn is climbing, and the new hire's first major project just slipped a month. I don't know what to tell the board.",
		Humor: 0.03, Formality: 0.55, Optimism: 0.05, Directness: 0.7, Warmth: 0.25},

	// ---- More mid-band / hard cases (intentionally mixed) ----
	{Text: "I'll be honest — the thing isn't working. Not in a fatal way, just in a 'we've been pretending it's fine for a quarter and it's not fine' way. We need to stop pretending, today.",
		Humor: 0.15, Formality: 0.3, Optimism: 0.3, Directness: 0.85, Warmth: 0.4},
	{Text: "I've been writing this email for an hour and I keep deleting it. The short version: I'm leaving. The long version is that I love you all, this has been the best job I've ever had, and I'm leaving anyway. I'll explain on Friday.",
		Humor: 0.15, Formality: 0.3, Optimism: 0.55, Directness: 0.7, Warmth: 0.78},
	{Text: "Honestly? Yeah, the launch went badly. We knew it might. We did it anyway because the alternative was waiting another quarter, and another quarter was worse than a botched launch. I'd do it again.",
		Humor: 0.1, Formality: 0.35, Optimism: 0.4, Directness: 0.78, Warmth: 0.45},
	{Text: "I think the thing nobody wants to say out loud is that the founder is the bottleneck now. He was the bottleneck two years ago in a different way, and it worked out. This time it's not going to.",
		Humor: 0.08, Formality: 0.45, Optimism: 0.18, Directness: 0.65, Warmth: 0.3},
	{Text: "The retro went exactly as well as I expected, which is to say, it didn't. Nobody wants to be the one to point at the obvious thing. So we'll have another retro next sprint and pretend the obvious thing didn't happen.",
		Humor: 0.4, Formality: 0.4, Optimism: 0.18, Directness: 0.55, Warmth: 0.3},
	{Text: "Look — I've thought about it. I know you have too. The honest answer is: I don't know. I have hunches, I have priors, and none of them are strong enough to bet on. Let's bet small and learn.",
		Humor: 0.1, Formality: 0.35, Optimism: 0.55, Directness: 0.55, Warmth: 0.55},
	{Text: "The product is good. Not 'venture-scale good,' which is what we keep telling investors, but actually good — the kind of good that small businesses pay for and renew. We should stop chasing the wrong story.",
		Humor: 0.1, Formality: 0.45, Optimism: 0.55, Directness: 0.78, Warmth: 0.3},

	// ---- Reviews / opinions ----
	{Text: "Honestly? It's fine. Not great, not bad. Does what it says on the tin. I wouldn't recommend it to a friend, but I wouldn't talk them out of it either. Three stars feels right.",
		Humor: 0.2, Formality: 0.3, Optimism: 0.45, Directness: 0.65, Warmth: 0.35},
	{Text: "I cannot recommend this product enough. Bought it for my mom last Christmas; she still tells me about it. The customer service is incredible — actual humans, in our timezone, who actually care. Five stars.",
		Humor: 0.1, Formality: 0.4, Optimism: 0.95, Directness: 0.7, Warmth: 0.85},
	{Text: "Terrible experience from start to finish. Order took three weeks, arrived broken, and customer service did not respond to any of my four emails. Avoid.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.05, Directness: 0.92, Warmth: 0.1},
	{Text: "I really wanted to love this. The website is gorgeous, the marketing is great, and the founder seems lovely. But the product itself just doesn't work for my use case. Returning it. Sorry.",
		Humor: 0.08, Formality: 0.45, Optimism: 0.3, Directness: 0.6, Warmth: 0.55},

	// ---- Job postings / professional ----
	{Text: "We're hiring a Senior Engineer to lead our infrastructure team. You'll own the reliability of our production stack, mentor a small team, and have a direct line to the CTO. Remote-friendly, generous PTO, real ownership.",
		Humor: 0.05, Formality: 0.55, Optimism: 0.78, Directness: 0.65, Warmth: 0.45},
	{Text: "Looking for a Designer who's allergic to cliches and obsessed with craft. We don't need a unicorn — just someone with strong opinions and the patience to defend them. Must love serif fonts.",
		Humor: 0.5, Formality: 0.4, Optimism: 0.7, Directness: 0.7, Warmth: 0.5},
	{Text: "The successful candidate will hold a Master's degree in a relevant field, possess at least seven years of post-graduate experience, and demonstrate a track record of leading cross-functional initiatives in a regulated environment.",
		Humor: 0.02, Formality: 0.85, Optimism: 0.55, Directness: 0.65, Warmth: 0.18},

	// ---- Personal essays / introspection ----
	{Text: "I used to think confidence was the absence of doubt. It's not. It's a willingness to act in the presence of doubt — to say 'I don't know if this is right, but here we go.' Doubt is the price of caring.",
		Humor: 0.1, Formality: 0.5, Optimism: 0.55, Directness: 0.55, Warmth: 0.55},
	{Text: "There's a moment, somewhere around year three of a long project, where you realize you've been wrong about something fundamental. Not catastrophically wrong — just wrong enough that the path forward is going to cost you a piece of who you thought you were. That's the moment.",
		Humor: 0.05, Formality: 0.55, Optimism: 0.4, Directness: 0.5, Warmth: 0.45},
	{Text: "My therapist says I've been outsourcing my self-worth to my job. I think she's right. I also think the job is partly what's keeping me afloat. So we'll work on it. Slowly. With many small detours.",
		Humor: 0.25, Formality: 0.4, Optimism: 0.45, Directness: 0.55, Warmth: 0.6},

	// ---- Crisp short-form / micro-posts ----
	{Text: "Hot take: most software is too big. The features added after Year 3 mostly serve the org chart, not the user.",
		Humor: 0.3, Formality: 0.4, Optimism: 0.4, Directness: 0.78, Warmth: 0.25},
	{Text: "If you keep deferring the hard conversation, the hard conversation will eventually happen anyway, with worse stakes and worse seating.",
		Humor: 0.25, Formality: 0.45, Optimism: 0.45, Directness: 0.78, Warmth: 0.35},
	{Text: "Underrated skill: being the person in the meeting who says 'I don't understand — can someone walk me through it?' Saves everyone an hour.",
		Humor: 0.4, Formality: 0.4, Optimism: 0.65, Directness: 0.65, Warmth: 0.55},
	{Text: "Working a lot doesn't make you good. Working on the right thing makes you good. Working a lot on the wrong thing makes you tired.",
		Humor: 0.2, Formality: 0.4, Optimism: 0.5, Directness: 0.78, Warmth: 0.35},
	{Text: "Money problem? Probably a sales problem. Sales problem? Probably a product problem. Product problem? Probably you haven't talked to a customer this month.",
		Humor: 0.3, Formality: 0.4, Optimism: 0.5, Directness: 0.85, Warmth: 0.3},

	// ---- News / journalistic ----
	{Text: "Investigators say the breach was first detected on Monday morning, when an automated alert flagged unusual outbound traffic from a payroll database. The company has since hired an outside firm to assist with the inquiry.",
		Humor: 0.02, Formality: 0.78, Optimism: 0.25, Directness: 0.7, Warmth: 0.1},
	{Text: "The conference, held annually in Geneva, drew approximately 4,000 delegates from 73 countries. Organizers said registration this year exceeded their expectations by nearly twenty percent.",
		Humor: 0.02, Formality: 0.78, Optimism: 0.65, Directness: 0.6, Warmth: 0.2},
	{Text: "After three days of testimony, the committee adjourned without reaching a conclusion. A spokesperson said deliberations would resume next week, though the precise schedule has not been made public.",
		Humor: 0.02, Formality: 0.82, Optimism: 0.4, Directness: 0.6, Warmth: 0.1},

	// ---- More slack/casual ----
	{Text: "lmaooo classic. ok ok one more time, with feeling",
		Humor: 0.85, Formality: 0.05, Optimism: 0.65, Directness: 0.55, Warmth: 0.5},
	{Text: "ohhhhh I see, ok that makes way more sense. thx!",
		Humor: 0.15, Formality: 0.06, Optimism: 0.78, Directness: 0.55, Warmth: 0.7},
	{Text: "kinda dying at this. why is it like this",
		Humor: 0.7, Formality: 0.05, Optimism: 0.18, Directness: 0.5, Warmth: 0.35},
	{Text: "be back in 5, getting tea",
		Humor: 0.1, Formality: 0.05, Optimism: 0.55, Directness: 0.65, Warmth: 0.45},

	// ---- More sarcasm / dry ----
	{Text: "So apparently 'we'll iterate' means 'we will not, in fact, iterate, but we will use the word in every all-hands until further notice.' Got it. Updating my dictionary now.",
		Humor: 0.5, Formality: 0.4, Optimism: 0.2, Directness: 0.7, Warmth: 0.22},
	{Text: "Ah, the quarterly 'we are committed to transparency' email. Always a delight. Almost as transparent as the org chart, which has apparently been a state secret since Q2.",
		Humor: 0.5, Formality: 0.45, Optimism: 0.2, Directness: 0.7, Warmth: 0.22},
	{Text: "Truly nothing more grounding than a 9 AM 'urgent' meeting that gets rescheduled at 8:55 to 4 PM, then rescheduled again to next Tuesday, then quietly deleted.",
		Humor: 0.5, Formality: 0.4, Optimism: 0.22, Directness: 0.6, Warmth: 0.22},

	// ---- Apology / customer-facing ----
	{Text: "We're truly sorry. The outage today affected a significant portion of our customers, and we know that broke trust we've worked hard to build. We owe you a full root-cause analysis, and you'll have it by end of day Friday. In the meantime, we've issued a credit to all affected accounts. Thank you for your patience — and for your honesty when we fall short.",
		Humor: 0.04, Formality: 0.65, Optimism: 0.45, Directness: 0.65, Warmth: 0.78},
	{Text: "I owe you an apology. I dropped the ball on the review. There's no good excuse. I'll have feedback to you by tomorrow morning, and I'll set up a recurring slot so it doesn't happen again. Sorry — for real.",
		Humor: 0.04, Formality: 0.4, Optimism: 0.45, Directness: 0.7, Warmth: 0.7},

	// ---- Persuasive / advocacy ----
	{Text: "We can keep doing what we're doing, or we can do something better. The cost of doing nothing isn't zero — it's the slow, quiet erosion of everything we've built. Let's choose the harder thing. Let's choose now.",
		Humor: 0.05, Formality: 0.5, Optimism: 0.65, Directness: 0.78, Warmth: 0.55},
	{Text: "I'm not asking for a parade. I'm asking for the bare minimum: that we ship a product we'd be proud to use ourselves. We're not there. Let's get there.",
		Humor: 0.1, Formality: 0.4, Optimism: 0.55, Directness: 0.85, Warmth: 0.4},

	// ---- Recipe / instructional ----
	{Text: "Bring a large pot of salted water to a rolling boil. Add the pasta. Stir once, set a timer, walk away. Do not, under any circumstances, peek at the timer. The pasta knows what it's doing.",
		Humor: 0.5, Formality: 0.45, Optimism: 0.6, Directness: 0.85, Warmth: 0.5},
	{Text: "Whisk the eggs with a pinch of salt until uniformly yellow. Heat the pan over medium-low — patience here matters. Add a knob of butter; let it foam, not brown. Pour in the eggs.",
		Humor: 0.05, Formality: 0.55, Optimism: 0.65, Directness: 0.85, Warmth: 0.4},

	// ---- Travel / lifestyle ----
	{Text: "Lisbon in May is exactly as good as everyone says. The hills are real, the pastel de nata is realer, and the trams are charmingly unsafe. Bring shoes you don't mind ruining. Bring an appetite.",
		Humor: 0.5, Formality: 0.35, Optimism: 0.85, Directness: 0.55, Warmth: 0.7},
	{Text: "Don't go to Bali in January. Or do, but bring a poncho and abandon all hope of a hike. The rice paddies are beautiful in any weather. Everything else gets dicey.",
		Humor: 0.4, Formality: 0.35, Optimism: 0.45, Directness: 0.78, Warmth: 0.5},

	// ---- Final fillers — varied mid-band ----
	{Text: "The plan is fine. It's not great, but it's fine, and 'fine' ships. Let's commit and move on.",
		Humor: 0.15, Formality: 0.3, Optimism: 0.45, Directness: 0.78, Warmth: 0.35},
	{Text: "Reviewed the doc. A few thoughts inline. Big picture I think we're 80% there — the last 20% is mostly tightening the framing in section 2 and cutting half of section 4.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.6, Directness: 0.7, Warmth: 0.45},
	{Text: "Got the test results back. Mostly good. One yellow flag we should keep an eye on. Nothing urgent, just worth a follow-up at the next visit.",
		Humor: 0.05, Formality: 0.45, Optimism: 0.55, Directness: 0.7, Warmth: 0.55},
	{Text: "The new branding looks great in the deck. I am, however, slightly worried that 'great in the deck' and 'great in the wild' are two different things. Let's mock up a real screen before we ship.",
		Humor: 0.45, Formality: 0.4, Optimism: 0.55, Directness: 0.65, Warmth: 0.45},
	{Text: "Numbers are flat this month. Not bad, not great. The dashboard will look like a ruler when we put it in front of the board. Let's prepare a story that explains why flat is not boring.",
		Humor: 0.4, Formality: 0.4, Optimism: 0.45, Directness: 0.7, Warmth: 0.4},
	{Text: "Sleep is the best feature I never paid for. Eight hours and suddenly the bug is obvious, the email is easy to write, and the reorg I was dreading sounds, frankly, like a fine idea.",
		Humor: 0.55, Formality: 0.4, Optimism: 0.78, Directness: 0.55, Warmth: 0.5},
	{Text: "Coffee at 4 PM is a deal with the devil. The devil is reliable. He always pays. The price is at 1:30 AM, and the price is exactly what you think it is.",
		Humor: 0.55, Formality: 0.4, Optimism: 0.4, Directness: 0.6, Warmth: 0.4},
	{Text: "The meeting could've been an email. The email could've been a thread. The thread could've been a doc. The doc could've been a single sentence at the top of someone else's already-existing doc.",
		Humor: 0.45, Formality: 0.4, Optimism: 0.35, Directness: 0.7, Warmth: 0.3},
	{Text: "Best advice I ever got: nobody knows what they're doing, and that's fine, as long as you're not the only one in the room pretending you do.",
		Humor: 0.45, Formality: 0.4, Optimism: 0.65, Directness: 0.65, Warmth: 0.55},
	{Text: "Let's pause. Let's actually pause — not 'pause for an hour and reconvene with the same energy,' but pause until the right person has time to think about it properly. Today doesn't need to be the day.",
		Humor: 0.1, Formality: 0.4, Optimism: 0.55, Directness: 0.7, Warmth: 0.5},
	{Text: "Reasonable disagreement is a feature, not a bug. The team that always agrees with the loudest voice in the room is exactly as good as that voice. Which, statistically, is not very.",
		Humor: 0.4, Formality: 0.45, Optimism: 0.5, Directness: 0.7, Warmth: 0.4},
	{Text: "Pricing is a story, not a calculation. The story has to make sense to the person paying. If they have to do math to understand it, the story is wrong, even if the math is right.",
		Humor: 0.15, Formality: 0.45, Optimism: 0.55, Directness: 0.7, Warmth: 0.4},
	{Text: "I'm proud of the team this quarter. Not 'all-hands-celebration' proud, just quietly proud — the kind that comes from watching people do the unglamorous work of holding a system together.",
		Humor: 0.05, Formality: 0.45, Optimism: 0.7, Directness: 0.55, Warmth: 0.78},
	{Text: "Honestly the most valuable thing in this company is the slack channel where engineers complain about deploys. Better signal than any retro, faster turnaround than any survey, and free.",
		Humor: 0.6, Formality: 0.35, Optimism: 0.55, Directness: 0.65, Warmth: 0.4},
	{Text: "Six months in and I still don't fully understand how billing works. I have asked four people. I have read three docs. I am told this is normal. I am told there is a wiki page that does not exist.",
		Humor: 0.55, Formality: 0.4, Optimism: 0.3, Directness: 0.55, Warmth: 0.4},
	{Text: "The most expensive lesson of my career was thinking I could outwork a bad strategy. I couldn't. The strategy was wrong, and working harder just got me to the wrong place faster.",
		Humor: 0.1, Formality: 0.45, Optimism: 0.4, Directness: 0.7, Warmth: 0.45},
	{Text: "Keep a list of the things you've changed your mind about. Update it monthly. The list is the closest thing you have to a calibrated track record on yourself.",
		Humor: 0.1, Formality: 0.45, Optimism: 0.6, Directness: 0.78, Warmth: 0.4},
	{Text: "I am, statistically, the dumbest engineer in any room I walk into. This has been true for fifteen years. It will be true for fifteen more. The trick is to keep walking into the rooms.",
		Humor: 0.5, Formality: 0.4, Optimism: 0.65, Directness: 0.65, Warmth: 0.5},
	{Text: "The intern asked me what advice I'd give my younger self. I told her: write more, code less, and call your mother. She said two out of three. I told her: better than I managed.",
		Humor: 0.65, Formality: 0.4, Optimism: 0.65, Directness: 0.5, Warmth: 0.7},
	{Text: "Conviction is a finite resource. Spend it on the bets you'd be embarrassed not to have made. Save it for the meetings where everyone else has already given up.",
		Humor: 0.1, Formality: 0.5, Optimism: 0.55, Directness: 0.7, Warmth: 0.4},

	// ---- A few more dedicated low-axis examples to balance coverage ----
	{Text: "dunno, maybe? might work, kind of",
		Humor: 0.05, Formality: 0.06, Optimism: 0.4, Directness: 0.08, Warmth: 0.35},
	{Text: "no",
		Humor: 0.05, Formality: 0.1, Optimism: 0.3, Directness: 0.92, Warmth: 0.18},
	{Text: "yes",
		Humor: 0.05, Formality: 0.1, Optimism: 0.65, Directness: 0.92, Warmth: 0.35},
	{Text: "Status: failed. Owner: unassigned. ETA: unknown. Blocker: dependency unresolved. Action: escalate per protocol.",
		Humor: 0.02, Formality: 0.7, Optimism: 0.08, Directness: 0.85, Warmth: 0.04},
	{Text: "The outage continues. Root cause unknown. Mitigation in progress. Customer impact: severe. Updates every fifteen minutes until resolution.",
		Humor: 0.02, Formality: 0.7, Optimism: 0.1, Directness: 0.92, Warmth: 0.06},
	{Text: "I appreciate you so much. Thank you for everything. Truly grateful, friend. ❤️",
		Humor: 0.05, Formality: 0.2, Optimism: 0.92, Directness: 0.5, Warmth: 0.97},
	{Text: "Sending hugs and warm thoughts your way today. You're going to do great. We're all rooting for you.",
		Humor: 0.05, Formality: 0.2, Optimism: 0.92, Directness: 0.55, Warmth: 0.97},
	{Text: "JOKE OF THE DAY: my code. tip your waitress, try the fish, I'll be here all week",
		Humor: 0.97, Formality: 0.1, Optimism: 0.55, Directness: 0.65, Warmth: 0.4},
	{Text: "haha haha haha h a h a. anyway",
		Humor: 0.85, Formality: 0.05, Optimism: 0.4, Directness: 0.55, Warmth: 0.3},
	{Text: "lol lol lol omg STOP I'm crying 😂😂😂",
		Humor: 0.97, Formality: 0.04, Optimism: 0.78, Directness: 0.55, Warmth: 0.55},
	{Text: "I have, against my better judgment, opened the spreadsheet. The spreadsheet has 47 tabs. I will see you on the other side.",
		Humor: 0.78, Formality: 0.4, Optimism: 0.3, Directness: 0.55, Warmth: 0.45},
	{Text: "The aforementioned shall hereinafter be referred to as 'the cat,' notwithstanding the fact that the cat does not, in any meaningful sense, agree to this designation.",
		Humor: 0.85, Formality: 0.85, Optimism: 0.55, Directness: 0.55, Warmth: 0.4},
	{Text: "Prognosis is unfavorable. The team should prepare for an extended period of degraded performance. Recovery, while possible, is not assured within the operative timeline.",
		Humor: 0.02, Formality: 0.85, Optimism: 0.1, Directness: 0.78, Warmth: 0.08},
	{Text: "Hey hey hey!! Long time no chat. Hope you're doing amazing. Coffee soon? Like soon-soon?",
		Humor: 0.3, Formality: 0.06, Optimism: 0.92, Directness: 0.55, Warmth: 0.92},
	{Text: "Get out. Now. I'm not kidding. Take the laptop, leave the rest. We'll figure out the rest later.",
		Humor: 0.05, Formality: 0.2, Optimism: 0.2, Directness: 0.97, Warmth: 0.4},
	{Text: "Friends, the moment has arrived. Years of work, weeks of polish, and a lot of late-night Slack threads — we are live. Thank you, all of you. Onward together.",
		Humor: 0.1, Formality: 0.4, Optimism: 0.95, Directness: 0.55, Warmth: 0.92},
	{Text: "The endpoint returns 503 under load above 200 RPS. Scaling horizontally does not help; the bottleneck is the shared cache. Investigate before next launch.",
		Humor: 0.03, Formality: 0.6, Optimism: 0.25, Directness: 0.92, Warmth: 0.1},
	{Text: "Honestly idk maybe? could be cool. or terrible. one of those. you know me.",
		Humor: 0.4, Formality: 0.05, Optimism: 0.4, Directness: 0.1, Warmth: 0.45},
	{Text: "Per our prior correspondence, kindly find attached the requested documentation. Should you require additional materials, please do not hesitate to reach out.",
		Humor: 0.02, Formality: 0.92, Optimism: 0.55, Directness: 0.55, Warmth: 0.25},
	{Text: "Hi! Hope you're well 🌸 Just circling back on the question I sent last week — totally no pressure, but figured I'd give a gentle nudge!",
		Humor: 0.15, Formality: 0.4, Optimism: 0.75, Directness: 0.4, Warmth: 0.85},
	{Text: "My condolences. There are no words that can make this easier; please know that you are loved, and that we're here when you're ready.",
		Humor: 0.02, Formality: 0.55, Optimism: 0.35, Directness: 0.5, Warmth: 0.92},

	// ---- Augmentation: more clearly-humorous samples to help fit the
	// humor axis (the unaugmented corpus skewed low-humor heavily, which
	// pulled down the MAE on the high tail). Also a handful of cleanly
	// optimistic + cleanly pessimistic single-axis samples to anchor the
	// optimism head.

	{Text: "haha haha I just spit out my coffee. that meme is unholy. please post more.",
		Humor: 0.93, Formality: 0.05, Optimism: 0.65, Directness: 0.55, Warmth: 0.55},
	{Text: "Lmao no way. NO WAY. nobody is going to believe this story. send the screenshot, I beg you.",
		Humor: 0.92, Formality: 0.05, Optimism: 0.55, Directness: 0.6, Warmth: 0.45},
	{Text: "ok this is hilarious. genuinely the funniest thing I've read all week. punchline straight to the brain.",
		Humor: 0.95, Formality: 0.05, Optimism: 0.78, Directness: 0.55, Warmth: 0.5},
	{Text: "yikes!! lol whoops. ok ok ok joking aside, that was actually a great pitch. funniest slide deck I've ever seen.",
		Humor: 0.88, Formality: 0.1, Optimism: 0.7, Directness: 0.55, Warmth: 0.55},
	{Text: "I told the joke. it landed. one out of one. retiring on top.",
		Humor: 0.88, Formality: 0.1, Optimism: 0.78, Directness: 0.65, Warmth: 0.4},
	{Text: "rofl no the punchline is that the bug fixed itself. kidding. partly. mostly.",
		Humor: 0.92, Formality: 0.05, Optimism: 0.55, Directness: 0.55, Warmth: 0.4},
	{Text: "haha that's so silly. ridiculous in the best way. goofy energy all around.",
		Humor: 0.9, Formality: 0.1, Optimism: 0.78, Directness: 0.5, Warmth: 0.6},
	{Text: "lmao the punchline. THE PUNCHLINE. I'm sending this to everyone, sorry not sorry.",
		Humor: 0.95, Formality: 0.05, Optimism: 0.65, Directness: 0.55, Warmth: 0.5},
	{Text: "absurd. completely absurd. lol. lol lol. ok it's actually pretty funny once you say it out loud.",
		Humor: 0.88, Formality: 0.1, Optimism: 0.6, Directness: 0.5, Warmth: 0.4},
	{Text: "haha you're joking right? you're joking. please tell me you're joking. ok no this is hilarious.",
		Humor: 0.9, Formality: 0.05, Optimism: 0.55, Directness: 0.55, Warmth: 0.45},

	// Anchored cleanly optimistic — minimal cross-axis confounds.
	{Text: "Things are looking up. Every signal is positive, the team is energized, and the trajectory is exactly where we hoped. Excited about what's next.",
		Humor: 0.05, Formality: 0.45, Optimism: 0.93, Directness: 0.65, Warmth: 0.45},
	{Text: "Wonderful news today! The deal closed, the customer is delighted, and the contract terms are better than we dared to hope for.",
		Humor: 0.05, Formality: 0.5, Optimism: 0.95, Directness: 0.65, Warmth: 0.5},
	{Text: "Genuinely happy with how the quarter is shaping up. Wins everywhere, the metrics are beautiful, and the team is glad we made the bet.",
		Humor: 0.08, Formality: 0.4, Optimism: 0.92, Directness: 0.65, Warmth: 0.45},
	{Text: "Hopeful about the path ahead. The signals are promising and the team is winning. Optimistic — probably more so than I've been in a year.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.92, Directness: 0.65, Warmth: 0.4},
	{Text: "Excellent quarter. Brilliant execution. The product is succeeding on every metric we care about, and customers are thrilled. Best stretch of my career.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.97, Directness: 0.7, Warmth: 0.5},

	// Anchored cleanly pessimistic — minimal cross-axis confounds.
	{Text: "Bad. Worse than last week, worse than last month. Failure mode after failure mode and nothing is improving. Frustrated, worried, and out of patience.",
		Humor: 0.05, Formality: 0.4, Optimism: 0.05, Directness: 0.85, Warmth: 0.15},
	{Text: "Terrible numbers. Awful trajectory. The launch was a failure, the rollback was botched, and the team is exhausted. Risks compounding daily.",
		Humor: 0.04, Formality: 0.5, Optimism: 0.05, Directness: 0.85, Warmth: 0.12},
	{Text: "Disappointed. Frustrated. Worried. The product is broken, customers are angry, and every fix introduces a new problem. We are struggling.",
		Humor: 0.04, Formality: 0.45, Optimism: 0.05, Directness: 0.7, Warmth: 0.18},
	{Text: "Concerned. Concerned about the runway, concerned about churn, concerned about morale. None of these concerns are new, none have improved, and the risks keep mounting.",
		Humor: 0.04, Formality: 0.55, Optimism: 0.05, Directness: 0.7, Warmth: 0.15},
	{Text: "Wrong call. Bad outcome. Worst quarter in my tenure. The numbers are terrible and the explanations are getting worse. We need to do better, and I don't know how.",
		Humor: 0.04, Formality: 0.45, Optimism: 0.05, Directness: 0.78, Warmth: 0.2},

	// ---- Augmentation: a few more high-formality anchors to firm up
	// the formality-axis coverage floor (>=40 high-band).
	{Text: "Pursuant to the foregoing analysis, the Committee respectfully recommends that the proposed amendment be adopted in its entirety, subject to such modifications as may be required by ongoing regulatory consultation. We hereby acknowledge the diligent contributions of the working group.",
		Humor: 0.02, Formality: 0.95, Optimism: 0.55, Directness: 0.6, Warmth: 0.12},
	{Text: "Moreover, the empirical evidence presented herein, when considered in conjunction with the theoretical framework established in Section II, supports the conclusion that the observed phenomenon is causally rather than merely correlationally related to the hypothesized antecedent variables.",
		Humor: 0.02, Formality: 0.96, Optimism: 0.5, Directness: 0.55, Warmth: 0.1},
	{Text: "The Court holds that the doctrine of qualified immunity, as articulated in the relevant precedent, shields the defendant from liability under the circumstances presented. The plaintiff's contrary arguments, while not without rhetorical force, are unavailing as a matter of law.",
		Humor: 0.02, Formality: 0.95, Optimism: 0.4, Directness: 0.7, Warmth: 0.08},
	{Text: "We respectfully submit that the Department's interpretation of the statute is inconsistent with both its plain language and its legislative history. Accordingly, we urge the Court to vacate the agency's determination and remand the matter for further proceedings consistent with this opinion.",
		Humor: 0.02, Formality: 0.95, Optimism: 0.45, Directness: 0.7, Warmth: 0.08},
}
