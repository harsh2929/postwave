# Moosewave for Zapier

The Moosewave [Zapier](https://zapier.com) integration. This package is a
[zapier-platform-cli](https://github.com/zapier/zapier-platform) app that
exposes Moosewave as both a **trigger source** (campaign sent, subscriber
added, subscriber unsubscribed, approval requested/decided, bounce received,
and subscriber added to a list) and an **action sink** (add / update
/ unsubscribe subscriber, send campaign, start sequence, add to / remove from
a list). A **search** (find subscriber) backs find-or-create Zaps.

## Architecture

Triggers use **REST Hooks** — Zapier calls our `performSubscribe`, which
POSTs to `/api/v1/outbound-webhooks` and persists the returned webhook id in
`subscribeData`. When Moosewave fires the event the customer subscribed to, it
POSTs the canonical `{event, webhook, delivery}` envelope to the
Zapier-supplied `targetUrl`. The trigger preserves that envelope and mirrors
the stable `event.id` to a root `id`, which Zapier uses for deduplication.
Automatic attempts and manual replay retain `event.id` but receive a new
`delivery.id`.

Authentication is a bearer-token API key (managed at
`https://app.moosewave.com/settings/api-keys`). The token is attached on every
outbound request by the `beforeRequest` middleware in `index.js`.

Dynamic dropdowns (list / campaign / sequence pickers in the action UI) are
backed by hidden helper triggers (`list_lists`, `list_draft_campaigns`,
`list_sequences`) defined inline in `index.js`.

## Layout

```
packages/zapier/
├── index.js                       — app definition (triggers + creates wired up here)
├── authentication.js              — API-key custom auth
├── triggers/
│   ├── campaign-sent.js
│   ├── subscriber-added.js
│   ├── subscriber-unsubscribed.js
│   ├── approval-decided.js
│   ├── approval-requested.js
│   ├── bounce-received.js
│   └── list-subscriber-added.js
├── creates/
│   ├── add-subscriber.js
│   ├── update-subscriber.js
│   ├── unsubscribe-subscriber.js
│   ├── send-campaign.js
│   ├── start-sequence.js
│   ├── add-to-list.js
│   └── remove-from-list.js
├── searches/find-subscriber.js
├── lib/                           — api-url, fields, subscribers (email→id)
├── test/index.test.js             — node:test smoke tests
├── .zapierapprc                   — populated by `zapier register` (gitignored)
└── package.json
```

## One-time setup (operator)

```sh
npm install -g zapier-platform-cli
cd packages/zapier
npm install
zapier login
zapier register postwave         # creates the Zapier app + writes .zapierapprc
```

After `zapier register`, the `.zapierapprc` file in this directory will contain
the Zapier app id. **Commit nothing in `.zapierapprc`** — it's per-operator
state and the file is `.gitignore`d.

## Local development

```sh
cd packages/zapier
npm install
npm test                          # node --test ./test/
npx zapier validate --without-style
npx zapier test                   # runs against your registered dev version
```

## Push a new version

```sh
cd packages/zapier
# bump the "version" in package.json first
npx zapier push
```

## Promote to public

Promote the current pushed version to the public listing:

```sh
npx zapier promote 0.1.0
```

## Honest gaps

- `/api/v1/auth/me` — exists in the API and is what `authentication.test`
  hits. (Verified at `apps/api/main.go`.)
- `/api/v1/approvals` and `/api/v1/deliverability/suppressions` — those
  performList endpoints may not be deployed in every tenant tier. Those
  triggers handle 404 gracefully and fall through to an empty sample list, so
  the rest of the integration (subscribe/unsubscribe + real hook delivery)
  still works fine without them.
- The `.zapierapprc` file shipped in source control is empty. The operator
  must run `zapier register` once to populate it (or `zapier link` to attach
  to an existing app).
