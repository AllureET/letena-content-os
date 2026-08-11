<?php
/**
 * LCOS attribution aggregates, runs INSIDE letenav2 as api/lcos/aggregates.php.
 * Returns COUNTS ONLY, never records. LCOS calls this daily (WF17) to attribute
 * consultations and referrals to content topics.
 *
 * SCHEMA VERIFIED against the live repo (2026-08-11): consult categories are a
 * JOIN TABLE, coded. phase1_up.sql: `category` (id, code, label, 'UTI','OTHER'
 * etc.) + `category_tag` (consult_id, category_id). Older db_patient_model.sql
 * has `consult_category` (consult_id, category VARCHAR). This endpoint prefers
 * category_tag+category and falls back to consult_category if that pair is
 * absent, introspected at runtime.
 *
 * Counting is done at the consult level per the EMR data-model rule.
 */
require_once __DIR__ . '/../../config/dbconn.php';
if (!isset($db) && isset($dbconn)) { $db = $dbconn; }
require_once __DIR__ . '/../../lib/integration_creds.php';

$secret = letena_integration_cred_effective($db, 'lcos', 'lcos_ingest_secret');
$ts  = $_SERVER['HTTP_X_LETENA_TIMESTAMP'] ?? '';
$sig = $_SERVER['HTTP_X_LETENA_SIGNATURE'] ?? '';
$qs  = $_SERVER['QUERY_STRING'] ?? '';
if (!$secret || abs(time() - (int)$ts) > 300
    || !hash_equals('sha256=' . hash_hmac('sha256', $ts . '.' . $qs, $secret), $sig)) {
    http_response_code(401); exit('unauthorized');
}

$from = preg_match('/^\d{4}-\d{2}-\d{2}$/', $_GET['from'] ?? '') ? $_GET['from'] : gmdate('Y-m-d', strtotime('-1 day'));
$to   = preg_match('/^\d{4}-\d{2}-\d{2}$/', $_GET['to'] ?? '') ? $_GET['to'] : gmdate('Y-m-d');
if ((strtotime($to) - strtotime($from)) > 31 * 86400) { http_response_code(422); exit('range too wide'); }

function lcos_table_exists(mysqli $db, string $t): bool {
    $stmt = $db->prepare("SELECT 1 FROM information_schema.tables
                          WHERE table_schema = DATABASE() AND table_name = ?");
    $stmt->bind_param('s', $t);
    $stmt->execute();
    return (bool)$stmt->get_result()->fetch_row();
}

if (lcos_table_exists($db, 'category_tag') && lcos_table_exists($db, 'category')) {
    // Live coded model: category_tag -> category.code
    $sql = "SELECT DATE(c.opened_at) AS d, cat.code AS category,
                   COUNT(DISTINCT c.consult_id) AS consults,
                   COUNT(DISTINCT CASE WHEN c.referred = 1 THEN c.consult_id END) AS referrals
            FROM consult c
            JOIN category_tag ct ON ct.consult_id = c.consult_id
            JOIN category cat ON cat.id = ct.category_id
            WHERE c.opened_at >= ? AND c.opened_at < DATE_ADD(?, INTERVAL 1 DAY)
            GROUP BY DATE(c.opened_at), cat.code";
} elseif (lcos_table_exists($db, 'consult_category')) {
    $sql = "SELECT DATE(c.opened_at) AS d, cc.category AS category,
                   COUNT(DISTINCT c.consult_id) AS consults,
                   COUNT(DISTINCT CASE WHEN c.referred = 1 THEN c.consult_id END) AS referrals
            FROM consult c
            JOIN consult_category cc ON cc.consult_id = c.consult_id
            WHERE c.opened_at >= ? AND c.opened_at < DATE_ADD(?, INTERVAL 1 DAY)
            GROUP BY DATE(c.opened_at), cc.category";
} else {
    http_response_code(500); exit('no category storage found');
}

$stmt = $db->prepare($sql);
$stmt->bind_param('ss', $from, $to);
$stmt->execute();
$res = $stmt->get_result();

$days = [];
while ($r = $res->fetch_assoc()) {
    $slug = strtolower(preg_replace('/[^a-z0-9]+/i', '_', trim((string)$r['category'])));
    if ($slug === '') continue;
    $d = $r['d'];
    $days[$d][$slug]['consults']  = ($days[$d][$slug]['consults'] ?? 0) + (int)$r['consults'];
    $days[$d][$slug]['referrals'] = ($days[$d][$slug]['referrals'] ?? 0) + (int)$r['referrals'];
}
$out = [];
foreach ($days as $d => $cats) { $out[] = ['date' => $d, 'categories' => $cats]; }
header('Content-Type: application/json');
echo json_encode(['days' => $out]);
