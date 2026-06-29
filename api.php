<?php
/**
 * State sync API for Doc Manager (single shared dataset).
 * Stores app state as key/value rows in SQLite (database.sqlite), with a flat
 * JSON fallback (database.json) when SQLite isn't available.
 *
 *   GET  /api/load-state              -> { success, data: { key: value, ... } }
 *   POST /api/save-state { key, value } -> { success }
 *
 * Auth: every request must send the shared secret in the X-Sync-Token header.
 * The expected secret is read from sync_secret.php (NOT in the repo — you create
 * it on the server: <?php return 'long-random-string';). If that file is absent,
 * sync is treated as "not configured" and the client stays local-only.
 */

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, GET, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization, X-Sync-Token");
header("Content-Type: application/json; charset=utf-8");

// CORS preflight — must answer before the auth gate (preflight carries no token).
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// ---- Auth gate ----------------------------------------------------------
$secretFile = __DIR__ . '/sync_secret.php';
if (!file_exists($secretFile)) {
    // Sync not set up on this server: tell the client to stay local-only.
    echo json_encode(['success' => false, 'error' => 'sync_not_configured']);
    exit();
}
$expected = trim((string) (include $secretFile));
$provided = $_SERVER['HTTP_X_SYNC_TOKEN'] ?? '';
if ($expected === '' || !is_string($provided) || !hash_equals($expected, $provided)) {
    http_response_code(401);
    echo json_encode(['success' => false, 'error' => 'unauthorized']);
    exit();
}

// ---- Storage ------------------------------------------------------------
define('SQLITE_FILE', __DIR__ . '/database.sqlite');
define('JSON_FILE', __DIR__ . '/database.json');
$USE_JSON = !class_exists('SQLite3');

try {
    $db = null;
    if ($USE_JSON) {
        if (!file_exists(JSON_FILE)) {
            file_put_contents(JSON_FILE, json_encode([]));
            @chmod(JSON_FILE, 0644);
        }
    } else {
        if (!is_writable(__DIR__)) {
            throw new Exception("Directory not writable by PHP (set 755/775 in cPanel).");
        }
        $db = new SQLite3(SQLITE_FILE);
        $db->enableExceptions(true);
        $db->busyTimeout(5000);
        $db->exec("CREATE TABLE IF NOT EXISTS app_state (
            state_key TEXT PRIMARY KEY,
            state_value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );");
    }

    $action = $_GET['action'] ?? '';
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'load') {
        loadAppState($db, $USE_JSON);
    } elseif ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'save') {
        saveAppState($db, $USE_JSON);
    } else {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid action or method.']);
    }
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => 'Database operation failed: ' . $e->getMessage()]);
}

function loadAppState($db, $useJson) {
    if ($useJson) {
        $data = json_decode(@file_get_contents(JSON_FILE), true) ?: [];
        echo json_encode(['success' => true, 'data' => $data]);
        return;
    }
    $data = [];
    $res = $db->query("SELECT state_key, state_value FROM app_state");
    if ($res) {
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            $data[$row['state_key']] = $row['state_value'];
        }
    }
    echo json_encode(['success' => true, 'data' => $data]);
}

function saveAppState($db, $useJson) {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input) || !array_key_exists('key', $input) || !array_key_exists('value', $input)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Missing key or value.']);
        return;
    }
    $key = (string) $input['key'];
    $value = (string) $input['value'];

    if ($useJson) {
        $data = json_decode(@file_get_contents(JSON_FILE), true) ?: [];
        $data[$key] = $value;
        if (file_put_contents(JSON_FILE, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) === false) {
            http_response_code(500);
            echo json_encode(['success' => false, 'error' => 'Failed to write JSON store.']);
            return;
        }
    } else {
        $stmt = $db->prepare("REPLACE INTO app_state (state_key, state_value) VALUES (:k, :v)");
        $stmt->bindValue(':k', $key, SQLITE3_TEXT);
        $stmt->bindValue(':v', $value, SQLITE3_TEXT);
        $stmt->execute();
    }
    echo json_encode(['success' => true]);
}
