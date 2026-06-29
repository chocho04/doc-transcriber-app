<?php
/**
 * One-time diagnostic for the Doc Manager SQLite sync.
 * Upload to the same directory as api.php, visit it in a browser,
 * then DELETE it when done (it exposes server internals).
 */
header('Content-Type: text/plain; charset=utf-8');
error_reporting(E_ALL);
ini_set('display_errors', '1');

echo "=== Doc Manager Sync Diagnostics ===\n\n";

// 1. PHP / SQLite availability
echo "PHP version:            " . PHP_VERSION . "\n";
echo "SQLite3 class exists:   " . (class_exists('SQLite3') ? 'YES' : 'NO  <-- would fall back to database.json') . "\n";
echo "PDO sqlite available:   " . (class_exists('PDO') && in_array('sqlite', PDO::getAvailableDrivers() ?: []) ? 'YES' : 'NO') . "\n";
echo "curl available:         " . (function_exists('curl_init') ? 'YES' : 'NO') . "\n\n";

// 2. Limits relevant to large payloads
echo "post_max_size:          " . ini_get('post_max_size') . "\n";
echo "upload_max_filesize:    " . ini_get('upload_max_filesize') . "\n";
echo "memory_limit:           " . ini_get('memory_limit') . "\n";
echo "max_input_vars:         " . ini_get('max_input_vars') . "\n\n";

// 3. Directory + file writability
$dir = __DIR__;
$dbFile = $dir . '/database.sqlite';
$jsonFile = $dir . '/database.json';
$log = $dir . '/sync_errors.log';

echo "Script directory:       $dir\n";
echo "Dir writable by PHP:    " . (is_writable($dir) ? 'YES' : 'NO  <-- chmod 755/775 needed') . "\n";
echo "PHP process user:       " . (function_exists('posix_getpwuid') ? posix_getpwuid(posix_geteuid())['name'] : get_current_user()) . "\n\n";

echo "database.sqlite exists: " . (file_exists($dbFile) ? 'YES' : 'no (will be created on first save)') . "\n";
if (file_exists($dbFile)) {
    echo "  size:                 " . filesize($dbFile) . " bytes\n";
    echo "  writable:             " . (is_writable($dbFile) ? 'YES' : 'NO  <-- chmod 644/664 needed') . "\n";
    echo "  perms:                " . substr(sprintf('%o', fileperms($dbFile)), -4) . "\n";
}
echo "database.json exists:   " . (file_exists($jsonFile) ? 'YES  <-- means it ran in JSON-fallback mode at some point' : 'no') . "\n\n";

// 3b. File-upload temp directory (cause of UPLOAD_ERR_NO_TMP_DIR / error code 6)
echo "--- Upload temp directory ---\n";
$uploadTmp = ini_get('upload_tmp_dir');
$sysTmp = sys_get_temp_dir();
$pdr = ini_get('enable_post_data_reading');
echo "enable_post_data_reading: " . ($pdr ? 'On' : 'Off  <-- code-only fix active: upload.php parses php://input itself') . "\n";
echo "upload_tmp_dir (ini):   " . ($uploadTmp !== '' ? $uploadTmp : '(empty -> uses system temp)') . "\n";
echo "system temp dir:        $sysTmp\n";
echo "system temp writable:   " . (is_writable($sysTmp) ? 'YES' : 'NO  <-- this causes upload error code 6') . "\n";
$localTmp = $dir . '/tmp';
echo "local ./tmp exists:     " . (is_dir($localTmp) ? 'YES' : 'no (create it + chmod 0777)') . "\n";
echo "local ./tmp writable:   " . (is_dir($localTmp) && is_writable($localTmp) ? 'YES' : 'NO  <-- chmod 0777 ' . $localTmp) . "\n";
echo ">> If uploads fail with error code 6, set this in cPanel MultiPHP INI Editor (Editor mode):\n";
echo "   upload_tmp_dir = \"$localTmp\"\n\n";

// 4. Live write test against SQLite (mirrors api.php exactly)
echo "--- Live SQLite write test ---\n";
try {
    if (!class_exists('SQLite3')) {
        echo "SKIPPED: SQLite3 not available.\n";
    } else {
        $db = new SQLite3($dbFile);
        $db->enableExceptions(true);
        $db->exec("CREATE TABLE IF NOT EXISTS app_state (state_key TEXT PRIMARY KEY, state_value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
        $stmt = $db->prepare("REPLACE INTO app_state (state_key, state_value) VALUES (:k, :v)");
        $stmt->bindValue(':k', '__diagnostic_test__', SQLITE3_TEXT);
        $stmt->bindValue(':v', 'ok ' . date('c'), SQLITE3_TEXT);
        $stmt->execute();
        $row = $db->querySingle("SELECT state_value FROM app_state WHERE state_key='__diagnostic_test__'");
        echo "Write + read back:      SUCCESS -> $row\n";
        $count = $db->querySingle("SELECT COUNT(*) FROM app_state");
        echo "Rows currently stored:  $count\n";
        $db->exec("DELETE FROM app_state WHERE state_key='__diagnostic_test__'");
        $db->close();
    }
} catch (Throwable $e) {
    echo "FAILED: " . $e->getMessage() . "\n";
}

// 5. Recent sync errors
echo "\n--- Last lines of sync_errors.log ---\n";
if (file_exists($log)) {
    $lines = file($log, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach (array_slice($lines, -15) as $l) echo $l . "\n";
} else {
    echo "(no sync_errors.log yet)\n";
}
