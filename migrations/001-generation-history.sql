-- Generation history.
--
-- The tool has no client id of its own: the product-service callback carries a
-- beta site URL, an existing site URL, and the onboarding form, and the beta
-- URL is the only stable handle. So the client key IS that URL, normalized
-- (lowercase host, no protocol, no trailing slash) — two spellings of one site
-- must not become two clients.
--
-- Versions are per client and allocated in the database, not in code:
-- UNIQUE(client_id, version) makes two concurrent callbacks collide instead of
-- both becoming V2. A failed generation keeps its row and whatever pages it
-- managed — "how many times was this generated" counts attempts, not successes.
--
-- HTML lives here as gzipped bytea rather than in object storage. Four pages
-- at ~100kb gzip to ~80kb a generation; a thousand clients at five versions is
-- a few hundred megabytes, which is not a reason to add a second storage
-- system. Revisit if generations ever carry media.

CREATE TABLE IF NOT EXISTS clients (
    id            serial PRIMARY KEY,
    client_key    text NOT NULL UNIQUE,     -- normalized beta site URL
    beta_site_url text NOT NULL,            -- as received, for display
    existing_site text NOT NULL DEFAULT '',
    onboarding    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS generations (
    id            serial PRIMARY KEY,
    client_id     integer NOT NULL REFERENCES clients(id),
    version       integer NOT NULL,
    engine        text NOT NULL DEFAULT '',
    status        text NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
    brand         jsonb NOT NULL DEFAULT '{}'::jsonb,
    job_draft_id  text NOT NULL DEFAULT '',          -- joins back to the jobs store
    error         text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    UNIQUE (client_id, version)
);

CREATE INDEX IF NOT EXISTS generations_client_idx ON generations (client_id, version DESC);

CREATE TABLE IF NOT EXISTS pages (
    id             serial PRIMARY KEY,
    generation_id  integer NOT NULL REFERENCES generations(id),
    slug           text NOT NULL,           -- home | about | services | contact | …
    html_gz        bytea NOT NULL,
    size_bytes     integer NOT NULL,        -- uncompressed, for display
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (generation_id, slug)
);
