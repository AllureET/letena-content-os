<?php
/**
 * content_os.php, entry point for the Letena Content OS from inside the EMR.
 * Additive page, no nav changes, no patient data. Requires a signed-in staff
 * session; shows the Content OS dashboard link (from the credential store)
 * and what the system is, in the EMR design language.
 */
require_once __DIR__ . '/config/session.php';
require_once __DIR__ . '/config/dbconn.php';
if (!isset($db) && isset($dbconn)) { $db = $dbconn; }
require_once __DIR__ . '/lib/integration_creds.php';
$lcosUrl = $db ? letena_integration_cred_effective($db, 'lcos', 'lcos_base_url') : null;
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Content OS · Letena EMR</title>
<style>
:root{--cetacean:#16103F;--fuzzy-wuzzy:#CD6962;--marigold:#EBAB20;--jelly-bean:#477287;
--plump-purple:#5D489C;--teal:#5BBFB5;--canvas:#F5F3EF;--surface:#FFFFFF;--line:#E6E2DA;
--ink:#16103F;--ink-2:#4A5160;--ink-mute:#8A8578;--r-md:10px;--r-lg:14px}
*{box-sizing:border-box;margin:0}
body{font-family:'Poppins',system-ui,sans-serif;background:var(--canvas);color:var(--ink);
font-size:14px;padding:40px 20px}
.wrap{max-width:720px;margin:0 auto}
.mark{font-family:Georgia,'Crimson Pro',serif;font-size:26px;margin-bottom:4px}
.mark b{color:var(--fuzzy-wuzzy)}
.sub{color:var(--ink-mute);font-size:13px;margin-bottom:22px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);
padding:18px 20px;margin-bottom:14px}
.eyebrow{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--plump-purple);
font-weight:600;margin-bottom:8px}
.btn{display:inline-block;background:var(--fuzzy-wuzzy);color:#fff;border-radius:8px;
padding:10px 22px;text-decoration:none;font-weight:500;font-size:14px}
.muted{color:var(--ink-mute)}
.kv{line-height:1.8;font-size:13px}
a{color:var(--jelly-bean)}
.pill{display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border-radius:999px;
font-size:11px;font-weight:500;color:#2C6F68;background:#E2F0EE}
.pill .d{width:6px;height:6px;border-radius:50%;background:currentColor}
</style>
</head>
<body>
<div class="wrap">
  <div class="mark">letena<b>.</b>os</div>
  <div class="sub">Content OS, from real questions to medically governed content</div>

  <div class="card">
    <div class="eyebrow">What this is</div>
    <div class="kv">
      The Content OS turns the anonymized questions Ethiopians ask Letena into
      approved, claim-traceable education content in Amharic and English. It
      reads demand from this EMR's own triage (no patient data ever crosses),
      maps it against approved medical knowledge cards, and runs generation,
      validation, language review and publishing with clinical sign-off at
      every risk gate.
    </div>
  </div>

  <?php if ($lcosUrl): ?>
  <div class="card">
    <div class="eyebrow">Dashboard</div>
    <p class="kv" style="margin-bottom:12px"><span class="pill"><span class="d"></span>connected</span></p>
    <a class="btn" href="<?php echo htmlspecialchars($lcosUrl, ENT_QUOTES); ?>" target="_blank" rel="noopener">Open Content OS</a>
    <p class="muted" style="margin-top:10px;font-size:12px">Opens in a new tab. Sign in with your Content OS account.</p>
  </div>
  <?php else: ?>
  <div class="card">
    <div class="eyebrow">Not configured yet</div>
    <div class="kv muted">
      The Content OS server address has not been set. An administrator enters
      <code>lcos_base_url</code> (group <code>lcos</code>) in
      <a href="integration_credentials.php">Integration credentials</a> once
      the Content OS host is live. Until then this page is informational.
    </div>
  </div>
  <?php endif; ?>

  <div class="card">
    <div class="eyebrow">How it connects to this EMR</div>
    <div class="kv muted">
      A 15-minute background job (<code>lcos_export</code>) exports new inbox
      messages with their triage category and urgency as hints. Identifiers
      never leave this system: no usernames, no phone numbers, no patient or
      consult IDs. The Content OS strips any identifying text on arrival and
      stores only the sanitized question.
    </div>
  </div>

  <p class="muted" style="font-size:12px"><a href="emr_home.php">&larr; Back to EMR home</a></p>
</div>
</body>
</html>
