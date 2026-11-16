# Settings: API keys in the database

Every API key and connection detail of SampAudience is entered in the console and kept in MongoDB.
Nothing about an outside system has to be put in the server's environment or a config file.

## What stays on the server

| Variable | Why it cannot move |
| --- | --- |
| `MONGODB_URL` | Where the database is: it is needed before anything can be read from it. |
| `SETTINGS_ENCRYPTION_KEY` (optional, recommended) | Seals the saved secrets. Kept apart from the data, so a copy of the database alone cannot open them. Unset: a random key is created on first start and stored in the `settings_keys` collection. |

Everything else in `.env.example` (port, public URL, worker timings) is ordinary tuning with defaults.

## What is in the database

Console → **Settings** (supply admins only):

| Group | Settings | Was |
| --- | --- | --- |
| SUPPLY360 connection | API address, client id, signing secret | `SUPPLY360_URL`, `SUPPLY360_CLIENT_ID`, `SUPPLY360_SECRET` |
| AI audience drafting | engine (`rules`/`anthropic`), Anthropic API key, model | `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| Connected systems | per system: client id, kind, webhook, signing secret, outcome secret | `admin.js client ...` |

- Saving takes effect at once in every process (each re-reads the settings every 10 seconds); no restart.
- Secrets (`settings` collection, field `sealed`) are AES-256-GCM encrypted and never sent back to the
  browser: the console shows only whether one is set and its last four characters. An empty secret box
  keeps the saved one; **Remove** deletes it.
- Saving an Anthropic key turns Claude on unless the engine is set to `rules`.
- **Test** checks the SUPPLY360 connection (reads the attribute catalogue) or the Anthropic key (looks up
  the model).
- Connected systems: a new system gets a generated signing secret (and, for a survey host, an outcome
  secret), shown once. **New secret** rotates it: the previous one keeps working until **Retire previous**,
  so the other system can be updated without downtime. These secrets must stay readable to verify HMAC
  signatures, so they are stored as before; access to them is limited to supply admins.
- Every change is written to `audit_log` (`settings.saved`, `client.*`) with the keys changed, never the values.

## Existing servers

Values in the environment keep working: a setting never saved in the console falls back to its old
variable, and the console marks it *From the server environment*. Save it once in the console, then
delete the variable from the server.

If `SETTINGS_ENCRYPTION_KEY` is set or changed after secrets were saved, those secrets can no longer be
opened; the console flags them and they must be entered again. Set the key before the first save.

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/v1/admin/settings` | groups, fields (no secret values), where each value comes from |
| PUT | `/api/v1/admin/settings` | `{ "values": { "supply360.secret": "…", "ai.provider": "rules", "ai.anthropicApiKey": null } }`; `null` removes |
| POST | `/api/v1/admin/settings/test/supply360` · `/test/ai` | `{ ok, message }` |
| GET / POST | `/api/v1/admin/clients` | list; add or change `{ id, system, name, webhookUrl, secret?, outcomeSecret?: "generate"/null }` |
| POST | `/api/v1/admin/clients/:id/rotate` · `/retire-previous` | new signing secret (returned once) / stop accepting the old one |
