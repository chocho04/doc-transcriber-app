<?php
/**
 * PHP File Restorer for Doc Manager
 * Writes a bundled backup file back into the uploads/ directory under its
 * ORIGINAL name, so the "uploads/<name>" references inside restored data stay
 * valid. Pairs with the frontend restoreFileToServer() used during ZIP restore.
 *
 * Request body (application/json):  { "filename": "<name>", "base64Data": "data:...;base64,..." }
 * Response:                         { "success": true, "url": "uploads/<name>" }
 *
 * Path-traversal safe: only the sanitized basename inside uploads/ is written.
 */

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Content-Type: application/json; charset=utf-8");

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
    $raw = file_get_contents('php://input');
    $input = json_decode($raw, true);
    if (!is_array($input)) {
        $input = $_POST;
    }

    $filename = isset($input['filename']) ? (string)$input['filename'] : '';
    $base64Data = isset($input['base64Data']) ? (string)$input['base64Data'] : '';

    if (strpos($base64Data, ';base64,') !== false) {
        $parts = explode(';base64,', $base64Data);
        $base64Content = $parts[1];
    } else {
        $base64Content = $base64Data;
    }

    $fileData = base64_decode($base64Content);
    if ($fileData === false || $fileData === '') {
        throw new Exception('Decoded file is empty.');
    }

    // Preserve the original name (basename only) and restrict to safe characters.
    $name = basename(str_replace('\\', '/', $filename));
    if ($name === '' || $name === '.' || $name === '..' || !preg_match('/^[A-Za-z0-9._-]+$/', $name)) {
        throw new Exception('Invalid filename.');
    }

    $upload_dir = __DIR__ . '/uploads';
    if (!file_exists($upload_dir)) {
        if (!mkdir($upload_dir, 0755, true)) {
            throw new Exception('Failed to create uploads directory.');
        }
    }
    if (!is_writable($upload_dir)) {
        throw new Exception("Uploads directory is not writable. Set permissions to 755/775 in cPanel.");
    }

    $target = $upload_dir . '/' . $name;
    if (file_put_contents($target, $fileData) === false) {
        throw new Exception('Failed to write file to storage.');
    }

    echo json_encode([
        'success' => true,
        'url' => 'uploads/' . $name
    ]);

} catch (Throwable $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage()
    ]);
}
