<?php
/**
 * SQLite3 Database Synchronization API for Doc Manager
 * Handles preloading and real-time syncing of app state & files
 */

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, GET, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Content-Type: application/json; charset=utf-8");

// Handle CORS preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// ==========================================
// DATABASE CONFIGURATION
// ==========================================
define('SQLITE_FILE', __DIR__ . '/database.sqlite'); // The SQLite database filename (secured via .htaccess)

// Optional: Enable database sync. If set to false, it will fallback to local-only mode.
define('DB_ENABLED', true);

/**
 * Sends a fallback response for local-only offline mode
 */
function reportOfflineFallback() {
    $action = $_GET['action'] ?? '';
    if ($action === 'load') {
        echo json_encode([
            'success' => true,
            'data' => [],
            'warning' => 'Database synchronization not active. Working in local-only offline mode.'
        ]);
    } else {
        echo json_encode([
            'success' => true,
            'message' => 'Local mode active. Data saved browser-side only.'
        ]);
    }
}

/**
 * Writes diagnostic error details to a secure file sync_errors.log
 */
function logSyncError($message, $context = []) {
    $logFile = __DIR__ . '/sync_errors.log';
    $timestamp = date('Y-m-d H:i:s');
    $logData = [
        'timestamp' => $timestamp,
        'message' => $message,
        'context' => $context,
        'server' => [
            'request_method' => $_SERVER['REQUEST_METHOD'] ?? '',
            'content_length' => $_SERVER['CONTENT_LENGTH'] ?? ($_SERVER['HTTP_CONTENT_LENGTH'] ?? '0'),
            'content_type' => $_SERVER['CONTENT_TYPE'] ?? ($_SERVER['HTTP_CONTENT_TYPE'] ?? ''),
            'post_max_size' => ini_get('post_max_size'),
            'upload_max_filesize' => ini_get('upload_max_filesize'),
            'memory_limit' => ini_get('memory_limit'),
        ]
    ];
    $logLine = json_encode($logData, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
    @file_put_contents($logFile, $logLine, FILE_APPEND);
}

if (!DB_ENABLED) {
    reportOfflineFallback();
    exit();
}

// Check database engine fallback state
if (!class_exists('SQLite3')) {
    define('USE_JSON_FALLBACK', true);
    define('JSON_FILE', __DIR__ . '/database.json');
} else {
    define('USE_JSON_FALLBACK', false);
}

try {
    $db = null;

    if (USE_JSON_FALLBACK) {
        // Auto-initialize JSON file if it doesn't exist
        if (!file_exists(JSON_FILE)) {
            file_put_contents(JSON_FILE, json_encode([]));
            chmod(JSON_FILE, 0644);
        }
    } else {
        // Check if the directory is writable
        $db_dir = dirname(SQLITE_FILE);
        if (!is_writable($db_dir)) {
            throw new Exception("The directory '$db_dir' is not writable by PHP. Please verify folder permissions (typically 755 or 777 in cPanel).");
        }

        // Establish SQLite3 connection (Without PDO)
        $db = new SQLite3(SQLITE_FILE);
        $db->enableExceptions(true);

        // Auto-initialize table schema
        $sql = "CREATE TABLE IF NOT EXISTS app_state (
            state_key TEXT PRIMARY KEY,
            state_value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );";
        $db->exec($sql);
    }

    // Route Actions
    $action = $_GET['action'] ?? '';

    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'load') {
        loadAppState($db);
    } elseif ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'save') {
        saveAppState($db);
    } else {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid action or request method.']);
    }

} catch (Exception $e) {
    logSyncError('Database or API exception: ' . $e->getMessage(), [
        'trace' => $e->getTraceAsString(),
        'code' => $e->getCode()
    ]);
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => 'Database operation failed: ' . $e->getMessage()
    ]);
}

/**
 * Loads all key-value entries from database
 */
function loadAppState($db) {
    if (USE_JSON_FALLBACK) {
        $content = file_get_contents(JSON_FILE);
        $data = json_decode($content, true) ?: [];
        echo json_encode([
            'success' => true,
            'data' => $data,
            'warning' => 'SQLite3 class not found. Fell back to flat JSON database storage.'
        ]);
    } else {
        $results = $db->query("SELECT state_key, state_value FROM app_state");
        $data = [];
        if ($results) {
            while ($row = $results->fetchArray(SQLITE3_ASSOC)) {
                $data[$row['state_key']] = $row['state_value'];
            }
        }

        echo json_encode([
            'success' => true,
            'data' => $data
        ]);
    }
}

/**
 * Saves or updates a key-value entry in database
 */
function saveAppState($db) {
    $raw_input = file_get_contents('php://input');
    $input = json_decode($raw_input, true);
    if (!$input || !is_array($input)) {
        $input = $_POST;
    }

    if (!is_array($input) || !array_key_exists('key', $input) || !array_key_exists('value', $input)) {
        $contentLength = (int)($_SERVER['CONTENT_LENGTH'] ?? ($_SERVER['HTTP_CONTENT_LENGTH'] ?? 0));
        $postMaxSize = ini_get('post_max_size');
        
        $errorMsg = 'Missing key or value in request payload.';
        $isSizeViolation = false;
        
        if ($_SERVER['REQUEST_METHOD'] === 'POST' && $contentLength > 0 && empty($raw_input) && empty($_POST)) {
            $isSizeViolation = true;
            $errorMsg = "Request payload discarded. The request size ($contentLength bytes) likely exceeds your server's PHP 'post_max_size' limit ($postMaxSize). Please increase 'post_max_size' and 'upload_max_filesize' in your cPanel PHP selector/MultiPHP settings.";
        }

        logSyncError($errorMsg, [
            'action' => 'save',
            'content_length' => $contentLength,
            'json_error' => json_last_error_msg(),
            'is_size_violation' => $isSizeViolation
        ]);

        http_response_code(400);
        echo json_encode([
            'success' => false, 
            'error' => $errorMsg,
            'is_size_limit_issue' => $isSizeViolation
        ]);
        return;
    }

    $key = $input['key'];
    $value = $input['value'];

    if (USE_JSON_FALLBACK) {
        $content = file_get_contents(JSON_FILE);
        $data = json_decode($content, true) ?: [];
        $data[$key] = $value;
        
        $success = file_put_contents(JSON_FILE, json_encode($data, JSON_PRETTY_PRINT));
        if ($success === false) {
            http_response_code(500);
            echo json_encode(['success' => false, 'error' => 'Failed to write to local JSON file.']);
            return;
        }
    } else {
        $stmt = $db->prepare("REPLACE INTO app_state (state_key, state_value) VALUES (:key, :value)");
        $stmt->bindValue(':key', $key, SQLITE3_TEXT);
        $stmt->bindValue(':value', $value, SQLITE3_TEXT);
        $stmt->execute();
    }

    echo json_encode([
        'success' => true,
        'message' => 'State synced successfully.'
    ]);
}
