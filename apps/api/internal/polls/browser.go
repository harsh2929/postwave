// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"bytes"
	"errors"
	"html/template"
	"net/http"
	"strconv"
	"strings"
)

// pollPageData is deliberately presentation-only. In particular, it has no
// tenant, email address, poll id, or absolute URL fields. The form action
// contains only the already-held opaque recipient reference and option token as
// a relative query; the short-lived, one-time confirmation challenge is kept in
// the POST body instead of reflected into a URL.
type pollPageData struct {
	Title             string
	Eyebrow           string
	Heading           string
	Message           string
	Detail            string
	Question          string
	OptionLabel       string
	FormAction        string
	ConfirmationToken string
	ButtonLabel       string
	Footnote          string
	Tone              string
	Role              string
	ShowForm          bool
}

const pollPageHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>{{.Title}}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f3f6fb;
      --panel: #ffffff;
      --text: #172033;
      --muted: #5c667a;
      --line: #dce3ef;
      --accent: #3159d8;
      --accent-hover: #2448bd;
      --focus: #ffbf47;
      --success: #157347;
      --warning: #9a5a00;
      --danger: #b42318;
      --shadow: 0 24px 70px rgba(23, 32, 51, .13);
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(circle at 20% 10%, rgba(49, 89, 216, .12), transparent 34rem),
        var(--bg);
      color: var(--text);
      font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(100%, 620px);
      padding: clamp(28px, 6vw, 52px);
      border: 1px solid var(--line);
      border-radius: 24px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .mark {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 34px;
      color: var(--muted);
      font-size: .85rem;
      font-weight: 700;
      letter-spacing: .04em;
    }
    .mark::before {
      width: 12px;
      height: 12px;
      border-radius: 4px;
      background: var(--accent);
      content: "";
      transform: rotate(12deg);
    }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--accent);
      font-size: .78rem;
      font-weight: 800;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: clamp(2rem, 7vw, 3.25rem);
      line-height: 1.06;
      letter-spacing: -.04em;
    }
    .lede { margin: 18px 0 0; color: var(--muted); font-size: 1.05rem; }
    .detail { margin: 18px 0 0; color: var(--muted); }
    .selection {
      margin: 30px 0;
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: color-mix(in srgb, var(--panel) 88%, var(--accent) 12%);
    }
    .question { margin: 0 0 14px; font-weight: 650; }
    .choice-label {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: .78rem;
      font-weight: 750;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .choice { font-size: 1.22rem; }
    form { margin-top: 28px; }
    button {
      width: 100%;
      min-height: 52px;
      border: 0;
      border-radius: 12px;
      padding: 13px 20px;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-weight: 750;
      transition: background-color .15s ease, transform .15s ease;
    }
    button:hover { background: var(--accent-hover); }
    button:active { transform: translateY(1px); }
    button:focus-visible { outline: 4px solid var(--focus); outline-offset: 3px; }
    .footnote {
      margin: 16px 0 0;
      color: var(--muted);
      font-size: .88rem;
    }
    .result {
      width: 48px;
      height: 48px;
      margin-bottom: 24px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: color-mix(in srgb, currentColor 12%, transparent);
      color: var(--success);
      font-size: 1.55rem;
      font-weight: 850;
    }
    .warning .result { color: var(--warning); }
    .error .result { color: var(--danger); }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0e1421;
        --panel: #171f2e;
        --text: #edf2fb;
        --muted: #adb8ca;
        --line: #303c50;
        --accent: #8ca7ff;
        --accent-hover: #7796fa;
        --shadow: 0 24px 70px rgba(0, 0, 0, .38);
      }
      button { color: #0b1530; }
    }
    @media (prefers-reduced-motion: reduce) {
      button { transition: none; }
    }
  </style>
</head>
<body>
  <main class="{{.Tone}}" aria-labelledby="page-title">
    <div class="mark" aria-label="Moosewave">POSTWAVE</div>
    <div class="copy"{{if .Role}} role="{{.Role}}" aria-live="polite"{{end}}>
      {{if not .ShowForm}}<div class="result" aria-hidden="true">{{if eq .Tone "success"}}✓{{else}}!{{end}}</div>{{end}}
      <p class="eyebrow">{{.Eyebrow}}</p>
      <h1 id="page-title">{{.Heading}}</h1>
      <p class="lede">{{.Message}}</p>
      {{if .Detail}}<p class="detail">{{.Detail}}</p>{{end}}
    </div>
    {{if .ShowForm}}
      <section class="selection" aria-label="Response to confirm">
        <p class="question">{{.Question}}</p>
        <span class="choice-label">Selected response</span>
        <strong class="choice">{{.OptionLabel}}</strong>
      </section>
      <form method="post" action="{{.FormAction}}" autocomplete="off">
        {{if .ConfirmationToken}}<input type="hidden" name="c" value="{{.ConfirmationToken}}">{{end}}
        <button type="submit">{{.ButtonLabel}}</button>
      </form>
    {{end}}
    {{if .Footnote}}<p class="footnote">{{.Footnote}}</p>{{end}}
  </main>
</body>
</html>`

var pollPageTemplate = template.Must(template.New("poll-confirmation").Parse(pollPageHTML))

func writePollPage(w http.ResponseWriter, status int, page pollPageData) {
	var rendered bytes.Buffer
	if err := pollPageTemplate.Execute(&rendered, page); err != nil {
		http.Error(w, "Unable to render this page.", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = rendered.WriteTo(w)
}

// pollWantsHTML chooses HTML only when the client actually prefers it. Empty
// and wildcard-only Accept values keep the long-standing JSON response, while a
// normal browser header (explicit text/html plus a lower-quality wildcard)
// receives the confirmation page.
func pollWantsHTML(accept string) bool {
	ranges := parsePollAccept(accept)
	if len(ranges) == 0 {
		return false
	}
	htmlMatch := bestPollAcceptMatch(ranges, "text", "html")
	jsonMatch := bestPollAcceptMatch(ranges, "application", "json")
	if !htmlMatch.matched || htmlMatch.quality <= 0 {
		return false
	}
	if !jsonMatch.matched || jsonMatch.quality <= 0 {
		return true
	}
	if htmlMatch.quality != jsonMatch.quality {
		return htmlMatch.quality > jsonMatch.quality
	}
	if htmlMatch.specificity != jsonMatch.specificity {
		return htmlMatch.specificity > jsonMatch.specificity
	}
	// Preserve sender order for equally acceptable, equally specific formats.
	// A wildcard matches both at the same position and therefore falls through
	// to JSON, preserving the existing API default.
	return htmlMatch.order < jsonMatch.order
}

type pollAcceptRange struct {
	typeName string
	subtype  string
	quality  float64
	order    int
}

type pollAcceptMatch struct {
	quality     float64
	specificity int
	order       int
	matched     bool
}

func parsePollAccept(raw string) []pollAcceptRange {
	var ranges []pollAcceptRange
	for order, item := range strings.Split(strings.ToLower(raw), ",") {
		parts := strings.Split(item, ";")
		mediaType := strings.TrimSpace(parts[0])
		typeParts := strings.Split(mediaType, "/")
		if len(typeParts) != 2 || strings.TrimSpace(typeParts[0]) == "" ||
			strings.TrimSpace(typeParts[1]) == "" {
			continue
		}
		quality := 1.0
		valid := true
		for _, parameter := range parts[1:] {
			nameValue := strings.SplitN(strings.TrimSpace(parameter), "=", 2)
			if len(nameValue) != 2 || strings.TrimSpace(nameValue[0]) != "q" {
				continue
			}
			parsed, err := strconv.ParseFloat(strings.Trim(strings.TrimSpace(nameValue[1]), `"`), 64)
			if err != nil || parsed < 0 || parsed > 1 {
				valid = false
				break
			}
			quality = parsed
		}
		if !valid {
			continue
		}
		ranges = append(ranges, pollAcceptRange{
			typeName: strings.TrimSpace(typeParts[0]),
			subtype:  strings.TrimSpace(typeParts[1]),
			quality:  quality,
			order:    order,
		})
	}
	return ranges
}

func bestPollAcceptMatch(ranges []pollAcceptRange, offeredType, offeredSubtype string) pollAcceptMatch {
	best := pollAcceptMatch{specificity: -1}
	for _, candidate := range ranges {
		specificity := -1
		switch {
		case candidate.typeName == offeredType && candidate.subtype == offeredSubtype:
			specificity = 2
		case candidate.typeName == offeredType && candidate.subtype == "*":
			specificity = 1
		case candidate.typeName == "*" && candidate.subtype == "*":
			specificity = 0
		}
		if specificity < 0 {
			continue
		}
		if !best.matched || specificity > best.specificity ||
			(specificity == best.specificity && candidate.quality > best.quality) {
			best = pollAcceptMatch{
				quality: candidate.quality, specificity: specificity,
				order: candidate.order, matched: true,
			}
		}
	}
	return best
}

func confirmationResultPage(result *ConfirmResult) pollPageData {
	page := pollPageData{
		Title:   "Response received · Moosewave",
		Eyebrow: "Poll response",
		Heading: "Response received",
		Message: "Your confirmation was received.",
		Tone:    "warning",
		Role:    "status",
	}
	if result == nil {
		page.Detail = "The response could not be included in the poll totals."
		return page
	}
	switch result.State {
	case StateCounted:
		page.Title = "Response confirmed · Moosewave"
		page.Heading = "Response confirmed"
		page.Message = "Your response has been counted."
		page.Detail = "You can close this page."
		page.Tone = "success"
	case StateMachineExcluded:
		page.Message = "This confirmation was classified as automated."
		page.Detail = "It was recorded as evidence, but it was not included in the poll totals."
	case StateUnclassifiedExcluded:
		page.Message = "We could not verify this confirmation as human activity."
		page.Detail = "It was recorded as evidence, but it was not included in the poll totals."
	case StateVoidedMultiOption:
		page.Title = "Responses not counted · Moosewave"
		page.Heading = "Responses not counted"
		page.Message = "Multiple options were confirmed close together."
		page.Detail = "To protect this poll from automated link scanning, none of those responses were included in the totals."
	case StateSupersededChoice:
		page.Title = "Response replaced · Moosewave"
		page.Heading = "This response was replaced"
		page.Message = "A later option is now your current response."
		page.Detail = "This older confirmation remains in the audit history but is not included in the totals."
	default:
		page.Detail = "The response was recorded, but it could not be included in the poll totals."
	}
	if result.Replayed {
		page.Footnote = "This exact confirmation was already recorded. No additional response was created."
	}
	return page
}

func publicPollErrorPage(err error) (int, pollPageData) {
	page := pollPageData{
		Title:   "Response unavailable · Moosewave",
		Eyebrow: "Poll response",
		Heading: "Response unavailable",
		Message: "We could not confirm this response.",
		Tone:    "error",
		Role:    "alert",
	}
	switch {
	case errors.Is(err, ErrUnknownToken), errors.Is(err, ErrNotFound):
		page.Title = "Invalid response link · Moosewave"
		page.Heading = "This response link is invalid"
		page.Message = "The link may be incomplete or no longer valid."
		page.Detail = "Return to the original email and choose an option again."
		return http.StatusNotFound, page
	case errors.Is(err, ErrPollClosed):
		page.Title = "Poll closed · Moosewave"
		page.Heading = "This poll has closed"
		page.Message = "Responses are no longer being accepted."
		return http.StatusGone, page
	case errors.Is(err, ErrConfirmationRequired):
		// A missing, expired, and consumed challenge are intentionally
		// indistinguishable at this public bearer boundary. This message is true
		// for all three and does not turn the endpoint into a token oracle.
		page.Title = "Confirmation unavailable · Moosewave"
		page.Heading = "This confirmation has expired or was already used"
		page.Message = "No additional response was recorded."
		page.Detail = "Return to the original email, choose the option again, and use the new confirmation page."
		return http.StatusPreconditionRequired, page
	case errors.Is(err, ErrInvalidInput):
		page.Heading = "We could not read this confirmation"
		page.Message = "No response was recorded."
		page.Detail = "Return to the original email and try again."
		return http.StatusBadRequest, page
	case errors.Is(err, ErrConflict):
		page.Message = "This response can no longer be accepted in its current form."
		page.Detail = "Return to the original email and try again."
		return http.StatusConflict, page
	default:
		page.Title = "Something went wrong · Moosewave"
		page.Heading = "Something went wrong"
		page.Message = "No response was recorded."
		page.Detail = "Please wait a moment and try again from the original email."
		return http.StatusInternalServerError, page
	}
}
