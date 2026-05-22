-- Lost and Found tables (runs against mycelium_db)

CREATE TABLE IF NOT EXISTS lf_cases (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  title           VARCHAR(200) NOT NULL,
  description     TEXT NOT NULL,
  subject_name    VARCHAR(100),
  subject_type    VARCHAR(20) NOT NULL DEFAULT 'person'
                  CHECK (subject_type IN ('person', 'pet', 'item')),
  last_seen_location TEXT,
  last_seen_at    TIMESTAMPTZ,
  status          VARCHAR(20) NOT NULL DEFAULT 'searching'
                  CHECK (status IN ('searching', 'found', 'resolved')),
  contact_info    TEXT,
  tags            TEXT[]   DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lf_case_photos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id       UUID NOT NULL REFERENCES lf_cases(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  original_name TEXT,
  size_bytes    BIGINT,
  is_primary    BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lf_tips (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id      UUID NOT NULL REFERENCES lf_cases(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id),
  tip_type     VARCHAR(20) NOT NULL
               CHECK (tip_type IN ('sighting', 'contact', 'media', 'official', 'resource')),
  content      TEXT NOT NULL,
  location     TEXT,
  occurred_at  TIMESTAMPTZ,
  source_url   TEXT,
  is_verified  BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lf_tip_media (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tip_id        UUID NOT NULL REFERENCES lf_tips(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  original_name TEXT,
  size_bytes    BIGINT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lf_cases_status      ON lf_cases(status);
CREATE INDEX IF NOT EXISTS idx_lf_cases_user_id     ON lf_cases(user_id);
CREATE INDEX IF NOT EXISTS idx_lf_cases_created_at  ON lf_cases(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lf_tips_case_id      ON lf_tips(case_id);
CREATE INDEX IF NOT EXISTS idx_lf_case_photos_case  ON lf_case_photos(case_id);
CREATE INDEX IF NOT EXISTS idx_lf_tip_media_tip     ON lf_tip_media(tip_id);

CREATE OR REPLACE FUNCTION lf_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lf_cases_updated_at ON lf_cases;
CREATE TRIGGER lf_cases_updated_at
  BEFORE UPDATE ON lf_cases
  FOR EACH ROW EXECUTE FUNCTION lf_set_updated_at();
