-- 0003: additional EMR hint slugs. The exporter now passes slugified
-- ai_triage_results.extracted_topic (free text), and the coded category table
-- uses codes like UTI/OTHER. Map the likely slugs; unknown slugs are ignored.
SET search_path = lcos, public;

INSERT INTO emr_category_map (emr_category, topic_code, is_myth_signal, min_risk_tier, notes) VALUES
  ('emergency_contraception', 'EC',   false, NULL, 'extracted_topic'),
  ('family_planning',         'CON',  false, NULL, 'extracted_topic'),
  ('sti',                     'STI',  false, NULL, 'extracted_topic / category code'),
  ('std',                     'STI',  false, NULL, NULL),
  ('hiv',                     'HIV',  false, NULL, NULL),
  ('menstruation',            'MEN',  false, NULL, NULL),
  ('period',                  'MEN',  false, NULL, NULL),
  ('pregnancy_test',          'PREG', false, NULL, NULL),
  ('uti',                     'SEX',  false, NULL, 'category code UTI'),
  ('sexual_health',           'SEX',  false, NULL, NULL),
  ('puberty',                 'YTH',  false, NULL, NULL),
  ('cervical_cancer',         'HPV',  false, NULL, NULL),
  ('gbv',                     'SAFE', false, 'TIER_4', NULL),
  ('sexual_violence',         'SAFE', false, 'TIER_4', NULL)
ON CONFLICT (emr_category) DO NOTHING;
