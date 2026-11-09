# Implementation status

What is built for [ECOSYSTEM_ARCHITECTURE.md](ECOSYSTEM_ARCHITECTURE.md), where it lives, and how
it is tested. Dated 2026-11-06.

The PROJEXA and ZAPX screens were checked in a browser: PROJEXA against its real API with a
stand-in SAMPLEON, ZAPX with stand-in API answers.

## Per system

| System | Repository | What was added |
|---|---|---|
| SAMPLEON | `kunalsharma-ai/Sampleon` (this one) | The whole service: contracts package, Audience Requests with `AR-` IDs, natural-language targeting (rules, optional Claude), feasibility from SUPPLY360, human approval by a second person, soft and full launch, manual and automatic batches, invitations, survey-card entry, sessions, verified outcomes, hard quotas, quality reversal, auto-close at target, routing, event outbox and inbox, dashboard API with role scoping, operations console (`/console`), the attribute catalogue readable by source systems |
| SUPPLY360 | `kunalsharma-ai/Sampledge-full-Supply-CRM` | `/api/v1/s2s/supply/*`: attribute catalogue, eligibility count/select/check over panelists and profile attributes, consent and health-data rules, exclusions and fatigue from its own history, deliveries as survey cards plus one Comms Hub e-mail per panel, the panel-website card feed, inbound SAMPLEON events (participation, rewards, quality reversal, card withdrawal), `reward.eligibility_confirmed` back to SAMPLEON. New tables with row-level security. No new respondent store |
| ZAPX | `kunalsharma-ai/Sampledge-ZAPX` | `SAMPLEON` vendor integration sharing the PROJEXA survey-host adapter (redirect + signed S2S outcome through the callback outbox), Sampledge service signing, audience requests for independent surveys, `connect` for PROJEXA-linked surveys, the signed event receiver, a per-survey record of each request, and the studio's SAMPLEON audiences panel (connect, request, progress) |
| PROJEXA | `kunalsharma-ai/Projecxa` | Audience requests built from a project, quota cells translated into SUPPLY360 attribute quotas through a saved question → attribute map, approved changes sent as `PATCH`, the signed event receiver, a per-project record of each request (kept apart from PROJEXA's own completes), and the project's SAMPLEON tab in the web app |

## Tests

| Where | What | Result on 2026-11-06 |
|---|---|---|
| SAMPLEON `npm test` | Contracts, signing, NL parsing, both workflows against a contract-faithful SUPPLY360, routing, quotas and quality reversal, changes and closing, dashboard roles, outbox dead letter, NL-only requests, catalogue for source systems | 10 passing |
| SUPPLY360 `apps/api/src/test/sampleon.test.ts` | Signatures, eligible/reachable/missing profile, health consent, check with quotas, deliveries with consent/exclusions/fatigue, card feed per panel, events → participation and rewards → confirmation, closing and tenant isolation | 8 passing; whole API suite 241 tests, 0 failing |
| ZAPX `packages/redirect-core`, `apps/api/test/sampleon.test.ts` | Adapter and signature vectors shared with `@sampledge/contracts`; request submission, connect, respondent outcome via the callback worker, event receiver | 4 + 9 passing; whole API suite passing; lint and format clean |
| PROJEXA `apps/api/test/e2e/sampleon.e2e.spec.ts`, `test/unit/sampleon-quotas.spec.ts` | Request built from a project, roles and tenants, approved changes, events, quota cells mapped and sent as SUPPLY360 quotas | 5 + 6 passing; whole suite 401 tests passing |
| `e2e/ecosystem/run.mjs` | Both workflows across the four real services | Passing |

The cross-service run found two defects that the per-repository tests could not: PROJEXA and
ZAPX read the new request's ID from the wrong response field, and the rule parser read
"professional" in "years of professional experience" as the *professional* panel segment. Both
are fixed and covered by tests.

## Added 2026-11-09

- **Outside sample partners** (ECOSYSTEM_ARCHITECTURE §5.5): each partner on a request gets its
  own entry link (`/p/{token}?pid=`), respondents go back to the partner's own links with a
  signed status, and partner completes count only when the survey host verifies them, up to the
  partner's cap. Session events carry `partnerRef`, so SUPPLY360 pays partners on verified
  completes instead of the partner's own report. Tests: `test/partners.test.ts` (3).
- **`project.created` from PROJEXA**: PROJEXA now sends it when a project is created or copied
  (PROJEXA repository), so SAMPLEON knows the project before its first audience request.

## Changed 2026-11-09: Express and MongoDB

The service moved from Fastify + PostgreSQL to **Express 5 + MongoDB** (driver 7, server 7 or
later, run as a replica set because transactions need one). Nothing outside the service changed:
the same paths, status codes, response bodies, headers, signatures, events and admin commands.

- Tables became collections with the same field names; the unique constraints became unique
  indexes (one open request per source survey is a partial unique index on an `open` flag kept in
  step with the status). `src/migrate.ts` creates them on start; the `.sql` files are gone.
- `SELECT … FOR UPDATE` became a write to the locked document inside a MongoDB transaction, so a
  second transaction on the same request, session or partner conflicts and runs again after it
  (`tx()` in `src/db.ts`). Worker claims (`SKIP LOCKED`) became one-at-a-time
  `findOneAndUpdate` claims. Former serial ids (outbox, routing decisions, audit) come from a
  `counters` collection, so dead-letter ids are still numbers (sent as strings, as before).
- `MONGODB_URL` replaces `DATABASE_URL` (still read as a fallback). There was no production data
  to move, so there is no data migration from PostgreSQL.
- Tests: the 13 service tests pass unchanged on MongoDB 8.0, plus `test/concurrency.test.ts` (4)
  for parallel creates, parallel verified completes on a full quota, parallel partner entries and
  the HTTP edges. A recorded run of the old and new service over the same test traffic gave the
  same status codes and response and event shapes.

## Not done yet

- **Claude targeting** is implemented and checked like the rule parser, but the cross-service run
  uses the rule parser so it needs no API key.
- **External survey providers** fit the same contracts (`EXTERNAL` client, survey-host
  contract), but none is onboarded.
- **Production deployment** (hosting, secrets, DNS) is outside these changes.
