# Personal-data breach response

Status: **operational draft / counsel approval required**

Owner: Privacy and Security

Last legal-source review: 2026-08-19

This playbook is an internal response aid, not a jurisdiction-by-jurisdiction
legal determination. The Privacy Incidents product is currently a provisional
incident register. Its counsel sign-off, notification recording, packet
generation and closure controls are on release hold until authenticated
approval, versioned legal rules, immutable artifacts and dispatch receipts are
implemented and qualified.

## Governing boundary

GDPR Article 33 generally requires a controller to notify the competent
supervisory authority without undue delay and, where feasible, within 72 hours
after becoming aware of a personal-data breach, unless the breach is unlikely
to result in a risk to individuals' rights and freedoms. Article 34 separately
addresses communication to affected individuals where a breach is likely to
result in a high risk.

Those thresholds, exceptions, roles and start times matter. A stored
`detected_at` value or a product-generated `+72h` timestamp is only an
operational response target; it does not prove legal awareness, controller
status, reportability or the applicable deadline.

## Definitions

- **Personal-data breach**: a security incident leading to accidental or
  unlawful destruction, loss, alteration, unauthorized disclosure of, or
  access to personal data.
- **Detection**: the first technical or human signal that something may have
  happened.
- **Awareness**: the point at which the relevant controller has a reasonable
  degree of certainty that a security incident has compromised personal data.
  Record the evidence and accountable decision that establishes this time.
- **Operational target**: an internal escalation deadline. It must never be
  shown as a statutory conclusion unless a current, applicable rule and counsel
  decision establish that conclusion.
- **Notification decision**: a versioned, audience-specific notify / do-not-
  notify decision tied to the incident revision, jurisdiction, risk analysis,
  approver and rationale.

## Immediate response timeline

The sequence below is an internal service objective. It does not replace the
earliest applicable legal deadline.

```text
T+0      Preserve the first signal; page the response owner; begin a timeline.
T+1h     Contain ongoing exposure where safe; preserve forensic evidence.
T+4h     Establish controller/processor roles, affected systems and known scope.
T+12h    Record awareness analysis, risk assessment and jurisdiction unknowns.
T+24h    Prepare phased notices where counsel determines notification is due.
T+48h    Reconcile recipients, approved artifact hashes and delivery channels.
T+72h    Escalation target: prove each due notice was sent or record the delay,
         missing facts, decision owner and immediate recovery action.
```

Do not wait for complete information where an applicable regime permits or
requires phased notification. Do not send an unapproved template merely to
satisfy an internal timer.

## Decision framework

```text
Is there reasonable certainty that personal data was compromised?
│
├── No / still investigating
│   └── Preserve the incident record, evidence and reassessment owner.
│
└── Yes
    ├── Establish controller/processor role and awareness evidence.
    ├── Identify affected people, records, data types and jurisdictions.
    ├── Assess likelihood and severity of harm using current counsel guidance.
    └── Record a separate decision for every required audience:
        ├── Authority notification due
        ├── Individual communication due
        ├── Contractual/customer notice due
        ├── Not due, with legal basis and evidence
        └── Unknown, with owner, deadline and escalation
```

For GDPR-specific analysis, a breach that is unlikely to result in risk may
fall within the Article 33 notification exception, but it must still be
documented. A likely high risk may trigger Article 34 communication to affected
individuals, subject to its conditions and exceptions. Counsel must apply the
current law to the actual facts.

## Minimum incident record

Before any external artifact is approved, the incident revision should capture:

1. detection, awareness and occurrence timestamps with provenance;
2. controller, processor and affected-tenant roles;
3. nature and cause of the breach, including what remains unknown;
4. affected systems, regions, jurisdictions, people, records and data types;
5. likely consequences and documented risk analysis;
6. containment and remediation measures actually completed or proposed;
7. verified DPO/controller contact from tenant or corporate configuration;
8. audience-specific notify / do-not-notify decisions and legal basis;
9. approving identities, step-up evidence and exact approved revision; and
10. immutable artifact IDs/hashes plus provider or portal delivery receipts.

Never infer a completed containment step, credential rotation, forensic
engagement, counsel review or notification from a workflow state alone.

## Notification contents

For a GDPR supervisory-authority notice, Article 33(3) identifies information
including the nature of the breach; categories and approximate numbers of data
subjects and records; DPO or contact details; likely consequences; and measures
taken or proposed. When information cannot be provided at once, Article 33
allows it to be supplied in phases without undue further delay.

Communication to affected individuals has its own Article 34 requirements and
must use clear, plain language. Other laws, contracts and regulators have
different thresholds, recipients, clocks, forms and content requirements.
Packets must be generated from versioned, sourced rules and verified incident
facts—not from a global static template.

## Roles and separation of duties

- **Response owner**: maintains the timeline, owners and next-action state.
- **Technical incident commander**: owns containment and forensic facts.
- **Privacy lead / DPO**: owns the risk and notification-decision process.
- **Legal counsel**: reviews applicable law and approves exact external text.
- **Communications owner**: sends only the approved artifact through an
  approved channel and retains the delivery receipt.
- **Executive owner**: approves public communications where policy requires.

An email address typed by the acting operator is not a second approver.
Production approval requires a separately authenticated principal, fresh
step-up where policy requires it, immutable decision evidence and prevention of
self-approval or silent overwrite.

## Tooling boundary

- The desktop Privacy Incidents route and `/api/v1/privacy/incidents` records
  are provisional response-register data, not a certified legal system of
  record.
- The legacy operational target currently derives from `detected_at`; it must
  not be described as an authoritative legal clock.
- The reviewed API now returns only jurisdiction code/name recognition plus an
  explicit `jurisdiction_rules_release_hold`; it emits no deadline, threshold,
  recipient or notice-content conclusion. That selector is not legal advice
  and must not authorize a packet or notification.
- Counsel sign-off, manual “sent” recording, packet generation/download and
  incident closure remain unavailable until the release acceptance criteria in
  the Route 37 audit pass.
- Slack, GitHub and a public status page are coordination channels only when a
  specific incident plan names them. No automatic publication or permanent-
  record claim is made here.

## Source register

The product must retain exact source versions and effective dates. These links
are a review starting point, not a substitute for counsel:

- [EU GDPR, Articles 33 and 34 (EUR-Lex)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679)
- [EDPB Guidelines 9/2022 on personal-data breach notification](https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-92022-personal-data-breach-notification-under_en)
- [ICO personal-data breach guidance](https://ico.org.uk/for-organisations/advice-for-small-organisations/personal-data-breaches/)
- [California Attorney General breach-reporting guidance](https://oag.ca.gov/privacy/databreach/reporting)
- [Texas Business & Commerce Code §521.053](https://statutes.capitol.texas.gov/Docs/BC/htm/BC.521.htm#521.053)
- [Florida Statutes §501.171](https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.171.html)
- [Washington RCW 19.255.010](https://app.leg.wa.gov/RCW/default.aspx?cite=19.255.010)

At the 2026-08-19 spot check, the former static application matrix disagreed
with current official California and Texas authority-notification thresholds
or timing. Obligation-shaped output from that matrix is now suppressed behind
the release hold. Do not add it back until a versioned replacement is reviewed
and regression-tested.

## Post-incident

- Preserve the final timeline, decision revisions, approved artifacts,
  delivery receipts and supersessions according to the applicable retention
  and legal-hold policy.
- Assign remediation owners and dates; verify closure evidence independently.
- Review technical and organizational measures after any control failure.
- Publish a post-incident report only under the approved communications plan;
  no universal 14-day public-postmortem promise is made.

## Exercises and review

Run a tabletop at least every six months and after material workflow or legal-
rule changes. Each exercise must retain its participants, scenario, system
version, findings, owners and closure evidence. A calendar statement without
that evidence is not proof that the exercise occurred.
