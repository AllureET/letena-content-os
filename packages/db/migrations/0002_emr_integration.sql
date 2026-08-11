-- 0002: Letena EMR integration. The EMR (letenav2) already classifies inbound
-- messages: ai_triage_results carries language + triage level, and consults
-- carry multi-select tags from the canonical 17-category taxonomy. LCOS accepts
-- those as HINTS on ingest and maps them to LCOS topics, so the classifier
-- starts from the EMR's judgement instead of cold.
SET search_path = lcos, public;

ALTER TABLE audience_questions
  ADD COLUMN IF NOT EXISTS category_hints text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS urgency_hint   text CHECK (urgency_hint IS NULL OR urgency_hint IN ('routine','consult','urgent'));

COMMENT ON COLUMN audience_questions.category_hints IS
  'EMR canonical category slugs supplied by the letena.et exporter. Hints only; classification still runs.';

-- EMR canonical taxonomy -> LCOS topic mapping. Seeded, editable in Settings UI.
CREATE TABLE IF NOT EXISTS emr_category_map (
  emr_category  text PRIMARY KEY,
  topic_code    text REFERENCES topics(code),
  is_myth_signal boolean NOT NULL DEFAULT false,
  min_risk_tier risk_tier,
  notes         text
);

INSERT INTO emr_category_map (emr_category, topic_code, is_myth_signal, min_risk_tier, notes) VALUES
  ('pregnancy',              'PREG', false, NULL,     NULL),
  ('contraception',          'CON',  false, NULL,     NULL),
  ('stds_sti',               'STI',  false, NULL,     NULL),
  ('general_sexual_health',  'SEX',  false, NULL,     NULL),
  ('menstrual_health',       'MEN',  false, NULL,     NULL),
  ('adolescent_health',      'YTH',  false, NULL,     NULL),
  ('infertility',            'FERT', false, NULL,     NULL),
  ('abortion',               'SAFE', false, 'TIER_4', 'Tier 4 content territory'),
  ('violence_and_abuse',     'SAFE', false, 'TIER_4', 'GBV; Tier 4, medical_director only'),
  ('hiv_aids',               'HIV',  false, NULL,     NULL),
  ('reproductive_cancer',    'HPV',  false, NULL,     NULL),
  ('consent_relationships',  'SEX',  false, NULL,     NULL),
  ('virginity_myths',        'SEX',  true,  NULL,     'Strong myth prior'),
  ('pleasure_intimacy',      'SEX',  false, NULL,     NULL),
  ('safe_sex',               'CON',  false, NULL,     'Overlaps STI; classifier decides'),
  ('utis',                   'SEX',  false, NULL,     'No dedicated topic yet'),
  ('other',                  NULL,   false, NULL,     NULL)
ON CONFLICT (emr_category) DO NOTHING;

INSERT INTO settings (key, value, description) VALUES
  ('emr.export_enabled', 'true', 'Accept ingest batches from the letena.et exporter'),
  ('emr.hint_confidence_boost', '0.15', 'match_confidence boost when classifier agrees with EMR category hint')
ON CONFLICT (key) DO NOTHING;
