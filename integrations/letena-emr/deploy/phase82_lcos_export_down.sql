-- phase82_lcos_export_down.sql, removes the LCOS exporter watermark. Safe:
-- the exporter fails closed (exits 0, no export) when the table is absent,
-- and re-running the up migration restarts the export from inbox id 0.
DROP TABLE IF EXISTS `lcos_export_state`;
