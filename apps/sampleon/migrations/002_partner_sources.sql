-- Outside sample partners: one entry link per partner and request, and sessions that came through it.
CREATE TABLE partner_sources (
  id            text PRIMARY KEY,                -- pts_<ulid>
  request_id    text NOT NULL REFERENCES audience_requests(id),
  partner_ref   text NOT NULL,                   -- the partner fill at SUPPLY360 (or any id the caller chooses)
  name          text NOT NULL,
  country       text NOT NULL,
  cap           integer NOT NULL,                -- verified completes the partner is paid for
  entry_token   text NOT NULL UNIQUE,
  secret        text NOT NULL,                   -- signs the redirects back to the partner
  complete_url  text,
  screenout_url text,
  overquota_url text,
  status        text NOT NULL DEFAULT 'live',    -- live | closed
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  UNIQUE (request_id, partner_ref)
);

ALTER TABLE sessions ADD COLUMN partner_source_id text REFERENCES partner_sources(id);
ALTER TABLE sessions ADD COLUMN partner_rid text;
CREATE UNIQUE INDEX sessions_partner_rid ON sessions (partner_source_id, partner_rid) WHERE partner_source_id IS NOT NULL;
