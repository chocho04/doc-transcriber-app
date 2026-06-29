<?php
/**
 * PHP File Uploader for Doc Manager
 * Stores uploaded images/documents into the uploads/ directory.
 *
 * Accepts two transports:
 *   1. multipart/form-data  -> $_FILES['file'] + $_POST['filename']   (preferred:
 *      smaller payload and far less likely to be stripped by ModSecurity/WAF)
 *   2. application/json      -> { base64Data, filename }              (legacy fallback)
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

/**
 * Converts a php.ini shorthand size (e.g. "64M", "8M", "512K") to bytes.
 */
function iniSizeToBytes($val) {
    $val = trim((string)$val);
    if ($val === '') return 0;
    $last = strtolower($val[strlen($val) - 1]);
    $num = (int)$val;
    switch ($last) {
        case 'g': $num *= 1024;
        case 'm': $num *= 1024;
        case 'k': $num *= 1024;
    }
    return $num;
}

/**
 * Manually parses a multipart/form-data body (raw bytes) into named parts.
 * Used when enable_post_data_reading=Off, so PHP never populates $_FILES/$_POST
 * and never creates an upload temp file. Returns ['name' => ['filename'=>?, 'content'=>bytes]].
 * Binary-safe: relies only on byte-based strpos/substr (no mbstring overload in PHP 8).
 */
function parseMultipartBody($rawBody, $boundary) {
    $result = [];
    $delimiter = '--' . $boundary;
    $blocks = explode($delimiter, $rawBody);
    foreach ($blocks as $block) {
        if ($block === '' || trim($block) === '--' || trim($block) === '') {
            continue; // preamble, epilogue, or closing delimiter
        }
        if (substr($block, 0, 2) === "\r\n") {
            $block = substr($block, 2);
        }
        $headerEnd = strpos($block, "\r\n\r\n");
        if ($headerEnd === false) {
            continue;
        }
        $rawHeaders = substr($block, 0, $headerEnd);
        $content = substr($block, $headerEnd + 4);
        // The part content is followed by a trailing CRLF before the next delimiter.
        if (substr($content, -2) === "\r\n") {
            $content = substr($content, 0, -2);
        }
        $name = null;
        $partFilename = null;
        foreach (explode("\r\n", $rawHeaders) as $headerLine) {
            if (stripos($headerLine, 'content-disposition:') === 0) {
                if (preg_match('/\bname="([^"]*)"/i', $headerLine, $m)) {
                    $name = $m[1];
                }
                if (preg_match('/\bfilename="([^"]*)"/i', $headerLine, $mf)) {
                    $partFilename = $mf[1];
                }
            }
        }
        if ($name !== null) {
            $result[$name] = ['filename' => $partFilename, 'content' => $content];
        }
    }
    return $result;
}

$filename = 'unknown';
$base64Data = null;

try {
    $fileData = null;

    // ----- Transport 0: raw binary body (preferred) -----
    // The file is POSTed as the raw request body with ?filename=... in the query.
    // No $_FILES => no PHP temp dir needed; binary body => WAF-friendly.
    if (isset($_GET['filename']) && empty($_FILES['file'])) {
        $filename = trim($_GET['filename']);
        $fileData = file_get_contents('php://input');
        if ($fileData === false || $fileData === '') {
            $contentLength = (int)($_SERVER['CONTENT_LENGTH'] ?? ($_SERVER['HTTP_CONTENT_LENGTH'] ?? 0));
            if ($contentLength > 0) {
                $postMaxSize = ini_get('post_max_size');
                throw new Exception(
                    "Сървърът отхвърли тялото на заявката ($contentLength байта, лимит $postMaxSize). " .
                    "Това обикновено е ModSecurity/WAF. Свържете се с хостинг поддръжката."
                );
            }
            throw new Exception('Empty request body.');
        }
    }
    // ----- Transport 1: multipart/form-data file upload -----
    elseif (!empty($_FILES['file']) && isset($_FILES['file']['tmp_name'])) {
        $upload = $_FILES['file'];
        if ($upload['error'] !== UPLOAD_ERR_OK) {
            throw new Exception('File upload error code: ' . $upload['error']);
        }
        $filename = trim($_POST['filename'] ?? $upload['name'] ?? '');
        $fileData = file_get_contents($upload['tmp_name']);
        if ($fileData === false) {
            throw new Exception('Failed to read uploaded temp file.');
        }
    }
    // ----- Transport 1b: multipart parsed manually from php://input -----
    // Triggered when enable_post_data_reading=Off, so $_FILES is empty but the
    // browser still sent multipart/form-data. No temp file is ever created.
    elseif (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'multipart/form-data') !== false) {
        $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
        if (!preg_match('/boundary=("?)([^";]+)\1/i', $contentType, $bm)) {
            throw new Exception('Multipart boundary not found in Content-Type.');
        }
        $boundary = $bm[2];
        $rawBody = file_get_contents('php://input');
        if ($rawBody === false || $rawBody === '') {
            $contentLength = (int)($_SERVER['CONTENT_LENGTH'] ?? ($_SERVER['HTTP_CONTENT_LENGTH'] ?? 0));
            throw new Exception(
                "Празно тяло на заявката (CONTENT_LENGTH=$contentLength). " .
                "Ако е > 0, тялото е премахнато от ModSecurity/WAF — свържете се с хостинг поддръжката."
            );
        }
        $parts = parseMultipartBody($rawBody, $boundary);
        if (!isset($parts['file'])) {
            throw new Exception('Multipart body has no "file" part.');
        }
        $fileData = $parts['file']['content'];
        $filename = trim(
            ($parts['filename']['content'] ?? '') !== ''
                ? $parts['filename']['content']
                : ($parts['file']['filename'] ?? '')
        );
        if ($fileData === '') {
            throw new Exception('Uploaded file part is empty.');
        }
    } else {
        // ----- Transport 2: JSON base64 (legacy) -----
        $raw_input = file_get_contents('php://input');
        $input = json_decode($raw_input, true);
        if (!$input || !is_array($input)) {
            $input = $_POST;
        }

        if (!is_array($input) || !isset($input['base64Data']) || !isset($input['filename'])) {
            // The browser sent a body but PHP received nothing. Distinguish a real
            // size-limit overflow from a WAF/ModSecurity body strip by comparing the
            // declared CONTENT_LENGTH against the actual post_max_size in bytes.
            $contentLength = (int)($_SERVER['CONTENT_LENGTH'] ?? ($_SERVER['HTTP_CONTENT_LENGTH'] ?? 0));
            $bodyEmpty = empty($raw_input) && empty($_POST) && empty($_FILES);
            if ($contentLength > 0 && $bodyEmpty) {
                $postMaxSize = ini_get('post_max_size');
                $limitBytes = iniSizeToBytes($postMaxSize);
                if ($limitBytes > 0 && $contentLength >= $limitBytes) {
                    throw new Exception(
                        "Файлът ($contentLength байта) надвишава лимита на сървъра 'post_max_size' ($postMaxSize). " .
                        "Увеличете 'post_max_size' и 'upload_max_filesize' в cPanel (MultiPHP INI Editor)."
                    );
                }
                throw new Exception(
                    "Сървърът отхвърли тялото на заявката ($contentLength байта, под лимита $postMaxSize). " .
                    "Това обикновено се причинява от ModSecurity/WAF. Свържете се с хостинг поддръжката, " .
                    "за да изключат ModSecurity за този сайт, или да добавят изключение за качването на файлове."
                );
            }
            throw new Exception('Invalid request parameters. Missing file/base64Data or filename.');
        }

        $filename = trim($input['filename']);
        $base64Data = $input['base64Data'];

        if (strpos($base64Data, ';base64,') !== false) {
            $parts = explode(';base64,', $base64Data);
            $base64Content = $parts[1];
        } else {
            $base64Content = $base64Data;
        }

        $fileData = base64_decode($base64Content);
        if ($fileData === false || $fileData === '') {
            throw new Exception('Failed to decode base64 file data.');
        }
    }

    if (empty($filename)) {
        throw new Exception('Filename cannot be empty.');
    }

    // Extract extension safely
    $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));

    // Allowed safe extensions
    $allowed_extensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'rtf', 'txt', 'csv', 'ppt', 'pptx', 'odt', 'ods', 'odp'];
    if (!in_array($extension, $allowed_extensions, true)) {
        throw new Exception('File extension not allowed for upload security.');
    }

    // Create uploads directory if not exists
    $upload_dir = __DIR__ . '/uploads';
    if (!file_exists($upload_dir)) {
        if (!mkdir($upload_dir, 0755, true)) {
            throw new Exception('Failed to create uploads directory.');
        }
    }
    if (!is_writable($upload_dir)) {
        throw new Exception("Uploads directory is not writable. Set permissions to 755/775 in cPanel.");
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

} catch (Throwable $e) {
    // Log upload failure to sync_errors.log
    $logFile = __DIR__ . '/sync_errors.log';
    $timestamp = date('Y-m-d H:i:s');
    $logData = [
        'timestamp' => $timestamp,
        'message' => 'Upload failed: ' . $e->getMessage(),
        'context' => [
            'filename' => $filename ?? 'unknown',
            'content_type' => $_SERVER['CONTENT_TYPE'] ?? '',
            'post_data_reading' => ini_get('enable_post_data_reading'),
            'has_files' => !empty($_FILES['file']) ? 'yes' : 'no',
            'content_length' => $_SERVER['CONTENT_LENGTH'] ?? '0',
            'base64_length' => isset($base64Data) ? strlen((string)$base64Data) : 0
        ]
    ];
    @file_put_contents($logFile, json_encode($logData, JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND);

    http_response_code(400);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage()
    ]);
}
