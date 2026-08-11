<?php
/**
 * cron_lcos_export.php, exports new unified_inbox messages to the Letena
 * Content OS (LCOS) ingest API with category/urgency/language hints, so the
 * content system rides the EMR's existing triage instead of re-classifying.
 *
 * Registered in api/cron/dispatch.php as job=lcos_export. CLI-only with the
 * LETENA_CRON_DISPATCH_LIB widening, idempotent (watermark advances only on
 * a 2xx from LCOS), and a no-op when nothing is new or creds are unset.
 *
 * PRIVACY: exports raw_message text (LCOS de-identifies at its boundary, in
 * memory, and stores only sanitized text), platform, received_at, language,
 * triage_level, slugified extracted_topic, and sha256(salt.inbox_id). It
 * NEVER exports platform_user_id, platform_username, platform_msg_id,
 * extracted_age/sex/city, drafts, or any patient/consult identifier.
 * Migration: migrations/phase82_lcos_export_up.sql (watermark table).
 * Credentials via integration_credentials.php: lcos_base_url,
 * lcos_ingest_secret, lcos_hash_salt (group 'lcos').
 */
if (PHP_SAPI !== 'cli' && !defined('LETENA_CRON_DISPATCH_LIB')) {
    http_response_code(403); exit('forbidden');
}

require_once __DIR__ . '/config/dbconn.php';
if (!isset($db) && isset($dbconn)) { $db = $dbconn; }
if (!isset($db) || !$db) { fwrite(STDERR, "no db\n"); exit(1); }
require_once __DIR__ . '/lib/integration_creds.php';

$LCOS_URL    = letena_integration_cred_effective($db, 'lcos', 'lcos_base_url');
$LCOS_SECRET = letena_integration_cred_effective($db, 'lcos', 'lcos_ingest_secret');
$HASH_SALT   = letena_integration_cred_effective($db, 'lcos', 'lcos_hash_salt');
if (!$LCOS_URL || !$LCOS_SECRET || !$HASH_SALT) {
    echo "lcos creds not configured; nothing to do\n"; exit(0);
}

$res = $db->query("SELECT last_inbox_id FROM lcos_export_state WHERE k='inbox'");
$row = $res ? $res->fetch_assoc() : null;
$watermark = $row ? (int)$row['last_inbox_id'] : 0;

$stmt = $db->prepare(
    "SELECT ui.id, ui.platform, ui.raw_message, ui.received_at,
            ui.language_detected, ui.triage_level, atr.extracted_topic
     FROM unified_inbox ui
     LEFT JOIN ai_triage_results atr ON atr.inbox_id = ui.id
     WHERE ui.id > ? ORDER BY ui.id ASC LIMIT 200");
$stmt->bind_param('i', $watermark);
$stmt->execute();
$result = $stmt->get_result();

$CHANNEL_MAP = [
    'telegram' => 'TELEGRAM', 'whatsapp' => 'WHATSAPP', 'facebook' => 'FACEBOOK',
    'instagram' => 'INSTAGRAM', 'tiktok' => 'TIKTOK_COMMENT', 'sms' => 'HOTLINE',
    'phone_call' => 'PHONE_INTAKE', 'walk_in' => 'MANUAL_ENTRY', 'manual' => 'MANUAL_ENTRY',
];

$batch = []; $maxId = $watermark;
while ($r = $result->fetch_assoc()) {
    $maxId = max($maxId, (int)$r['id']);
    $text = trim((string)$r['raw_message']);
    if ($text === '' || mb_strlen($text) < 3) continue;
    $hints = [];
    if (!empty($r['extracted_topic'])) {
        $slug = trim(preg_replace('/[^a-z0-9]+/', '_', strtolower(trim($r['extracted_topic']))), '_');
        if ($slug !== '') $hints[] = $slug;
    }
    $lang = strtolower(substr((string)($r['language_detected'] ?: ''), 0, 2));
    $batch[] = [
        'channel'        => $CHANNEL_MAP[strtolower((string)$r['platform'])] ?? 'OTHER',
        'captured_at'    => gmdate('Y-m-d\TH:i:s\Z', strtotime($r['received_at'])),
        'source_hash'    => hash('sha256', $HASH_SALT . ':' . $r['id']),
        'text'           => mb_substr($text, 0, 4000),
        'language_hint'  => in_array($lang, ['am','en','om','ti'], true) ? strtoupper($lang) : null,
        'urgency_hint'   => in_array($r['triage_level'] ?? '', ['routine','consult','urgent'], true)
                              ? $r['triage_level'] : null,
        'category_hints' => $hints,
    ];
}

if (!$batch) { echo "nothing to export (watermark $watermark)\n"; exit(0); }

$body = json_encode(['batch_id' => 'emr-' . gmdate('Ymd-His'), 'questions' => $batch]);
$ts = (string)time();
$sig = hash_hmac('sha256', $ts . '.' . $body, $LCOS_SECRET);
$ch = curl_init(rtrim($LCOS_URL, '/') . '/api/v1/ingest/questions');
curl_setopt_array($ch, [
    CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 15, CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'X-Letena-Signature: sha256=' . $sig,
        'X-Letena-Timestamp: ' . $ts,
    ],
]);
curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($code >= 200 && $code < 300) {
    $stmt = $db->prepare("INSERT INTO lcos_export_state (k, last_inbox_id) VALUES ('inbox', ?)
                          ON DUPLICATE KEY UPDATE last_inbox_id = VALUES(last_inbox_id)");
    $stmt->bind_param('i', $maxId);
    $stmt->execute();
    echo 'exported ' . count($batch) . " questions, watermark -> $maxId\n";
    exit(0);
}
fwrite(STDERR, "LCOS ingest failed HTTP $code; watermark unchanged, will retry\n");
exit(1);
