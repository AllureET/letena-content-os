-- phase82_lcos_export_up.sql, watermark table for the LCOS question exporter
-- (cron_lcos_export.php). Additive and idempotent. See api/lcos/ and the
-- Content OS repo for the receiving side.
CREATE TABLE IF NOT EXISTS `lcos_export_state` (
  `k` VARCHAR(32) NOT NULL PRIMARY KEY,
  `last_inbox_id` BIGINT NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
