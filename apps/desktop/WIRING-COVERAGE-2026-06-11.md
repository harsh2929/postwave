# Backend↔Desktop Coverage Audit — 2026-06-11

Method: per package — exact mounted routes → api-client wrapper coverage → UI consumption.
Branch: feat/full-surface-wiring. This file is the implementation backlog for 100% coverage.

## Already FULLY WIRED (no action; corrects earlier roadmap assumptions)
flowbuilder (all 10 routes), developer_marketplace (all 22), paywall (members + tiers),
subscription_types, domain_warmup, sender_reputation, campaign_replies, campaign_summary,
campaign_to_template, newsletter_feed (public RSS), cohorts (Analytics), preferences
(public token pages — by design no desktop UI), automation service (all 8 proxied routes),
list_health, subscriber_dedupe (list), merge (preview).

## UNWIRED / PARTIAL — the backlog (route groups; shapes captured in audit)

### Campaign composer & pre-send
| # | Capability | Routes | Status |
|---|---|---|---|
| 1 | Block editor | GET /email-blocks/catalog, POST /email-blocks/compose | UNWIRED |
| 2 | Send-window policy | GET/PUT/DELETE /send-window, POST /send-window/check | UNWIRED |
| 3 | Accessibility check | POST /a11y/check | UNWIRED |
| 4 | AI translations | /translations/settings, /translations/dictionary CRUD+import/export | UNWIRED |
| 5 | From-name picker | GET /from-name-picker | UNWIRED |
| 6 | Link checker | POST /campaigns/{id}/check-links | UNWIRED |
| 7 | UTM templates | /utm-templates CRUD + apply + preview | UNWIRED |
| 8 | Subject analyzer | GET /subject-analyzer/buckets, POST /subject-analyzer/score | UNWIRED |
| 9 | Email validation | POST /email-validation/check, /check-batch | UNWIRED |

### Campaigns post-send & experimentation
| 10 | Resend unopened | POST /campaigns/{id}/resend-unopened | UNWIRED |
| 11 | Clone campaign | POST /campaigns/{id}/clone | UNWIRED |
| 12 | Holdout | POST/GET/DELETE /campaigns/{id}/holdout, GET .../holdout/lift | UNWIRED |
| 13 | Control groups | /control-groups CRUD + /{id}/report | UNWIRED |
| 14 | Content optimizer | GET/POST /campaigns/{id}/content-optimizer (+/preview) | UNWIRED |
| 15 | Content remix | POST /campaigns/{id}/remix | UNWIRED |
| 16 | Reply analytics | /replies/summary, /by-campaign/{id}, /top-senders, /timeseries | UNWIRED |

### Subscribers / CRM
| 17 | Lifecycle rollup | GET /lifecycle/distribution, /lifecycle/stages | PARTIAL |
| 18 | Lead scoring | GET/PUT /scoring/rules, POST /scoring/recompute | UNWIRED |
| 19 | Contact rating | GET /contact-ratings/{id}, POST /contact-ratings/recompute | UNWIRED |
| 20 | EQ score | POST /deliverability/eq-score | UNWIRED |
| 21 | Notes | /subscribers/{id}/notes CRUD | UNWIRED |
| 22 | Sunset policies | /sunset/policies CRUD + run + executions + reengagement/preview | UNWIRED |
| 23 | Inactive keys | GET /inactive-keys | UNWIRED |
| 24 | Growth sources | /growth-source/summary, /timeseries, /quality | UNWIRED |
| 25 | Preset segments | GET /preset-segments, /{key}/list | UNWIRED |
| 26 | Predictive/RFM | /predictive/catalog, /profiles, /profiles/{email}, /rfm/segments, /recompute | UNWIRED |
| 27 | Tag taxonomy ops | POST /tag-taxonomy/merge, /rename; GET /subscribers, /suggest | PARTIAL |

### Automations & triggers
| 28 | Zero-copy triggers | 12 routes: CRUD, validate, poll, fires, alerts, DLQ+retry | UNWIRED |
| 29 | Trigger delay prefs | GET/PUT /trigger-delay/preferences | UNWIRED |
| 30 | Omnichannel campaigns | /omnichannel/catalog, /campaigns CRUD, /validate | UNWIRED |

### Analytics & data platform
| 31 | Scheduled reports | /scheduled-reports CRUD + send-now | UNWIRED |
| 32 | Conversions | GET /conversions, /conversions/keys CRUD | UNWIRED |
| 33 | Commerce suite | ~20 routes: integrations, catalogs, feeds, cart-recovery, back-in-stock, price-drop, lifecycle | UNWIRED |
| 34 | Exports | POST/GET /exports, GET /exports/{id} | PARTIAL |
| 35 | Warehouse | 12 routes: catalog, validate, connections, mappings, runs, errors | UNWIRED |
| 36 | Custom objects | /custom-objects/types CRUD + records | UNWIRED |
| 37 | CDP transforms | POST /cdp/transforms/preview, GET /ops | UNWIRED |

### Deliverability (incl. services/deliverability via proxy)
| 38 | Spam-trap guard | /spam-trap-guard/hits, /stats, /run-now | UNWIRED |
| 39 | Soft-bounce recovery | /soft-bounce-recovery/stats, /run-now | UNWIRED |
| 40 | Intelligent retry | /intelligent-retry/events + mark-ready/dismiss | UNWIRED |
| 41 | ISP breakdown | /isp-breakdown, /isp-breakdown/by-campaign/{id} | UNWIRED |
| 42 | Campaign placement report | GET /api/v1/inbox-reality/campaigns/{id} (proxied) | UNWIRED |
| 43 | Auth-checks matrix | GET /v1/auth-checks (proxied) | UNWIRED |
| 44 | AI Diagnostician | POST /v1/diagnose/{campaign_id} (proxied) | UNWIRED |
| 45 | Blocklist auto-suppress | GET/PATCH /blocklist/auto-suppress | UNWIRED |
| 46 | List inbox-reality | GET /lists/{id}/inbox-reality | UNWIRED |

### Growth & monetization
| 47 | Paid tiers gaps | gift attribution/stats/cancel UI; paid-subs admin UI | PARTIAL |
| 48 | Firewall attack mode | /firewall/settings, /events, /stats, /detect | UNWIRED |
| 49 | Onsite growth | targeting, experiments, spin rewards (9 routes) | UNWIRED |
| 50 | Archive comments admin | GET /archive/comments + moderate/pin/unpin/delete | UNWIRED |
| 51 | Affiliates admin | /admin/affiliates CRUD + conversions + payouts | UNWIRED |
| 52 | Podcast tokens | /podcast/subscribers/{email}/token GET/POST/DELETE | UNWIRED |
| 53 | ActivityPub | /activitypub/actor (+provision), /inbox(+read), /followers, /outbox | UNWIRED |

### Platform & developer
| 54 | API usage dashboard | /api-usage/summary, /keys, /timeseries | UNWIRED |
| 55 | Cost ledger | /costs, /costs/ledger | UNWIRED |
| 56 | Feature flags | /feature-flags CRUD + resolve | UNWIRED |
| 57 | Regions | /api/regions, /api/regions/current (public) | UNWIRED |
| 58 | OpenAPI in-app | GET /api/v1/openapi.json | UNWIRED |
| 59 | Server-side palette search | GET /api/v1/search | UNWIRED |
| 60 | Discord/Teams receiver presets | (dispatchers exist; presets UI only) | UNWIRED |

Excluded (no tenant-facing HTTP surface): prioritization, subscriberscore, budgets,
llmactions (internal executors), mobilepush (public ingest), bounceclass (unmounted),
status (public page), webvitals (web-app ingest), archive_content_remix (unmounted).
