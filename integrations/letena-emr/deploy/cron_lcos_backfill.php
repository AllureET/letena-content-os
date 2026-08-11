<?php
/**
 * cron_lcos_backfill.php, bounded backfill of the LEGACY written Q&A history
 * (the `questions` table, years of direct questions) into the Letena Content
 * OS ingest API. This is the historical companion to cron_lcos_export.php,
 * which handles live unified_inbox traffic.
 *
 * ORDER AND WINDOW (owner instruction, Nate, Aug 2026): newest first, so the
 * freshest demand lands in LCOS first and can drive the first months of
 * content, bounded to the last N months (default 18). N is editable on the
 * Integration credentials page as "Backfill window (months)"; widen it later
 * and the job resumes digging further back on its own. Lifetime topic trends
 * do NOT need this export: api/lcos/aggregates.php already serves lifetime
 * coded-topic counts (category_tag -> category.code) for trend reads.
 *
 * WHY THESE TABLES: the content dashboard (lib/content_insight.php) already
 * proves the demand history exists: consult topics via category_tag ->
 * category.code, and consults link back to the originating written question
 * through consult.source_question_id.
 *
 * Registered in api/cron/dispatch.php as job=lcos_backfill. Runs on the same
 * 15-minute schedule as lcos_export; 300 rows per run, newest to oldest,
 * until the window floor is reached, after which every run is a cheap no-op
 * ("backfill complete"). Safe to leave registered.
 *
 * PRIVACY, same contract as the live exporter: exports question_text (LCOS
 * de-identifies at its boundary, in memory, and stores only sanitized text),
 * created_at, a platform-derived channel, coded topic hints, and
 * sha256(salt:legacy_q:id). It NEVER exports name, sex, age, location, city,
 * country, address, phone_number, social_media_username, passcode, user_id,
 * remarks, answers, or any patient/consult identifier.
 *
 * State: lcos_export_state row k='legacy_q' stores the LOWEST question id
 * exported so far (the walk is descending). 0 means not started; the first
 * run sets the ceiling to MAX(id)+1. Advances only on a 2xx from LCOS.
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

// Backfill window: how many months back the walk digs. Editable on the
// Integration credentials page; blank or invalid means the 18-month default.
$months = (int) letena_integration_cred_effective($db, 'lcos', 'lcos_backfill_months');
if ($months < 1 || $months > 240) { $months = 18; }
$cutoff = date('Y-m-d H:i:s', strtotime("-{$months} months"));

/** Guarded table check so a schema without the patient model degrades. */
function lcos_bf_has_table($db, $table) {
    $st = @$db->prepare(
        "SELECT 1 FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1");
    if (!$st) return false;
    $st->bind_param('s', $table);
    $st->execute();
    $ok = (bool)$st->get_result()->fetch_row();
    $st->close();
    return $ok;
}

$res = $db->query("SELECT last_inbox_id FROM lcos_export_state WHERE k='legacy_q'");
$row = $res ? $res->fetch_assoc() : null;
$watermark = $row ? (int)$row['last_inbox_id'] : 0;

// Descending walk: the watermark is the lowest id exported so far. On the
// first run the ceiling is one above the newest question.
if ($watermark === 0) {
    $res = $db->query("SELECT MAX(id) AS m FROM questions");
    $mrow = $res ? $res->fetch_assoc() : null;
    if (!$mrow || $mrow['m'] === null) { echo "no legacy questions; nothing to do\n"; exit(0); }
    $watermark = (int)$mrow['m'] + 1;
}

$stmt = $db->prepare(
    "SELECT id, question_text, social_media_platform, category, created_at
     FROM questions WHERE id < ? AND created_at >= ?
     ORDER BY id DESC LIMIT 300");
$stmt->bind_param('is', $watermark, $cutoff);
$stmt->execute();
$result = $stmt->get_result();

$rows = []; $minId = $watermark;
while ($r = $result->fetch_assoc()) {
    $minId = min($minId, (int)$r['id']);
    $rows[] = $r;
}
$stmt->close();

if (!$rows) {
    echo "backfill complete for the {$months}-month window (floor id $watermark)\n";
    exit(0);
}

// Coded topics for this page: consult.source_question_id -> category_tag ->
// category.code, the exact join the content dashboard uses. Guarded so the
// backfill still runs (text only) on a schema without the patient model.
$topicByQid = [];
if (lcos_bf_has_table($db, 'consult') && lcos_bf_has_table($db, 'category_tag')
    && lcos_bf_has_table($db, 'category')) {
    $ids = array_map(function ($r) { return (int)$r['id']; }, $rows);
    $ph = implode(',', array_fill(0, count($ids), '?'));
    $st = @$db->prepare(
        "SELECT c.source_question_id AS qid,
                GROUP_CONCAT(DISTINCT cat.code) AS codes
         FROM consult c
         JOIN category_tag ct ON ct.consult_id = c.consult_id
         JOIN category cat    ON cat.id = ct.category_id
         WHERE c.source_question_id IN ($ph)
         GROUP BY c.source_question_id");
    if ($st) {
        $types = str_repeat('i', count($ids));
        $st->bind_param($types, ...$ids);
        $st->execute();
        $tr = $st->get_result();
        while ($t = $tr->fetch_assoc()) {
            $topicByQid[(int)$t['qid']] = explode(',', (string)$t['codes']);
        }
        $st->close();
    }
}

$CHANNEL_MAP = [
    'telegram' => 'TELEGRAM', 'whatsapp' => 'WHATSAPP', 'facebook' => 'FACEBOOK',
    'instagram' => 'INSTAGRAM', 'tiktok' => 'TIKTOK_COMMENT', 'youtube' => 'YOUTUBE_COMMENT',
    'website' => 'WEBSITE', 'web' => 'WEBSITE',
];

$slugify = function ($v) {
    $slug = trim(preg_replace('/[^a-z0-9]+/', '_', strtolower(trim((string)$v))), '_');
    return $slug;
};

$batch = [];
foreach ($rows as $r) {
    $text = trim((string)$r['question_text']);
    if ($text === '' || mb_strlen($text) < 3) continue;
    $hints = [];
    foreach ($topicByQid[(int)$r['id']] ?? [] as $code) {
        $slug = $slugify($code);
        if ($slug !== '') $hints[] = $slug;
    }
    // The legacy free-text category column is a weaker, secondary hint.
    if (!empty($r['category'])) {
        $slug = $slugify($r['category']);
        if ($slug !== '' && !in_array($slug, $hints, true)) $hints[] = $slug;
    }
    $platform = strtolower(trim((string)($r['social_media_platform'] ?: '')));
    $capturedAt = $r['created_at'] ? strtotime($r['created_at']) : false;
    $batch[] = [
        'channel'        => $CHANNEL_MAP[$platform] ?? 'WEBSITE',
        'captured_at'    => gmdate('Y-m-d\TH:i:s\Z', $capturedAt !== false ? $capturedAt : time()),
        'source_hash'    => hash('sha256', $HASH_SALT . ':legacy_q:' . $r['id']),
        'text'           => mb_substr($text, 0, 4000),
        'language_hint'  => null,
        'urgency_hint'   => null,
        'category_hints' => $hints,
    ];
}

if (!$batch) {
    // Every row on this page was empty text; advance past it so the job
    // cannot wedge on a stretch of blank legacy rows.
    $stmt = $db->prepare("INSERT INTO lcos_export_state (k, last_inbox_id) VALUES ('legacy_q', ?)
                          ON DUPLICATE KEY UPDATE last_inbox_id = VALUES(last_inbox_id)");
    $stmt->bind_param('i', $minId);
    $stmt->execute();
    echo "page had no exportable text, watermark -> $minId\n";
    exit(0);
}

$body = json_encode(['batch_id' => 'emr-legacy-' . $watermark . '-' . $minId, 'questions' => $batch]);
$ts = (string)time();
$sig = hash_hmac('sha256', $ts . '.' . $body, $LCOS_SECRET);
$ch = curl_init(rtrim($LCOS_URL, '/') . '/api/v1/ingest/questions');
curl_setopt_array($ch, [
    CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 20, CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'X-Letena-Signature: sha256=' . $sig,
        'X-Letena-Timestamp: ' . $ts,
    ],
]);
curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($code >= 200 && $code < 300) {
    $stmt = $db->prepare("INSERT INTO lcos_export_state (k, last_inbox_id) VALUES ('legacy_q', ?)
                          ON DUPLICATE KEY UPDATE last_inbox_id = VALUES(last_inbox_id)");
    $stmt->bind_param('i', $minId);
    $stmt->execute();
    echo 'backfilled ' . count($batch) . " legacy questions (newest first), watermark -> $minId\n";
    exit(0);
}
fwrite(STDERR, "LCOS ingest failed HTTP $code; watermark unchanged, will retry\n");
exit(1);
