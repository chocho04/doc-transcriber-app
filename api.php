<?php
/**
 * State sync API for Doc Manager (single shared dataset, PIN-gated).
 * Data is key/value rows in SQLite (database.sqlite); flat JSON fallback
 * (database.json) when SQLite isn't available.
 *
 *   GET  /api/auth-info               -> { success, pinLength }        (no auth)
 *   GET  /api/load-state             -> { success, data: {...} }       (auth)
 *   POST /api/save-state { key,value } -> { success }                  (auth)
 *   POST /api/set-pin   { value }     -> { success }                   (auth)
 *
 * Auth: every non-public request must send the current Access PIN in the
 * X-Sync-Token header. The PIN is stored in the DB (internal row "_access_pin",
 * never returned by load and not client-writable via save) and defaults to 1234.
 */

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, GET, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization, X-Sync-Token");
header("Content-Type: application/json; charset=utf-8");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

define('SQLITE_FILE', __DIR__ . '/database.sqlite');
define('JSON_FILE', __DIR__ . '/database.json');
define('DEFAULT_PIN', '1234');
define('PIN_KEY', '_access_pin');

$USE_JSON = !class_exists('SQLite3');

function db_get_value($db, $useJson, $key) {
    if ($useJson) {
        $data = json_decode(@file_get_contents(JSON_FILE), true) ?: [];
        return array_key_exists($key, $data) ? $data[$key] : null;
    }
    $stmt = $db->prepare("SELECT state_value FROM app_state WHERE state_key = :k");
    $stmt->bindValue(':k', $key, SQLITE3_TEXT);
    $res = $stmt->execute();
    $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
    return $row ? $row['state_value'] : null;
}

function db_set_value($db, $useJson, $key, $value) {
    if ($useJson) {
        $data = json_decode(@file_get_contents(JSON_FILE), true) ?: [];
        $data[$key] = $value;
        return file_put_contents(JSON_FILE, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) !== false;
    }
    $stmt = $db->prepare("REPLACE INTO app_state (state_key, state_value) VALUES (:k, :v)");
    $stmt->bindValue(':k', $key, SQLITE3_TEXT);
    $stmt->bindValue(':v', $value, SQLITE3_TEXT);
    return (bool) $stmt->execute();
}

function db_get_all_except($db, $useJson, $exceptKey) {
    $out = [];
    if ($useJson) {
        $data = json_decode(@file_get_contents(JSON_FILE), true) ?: [];
        foreach ($data as $k => $v) { if ($k !== $exceptKey) $out[$k] = $v; }
        return $out;
    }
    $res = $db->query("SELECT state_key, state_value FROM app_state");
    if ($res) {
        while ($row = $res->fetchArray(SQLITE3_ASSOC)) {
            if ($row['state_key'] !== $exceptKey) $out[$row['state_key']] = $row['state_value'];
        }
    }
    return $out;
}

try {
    $db = null;
    if ($USE_JSON) {
        if (!file_exists(JSON_FILE)) { file_put_contents(JSON_FILE, json_encode([])); @chmod(JSON_FILE, 0644); }
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

    $accessPin = db_get_value($db, $USE_JSON, PIN_KEY);
    if ($accessPin === null || $accessPin === '') {
        $accessPin = DEFAULT_PIN;
    }

    $action = $_GET['action'] ?? '';

    // Public: lets a fresh device know how many PIN digits to expect.
    if ($action === 'authinfo') {
        echo json_encode(['success' => true, 'pinLength' => strlen($accessPin)]);
        exit();
    }

    // Everything else requires the current PIN.
    $provided = $_SERVER['HTTP_X_SYNC_TOKEN'] ?? '';
    if (!is_string($provided) || !hash_equals((string)$accessPin, $provided)) {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'unauthorized']);
        exit();
    }

    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'load') {
        echo json_encode(['success' => true, 'data' => db_get_all_except($db, $USE_JSON, PIN_KEY)]);
    } elseif ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'save') {
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input) || !array_key_exists('key', $input) || !array_key_exists('value', $input)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'error' => 'Missing key or value.']);
            exit();
        }
        if ((string)$input['key'] === PIN_KEY) { // protected; use set-pin
            echo json_encode(['success' => true]);
            exit();
        }
        db_set_value($db, $USE_JSON, (string)$input['key'], (string)$input['value']);
        echo json_encode(['success' => true]);
    } elseif ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'setpin') {
        $input = json_decode(file_get_contents('php://input'), true);
        $newPin = isset($input['value']) ? trim((string)$input['value']) : '';
        if (!preg_match('/^\d{4,10}$/', $newPin)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'error' => 'PIN must be 4-10 digits.']);
            exit();
        }
        db_set_value($db, $USE_JSON, PIN_KEY, $newPin);
        echo json_encode(['success' => true]);
    } else {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid action or method.']);
    }
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => 'Database operation failed: ' . $e->getMessage()]);
}
