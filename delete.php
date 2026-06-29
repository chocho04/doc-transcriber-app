<?php
/**
 * PHP File Deleter for Doc Manager
 * Removes a previously uploaded file from the uploads/ directory.
 *
 * Request body (application/json):  { "url": "uploads/<name>" }
 * Response:                         { "success": true, "deleted": true|false }
 *
 * Path-traversal safe: only the basename inside uploads/ is ever touched, so
 * values like "uploads/../api.php" can never escape the uploads folder.
 */

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Content-Type: application/json; charset=utf-8");

// Handle CORS preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Method Not Allowed']);
    exit();
}

try {
    // enable_post_data_reading is Off on this host (see .user.ini), so read the
    // raw JSON body from php://input rather than relying on $_POST.
    $raw = file_get_contents('php://input');
    $input = json_decode($raw, true);
    if (!is_array($input)) {
        $input = $_POST;
    }

    $url = isset($input['url']) ? (string)$input['url'] : '';
    if (strpos($url, 'uploads/') !== 0) {
        throw new Exception('Only uploads/ paths can be deleted.');
    }

    // Strip the "uploads/" prefix and keep only the basename — this neutralizes
    // any "../" or absolute-path tricks.
    $name = basename(str_replace('\\', '/', substr($url, strlen('uploads/'))));
    if ($name === '' || $name === '.' || $name === '..') {
        throw new Exception('Invalid filename.');
    }

    $uploads_dir = realpath(__DIR__ . '/uploads');
    if ($uploads_dir === false) {
        // The uploads folder doesn't exist yet -> nothing to delete.
        echo json_encode(['success' => true, 'deleted' => false]);
        exit();
    }

    $target = realpath($uploads_dir . DIRECTORY_SEPARATOR . $name);

    $deleted = false;
    if ($target !== false && dirname($target) === $uploads_dir && is_file($target)) {
        if (!@unlink($target)) {
            throw new Exception('Failed to delete file.');
        }
        $deleted = true;
    }

    echo json_encode(['success' => true, 'deleted' => $deleted]);

} catch (Throwable $e) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => $e->getMessage()]);
}
