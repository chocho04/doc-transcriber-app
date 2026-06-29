<?php
/**
 * PHP Base64 File Uploader for Doc Manager
 * Decodes and stores uploaded images/documents into the uploads/ directory
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
    // Parse input (try JSON first, fallback to $_POST)
    $raw_input = file_get_contents('php://input');
    $input = json_decode($raw_input, true);
    if (!$input || !is_array($input)) {
        $input = $_POST;
    }

    if (!is_array($input) || !isset($input['base64Data']) || !isset($input['filename'])) {
        throw new Exception('Invalid request parameters. Missing base64Data or filename.');
    }

    $filename = trim($input['filename']);
    $base64Data = $input['base64Data'];

    if (empty($filename)) {
        throw new Exception('Filename cannot be empty.');
    }

    // Extract extension safely
    $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
    
    // Allowed safe extensions
    $allowed_extensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'rtf', 'txt', 'csv', 'ppt', 'pptx', 'odt', 'ods', 'odp'];
    if (!in_items($extension, $allowed_extensions)) {
        throw new Exception('File extension not allowed for upload security.');
    }

    // Helper function for in_array logic
    function in_items($item, $array) {
        return in_array($item, $array, true);
    }

    // Extract base64 content
    if (strpos($base64Data, ';base64,') !== false) {
        $parts = explode(';base64,', $base64Data);
        $base64Content = $parts[1];
    } else {
        $base64Content = $base64Data;
    }

    $fileData = base64_decode($base64Content);
    if (!$fileData) {
        throw new Exception('Failed to decode base64 file data.');
    }

    // Create uploads directory if not exists
    $upload_dir = __DIR__ . '/uploads';
    if (!file_exists($upload_dir)) {
        if (!mkdir($upload_dir, 0755, true)) {
            throw new Exception('Failed to create uploads directory.');
        }
    }

    // Generate a unique, safe filename to prevent overwrites or traversal
    $safe_basename = preg_replace('/[^a-zA-Z0-9_\-]/', '', pathinfo($filename, PATHINFO_FILENAME));
    if (empty($safe_basename)) {
        $safe_basename = 'file';
    }
    $unique_name = $safe_basename . '_' . time() . '_' . bin2hex(random_bytes(4)) . '.' . $extension;
    $target_file = $upload_dir . '/' . $unique_name;

    // Save the file
    if (file_put_contents($target_file, $fileData) === false) {
        throw new Exception('Failed to write file to storage.');
    }

    // Return the relative URL path
    echo json_encode([
        'success' => true,
        'url' => 'uploads/' . $unique_name
    ]);

} catch (Exception $e) {
    // Log upload failure to sync_errors.log if it exists
    $logFile = __DIR__ . '/sync_errors.log';
    $timestamp = date('Y-m-d H:i:s');
    $logData = [
        'timestamp' => $timestamp,
        'message' => 'Upload failed: ' . $e->getMessage(),
        'context' => [
            'filename' => $filename ?? 'unknown',
            'base64_length' => isset($base64Data) ? strlen($base64Data) : 0
        ]
    ];
    @file_put_contents($logFile, json_encode($logData) . "\n", FILE_APPEND);

    http_response_code(400);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage()
    ]);
}
