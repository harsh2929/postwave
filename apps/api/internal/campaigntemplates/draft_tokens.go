// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"regexp"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/unsubscribetoken"
)

// A `{{ name }}` merge tag in a template means one of four different things,
// and only one of them may be replaced when a campaign draft is created.
//
// Before this distinction existed, CreateCampaignFromTemplate replaced every
// tag that had a declared default. A draft from a built-in design therefore
// greeted every recipient as "Friend", named Moosewave as the sender's product,
// asked people to reply to creator@example.invalid, and replaced the
// per-recipient unsubscribe placeholder with https://moosewave.com/unsubscribe —
// a domain the sender does not control — so no recipient could unsubscribe.
const (
	// VariableRoleContent is ordinary template copy (a headline, a date, a
	// call-to-action URL). The caller's value, else the template's declared
	// default, is written into the draft.
	VariableRoleContent = "content"
	// VariableRoleSubscriber is resolved separately for each recipient when
	// the email is rendered, from that subscriber's own profile. The draft
	// keeps the merge tag. A declared default becomes the fallback shown to
	// subscribers who have no value.
	VariableRoleSubscriber = "subscriber"
	// VariableRoleWorkspace is filled from the workspace's own settings when
	// the draft is created, so a design never speaks for the wrong sender.
	VariableRoleWorkspace = "workspace"
	// VariableRoleSendTime is rendered by the send loop itself: the
	// per-recipient unsubscribe link and the campaign's archive links. It is
	// never a template variable and can never be given a value.
	VariableRoleSendTime = "send_time"
)

// Workspace tokens. brand_name is also where a caller's brand.name lands
// (brand.* values are exposed as brand_* tags), so a caller-supplied brand and
// the workspace's own name fill the same slot.
const (
	WorkspaceBrandNameToken    = "brand_name"
	WorkspaceSenderNameToken   = "sender_name"
	WorkspaceReplyToEmailToken = "reply_to_email"
)

// subscriberMergeFields are the canonical subscriber fields every renderer
// resolves per recipient (see campaignsendruntime.PostgresRecipientResolver
// and the preview-as endpoint). `subscriber.<field>` spellings are recipient
// data too.
var subscriberMergeFields = map[string]struct{}{
	"email":        {},
	"first_name":   {},
	"last_name":    {},
	"full_name":    {},
	"display_name": {},
}

var workspaceTokens = map[string]struct{}{
	WorkspaceBrandNameToken:    {},
	WorkspaceSenderNameToken:   {},
	WorkspaceReplyToEmailToken: {},
}

// archiveTokens are the campaign-scoped links the send loop's archive-bar
// renderer fills (archive_bar.Render): the publication archive, the
// view-in-browser copy, and the bar itself. A template's sample value for
// one of them is a link to someone else's archive.
var archiveTokens = map[string]struct{}{
	"archive_bar":         {},
	"view_in_browser_url": {},
	"archive_url":         {},
}

// variableRole classifies a bare merge-tag name.
func variableRole(name string) string {
	_, archive := archiveTokens[name]
	switch {
	case unsubscribetoken.IsName(name), archive:
		return VariableRoleSendTime
	case isSubscriberMergeField(name):
		return VariableRoleSubscriber
	case isWorkspaceToken(name):
		return VariableRoleWorkspace
	default:
		return VariableRoleContent
	}
}

func isSubscriberMergeField(name string) bool {
	if _, ok := subscriberMergeFields[name]; ok {
		return true
	}
	return strings.HasPrefix(name, "subscriber.") && len(name) > len("subscriber.")
}

func isWorkspaceToken(name string) bool {
	_, ok := workspaceTokens[name]
	return ok
}

// preservedInDraft reports whether a tag must survive draft creation
// verbatim because something downstream renders it: the send loop (the
// unsubscribe and archive links) or the per-recipient merge (subscriber
// fields).
func preservedInDraft(name string) bool {
	role := variableRole(name)
	return role == VariableRoleSendTime || role == VariableRoleSubscriber
}

// TemplateVariableRoles lists every merge tag in a template (declared as a
// variable or written into its name, subject, preview text, or bodies) whose
// role is not ordinary content. Clients use it to decide which variables to
// offer as editable fields; a name that is absent is content.
func TemplateVariableRoles(template *Template) map[string]string {
	roles := map[string]string{}
	if template == nil {
		return roles
	}
	note := func(name string) {
		name = strings.TrimSpace(name)
		if name == "" {
			return
		}
		if role := variableRole(name); role != VariableRoleContent {
			roles[name] = role
		}
	}
	for _, variable := range template.Variables {
		name, _ := variable["name"].(string)
		note(name)
	}
	for _, text := range []string{
		template.Name, template.Subject, template.PreviewText, template.BodyHTML, template.BodyMJML,
	} {
		for _, match := range placeholderRE.FindAllStringSubmatch(text, -1) {
			note(match[1])
		}
	}
	return roles
}

// subscriberFallbackRE limits a fallback to text that can sit inside a
// `{{ field | default: '...' }}` filter and inside HTML source unescaped.
// Quotes, pipes, braces, and markup characters would change the filter's
// meaning or the surrounding document, so such a default is not carried.
var subscriberFallbackRE = regexp.MustCompile(`^[\p{L}\p{N} .,!?\-]{1,40}$`)

func safeSubscriberFallback(value any) (string, bool) {
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	text = strings.TrimSpace(text)
	if !subscriberFallbackRE.MatchString(text) {
		return "", false
	}
	return text, true
}

// withSubscriberFallbacks rewrites bare subscriber tags that have a fallback
// into the merge engine's default filter, so a recipient with no first name
// reads "Hi there" rather than "Hi ,". A tag already carrying a filter is not
// matched by placeholderRE and is left exactly as written.
func withSubscriberFallbacks(input string, fallbacks map[string]string) string {
	if len(fallbacks) == 0 || input == "" {
		return input
	}
	return placeholderRE.ReplaceAllStringFunc(input, func(match string) string {
		parts := placeholderRE.FindStringSubmatch(match)
		fallback, ok := fallbacks[parts[1]]
		if !ok {
			return match
		}
		return "{{ " + parts[1] + " | default: '" + fallback + "' }}"
	})
}

// subscriberFallbacks collects the fallback for each subscriber tag: the
// caller's value when one was supplied (a caller cannot set a recipient's
// name, but can say what to show when it is missing), else the template's
// declared default.
func subscriberFallbacks(template *Template, supplied map[string]any) map[string]string {
	fallbacks := map[string]string{}
	if template != nil {
		for _, variable := range template.Variables {
			name, _ := variable["name"].(string)
			if !isSubscriberMergeField(name) {
				continue
			}
			if fallback, ok := safeSubscriberFallback(variable["default"]); ok {
				fallbacks[name] = fallback
			}
		}
	}
	for name, value := range supplied {
		if !isSubscriberMergeField(name) {
			continue
		}
		if fallback, ok := safeSubscriberFallback(value); ok {
			fallbacks[name] = fallback
		}
	}
	return fallbacks
}

// headerText writes each subscriber tag that has a fallback as that
// fallback. A subject, preview text or campaign name is one line shared by
// every recipient and listed as-is in the campaigns view; the engine also
// compiles the subject as a template of its own, where a {{ first_name }}
// action fails the send. A subscriber tag with no fallback is left for
// DraftUnresolvedVariables to report.
func headerText(input string, fallbacks map[string]string) string {
	if len(fallbacks) == 0 || input == "" {
		return input
	}
	return placeholderRE.ReplaceAllStringFunc(input, func(match string) string {
		parts := placeholderRE.FindStringSubmatch(match)
		if fallback, ok := fallbacks[parts[1]]; ok {
			return fallback
		}
		return match
	})
}

// unresolvedDraftVariables lists the content tags a caller is still expected
// to fill. Subscriber and send-time tags are rendered per recipient, and
// workspace tokens are filled from the workspace when a campaign is created,
// so none of those is reported.
func unresolvedDraftVariables(texts ...string) []string {
	unresolved := map[string]struct{}{}
	for _, text := range texts {
		for _, match := range placeholderRE.FindAllStringSubmatch(text, -1) {
			if variableRole(match[1]) == VariableRoleContent {
				unresolved[match[1]] = struct{}{}
			}
		}
	}
	return sortedNames(unresolved)
}

// DraftUnresolvedVariables lists the tags a draft still carries that nothing
// will fill: content variables nobody supplied (an empty link, a missing
// date), workspace tokens the workspace has no setting for (reply_to_email
// before a reply-to address is saved), and subscriber tags without a
// fallback in the subject or preview text. The author has to fill each one
// before the campaign is sent; clients show them next to the new draft.
func DraftUnresolvedVariables(draft campaigns.CreateInput) []string {
	unresolved := map[string]struct{}{}
	note := func(text string, header bool) {
		for _, match := range placeholderRE.FindAllStringSubmatch(text, -1) {
			switch variableRole(match[1]) {
			case VariableRoleContent, VariableRoleWorkspace:
				unresolved[match[1]] = struct{}{}
			case VariableRoleSubscriber:
				if header {
					unresolved[match[1]] = struct{}{}
				}
			}
		}
	}
	note(draft.Subject, true)
	note(draft.PreviewText, true)
	note(draft.BodyHTML, false)
	note(draft.BodyMJML, false)
	return sortedNames(unresolved)
}

func sortedNames(set map[string]struct{}) []string {
	names := make([]string, 0, len(set))
	for name := range set {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
