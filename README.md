<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/sampleon/public/brand/sampaudience-logo-dark.svg">
    <img src="apps/sampleon/public/brand/sampaudience-logo-light.svg" alt="SampAudience by Sampledge" height="64">
  </picture>
</p>

# SampAudience (formerly SAMPLEON)

> **Ask the world. Hear back.** SampAudience is the product name shown to people. The service,
> repository, package, API paths, environment variables, client ids (`sampleon`) and event
> source (`SAMPLEON`) keep their technical name so existing integrations keep working. See
> [docs/BRAND.md](docs/BRAND.md).

SAMPLEON is the Sampledge audience, invitation and routing engine. It sits between the systems
that own projects and surveys and the system that owns respondents:

| System | Owns |
|---|---|
| **SUPPLY360** | Respondents of the three panel websites, profiles (incl. B2B and healthcare), consent, activity, e-mail and notifications, rewards, support, quality |
| **SAMPLEON** (this repository) | Audience requests from PROJEXA and ZAPX, natural-language targeting, feasibility, human approval, soft/full launch, batches, invitations and survey cards, quota monitoring, deduplication and exclusions, routing, live monitoring and the operations dashboard |
| **PROJEXA** | Projects, requirements, budgets, milestones, project quotas and approved changes, progress and reporting |
| **ZAPX** | Survey programming, hosting, sessions, response capture, redirects and verified outcome events, for PROJEXA-linked and independent surveys |

SAMPLEON keeps **no respondent database**: it asks SUPPLY360 for counts, selections and
eligibility checks through signed APIs and stores only `respondentRef`, panel and country for
the people it invited. The full design is in
[docs/ECOSYSTEM_ARCHITECTURE.md](docs/ECOSYSTEM_ARCHITECTURE.md); what is built and how it is
tested is in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## Layout

```
packages/contracts   @sampledge/contracts: IDs, criteria, Audience Request, outcomes, signing, events (zod)
apps/sampleon        The service (Express + MongoDB): API, worker, respondent flow, console
e2e/ecosystem        Cross-service run of both workflows with the real SUPPLY360, ZAPX and PROJEXA
```

## Run locally

```bash
npm ci
npm run build
# MongoDB 7 or later as a replica set (one node is enough; transactions need a replica set), e.g.
#   mongod --replSet rs0 --dbpath ./data &  then once:  mongosh --eval 'rs.initiate()'
export MONGODB_URL='mongodb://localhost:27017/sampleon?replicaSet=rs0'
export SUPPLY360_URL=http://localhost:4000 SUPPLY360_SECRET=...      # SAMPLEON's secret at SUPPLY360
node apps/sampleon/dist/src/admin.js client supply360 SUPPLY360 SUPPLY360 http://localhost:4000/api/v1/s2s/supply/events <same secret>
node apps/sampleon/dist/src/admin.js client projexa PROJEXA PROJEXA https://projexa.example/api/v1/integrations/sampleon/events
node apps/sampleon/dist/src/admin.js client zapx ZAPX ZAPX https://zapx.example/api/v1/sampleon/events <secret> <outcome secret>
node apps/sampleon/dist/src/admin.js user manager@example.com "Supply Manager" supply_manager
node apps/sampleon/dist/src/admin.js user approver@example.com "Supply Approver" supply_approver
node apps/sampleon/dist/src/main.js        # API, worker and console on :4600 (console at /console)
```

Every setting is in [apps/sampleon/.env.example](apps/sampleon/.env.example). Collections and
indexes are created on start (`src/migrate.ts`; also `node apps/sampleon/dist/src/migrate.js`).
`DATABASE_URL` is still read when `MONGODB_URL` is not set.

## Tests

```bash
npm test                     # contracts + service tests on MongoDB: TEST_MONGODB_URL (a replica set; the
                             # sampleon_test database is dropped), else a throwaway MongoDB is downloaded
                             # once from fastdl.mongodb.org and started by mongodb-memory-server
node e2e/ecosystem/run.mjs   # both workflows across the four real services (see e2e/ecosystem/README.md)
```


## Marketing website

The SampAudience (formerly SAMPLEON) product showcase page is in [`website/`](website/README.md): a standalone Vite + React app, not part of the npm workspaces.
