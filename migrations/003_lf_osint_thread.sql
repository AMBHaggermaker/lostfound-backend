-- Feature 1: Lost & Found OSINT information thread rebuild
-- Extends lf_tips into a full OSINT thread: pinning, geocoded sightings,
-- optional anonymous display name, and an expanded tip taxonomy.
-- Extends lf_tip_media to carry documents (PDFs) alongside photos/video.

-- New OSINT fields on lf_tips
ALTER TABLE lf_tips
  ADD COLUMN IF NOT EXISTS is_pinned            BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS location_lat         NUMERIC,
  ADD COLUMN IF NOT EXISTS location_lng         NUMERIC,
  ADD COLUMN IF NOT EXISTS location_description TEXT,
  ADD COLUMN IF NOT EXISTS submitter_display    TEXT;

-- Widen the tip taxonomy to the OSINT set while keeping legacy values valid
-- so pre-existing rows ('official','resource') don't violate the constraint.
ALTER TABLE lf_tips DROP CONSTRAINT IF EXISTS lf_tips_tip_type_check;
ALTER TABLE lf_tips ADD CONSTRAINT lf_tips_tip_type_check
  CHECK (tip_type IN (
    'sighting', 'contact', 'document', 'media', 'official_report', 'other',
    'official', 'resource'   -- legacy values, retained for existing rows
  ));

-- file_kind distinguishes documents from images/video for badge rendering
ALTER TABLE lf_tip_media
  ADD COLUMN IF NOT EXISTS file_kind VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_lf_tips_pinned ON lf_tips(case_id, is_pinned);
CREATE INDEX IF NOT EXISTS idx_lf_cases_coords ON lf_cases(location_lat, location_lng)
  WHERE location_lat IS NOT NULL;
