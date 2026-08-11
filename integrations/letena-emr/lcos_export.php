<?php
/**
 * LCOS question exporter — runs INSIDE letenav2 (letena.et) as a cron job.
 * Deploy to: api/cron/jobs/lcos_export.php, register in api/cron/dispatch.php
 * as job=lcos_export, schedule via .github/workflows/cron.yml (every 15 min).
 *
 * SCHEMA VERIFIED against the live repo (db_migration_ai.sql, 2026-08-11):
 *   unified_inbox: id, platform ENUM(telegram,whatsapp,facebook,instagram,
 *     tiktok,sms,phone_call,walk_in,manual), raw_message TEXT,
 *     language_detected VARCHAR(10) DEFAULT 'am', received_at DATETIME,
 *     triage_level ENUM(routine,consult,urgent)  [denormalized, no join needed]
 *   ai_triage_results: inbox_id, extracted_topic VARCHAR(255)  [category hint]
 *
 * PRIVACY CONTRACT (enforced here AND rejected at the LCOS boundary):
 *   NEVER exported: platform_user_id, platform_username, platform_msg_id,
 *   patient/consult ids, extracted_age/sex/city, ai_draft_reply*, doctor
 *   fields, message summaries. Exported: raw_message text (LCOS de-identifies
 *   at its gate, in memory, and never stores the raw), platform→channel,
 *   received_at, language_detected, triage_level, slugified extracted_topic,
 *   source_hash = sha256(salt . inbox id).
 *
 * EMR house rules: mysqli prepared statements; additive migration only for
 * the watermark table; batch 200 per run so no long request; purely additive,
 * a failure here never touches the message or consult flow; watermark
 * advances only on a 2xx from LCOS so failures retry.
 */

require_once __DIR__ . '/../../../config/dbconn.php';
if (!isset($db) && isset($dbconn)) { $db = $dbconn; }           // H-1 alias, always
if (!isset($db) || !$db) { http_response_code(500); exit('no db'); }

require_once __DIR__ . '/../../../lib/integration_creds.php';
$LCOS_URL    = letena_integration_cred_effective($db, 'lcos', 'lcos_base_url');
$LCOS_SECRET = letena_integration_cred_effective($db, 'lcos', 'lcos_ingest_secret');
$HASH_SALT   = letena_integration_cred_effective($db, 'lcos', 'lcos_hash_salt');
if (!$LCOS_URL || !$LCOS_SECRET || !$HASH_SALT) { echo "lcos creds not configured; skipping\n"; exit(0); }

// Watermark table (created by lcos_export_migration_up.sql, additive).
$db->query("CREATE TABLE IF NOT EXISTS lcos_export_state (
    k VARCHAR(32) PRIMARY KEY, last_inbox_id BIGINT NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)");
$res = $db->query("SELECT last_inbox_id FROM lcos_export_state WHERE k='inbox'");
$row = $res ? $res->fetch_assoc() : null;
$watermark = $row ? (int)$row['last_inbox_id'] : 0;

$stmt = $db->prepare(
    "SELECT ui.id, ui.platform, ui.raw_message, ui.received_at,
            ui.language_detected, ui.triage_level,
            atr.extracted_topic
     FROM unified_inbox ui
     LEFT JOIN ai_triage_results atr ON atr.inbox_id = ui.id
     WHERE ui.id > ?
     ORDER BY ui.id ASC
     LIMIT 200");
$stmt->bind_param('i', $watermark);   // by-reference safe: real variable
$stmt->execute();
$result = $stmt->get_result();

// unified_inbox.platform ENUM -> LCOS ingest_channel
$CHANNEL_MAP = [
    'telegram'   => 'TELEGRAM',      'whatsapp' => 'WHATSAPP',
    'facebook'   => 'FACEBOOK',      'instagram' => 'INSTAGRAM',
    'tiktok'     => 'TIKTOK_COMMENT','sms' => 'HOTLINE',
    'phone_call' => 'PHONE_INTAKE',  'walk_in' => 'MANUAL_ENTRY',
    'manual'     => 'MANUAL_ENTRY',
];

function lcos_slug(string $s): string {
    $s = strtolower(trim($s));
    $s = preg_replace('/[^a-z0-9]+/', '_', $s);
    return trim($s, '_');
}

$batch = []; $maxId = $watermark;
while ($r = $result->fetch_assoc()) {
    $maxId = max($maxId, (int)$r['id']);
    $text = trim((string)$r['raw_message']);
    if ($text === '' || mb_strlen($text) < 3) continue;
    $hints = [];
    if (!empty($r['extracted_topic'])) {
        $slug = lcos_slug($r['extracted_topic']);
        if ($slug !== '') $hints[] = $slug;   // unknown slugs are ignored by LCOS
    }
    $lang = strtolower(substr((string)($r['language_detected'] ?: ''), 0, 2));
    $batch[] = [
        'channel'       => $CHANNEL_MAP[strtolower((string)$r['platform'])] ?? 'OTHER',
        'captured_at'   => gmdate('Y-m-d\TH:i:s\Z', strtotime($r['received_at'])),
        'source_hash'   => hash('sha256', $HASH_SALT . ':' . $r['id']),
        'text'          => mb_substr($text, 0, 4000),
        'language_hint' => in_array($lang, ['am','en','om','ti'], true) ? strtoupper($lang) : null,
        'urgency_hint'  => in_array($r['triage_level'] ?? '', ['routine','consult','urgent'], true)
                             ? $r['triage_level'] : null,
        'category_hints'=> $hints,
    ];
}

if (!$batch) { echo "nothing to export (watermark $watermark)\n"; exit(0); }

$body = json_encode(['batch_id' => 'emr-' . gmdate('Ymd-His'), 'questions' => $batch]);
$ts = (string)time();
$sig = hash_hmac('sha256', $ts . '.' . $body, $LCOS_SECRET);
$ch = curl_init($LCOS_URL . '/api/v1/ingest/questions');
curl_setopt_array($ch, [
    CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 15, CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'X-Letena-Signature: sha256=' . $sig,
        'X-Letena-Timestamp: ' . $ts,
    ],
]);
$resp = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($code >= 200 && $code < 300) {
    $stmt = $db->prepare("INSERT INTO lcos_export_state (k, last_inbox_id) VALUES ('inbox', ?)
                          ON DUPLICATE KEY UPDATE last_inbox_id = VALUES(last_inbox_id)");
    $stmt->bind_param('i', $maxId);
    $stmt->execute();
    echo "exported " . count($batch) . " questions, watermark -> $maxId\n";
} else {
    echo "LCOS ingest failed HTTP $code; watermark unchanged, will retry\n";
}
