-- 0241_templates_enhance_and_pack.sql
--
-- Templates polish + 2026 follow-on pack. Two-part migration:
--
--   Part 1 — Enhance the 7 legacy platform templates that were
--   carried forward from 0048 / 0187. The original copies were
--   functional but generic ("Welcome to our platform!", "Here's
--   our latest news!"). This rewrites each one in the editorial /
--   honest-math / consent-first voice we adopted in 0240 so that
--   the default gallery does not look like a 2018 SaaS starter
--   kit next to the 2026 pack.
--
--   Each UPDATE rewrites only name, description, subject,
--   preview_text, body_html, variables, and tags. tenant_id,
--   slug, goal, is_featured, usage_count, last_used_at,
--   body_mjml, category, created_by and created_at are
--   deliberately left alone — tenants who already cloned a
--   featured row keep their pin, and the slug-keyed analytics
--   that aggregate on usage_count keep their lineage.
--
--   Part 2 — Insert 10 additional platform templates that close
--   gaps we found while shipping 0240: a reply-bait welcome, a
--   one-link roundup, a margin-notes essay, a respectful sunset
--   notice, an account-credit loyalty promo, a letter-from-
--   future-self re-engagement, an export-ready notification
--   with SHA-256, a new-device security alert, a cohort-
--   milestone automation, and a 48h post-send debrief.
--
-- Curation notes:
--
--   * tenant_id is NULL on every inserted row (platform-owned).
--     ON CONFLICT (slug) WHERE tenant_id IS NULL DO NOTHING
--     mirrors the partial unique index from 0048 so re-running
--     the migration is a no-op and tenant-owned templates that
--     happen to share a slug are untouched.
--
--   * Six of the ten new rows are flagged is_featured = true so
--     every goal-filter tab in the gallery keeps a featured
--     hero after the 2026 pack lands. The mix prioritises
--     welcome / announcement / promotional / transactional /
--     automation as the most-used tabs.
--
--   * Style direction: editorial / engineering-voice / honest
--     math / consent-first re-engagement / state-aware
--     automation. HTML is hand-inlined, table-based, Outlook-
--     safe, and SQL-concatenated with || across multiple lines
--     so diffs stay reviewable.
--
--   * variables is jsonb (::jsonb cast on a JSON array literal)
--     and tags is text[] (ARRAY[...]). Embedded single quotes
--     are escaped as '' per Postgres string literal rules.
--
-- Idempotency: Part 1 UPDATEs are slug-keyed and rewrite columns
-- to a known value, so re-running converges. Part 2 uses ON
-- CONFLICT (slug) WHERE tenant_id IS NULL DO NOTHING.

BEGIN;

-- ============================================================
-- Part 1: Enhance the 7 legacy platform templates
-- ============================================================

-- 1. welcome-launch -> First-Sentence Welcome
UPDATE campaign_templates
   SET name = 'First-Sentence Welcome',
       description = 'A welcome that opens with the single sentence the user needs most, before any logo or chrome — pure signal, zero scaffolding.',
       subject = '{{first_name}}, here is the one thing first',
       preview_text = 'No tour. No checklist. One sentence, one action, then we get out of your way.',
       body_html =
            '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;background-color:#F7F5F0;border-collapse:collapse;">'
         || '<tr><td style="padding:56px 48px 24px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#8A7F6E;">Step one of one</td></tr>'
         || '<tr><td style="padding:24px 48px 8px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:32px;line-height:40px;letter-spacing:-0.01em;color:#1A1A1A;font-weight:400;">{{first_name}}, here is the one thing to do first in {{product}}:</td></tr>'
         || '<tr><td style="padding:16px 48px 32px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:32px;line-height:40px;letter-spacing:-0.01em;color:#1A1A1A;font-weight:400;">{{one_sentence}}</td></tr>'
         || '<tr><td style="padding:8px 48px 40px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:20px;line-height:32px;color:#1A1A1A;"><a href="{{one_action_url}}" style="color:#1A1A1A;text-decoration:underline;text-underline-offset:4px;font-weight:600;">Do that one thing now &rarr;</a></td></tr>'
         || '<tr><td style="padding:8px 48px 40px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:18px;letter-spacing:0.18em;text-transform:uppercase;color:#8A7F6E;">Why this and nothing else &mdash;</td></tr>'
         || '<tr><td style="padding:0 48px 56px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:28px;color:#3A3631;">{{why_this_first}}</td></tr>'
         || '<tr><td align="center" style="padding:8px 48px 56px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:18px;line-height:24px;letter-spacing:0.6em;color:#C9A87A;">*&nbsp;&nbsp;*&nbsp;&nbsp;*</td></tr>'
         || '<tr><td style="padding:0 48px 8px 48px;font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-size:20px;line-height:30px;color:#1A1A1A;">Yours, no checklist attached,</td></tr>'
         || '<tr><td style="padding:0 48px 8px 48px;font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-size:20px;line-height:30px;color:#1A1A1A;">{{founder_name}}</td></tr>'
         || '<tr><td style="padding:8px 48px 48px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:18px;letter-spacing:0.08em;color:#8A7F6E;">Reply directly: <a href="mailto:{{reply_email}}" style="color:#8A7F6E;text-decoration:underline;">{{reply_email}}</a></td></tr>'
         || '<tr><td style="padding:0 48px 24px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;line-height:24px;letter-spacing:0.4em;color:#C9A87A;">&mdash;&mdash;&mdash;</td></tr>'
         || '<tr><td style="padding:0 48px 56px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:18px;letter-spacing:0.12em;text-transform:uppercase;color:#8A7F6E;">You signed up for {{product}}. One email. No tour. <a href="{{unsubscribe_url}}" style="color:#8A7F6E;text-decoration:underline;">Unsubscribe</a>.</td></tr>'
         || '</table>',
       variables = '[{"name":"first_name","label":"First name","default":"there"},{"name":"product","label":"Product","default":"Postwave"},{"name":"one_sentence","label":"The one sentence","default":"Connect your sending domain — everything else can wait."},{"name":"one_action_url","label":"Action URL","default":"https://app.postwave.com/domains"},{"name":"why_this_first","label":"Why this matters","default":"Without it, even your test sends will land in spam."},{"name":"founder_name","label":"Signature","default":"Harsh"},{"name":"reply_email","label":"Reply-to","default":"harsh@postwave.com"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
       tags = ARRAY['welcome','minimal','first-action','editorial']
 WHERE tenant_id IS NULL AND slug = 'welcome-launch';

-- 2. newsletter-weekly -> Stat-of-the-Week Dispatch
UPDATE campaign_templates
   SET name = 'Stat-of-the-Week Dispatch',
       description = 'A weekly newsletter that opens with one curated industry stat as the entire hero — then earns the read with three short notes underneath.',
       subject = '{{stat_value}} — and what it means for you',
       preview_text = 'One number that changed our minds this week, plus three short notes underneath.',
       body_html =
            '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;margin:0 auto;">'
         || '<tr><td style="padding:40px 48px 16px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">THE WEEKLY &middot; ONE NUMBER</td></tr>'
         || '<tr><td style="padding:56px 48px 8px 48px;text-align:center;font-family:Georgia,''Times New Roman'',serif;font-size:96px;line-height:1;letter-spacing:-0.04em;color:#111111;font-weight:400;">{{stat_value}}</td></tr>'
         || '<tr><td style="padding:20px 48px 48px 48px;text-align:center;font-family:Georgia,''Times New Roman'',serif;font-size:14px;line-height:1.5;color:#6B5F4A;font-style:italic;">{{stat_caption}}</td></tr>'
         || '<tr><td align="center" style="padding:0 48px 40px 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:#D4C9B5;letter-spacing:0.4em;">&#9472;&#9472;&#9472;</td></tr></table></td></tr>'
         || '<tr><td style="padding:0 48px 8px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">01</td></tr>'
         || '<tr><td style="padding:6px 48px 32px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:26px;color:#111111;">{{note_one_title}}</td></tr>'
         || '<tr><td style="padding:0 48px 8px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">02</td></tr>'
         || '<tr><td style="padding:6px 48px 32px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:26px;color:#111111;">{{note_two_title}}</td></tr>'
         || '<tr><td style="padding:0 48px 8px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">03</td></tr>'
         || '<tr><td style="padding:6px 48px 40px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:26px;color:#111111;">{{note_three_title}}</td></tr>'
         || '<tr><td align="center" style="padding:0 48px 32px 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:#D4C9B5;letter-spacing:0.4em;">&#9472;&#9472;&#9472;</td></tr></table></td></tr>'
         || '<tr><td style="padding:0 48px 48px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:16px;line-height:24px;color:#111111;text-align:center;"><a href="mailto:{{reply_email}}" style="color:#111111;text-decoration:underline;text-underline-offset:3px;">Reply with your take &rarr;</a></td></tr>'
         || '<tr><td style="padding:0 48px 16px 48px;border-top:1px solid #EAEAEA;">&nbsp;</td></tr>'
         || '<tr><td style="padding:8px 48px 8px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;color:#737373;letter-spacing:0.02em;">You&rsquo;re reading because you subscribed. One short email, once a week.</td></tr>'
         || '<tr><td style="padding:4px 48px 32px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;color:#737373;letter-spacing:0.02em;"><a href="{{archive_url}}" style="color:#737373;text-decoration:underline;">View archive</a> &nbsp;&middot;&nbsp; <a href="{{unsubscribe_url}}" style="color:#737373;text-decoration:underline;">Unsubscribe</a></td></tr>'
         || '</table>',
       variables = '[{"name":"stat_value","label":"Hero stat","default":"73%"},{"name":"stat_caption","label":"Source caption","default":"of B2B emails sent Tuesdays at 10am — Litmus 2026"},{"name":"note_one_title","label":"Note 1 title","default":"Gmail tightened its bulk-sender threshold"},{"name":"note_two_title","label":"Note 2 title","default":"The case against Tuesday 10am"},{"name":"note_three_title","label":"Note 3 title","default":"One reader rewrote their preheader and won 4 points"},{"name":"reply_email","label":"Reply-to","default":"dispatch@postwave.com"},{"name":"archive_url","label":"Archive URL","default":"https://postwave.com/archive"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
       tags = ARRAY['newsletter','weekly','data','stat-hero']
 WHERE tenant_id IS NULL AND slug = 'newsletter-weekly';

-- 3. re-engagement-gentle -> Quiet-Exit Re-engagement
UPDATE campaign_templates
   SET name = 'Quiet-Exit Re-engagement',
       description = 'A consent-respecting re-engagement that tells the reader they will be auto-removed in 14 days unless they tap one button — no guilt, no copy gymnastics.',
       subject = 'We will quietly remove you in 14 days',
       preview_text = 'Tap one button to stay. Do nothing and we take ourselves off your list. Either is fine.',
       body_html =
            '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;margin:0 auto;background-color:#FAFAF7;">'
         || '<tr><td style="padding:56px 48px 24px 48px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">List hygiene notice</div></td></tr>'
         || '<tr><td style="padding:0 48px 32px 48px;"><h1 style="margin:0;font-family:Georgia,''Times New Roman'',serif;font-size:28px;line-height:36px;font-weight:400;color:#1A1A1A;letter-spacing:-0.01em;">We will quietly remove you from {{list_name}} in {{days_remaining}} days.</h1></td></tr>'
         || '<tr><td style="padding:0 48px 20px 48px;"><p style="margin:0;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:16px;line-height:26px;color:#3A3A3A;">Hi {{first_name}} — our records show {{last_open_phrase}}. That''s a long time, and we''d rather not crowd an inbox that isn''t using us. So in {{days_remaining}} days we''ll take ourselves off your list automatically.</p></td></tr>'
         || '<tr><td style="padding:0 48px 36px 48px;"><p style="margin:0;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:16px;line-height:26px;color:#3A3A3A;">If you''d like to stay, tap the button below once. If you''d rather not, you don''t need to do anything — silence is a perfectly good answer here.</p></td></tr>'
         || '<tr><td align="left" style="padding:0 48px 20px 48px;"><a href="{{keep_url}}" style="display:inline-block;padding:16px 32px;background-color:#1A1A1A;color:#FAFAF7;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:15px;line-height:20px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.01em;">Keep me on the list &rarr;</a></td></tr>'
         || '<tr><td style="padding:0 48px 56px 48px;"><a href="{{unsubscribe_url}}" style="font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:22px;color:#737373;text-decoration:underline;text-underline-offset:3px;">Or do nothing &mdash; also fine.</a></td></tr>'
         || '<tr><td align="center" style="padding:0 48px 40px 48px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:20px;color:#A8A8A8;letter-spacing:0.4em;">*&nbsp;&nbsp;*&nbsp;&nbsp;*</div></td></tr>'
         || '<tr><td style="padding:0 48px 24px 48px;"><p style="margin:0;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:13px;line-height:22px;color:#737373;">Questions, complaints, or a kind word? Reply to <a href="mailto:{{reply_email}}" style="color:#3A3A3A;text-decoration:underline;text-underline-offset:2px;">{{reply_email}}</a> and a person will read it.</p></td></tr>'
         || '<tr><td style="padding:0 48px 56px 48px;border-top:1px solid #E8E6DF;"><div style="padding-top:24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:18px;letter-spacing:0.08em;color:#A8A8A8;">List: {{list_name}}<br>Auto-prune in {{days_remaining}} days<br><a href="{{unsubscribe_url}}" style="color:#737373;text-decoration:underline;text-underline-offset:2px;">Unsubscribe now &rarr;</a></div></td></tr>'
         || '</table>',
       variables = '[{"name":"first_name","label":"First name","default":"there"},{"name":"days_remaining","label":"Days until prune","default":"14"},{"name":"last_open_phrase","label":"Last open phrase","default":"You haven''t opened in about four months"},{"name":"keep_url","label":"Keep-me URL","default":"https://postwave.com/preferences/keep"},{"name":"list_name","label":"List name","default":"the Postwave Dispatch"},{"name":"reply_email","label":"Reply-to","default":"harsh@postwave.com"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
       tags = ARRAY['re-engagement','consent','auto-prune','honest']
 WHERE tenant_id IS NULL AND slug = 're-engagement-gentle';

-- 4. announcement-product-launch -> Changelog-First Launch
UPDATE campaign_templates
   SET name = 'Changelog-First Launch',
       description = 'A product launch written as a committed-and-shipped changelog entry — version, ship date, three honest line items, one link.',
       subject = '{{product}} {{version}} shipped — here is what changed',
       preview_text = 'Written like a changelog, not a press release. Three line items. One link.',
       body_html =
            '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;background-color:#FFFFFF;margin:0 auto;"><tr><td style="padding:56px 48px 32px 48px;">'
         || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;font-weight:500;">POSTWAVE&nbsp;&nbsp;/&nbsp;&nbsp;{{product}}&nbsp;v{{version}}&nbsp;&nbsp;/&nbsp;&nbsp;SHIPPED&nbsp;{{ship_date}}</div>'
         || '</td></tr><tr><td style="padding:0 48px 36px 48px;">'
         || '<div style="font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:32px;line-height:38px;font-weight:700;color:#111111;letter-spacing:-0.01em;">{{headline}}</div>'
         || '</td></tr><tr><td style="padding:0 48px 14px 48px;">'
         || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
         || '<td valign="top" width="28" style="width:28px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:22px;font-weight:700;color:#15803D;">+</td>'
         || '<td valign="top" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:22px;color:#1F2937;">{{change_one}}</td>'
         || '</tr></table>'
         || '</td></tr><tr><td style="padding:0 48px 14px 48px;">'
         || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
         || '<td valign="top" width="28" style="width:28px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:22px;font-weight:700;color:#15803D;">+</td>'
         || '<td valign="top" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:22px;color:#1F2937;">{{change_two}}</td>'
         || '</tr></table>'
         || '</td></tr><tr><td style="padding:0 48px 36px 48px;">'
         || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
         || '<td valign="top" width="28" style="width:28px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:22px;font-weight:700;color:#B45309;">~</td>'
         || '<td valign="top" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:22px;color:#1F2937;">{{change_three}}</td>'
         || '</tr></table>'
         || '</td></tr><tr><td style="padding:0 48px 32px 48px;">'
         || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:22px;color:#D4D4D4;letter-spacing:0.05em;">────────────────────────────────────</div>'
         || '</td></tr><tr><td style="padding:0 48px 32px 48px;">'
         || '<div style="font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:26px;color:#1A1A1A;">{{why_paragraph}}</div>'
         || '</td></tr><tr><td style="padding:0 48px 56px 48px;">'
         || '<a href="{{changelog_url}}" style="font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:15px;line-height:22px;color:#111111;font-weight:600;text-decoration:underline;text-underline-offset:3px;">Read the full changelog &rarr;</a>'
         || '</td></tr><tr><td style="padding:0 48px 24px 48px;border-top:1px solid #EAEAEA;"></td></tr><tr><td style="padding:0 48px 48px 48px;">'
         || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:18px;letter-spacing:0.12em;text-transform:uppercase;color:#A3A3A3;">POSTWAVE&nbsp;&nbsp;//&nbsp;&nbsp;BUILD&nbsp;{{version}}&nbsp;&nbsp;//&nbsp;&nbsp;<a href="{{unsubscribe_url}}" style="color:#A3A3A3;text-decoration:underline;">UNSUBSCRIBE</a></div>'
         || '</td></tr></table>',
       variables = '[{"name":"product","label":"Product","default":"Postwave"},{"name":"version","label":"Version","default":"2026.6"},{"name":"ship_date","label":"Ship date","default":"June 3, 2026"},{"name":"headline","label":"Headline","default":"Segments can now reference shared audiences across workspaces"},{"name":"change_one","label":"Add 1","default":"Cross-workspace audience references in segment builder"},{"name":"change_two","label":"Add 2","default":"Inline preview when picking a shared audience"},{"name":"change_three","label":"Change 1","default":"Segment edits now show diff before save"},{"name":"why_paragraph","label":"Why we built it","default":"Three customers asked, four engineers argued, one PM lost. We shipped the version the customers wanted."},{"name":"changelog_url","label":"Changelog URL","default":"https://postwave.com/changelog"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
       tags = ARRAY['announcement','launch','changelog']
 WHERE tenant_id IS NULL AND slug = 'announcement-product-launch';

-- 5. promotional-flash-sale -> Countdown-Receipt Promo
UPDATE campaign_templates
   SET name = 'Countdown-Receipt Promo',
       description = 'A flash promo styled as a pre-filled order receipt with a live deadline timestamp — the discount is shown as already applied, no shouty caps.',
       subject = 'Your discount is pre-applied — expires {{deadline_human}}',
       preview_text = 'A receipt, not a flyer. The math is already done. The timestamp is the urgency.',
       body_html =
            '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;margin:0 auto;background:#FAFAFA;">'
         || '<tr><td style="padding:40px 20px;">'
         || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border:1px solid #E5E5E5;">'
         || '<tr><td style="padding:40px 40px 24px 40px;">'
         || '<p style="margin:0 0 24px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.4;color:#737373;letter-spacing:0.18em;text-transform:uppercase;">ORDER PREVIEW &mdash; NOT YET CHARGED</p>'
         || '<h1 style="margin:0 0 8px 0;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:24px;line-height:1.25;font-weight:600;color:#111111;">Your discount is pre-applied.</h1>'
         || '<p style="margin:0;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:1.5;color:#525252;">No code needed. Review below and confirm before the timer runs out.</p>'
         || '</td></tr>'
         || '<tr><td style="padding:0 40px 8px 40px;">'
         || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
         || '<tr><td style="padding:12px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.4;color:#737373;letter-spacing:0.14em;text-transform:uppercase;border-bottom:1px solid #E5E5E5;">Item</td>'
         || '<td align="right" style="padding:12px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.4;color:#737373;letter-spacing:0.14em;text-transform:uppercase;border-bottom:1px solid #E5E5E5;">Amount</td></tr>'
         || '<tr><td style="padding:14px 0 6px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.5;color:#111111;">{{plan_name}}</td>'
         || '<td align="right" style="padding:14px 0 6px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.5;color:#111111;">&mdash;</td></tr>'
         || '<tr><td style="padding:6px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.5;color:#525252;">Original</td>'
         || '<td align="right" style="padding:6px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.5;color:#525252;text-decoration:line-through;">{{original_price}}</td></tr>'
         || '<tr><td style="padding:6px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.5;color:#DC2626;">Discount &mdash; {{discount_line}}</td>'
         || '<td align="right" style="padding:6px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.5;color:#DC2626;">applied</td></tr>'
         || '<tr><td colspan="2" style="padding:8px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1;color:#A3A3A3;letter-spacing:0.2em;">- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -</td></tr>'
         || '<tr><td style="padding:6px 0 14px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.5;color:#111111;font-weight:700;">You pay</td>'
         || '<td align="right" style="padding:6px 0 14px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.5;color:#111111;font-weight:700;">{{final_price}}</td></tr>'
         || '</table>'
         || '</td></tr>'
         || '<tr><td style="padding:8px 40px 24px 40px;">'
         || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFBEB;border:1px solid #FDE68A;">'
         || '<tr><td style="padding:14px 16px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.5;color:#B45309;letter-spacing:0.08em;">EXPIRES {{deadline_iso}}<br><span style="color:#92400E;letter-spacing:0;text-transform:none;">that&rsquo;s {{deadline_human}}</span></td></tr>'
         || '</table>'
         || '</td></tr>'
         || '<tr><td align="center" style="padding:0 40px 32px 40px;">'
         || '<a href="{{claim_url}}" style="display:inline-block;padding:16px 32px;background:#111111;color:#FFFFFF;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:1;font-weight:600;text-decoration:none;border-radius:999px;letter-spacing:0.02em;">Confirm &amp; claim discount</a>'
         || '<p style="margin:14px 0 0 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;color:#737373;letter-spacing:0.08em;">No charge until you confirm on the next screen.</p>'
         || '</td></tr>'
         || '<tr><td style="padding:20px 40px 32px 40px;border-top:1px solid #E5E5E5;">'
         || '<p style="margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;color:#737373;letter-spacing:0.06em;">Reference: ORD-PRE-{{deadline_iso}}<br>Terms: one per account &middot; non-stackable &middot; void after deadline<br><a href="{{unsubscribe_url}}" style="color:#737373;text-decoration:underline;">Unsubscribe</a></p>'
         || '</td></tr>'
         || '</table>'
         || '</td></tr></table>',
       variables = '[{"name":"plan_name","label":"Plan","default":"Postwave Growth"},{"name":"original_price","label":"Original","default":"$79/mo"},{"name":"discount_line","label":"Discount line","default":"-$24/mo for 6 months"},{"name":"final_price","label":"You pay","default":"$55/mo"},{"name":"deadline_iso","label":"Deadline ISO","default":"2026-06-07 23:59 PT"},{"name":"deadline_human","label":"Deadline human","default":"Sunday at midnight"},{"name":"claim_url","label":"Claim URL","default":"https://postwave.com/offer/preview"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
       tags = ARRAY['promotional','receipt-style','no-hype']
 WHERE tenant_id IS NULL AND slug = 'promotional-flash-sale';

-- 6. transactional-receipt -> Receipt with Shipment Hooks
UPDATE campaign_templates
   SET name = 'Receipt with Shipment Hooks',
       description = 'A receipt that doubles as a status hub — order summary, ''what happens next'' timeline, then a one-tap support hatch.',
       subject = 'Receipt for order {{order_id}}',
       preview_text = 'Receipt plus what to expect next plus a one-tap support hatch — all in one place.',
       body_html =
            '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;margin:0 auto;">'
         || '<tr><td style="padding:48px 48px 24px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">RECEIPT &middot; ORDER {{order_id}}</td></tr>'
         || '<tr><td style="padding:0 48px 8px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:22px;line-height:30px;color:#1A1A1A;">Thank you, {{customer_name}}.</td></tr>'
         || '<tr><td style="padding:0 48px 32px 48px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:22px;color:#525252;">Your order is confirmed. Here is the math, the timeline, and a direct line to a human if you need one.</td></tr>'
         || '<tr><td style="padding:0 48px 12px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;line-height:14px;letter-spacing:0.18em;text-transform:uppercase;color:#A3A3A3;">&mdash;&mdash;&mdash; Order Math</td></tr>'
         || '<tr><td style="padding:0 48px 0 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">'
         || '<tr><td style="padding:14px 0 14px 0;border-bottom:1px solid #E5E5E5;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:20px;color:#1A1A1A;text-align:left;">{{item_one_label}}</td>'
         || '<td style="padding:14px 0 14px 0;border-bottom:1px solid #E5E5E5;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:20px;color:#1A1A1A;text-align:right;">{{item_one_amount}}</td></tr>'
         || '<tr><td style="padding:14px 0 14px 0;border-bottom:1px solid #E5E5E5;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:20px;color:#525252;text-align:left;">Tax</td>'
         || '<td style="padding:14px 0 14px 0;border-bottom:1px solid #E5E5E5;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:20px;color:#525252;text-align:right;">{{tax_amount}}</td></tr>'
         || '<tr><td style="padding:20px 0 8px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;text-align:left;">Total</td>'
         || '<td style="padding:20px 0 8px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px;line-height:28px;font-weight:700;color:#1A1A1A;text-align:right;">{{total_amount}}</td></tr>'
         || '</table></td></tr>'
         || '<tr><td style="padding:40px 48px 0 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;line-height:14px;letter-spacing:0.18em;text-transform:uppercase;color:#A3A3A3;">&mdash;&mdash;&mdash; Timeline</td></tr>'
         || '<tr><td style="padding:12px 48px 24px 48px;font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-size:18px;line-height:26px;color:#1A1A1A;">What happens next</td></tr>'
         || '<tr><td style="padding:0 48px 0 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">'
         || '<tr><td width="80" valign="top" style="padding:0 16px 18px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:#737373;letter-spacing:0.05em;white-space:nowrap;">T+0h</td>'
         || '<td valign="top" style="padding:0 0 18px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:20px;color:#1A1A1A;">{{next_step_one}}</td></tr>'
         || '<tr><td width="80" valign="top" style="padding:0 16px 18px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:#737373;letter-spacing:0.05em;white-space:nowrap;">T+24h</td>'
         || '<td valign="top" style="padding:0 0 18px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:20px;color:#1A1A1A;">{{next_step_two}}</td></tr>'
         || '<tr><td width="80" valign="top" style="padding:0 16px 0 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:#737373;letter-spacing:0.05em;white-space:nowrap;">T+72h</td>'
         || '<td valign="top" style="padding:0 0 0 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:20px;color:#1A1A1A;">{{next_step_three}}</td></tr>'
         || '</table></td></tr>'
         || '<tr><td style="padding:40px 48px 48px 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#FAF7F0;border-radius:6px;">'
         || '<tr><td style="padding:24px 28px 8px 28px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;line-height:14px;letter-spacing:0.18em;text-transform:uppercase;color:#8C7A52;">Support Hatch</td></tr>'
         || '<tr><td style="padding:0 28px 16px 28px;font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-size:16px;line-height:24px;color:#1A1A1A;">Something off? Reply to this email or write to <a href="mailto:{{support_email}}" style="color:#1A1A1A;text-decoration:underline;">{{support_email}}</a> &mdash; a real person reads every message.</td></tr>'
         || '<tr><td style="padding:0 28px 24px 28px;"><a href="mailto:{{support_email}}" style="display:inline-block;padding:14px 28px;background-color:#1A1A1A;color:#FAF7F0;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;font-weight:600;line-height:20px;text-decoration:none;border-radius:6px;">Email support</a></td></tr>'
         || '</table></td></tr>'
         || '<tr><td style="padding:0 48px 40px 48px;border-top:1px solid #E5E5E5;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">'
         || '<tr><td style="padding:20px 0 0 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;line-height:16px;letter-spacing:0.12em;text-transform:uppercase;color:#A3A3A3;">Transactional receipt &middot; Order {{order_id}}</td></tr>'
         || '</table></td></tr>'
         || '</table>',
       variables = '[{"name":"order_id","label":"Order ID","default":"PW-2026-04812"},{"name":"customer_name","label":"Customer","default":"Mira Patel"},{"name":"item_one_label","label":"Item 1","default":"Postwave Growth · monthly"},{"name":"item_one_amount","label":"Item 1 amount","default":"$79.00"},{"name":"tax_amount","label":"Tax","default":"$6.32"},{"name":"total_amount","label":"Total","default":"$85.32"},{"name":"next_step_one","label":"Next step 1","default":"TODAY · Confirmation queued · 2 min"},{"name":"next_step_two","label":"Next step 2","default":"TOMORROW · Invoice PDF emailed"},{"name":"next_step_three","label":"Next step 3","default":"MONTHLY · Auto-renew on the 3rd"},{"name":"support_email","label":"Support email","default":"support@postwave.com"}]'::jsonb,
       tags = ARRAY['transactional','receipt','timeline']
 WHERE tenant_id IS NULL AND slug = 'transactional-receipt';

-- 7. automation-day-three-tip -> Day-Three Course Correction
UPDATE campaign_templates
   SET name = 'Day-Three Course Correction',
       description = 'Day 3 of an onboarding drip that surfaces what the user has and hasn''t done, then gives one tactical nudge — personalized via state.',
       subject = 'Day 3: one thing to fix before day 4',
       preview_text = 'We looked at your account. Here is the single thing worth fixing today.',
       body_html =
            '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;background-color:#FFFFFF;margin:0 auto;">'
         || '<tr><td style="padding:48px 48px 0 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">DAY 3 OF 5 &middot; {{first_name}}</td></tr>'
         || '<tr><td style="padding:18px 48px 0 48px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:28px;line-height:34px;font-weight:600;color:#111111;">{{headline}}</td></tr>'
         || '<tr><td style="padding:14px 48px 0 48px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:22px;color:#525252;">We took a look at where you are. Here is your status, and the one thing worth fixing today.</td></tr>'
         || '<tr><td style="padding:32px 48px 0 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-top:1px solid #E5E5E5;border-bottom:1px solid #E5E5E5;">'
         || '<tr><td width="50%" style="width:50%;padding:16px 16px 16px 0;vertical-align:top;border-right:1px solid #E5E5E5;">'
         || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:18px;color:#15803D;letter-spacing:0.02em;">[x]</div>'
         || '<div style="margin-top:6px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:20px;color:#1F2937;">{{done_item_one}}</div>'
         || '<div style="margin-top:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;color:#737373;letter-spacing:0.08em;text-transform:uppercase;">Complete</div></td>'
         || '<td width="50%" style="width:50%;padding:16px 0 16px 16px;vertical-align:top;">'
         || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:18px;color:#15803D;letter-spacing:0.02em;">[x]</div>'
         || '<div style="margin-top:6px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:20px;color:#1F2937;">Account verified</div>'
         || '<div style="margin-top:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;color:#737373;letter-spacing:0.08em;text-transform:uppercase;">Complete</div></td></tr>'
         || '<tr><td width="50%" style="width:50%;padding:16px 16px 16px 0;vertical-align:top;border-top:1px solid #E5E5E5;border-right:1px solid #E5E5E5;">'
         || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:18px;color:#B45309;letter-spacing:0.02em;">[ ]</div>'
         || '<div style="margin-top:6px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:20px;color:#1F2937;">{{todo_item_one}}</div>'
         || '<div style="margin-top:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;color:#B45309;letter-spacing:0.08em;text-transform:uppercase;">Pending</div></td>'
         || '<td width="50%" style="width:50%;padding:16px 0 16px 16px;vertical-align:top;border-top:1px solid #E5E5E5;">'
         || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:18px;color:#B45309;letter-spacing:0.02em;">[ ]</div>'
         || '<div style="margin-top:6px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:20px;color:#1F2937;">Send first campaign</div>'
         || '<div style="margin-top:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;color:#B45309;letter-spacing:0.08em;text-transform:uppercase;">Pending</div></td></tr>'
         || '</table></td></tr>'
         || '<tr><td align="center" style="padding:32px 48px 0 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:#A3A3A3;letter-spacing:0.3em;">&mdash;&mdash;&mdash;</td></tr>'
         || '<tr><td style="padding:24px 48px 0 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">The one fix</td></tr>'
         || '<tr><td style="padding:12px 48px 0 48px;font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:26px;color:#111111;">{{fix_paragraph}}</td></tr>'
         || '<tr><td style="padding:24px 48px 0 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#F4F4F0;border-radius:4px;">'
         || '<tr><td style="padding:10px 16px;border-bottom:1px solid #E5E5E0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">Snippet &middot; copy &amp; paste</td></tr>'
         || '<tr><td style="padding:18px 20px 20px 20px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:20px;color:#111111;white-space:pre-wrap;word-break:break-word;">{{fix_snippet}}</td></tr>'
         || '</table></td></tr>'
         || '<tr><td style="padding:24px 48px 0 48px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:22px;color:#1F2937;"><a href="{{fix_url}}" style="color:#111111;text-decoration:underline;font-weight:600;">Open this setting &rarr;</a></td></tr>'
         || '<tr><td style="padding:32px 48px 0 48px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:13px;line-height:20px;color:#737373;">Tomorrow (Day 4): we will look at deliverability. Reply to this email if you would rather skip ahead.</td></tr>'
         || '<tr><td style="padding:40px 48px 48px 48px;border-top:1px solid #E5E5E5;margin-top:32px;"><div style="padding-top:24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:18px;letter-spacing:0.06em;color:#A3A3A3;">Postwave &middot; Onboarding series 3/5<br><a href="{{mute_url}}" style="color:#737373;text-decoration:underline;">Mute this series</a> &middot; <a href="{{unsubscribe_url}}" style="color:#737373;text-decoration:underline;">Unsubscribe</a></div></td></tr>'
         || '</table>',
       variables = '[{"name":"first_name","label":"First name","default":"there"},{"name":"headline","label":"Headline","default":"Your domain is verified — your DKIM record is not"},{"name":"done_item_one","label":"Done 1","default":"Workspace created"},{"name":"todo_item_one","label":"Todo 1","default":"DKIM record published"},{"name":"fix_paragraph","label":"Fix copy","default":"Add the DKIM TXT record below to your DNS — propagates in under an hour."},{"name":"fix_snippet","label":"Fix snippet","default":"postwave._domainkey  TXT  v=DKIM1; k=rsa; p=MIGfMA0GC..."},{"name":"fix_url","label":"Open setting URL","default":"https://app.postwave.com/domains/dkim"},{"name":"mute_url","label":"Mute series URL","default":"https://postwave.com/preferences/series"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
       tags = ARRAY['automation','drip','onboarding','state-aware']
 WHERE tenant_id IS NULL AND slug = 'automation-day-three-tip';

-- ============================================================
-- Part 2: Insert 10 new platform templates
-- ============================================================

INSERT INTO campaign_templates
    (tenant_id, slug, name, description, category, subject, preview_text,
     body_html, variables, tags, goal, is_featured)
VALUES

    -- 1. welcome-reply-bait
    (NULL, 'welcome-reply-bait',
     'Reply-Bait Welcome',
     'A welcome that asks one specific question and asks the reader to reply — designed to land a real human reply before any product action.',
     'marketing',
     '{{first_name}}, one question before anything else',
     'Reply with one sentence — that is the entire onboarding.',
        '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FAF9F6;">'
     || '<tr><td style="padding:80px 56px 24px 56px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#8A7F6E;">Not automated</td></tr>'
     || '<tr><td style="padding:24px 56px 8px 56px;font-family:Georgia,''Times New Roman'',serif;font-size:15px;line-height:22px;color:#5C5346;">{{first_name}},</td></tr>'
     || '<tr><td style="padding:8px 56px 80px 56px;font-family:Georgia,''Times New Roman'',serif;font-size:26px;line-height:36px;color:#1A1A1A;font-weight:400;">{{one_question}}</td></tr>'
     || '<tr><td style="padding:0 56px 8px 56px;font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-size:17px;line-height:24px;color:#1A1A1A;">Yours, {{founder_name}}</td></tr>'
     || '<tr><td style="padding:0 56px 80px 56px;font-family:Georgia,''Times New Roman'',serif;font-size:13px;line-height:20px;color:#5C5346;">&mdash; I read every reply.</td></tr>'
     || '<tr><td style="padding:0 56px 80px 56px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">'
     || '<tr><td style="border:1px dotted #C9A87A;padding:18px 22px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:#5C5346;">Reply to: <a href="mailto:{{reply_email}}" style="color:#1A1A1A;text-decoration:none;">{{reply_email}}</a></td></tr>'
     || '</table></td></tr>'
     || '<tr><td style="padding:0 56px 16px 56px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:18px;letter-spacing:0.08em;color:#8A7F6E;">&mdash; &mdash; &mdash;</td></tr>'
     || '<tr><td style="padding:0 56px 56px 56px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:18px;color:#8A7F6E;">Sent from {{product}}. Not what you signed up for? <a href="{{unsubscribe_url}}" style="color:#8A7F6E;text-decoration:underline;">Unsubscribe</a>.</td></tr>'
     || '</table>',
     '[{"name":"first_name","label":"First name","default":"there"},{"name":"one_question","label":"The question","default":"What is the single thing you are hoping {{product}} fixes this month?"},{"name":"product","label":"Product","default":"Postwave"},{"name":"founder_name","label":"Founder","default":"Harsh"},{"name":"reply_email","label":"Reply-to","default":"harsh@postwave.com"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
     ARRAY['welcome','reply','founder','conversational'],
     'welcome',
     true),

    -- 2. newsletter-one-link
    (NULL, 'newsletter-one-link',
     'One-Link Roundup',
     'A newsletter with exactly one link — chosen, defended, contextualized — with a refusal to include anything else this week.',
     'marketing',
     'One link this week. Just this one.',
     'We had five candidates. We killed four. Here is the one that survived.',
        '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;margin:0 auto;">'
     || '<tr><td style="padding:56px 48px 28px 48px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">ROUNDUP &middot; ONE LINK &middot; {{issue_date}}</div></td></tr>'
     || '<tr><td style="padding:0 48px 24px 48px;"><div style="font-family:Georgia,''Times New Roman'',serif;font-size:30px;line-height:38px;color:#1A1A1A;font-weight:normal;">One link this week. Just this one.</div></td></tr>'
     || '<tr><td style="padding:0 48px 32px 48px;"><div style="font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:26px;color:#1A1A1A;"><a href="{{link_url}}" style="color:#0A66C2;text-decoration:underline;font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:26px;">{{link_title}}</a></div></td></tr>'
     || '<tr><td style="padding:0 48px 36px 48px;"><div style="font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:26px;color:#1A1A1A;">{{why_this_one}}</div></td></tr>'
     || '<tr><td style="padding:0 48px 28px 48px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1px;color:#D4D4D4;letter-spacing:0.04em;">&#9472;&#9472;&#9472;</div></td></tr>'
     || '<tr><td style="padding:0 48px 12px 48px;"><div style="font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-size:12px;line-height:18px;color:#737373;">Killed this week</div></td></tr>'
     || '<tr><td style="padding:0 48px 8px 48px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:20px;color:#A3A3A3;text-decoration:line-through;">{{killed_one}}</div></td></tr>'
     || '<tr><td style="padding:0 48px 8px 48px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:20px;color:#A3A3A3;text-decoration:line-through;">{{killed_two}}</div></td></tr>'
     || '<tr><td style="padding:0 48px 8px 48px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:20px;color:#A3A3A3;text-decoration:line-through;">A think-piece about AI that said nothing new</div></td></tr>'
     || '<tr><td style="padding:0 48px 48px 48px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:20px;color:#A3A3A3;text-decoration:line-through;">A founder thread that was actually an ad</div></td></tr>'
     || '<tr><td style="padding:0 48px 56px 48px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:18px;letter-spacing:0.08em;color:#A3A3A3;"><a href="{{unsubscribe_url}}" style="color:#A3A3A3;text-decoration:underline;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;">Unsubscribe</a></div></td></tr>'
     || '</table>',
     '[{"name":"issue_date","label":"Issue date","default":"June 3"},{"name":"link_title","label":"Link title","default":"How Substack writers lost the Tuesday-10am habit"},{"name":"link_url","label":"Link URL","default":"https://example.com/article"},{"name":"why_this_one","label":"Why this one","default":"Because it is the first piece naming what we have all been quietly noticing."},{"name":"killed_one","label":"Killed 1","default":"Yet another ''best send time'' study"},{"name":"killed_two","label":"Killed 2","default":"A vendor whitepaper masquerading as research"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
     ARRAY['newsletter','minimal','curation','editorial'],
     'newsletter',
     true),

    -- 3. newsletter-margin-notes
    (NULL, 'newsletter-margin-notes',
     'Margin-Notes Newsletter',
     'A long-form essay newsletter rendered with margin-style annotations and pull-quotes — the layout itself does the curating.',
     'marketing',
     '{{essay_title}}',
     'An essay you can read in 4 minutes — or skim the margin notes in 40 seconds.',
        '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;background-color:#FAF9F6;">'
     || '<tr><td style="padding:48px 40px 32px 40px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#7A6F5C;">{{author_name}} &middot; {{read_time}}</div></td></tr>'
     || '<tr><td style="padding:0 40px 28px 40px;"><h1 style="margin:0;font-family:Georgia,''Times New Roman'',serif;font-size:30px;line-height:38px;color:#1A1A1A;font-weight:400;">{{essay_title}}</h1></td></tr>'
     || '<tr><td style="padding:0 40px 8px 40px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;color:#B8AC95;">&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;</div></td></tr>'
     || '<tr><td style="padding:24px 40px 0 40px;"><table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;">'
     || '<tr valign="top"><td width="380" style="width:380px;padding:0 20px 0 0;font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:28px;color:#2A2A2A;">'
     || '<p style="margin:0 0 20px 0;">There is a particular kind of attention the modern reader has lost &mdash; not the ability to focus, exactly, but the willingness to follow a single thought through three paragraphs before checking whether it pays off.</p>'
     || '<p style="margin:0 0 20px 0;">I have been thinking about this because of a notebook I found from 1987. The previous owner had written the body of an essay on the left page and, on the right, four words: <em>this is the turn.</em> A signal to her future self that the argument was about to pivot.</p>'
     || '<p style="margin:0 0 24px 0;">We used to read with a pencil. We used to argue with the margin. Now we scroll, and the margin is empty, and the argument loses.</p>'
     || '<table role="presentation" width="340" cellpadding="0" cellspacing="0" border="0" style="width:340px;margin:0 0 24px 0;"><tr><td style="padding:8px 0 8px 20px;border-left:3px solid #C9B68A;font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-size:20px;line-height:30px;color:#4A3F2E;">{{pull_quote}}</td></tr></table>'
     || '<p style="margin:0 0 20px 0;">So this newsletter is an experiment. The essay is on the left. The margin is on the right. If you have four minutes, read the essay. If you have forty seconds, skim the notes and you will still leave with the shape of the idea.</p>'
     || '<p style="margin:0;">Either way &mdash; thank you for the attention. It is the only currency I trust.</p>'
     || '</td><td width="180" style="width:180px;">'
     || '<table role="presentation" width="180" cellpadding="0" cellspacing="0" border="0" style="width:180px;background-color:#FFFFFF;border:1px solid #E8E0CC;margin-bottom:12px;"><tr><td style="padding:16px;">'
     || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#9A8C6E;margin-bottom:8px;">Note 01</div>'
     || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:19px;color:#2A2A2A;">{{margin_one}}</div>'
     || '</td></tr></table>'
     || '<table role="presentation" width="180" cellpadding="0" cellspacing="0" border="0" style="width:180px;background-color:#FFFFFF;border:1px solid #E8E0CC;margin-bottom:12px;"><tr><td style="padding:16px;">'
     || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#9A8C6E;margin-bottom:8px;">Note 02</div>'
     || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:19px;color:#2A2A2A;">{{margin_two}}</div>'
     || '</td></tr></table>'
     || '<table role="presentation" width="180" cellpadding="0" cellspacing="0" border="0" style="width:180px;background-color:#FFFFFF;border:1px solid #E8E0CC;"><tr><td style="padding:16px;">'
     || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#9A8C6E;margin-bottom:8px;">Note 03</div>'
     || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:19px;color:#2A2A2A;">{{margin_three}}</div>'
     || '</td></tr></table>'
     || '</td></tr></table></td></tr>'
     || '<tr><td style="padding:40px 40px 16px 40px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;color:#B8AC95;">&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;&mdash;</div></td></tr>'
     || '<tr><td style="padding:0 40px 48px 40px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#7A6F5C;line-height:18px;"><a href="{{archive_url}}" style="color:#7A6F5C;text-decoration:none;">Read in archive</a> &nbsp;&nbsp;/&nbsp;&nbsp; <a href="{{unsubscribe_url}}" style="color:#7A6F5C;text-decoration:none;">Unsubscribe</a></div></td></tr>'
     || '</table>',
     '[{"name":"essay_title","label":"Essay title","default":"The Tuesday problem"},{"name":"author_name","label":"Author","default":"Harsh"},{"name":"read_time","label":"Read time","default":"4 min"},{"name":"margin_one","label":"Margin 1","default":"73% of B2B sends cluster on Tue 10am"},{"name":"margin_two","label":"Margin 2","default":"Gmail''s throttle treats this as a bulk signal"},{"name":"margin_three","label":"Margin 3","default":"Moving to Thu 7am won us 4 points"},{"name":"pull_quote","label":"Pull-quote","default":"The day everyone sends is the day no one reads."},{"name":"archive_url","label":"Archive URL","default":"https://postwave.com/archive"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
     ARRAY['newsletter','longform','annotated'],
     'newsletter',
     false),

    -- 4. announcement-sunset-with-runway
    (NULL, 'announcement-sunset-with-runway',
     'Sunset with a Runway',
     'A respectful sunset announcement that pairs the end date with a precise migration runway and a one-click export — written like an apology.',
     'marketing',
     'We are sunsetting {{feature}} on {{sunset_date}}',
     'Here is the date, the why, the runway, and a one-click export. We owe you all four.',
        '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;background-color:#FFFFFF;margin:0 auto;">'
     || '<tr><td style="padding:48px 48px 0 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#6B6B6B;">Deprecation notice &middot; {{feature}}</td></tr>'
     || '<tr><td style="padding:32px 48px 8px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#B45309;">Sunset date</td></tr>'
     || '<tr><td style="padding:0 48px 16px 48px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:88px;line-height:96px;font-weight:700;color:#111111;letter-spacing:-0.04em;">{{sunset_date}}</td></tr>'
     || '<tr><td style="padding:8px 48px 0 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#6B6B6B;">───</td></tr>'
     || '<tr><td style="padding:24px 48px 8px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#6B6B6B;">Why</td></tr>'
     || '<tr><td style="padding:0 48px 32px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:26px;color:#1A1A1A;">{{why_paragraph}}</td></tr>'
     || '<tr><td style="padding:0 48px 0 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#6B6B6B;">───</td></tr>'
     || '<tr><td style="padding:24px 48px 16px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#6B6B6B;">Runway</td></tr>'
     || '<tr><td style="padding:0 48px 4px 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">'
     || '<tr><td width="14" valign="top" style="width:14px;padding:6px 14px 6px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:20px;color:#B45309;">&bull;</td>'
     || '<td valign="top" style="padding:6px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:20px;color:#1A1A1A;letter-spacing:0.02em;">{{milestone_one}}</td></tr>'
     || '<tr><td width="14" valign="top" style="width:14px;padding:6px 14px 6px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:20px;color:#B45309;">&bull;</td>'
     || '<td valign="top" style="padding:6px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:20px;color:#1A1A1A;letter-spacing:0.02em;">{{milestone_two}}</td></tr>'
     || '<tr><td width="14" valign="top" style="width:14px;padding:6px 14px 6px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:20px;color:#DC2626;">&bull;</td>'
     || '<td valign="top" style="padding:6px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:20px;color:#111111;font-weight:600;letter-spacing:0.02em;">{{milestone_three}}</td></tr>'
     || '</table></td></tr>'
     || '<tr><td style="padding:24px 48px 0 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#6B6B6B;">───</td></tr>'
     || '<tr><td style="padding:32px 48px 40px 48px;"><a href="{{export_url}}" style="display:inline-block;background-color:#111111;color:#FFFFFF;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:15px;line-height:20px;font-weight:600;text-decoration:none;padding:16px 32px;border-radius:6px;letter-spacing:0.01em;">Export everything (1 click) &rarr;</a></td></tr>'
     || '<tr><td style="padding:0 48px 24px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#6B6B6B;">───</td></tr>'
     || '<tr><td style="padding:0 48px 8px 48px;font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-size:16px;line-height:24px;color:#1A1A1A;">No spin. No pivot copy. We built it, it did not earn its keep, and we owe you the runway to leave clean.</td></tr>'
     || '<tr><td style="padding:0 48px 48px 48px;font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-size:16px;line-height:24px;color:#1A1A1A;">— {{founder_name}}</td></tr>'
     || '<tr><td style="padding:24px 48px 48px 48px;border-top:1px solid #E5E5E5;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:18px;letter-spacing:0.12em;text-transform:uppercase;color:#6B6B6B;">Deprecation notice &middot; {{feature}} &middot; <a href="{{unsubscribe_url}}" style="color:#6B6B6B;text-decoration:underline;">Unsubscribe</a></td></tr>'
     || '</table>',
     '[{"name":"feature","label":"Feature","default":"Legacy Segment API v1"},{"name":"sunset_date","label":"Sunset date","default":"AUG 31"},{"name":"why_paragraph","label":"Why","default":"v1 was built when we had 200 customers and 6 segments per workspace. Rather than patch it badly, we are retiring it."},{"name":"milestone_one","label":"Milestone 1","default":"JUN 15 · v2 reaches feature parity"},{"name":"milestone_two","label":"Milestone 2","default":"JUL 31 · v1 returns deprecation warnings"},{"name":"milestone_three","label":"Milestone 3","default":"AUG 31 · v1 returns 410 Gone"},{"name":"export_url","label":"Export URL","default":"https://app.postwave.com/export/legacy"},{"name":"founder_name","label":"Signature","default":"Harsh"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
     ARRAY['announcement','sunset','deprecation'],
     'announcement',
     true),

    -- 5. promotional-loyalty-no-coupon
    (NULL, 'promotional-loyalty-no-coupon',
     'Loyalty Credit, No Coupon',
     'A loyalty promo that credits the user''s account with a stated amount — no code, no checkout, no expiration — just a deposit confirmation.',
     'marketing',
     'We deposited ${{credit_amount}} into your account',
     'No code, no checkout, no expiration. It is already in your balance.',
        '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;background-color:#FFFFFF;margin:0 auto;">'
     || '<tr><td style="padding:40px 40px 24px 40px;border-bottom:1px solid #E5E5E5;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;font-weight:500;">CREDIT POSTED &middot; {{posted_date}}</div></td></tr>'
     || '<tr><td style="padding:56px 40px 16px 40px;text-align:left;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:64px;line-height:1;font-weight:700;color:#15803D;letter-spacing:-0.02em;">+${{credit_amount}}</div></td></tr>'
     || '<tr><td style="padding:0 40px 48px 40px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:#737373;letter-spacing:0.04em;">TO &middot; {{account_email}}</div></td></tr>'
     || '<tr><td style="padding:0 40px 8px 40px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;font-weight:500;">ACCOUNT LEDGER</div></td></tr>'
     || '<tr><td style="padding:0 40px 40px 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E5E5E5;border-bottom:1px solid #E5E5E5;">'
     || '<tr><td style="padding:14px 0;border-bottom:1px solid #F0F0F0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#737373;">Previous balance</td>'
     || '<td align="right" style="padding:14px 0;border-bottom:1px solid #F0F0F0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#737373;">${{prev_balance}}</td></tr>'
     || '<tr><td style="padding:14px 0;border-bottom:1px solid #F0F0F0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#15803D;">Credit posted</td>'
     || '<td align="right" style="padding:14px 0;border-bottom:1px solid #F0F0F0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#15803D;">+${{credit_amount}}</td></tr>'
     || '<tr><td style="padding:14px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;font-weight:700;color:#111111;">New balance</td>'
     || '<td align="right" style="padding:14px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;font-weight:700;color:#111111;">${{new_balance}}</td></tr>'
     || '</table></td></tr>'
     || '<tr><td style="padding:0 40px 16px 40px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;font-weight:500;">WHY THIS LANDED</div></td></tr>'
     || '<tr><td style="padding:0 40px 40px 40px;"><p style="margin:0;font-family:Georgia,''Times New Roman'',serif;font-size:16px;line-height:1.6;font-style:italic;color:#404040;">{{reason_paragraph}}</p></td></tr>'
     || '<tr><td style="padding:0 40px 16px 40px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#737373;">No code. No checkout. No expiration.</div><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#737373;margin-top:4px;">It is already in your balance.</div></td></tr>'
     || '<tr><td style="padding:8px 40px 56px 40px;"><a href="{{balance_url}}" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:#111111;text-decoration:underline;font-weight:600;letter-spacing:0.02em;display:inline-block;padding:14px 0;min-height:44px;">View your balance &rarr;</a></td></tr>'
     || '<tr><td style="padding:24px 40px 16px 40px;border-top:1px solid #E5E5E5;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">* &nbsp; * &nbsp; *</div></td></tr>'
     || '<tr><td style="padding:0 40px 40px 40px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.7;color:#A3A3A3;letter-spacing:0.04em;">STATEMENT &middot; {{posted_date}}<br>ACCOUNT &middot; {{account_email}}<br>REFERENCE &middot; CRD-{{posted_date}}</div>'
     || '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#A3A3A3;margin-top:20px;letter-spacing:0.04em;"><a href="{{unsubscribe_url}}" style="color:#A3A3A3;text-decoration:underline;">Unsubscribe</a></div></td></tr>'
     || '</table>',
     '[{"name":"credit_amount","label":"Credit amount","default":"50"},{"name":"posted_date","label":"Posted date","default":"JUN 3 · 9:14 IST"},{"name":"account_email","label":"Account email","default":"mira@loomstack.io"},{"name":"prev_balance","label":"Previous balance","default":"0.00"},{"name":"new_balance","label":"New balance","default":"50.00"},{"name":"reason_paragraph","label":"Reason","default":"Because you have been a customer for 24 months — and we wanted to say it with money, not a coupon."},{"name":"balance_url","label":"Balance URL","default":"https://app.postwave.com/billing"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
     ARRAY['promotional','loyalty','credit','anti-urgency'],
     'promotional',
     true),

    -- 6. re-engagement-letter-from-future-self
    (NULL, 're-engagement-letter-from-future-self',
     'Letter From Future Self',
     'A re-engagement framed as a letter the reader''s future self would write — an unconventional, empathy-first ask to reopen the relationship.',
     'marketing',
     'A short letter from the version of you who came back',
     'Not a discount. Not a guilt trip. A two-paragraph letter, then your choice.',
        '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FAF9F6;margin:0 auto;">'
     || '<tr><td style="padding:56px 56px 24px 56px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#8A8578;">A Letter &middot; Not From Us</td></tr>'
     || '<tr><td style="padding:8px 56px 28px 56px;font-family:Georgia,''Times New Roman'',serif;font-size:28px;font-style:italic;line-height:1.3;color:#2A2A2A;">Dear {{first_name}},</td></tr>'
     || '<tr><td style="padding:0 56px 24px 56px;font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:28px;font-style:italic;color:#2A2A2A;">{{paragraph_one}}</td></tr>'
     || '<tr><td style="padding:0 56px 36px 56px;font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:28px;font-style:italic;color:#2A2A2A;">{{paragraph_two}}</td></tr>'
     || '<tr><td style="padding:0 56px 8px 56px;font-family:Georgia,''Times New Roman'',serif;font-size:20px;font-style:italic;line-height:1.4;color:#2A2A2A;">Future {{first_name}}</td></tr>'
     || '<tr><td align="center" style="padding:40px 56px 40px 56px;font-family:Georgia,''Times New Roman'',serif;font-size:18px;letter-spacing:0.4em;color:#B8B2A3;">*&nbsp;&nbsp;*&nbsp;&nbsp;*</td></tr>'
     || '<tr><td align="center" style="padding:0 56px 16px 56px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">'
     || '<tr><td style="padding:14px 24px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:1.4;color:#1A1A1A;"><a href="{{come_back_url}}" style="color:#1A1A1A;text-decoration:underline;text-underline-offset:4px;font-weight:500;">come back</a></td>'
     || '<td style="padding:14px 8px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;color:#B8B2A3;">&nbsp;</td>'
     || '<td style="padding:14px 24px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:1.4;color:#1A1A1A;"><a href="{{stay_gone_url}}" style="color:#1A1A1A;text-decoration:underline;text-underline-offset:4px;font-weight:500;">stay gone</a></td></tr>'
     || '</table></td></tr>'
     || '<tr><td style="padding:48px 56px 56px 56px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#9A9486;line-height:1.6;">No tracking pixels in this one.<br /><a href="{{unsubscribe_url}}" style="color:#9A9486;text-decoration:underline;">Unsubscribe</a></td></tr>'
     || '</table>',
     '[{"name":"first_name","label":"First name","default":"Mira"},{"name":"paragraph_one","label":"Letter para 1","default":"I almost deleted that email too. The first thing I did when I came back was rebuild the segment we had been arguing about — it took 4 minutes."},{"name":"paragraph_two","label":"Letter para 2","default":"We are still here. The product got quieter and better. Come see for yourself, or don''t — both are fine."},{"name":"come_back_url","label":"Come back URL","default":"https://app.postwave.com/welcome-back"},{"name":"stay_gone_url","label":"Stay gone URL","default":"https://postwave.com/unsubscribe"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
     ARRAY['re-engagement','narrative','letter'],
     're_engagement',
     false),

    -- 7. transactional-export-ready
    (NULL, 'transactional-export-ready',
     'Export Ready with Half-Life',
     'An export-ready notification with file metadata, SHA-256 hash, and a precise deletion countdown — engineering-grade transparency.',
     'transactional',
     'Your export is ready — deletes in {{ttl_hours}}h',
     'Download link, file size, SHA-256, and a half-life timer. That is the whole email.',
        '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;margin:0 auto;">'
     || '<tr><td style="padding:48px 48px 24px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#6B6B66;">EXPORT READY &middot; JOB {{job_id}}</td></tr>'
     || '<tr><td style="padding:0 48px 32px 48px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:26px;line-height:32px;font-weight:600;color:#111111;letter-spacing:-0.01em;">{{headline}}</td></tr>'
     || '<tr><td style="padding:0 48px 0 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#F4F4F0;border-radius:4px;">'
     || '<tr><td style="padding:24px 24px 8px 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:22px;color:#111111;"><span style="display:inline-block;width:90px;color:#6B6B66;letter-spacing:0.08em;">FILE</span><span style="color:#111111;">&middot; {{file_name}}</span></td></tr>'
     || '<tr><td style="padding:0 24px 0 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:22px;color:#111111;"><span style="display:inline-block;width:90px;color:#6B6B66;letter-spacing:0.08em;">SIZE</span><span style="color:#111111;">&middot; {{file_size}}</span></td></tr>'
     || '<tr><td style="padding:0 24px 0 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:22px;color:#111111;"><span style="display:inline-block;width:90px;color:#6B6B66;letter-spacing:0.08em;">ROWS</span><span style="color:#111111;">&middot; {{row_count}}</span></td></tr>'
     || '<tr><td style="padding:0 24px 0 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:22px;color:#111111;word-break:break-all;"><span style="display:inline-block;width:90px;color:#6B6B66;letter-spacing:0.08em;vertical-align:top;">SHA-256</span><span style="color:#111111;">&middot; {{sha_hash}}</span></td></tr>'
     || '<tr><td style="padding:0 24px 24px 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:22px;color:#111111;"><span style="display:inline-block;width:90px;color:#6B6B66;letter-spacing:0.08em;">EXPIRES</span><span style="color:#111111;">&middot; {{expires_at}}</span></td></tr>'
     || '</table></td></tr>'
     || '<tr><td style="padding:24px 48px 8px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#6B6B66;">HALF-LIFE</td></tr>'
     || '<tr><td style="padding:0 48px 32px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:56px;line-height:60px;font-weight:600;color:#111111;letter-spacing:-0.02em;">{{ttl_hours}}h</td></tr>'
     || '<tr><td style="padding:0 48px 40px 48px;"><a href="{{download_url}}" style="display:inline-block;background-color:#111111;color:#FFFFFF;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:14px;line-height:20px;font-weight:600;text-decoration:none;padding:16px 28px;border-radius:6px;letter-spacing:0.01em;">Download CSV &rarr;</a></td></tr>'
     || '<tr><td style="padding:0 48px 32px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:12px;line-height:18px;font-style:italic;color:#6B6B66;">Link signed for your IP only. Deleted automatically.</td></tr>'
     || '<tr><td style="padding:24px 48px 48px 48px;border-top:1px solid #E8E8E2;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:12px;line-height:18px;color:#6B6B66;">Questions about this export? Reply to <a href="mailto:{{support_email}}" style="color:#111111;text-decoration:underline;">{{support_email}}</a>.</td></tr>'
     || '</table>',
     '[{"name":"job_id","label":"Job ID","default":"exp_01HZQ8K"},{"name":"headline","label":"Headline","default":"Your subscriber export is ready"},{"name":"file_name","label":"File name","default":"subscribers-2026-06-03.csv"},{"name":"file_size","label":"File size","default":"14.2 MB"},{"name":"row_count","label":"Row count","default":"124,308"},{"name":"sha_hash","label":"SHA-256","default":"7a3f9c1d...e1c2"},{"name":"ttl_hours","label":"TTL hours","default":"24"},{"name":"expires_at","label":"Expires at","default":"2026-06-04 09:14 UTC"},{"name":"download_url","label":"Download URL","default":"https://app.postwave.com/exports/signed/abc123"},{"name":"support_email","label":"Support","default":"support@postwave.com"}]'::jsonb,
     ARRAY['transactional','export','data','engineering'],
     'transactional',
     true),

    -- 8. transactional-security-new-device
    (NULL, 'transactional-security-new-device',
     'New-Device Security Alert',
     'A new-device sign-in alert with a fingerprint card, a map-free location panel, and a one-tap revoke — security UX without anxiety.',
     'transactional',
     'New sign-in on {{device_label}}',
     'If this was you, ignore. If not, one tap revokes the session and rotates your token.',
        '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;margin:0 auto;">'
     || '<tr><td style="padding:48px 48px 0 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">SECURITY EVENT &middot; {{event_id}}</td></tr>'
     || '<tr><td style="padding:20px 48px 0 48px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:24px;line-height:32px;font-weight:600;color:#111111;">New sign-in on {{device_label}}</td></tr>'
     || '<tr><td style="padding:16px 48px 0 48px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:15px;line-height:24px;color:#404040;">Hi {{first_name}} — we recorded a new authenticated session on your account. Review the fingerprint below.</td></tr>'
     || '<tr><td style="padding:28px 48px 0 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F4F0;">'
     || '<tr><td style="padding:24px 24px 8px 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">FINGERPRINT</td></tr>'
     || '<tr><td style="padding:8px 24px 0 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:22px;color:#111111;"><span style="color:#737373;">DEVICE&nbsp;&nbsp;&nbsp;</span>{{device_label}}</td></tr>'
     || '<tr><td style="padding:0 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:22px;color:#111111;"><span style="color:#737373;">BROWSER&nbsp;&nbsp;</span>{{browser}}</td></tr>'
     || '<tr><td style="padding:0 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:22px;color:#111111;"><span style="color:#737373;">IP&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>{{ip_rounded}}</td></tr>'
     || '<tr><td style="padding:0 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:22px;color:#111111;"><span style="color:#737373;">LOCATION&nbsp;</span>{{coarse_location}}</td></tr>'
     || '<tr><td style="padding:0 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:22px;color:#111111;"><span style="color:#737373;">ASN&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>{{asn}}</td></tr>'
     || '<tr><td style="padding:0 24px 24px 24px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:22px;color:#111111;"><span style="color:#737373;">AT&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>{{timestamp}}</td></tr>'
     || '</table></td></tr>'
     || '<tr><td style="padding:32px 48px 0 48px;font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-size:16px;line-height:24px;color:#404040;">If this was you, ignore.</td></tr>'
     || '<tr><td style="padding:24px 48px 0 48px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:15px;line-height:24px;color:#404040;">If it wasn''t, one tap signs that session out and rotates the API token tied to it.</td></tr>'
     || '<tr><td style="padding:28px 48px 0 48px;"><a href="{{revoke_url}}" style="display:inline-block;background-color:#DC2626;color:#FFFFFF;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:15px;line-height:20px;font-weight:600;text-decoration:none;padding:16px 32px;border-radius:999px;">Revoke + rotate token &rarr;</a></td></tr>'
     || '<tr><td style="padding:20px 48px 0 48px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:12px;line-height:18px;color:#737373;"><a href="{{sessions_url}}" style="color:#737373;text-decoration:underline;">View sessions &rarr;</a></td></tr>'
     || '<tr><td style="padding:40px 48px 16px 48px;border-top:1px solid #E5E5E5;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">&nbsp;</td></tr>'
     || '<tr><td style="padding:0 48px 48px 48px;font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:12px;line-height:18px;color:#737373;">This is a security notification from Postwave. Reply to this email if you need help from support — a human will respond.</td></tr>'
     || '</table>',
     '[{"name":"event_id","label":"Event ID","default":"sec_01HZQ9A"},{"name":"first_name","label":"First name","default":"Mira"},{"name":"device_label","label":"Device","default":"MacBook Pro · macOS 14.5"},{"name":"browser","label":"Browser","default":"Safari 17.5"},{"name":"ip_rounded","label":"IP rounded","default":"203.0.113.x"},{"name":"coarse_location","label":"Location","default":"Bangalore, IN (approx)"},{"name":"asn","label":"ASN","default":"AS15169 Google LLC"},{"name":"timestamp","label":"Timestamp","default":"2026-06-03 09:14 IST"},{"name":"revoke_url","label":"Revoke URL","default":"https://app.postwave.com/security/revoke/abc"},{"name":"sessions_url","label":"Sessions URL","default":"https://app.postwave.com/security/sessions"}]'::jsonb,
     ARRAY['transactional','security','device'],
     'transactional',
     false),

    -- 9. automation-milestone-cohort-hit
    (NULL, 'automation-milestone-cohort-hit',
     'Cohort Milestone Hit',
     'Fires when a customer crosses a usage milestone — pairing their number with the cohort percentile they just entered, no balloons.',
     'marketing',
     '{{milestone_value}} {{metric_name}} — you are in the top {{percentile}}%',
     'Not a confetti email. Just the number and a one-line context for what it means.',
        '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;background-color:#FFFFFF;margin:0 auto;">'
     || '<tr><td style="padding:48px 48px 24px 48px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">MILESTONE &middot; {{trigger_date}}</div></td></tr>'
     || '<tr><td align="center" style="padding:24px 48px 8px 48px;"><div style="font-family:Georgia,''Times New Roman'',serif;font-size:96px;line-height:1;font-weight:800;color:#111111;letter-spacing:-0.04em;">{{milestone_value}}</div></td></tr>'
     || '<tr><td align="center" style="padding:16px 48px 32px 48px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#737373;">{{metric_name}}</div></td></tr>'
     || '<tr><td align="center" style="padding:8px 48px 8px 48px;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#A3A3A3;letter-spacing:0.1em;">&#9472;&#9472;&#9472;</div></td></tr>'
     || '<tr><td align="center" style="padding:24px 48px 8px 48px;"><div style="font-family:system-ui,-apple-system,''Segoe UI'',sans-serif;font-size:32px;line-height:1.1;font-weight:600;color:#15803D;letter-spacing:-0.01em;">Top {{percentile}}%</div></td></tr>'
     || '<tr><td align="center" style="padding:12px 64px 36px 64px;"><div style="font-family:Georgia,''Times New Roman'',serif;font-style:italic;font-size:14px;line-height:1.5;color:#525252;">{{cohort_caption}}</div></td></tr>'
     || '<tr><td style="padding:24px 48px 8px 48px;border-top:1px solid #E5E5E5;"></td></tr>'
     || '<tr><td style="padding:16px 48px 4px 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">'
     || '<tr><td align="left" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#737373;letter-spacing:0.04em;padding:6px 0;">median</td>'
     || '<td align="right" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#525252;font-weight:400;padding:6px 0;">{{median_value}}</td></tr>'
     || '<tr><td align="left" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#737373;letter-spacing:0.04em;padding:6px 0;border-top:1px solid #F5F5F5;">p90</td>'
     || '<td align="right" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#525252;font-weight:400;padding:6px 0;border-top:1px solid #F5F5F5;">{{p90_value}}</td></tr>'
     || '<tr><td align="left" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#111111;letter-spacing:0.04em;padding:6px 0;border-top:1px solid #F5F5F5;font-weight:700;">yours</td>'
     || '<td align="right" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#111111;font-weight:700;padding:6px 0;border-top:1px solid #F5F5F5;">{{milestone_value}}</td></tr>'
     || '</table></td></tr>'
     || '<tr><td style="padding:32px 48px 48px 48px;"><a href="{{benchmark_url}}" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#111111;text-decoration:underline;text-underline-offset:3px;letter-spacing:0.02em;">See the full benchmark &rarr;</a></td></tr>'
     || '<tr><td style="padding:24px 48px 48px 48px;border-top:1px solid #E5E5E5;"><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#A3A3A3;line-height:1.7;">Sent because you crossed a tracked threshold.<br><a href="{{unsubscribe_url}}" style="color:#A3A3A3;text-decoration:underline;">Unsubscribe</a></div></td></tr>'
     || '</table>',
     '[{"name":"milestone_value","label":"Milestone","default":"10,000"},{"name":"metric_name","label":"Metric name","default":"SUBSCRIBERS"},{"name":"percentile","label":"Percentile","default":"12"},{"name":"trigger_date","label":"Trigger date","default":"JUN 3"},{"name":"cohort_caption","label":"Cohort caption","default":"of workspaces in your industry — based on 4,812 peers"},{"name":"median_value","label":"Median","default":"1,840"},{"name":"p90_value","label":"P90","default":"8,200"},{"name":"benchmark_url","label":"Benchmark URL","default":"https://app.postwave.com/benchmarks"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
     ARRAY['automation','milestone','cohort'],
     'automation',
     true),

    -- 10. automation-post-send-debrief
    (NULL, 'automation-post-send-debrief',
     'Post-Send Debrief',
     'Fires 48 hours after a campaign send with three honest takeaways and one tactical next step — written like a post-mortem.',
     'marketing',
     '48-hour debrief on {{campaign_name}}',
     'Three takeaways. One thing worth trying next. No vanity charts.',
        '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;margin:0 auto;">'
     || '<tr><td style="padding:40px 48px 28px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;letter-spacing:0.18em;text-transform:uppercase;color:#6B7280;">DEBRIEF &middot; 48H POST-SEND &middot; {{campaign_name}}</td></tr>'
     || '<tr><td style="padding:0 48px 8px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:26px;line-height:34px;color:#111111;font-weight:400;">48 hours later. Here''s the calm read on {{campaign_name}}.</td></tr>'
     || '<tr><td style="padding:0 48px 28px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:15px;line-height:24px;color:#6B7280;font-style:italic;">Three takeaways. One thing worth trying next. No vanity charts.</td></tr>'
     || '<tr><td style="padding:0 48px 0 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">'
     || '<tr><td style="padding:10px 14px;background-color:#15803D;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:14px;letter-spacing:0.18em;text-transform:uppercase;color:#FFFFFF;font-weight:600;">GOOD</td></tr>'
     || '<tr><td style="padding:16px 0 28px 0;font-family:Georgia,''Times New Roman'',serif;font-size:16px;line-height:26px;color:#111111;">{{good_takeaway}}</td></tr>'
     || '</table></td></tr>'
     || '<tr><td style="padding:0 48px 0 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">'
     || '<tr><td style="padding:10px 14px;background-color:#B45309;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:14px;letter-spacing:0.18em;text-transform:uppercase;color:#FFFFFF;font-weight:600;">SURPRISING</td></tr>'
     || '<tr><td style="padding:16px 0 28px 0;font-family:Georgia,''Times New Roman'',serif;font-size:16px;line-height:26px;color:#111111;">{{surprising_takeaway}}</td></tr>'
     || '</table></td></tr>'
     || '<tr><td style="padding:0 48px 0 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">'
     || '<tr><td style="padding:10px 14px;background-color:#DC2626;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:14px;letter-spacing:0.18em;text-transform:uppercase;color:#FFFFFF;font-weight:600;">WORRYING</td></tr>'
     || '<tr><td style="padding:16px 0 32px 0;font-family:Georgia,''Times New Roman'',serif;font-size:16px;line-height:26px;color:#111111;">{{worrying_takeaway}}</td></tr>'
     || '</table></td></tr>'
     || '<tr><td align="center" style="padding:0 48px 28px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:20px;color:#D1D5DB;letter-spacing:0.1em;">&#9472;&#9472;&#9472;</td></tr>'
     || '<tr><td style="padding:0 48px 12px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:18px;line-height:28px;color:#111111;font-style:italic;">What to try next &rarr;</td></tr>'
     || '<tr><td style="padding:0 48px 24px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:16px;line-height:26px;color:#374151;">{{next_step}}</td></tr>'
     || '<tr><td style="padding:0 48px 36px 48px;font-family:Georgia,''Times New Roman'',serif;font-size:16px;line-height:26px;"><a href="{{next_step_url}}" style="color:#111111;text-decoration:underline;font-style:italic;">Set this up in the next campaign &rarr;</a></td></tr>'
     || '<tr><td style="padding:0 48px 28px 48px;border-top:1px solid #E5E7EB;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:18px;letter-spacing:0.12em;text-transform:uppercase;color:#6B7280;padding-top:24px;"><a href="{{dashboard_url}}" style="color:#6B7280;text-decoration:none;">View full dashboard &rarr;</a></td></tr>'
     || '<tr><td style="padding:0 48px 40px 48px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:18px;letter-spacing:0.08em;color:#9CA3AF;">Postwave &middot; Sent because you opted in to campaign debriefs.<br><a href="{{unsubscribe_url}}" style="color:#9CA3AF;text-decoration:underline;">Unsubscribe</a></td></tr>'
     || '</table>',
     '[{"name":"campaign_name","label":"Campaign","default":"May Product Update"},{"name":"good_takeaway","label":"Good","default":"Open rate of 38% beat your 90-day median by 6 points — your subject line landed."},{"name":"surprising_takeaway","label":"Surprising","default":"Mobile click-through was 2.3× desktop — your hero CTA may be over-optimized for desktop."},{"name":"worrying_takeaway","label":"Worrying","default":"Unsub rate jumped to 0.18% — three times your trailing average. Likely cause: a re-engaged dormant cohort."},{"name":"next_step","label":"Next step","default":"Try splitting the next send by recency cohort — keep your active list lean."},{"name":"next_step_url","label":"Next step URL","default":"https://app.postwave.com/segments/new"},{"name":"dashboard_url","label":"Dashboard URL","default":"https://app.postwave.com/campaigns/may-update"},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":"https://postwave.com/unsubscribe"}]'::jsonb,
     ARRAY['automation','post-send','debrief'],
     'automation',
     false)

ON CONFLICT (slug) WHERE tenant_id IS NULL DO NOTHING;

COMMIT;
