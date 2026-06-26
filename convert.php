<?php
/**
 * PHP Document Converter for Doc Manager (cPanel compatible)
 * Converts DOC, RTF, XLS files to PDF using local LibreOffice or CloudConvert API
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

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method Not Allowed']);
    exit();
}

try {
    // Parse JSON input
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input || !isset($input['base64Data']) || !isset($input['filename'])) {
        throw new Exception('Invalid request parameters.');
    }

    $filename = $input['filename'];
    $base64Data = $input['base64Data'];
    $cloudConvertApiKey = $input['cloudConvertApiKey'] ?? '';

    // Extract actual base64 content
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

    $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));

    // Method 1: Local LibreOffice Conversion (highly efficient, works on VPS/Dedicated servers)
    $pdfBase64 = tryLocalConversion($fileData, $extension);

    // Method 2: CloudConvert API Conversion (fallback for standard shared cPanel hosting)
    if (!$pdfBase64) {
        if (empty($cloudConvertApiKey)) {
            throw new Exception('Локалното конвертиране не е налично на този сървър. Моля, конфигурирайте вашия CloudConvert API ключ в Настройките на приложението.');
        }
        $pdfBase64 = tryCloudConvert($base64Content, $filename, $extension, $cloudConvertApiKey);
    }

    if (!$pdfBase64) {
        throw new Exception('Конвертирането на документа е неуспешно.');
    }

    echo json_encode([
        'success' => true,
        'base64Data' => 'data:application/pdf;base64,' . $pdfBase64
    ]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage()
    ]);
}

/**
 * Converts document using local LibreOffice soffice
 */
function tryLocalConversion($fileData, $extension) {
    if (!function_exists('shell_exec') || !function_exists('exec')) {
        return null;
    }

    // Check if soffice/libreoffice commands are available
    $checkCmd = PHP_OS_FAMILY === 'Windows' ? 'where soffice' : 'which soffice || which libreoffice';
    $path = shell_exec($checkCmd);
    if (!$path) {
        $commonPaths = ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice'];
        $found = false;
        foreach ($commonPaths as $p) {
            if (is_executable($p)) {
                $found = true;
                break;
            }
        }
        if (!$found) {
            return null;
        }
    }

    $tempDir = sys_get_temp_dir();
    $tempId = uniqid('conv_', true);
    $inputFile = $tempDir . DIRECTORY_SEPARATOR . $tempId . '.' . $extension;
    $outputPdf = $tempDir . DIRECTORY_SEPARATOR . $tempId . '.pdf';

    if (file_put_contents($inputFile, $fileData) === false) {
        return null;
    }

    // Convert using headless soffice
    $cmd = sprintf(
        'soffice --headless --convert-to pdf --outdir %s %s 2>&1',
        escapeshellarg($tempDir),
        escapeshellarg($inputFile)
    );

    shell_exec($cmd);

    $pdfBase64 = null;
    if (file_exists($outputPdf) && filesize($outputPdf) > 0) {
        $pdfData = file_get_contents($outputPdf);
        if ($pdfData) {
            $pdfBase64 = base64_encode($pdfData);
        }
    }

    @unlink($inputFile);
    @unlink($outputPdf);

    return $pdfBase64;
}

/**
 * Converts document using CloudConvert API
 */
function tryCloudConvert($base64Content, $filename, $extension, $apiKey) {
    // 1. Create a CloudConvert Job
    $url = "https://api.cloudconvert.com/v2/jobs";
    $jobPayload = [
        'tasks' => [
            'import-1' => [
                'operation' => 'import/upload'
            ],
            'convert-1' => [
                'operation' => 'convert',
                'input' => 'import-1',
                'output_format' => 'pdf'
            ],
            'export-1' => [
                'operation' => 'export/url',
                'input' => 'convert-1'
            ]
        ]
    ];

    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json',
        'Authorization: Bearer ' . $apiKey
    ]);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($jobPayload));
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode !== 201 || !$response) {
        $errorMsg = json_decode($response, true)['message'] ?? 'Failed to create conversion job.';
        throw new Exception("CloudConvert Job Creation Error: " . $errorMsg);
    }

    $job = json_decode($response, true);
    $jobId = $job['data']['id'];

    // Find the import task details for file upload
    $uploadTask = null;
    foreach ($job['data']['tasks'] as $task) {
        if ($task['name'] === 'import-1') {
            $uploadTask = $task;
            break;
        }
    }

    if (!$uploadTask || !isset($uploadTask['result']['form'])) {
        throw new Exception("CloudConvert upload instructions not found.");
    }

    $uploadUrl = $uploadTask['result']['form']['url'];
    $uploadParams = $uploadTask['result']['form']['parameters'];

    // 2. Perform multipart form-data upload to CloudConvert
    $tempFile = tempnam(sys_get_temp_dir(), 'cc_');
    file_put_contents($tempFile, base64_decode($base64Content));

    $postFields = [];
    foreach ($uploadParams as $key => $val) {
        $postFields[$key] = $val;
    }
    
    // Add the file stream
    if (function_exists('curl_file_create')) {
        $postFields['file'] = curl_file_create($tempFile, null, $filename);
    } else {
        $postFields['file'] = '@' . realpath($tempFile) . ';filename=' . $filename;
    }

    $ch = curl_init($uploadUrl);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $postFields);
    curl_setopt($ch, CURLOPT_INFILESIZE, filesize($tempFile));
    
    $uploadResponse = curl_exec($ch);
    $uploadHttpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    @unlink($tempFile);

    if ($uploadHttpCode !== 201 && $uploadHttpCode !== 200 && $uploadHttpCode !== 204) {
        throw new Exception("CloudConvert File Upload Error (" . $uploadHttpCode . ").");
    }

    // 3. Poll job status until it is finished
    $statusUrl = "https://api.cloudconvert.com/v2/jobs/" . $jobId;
    $finished = false;
    $downloadUrl = null;

    for ($i = 0; $i < 30; $i++) {
        sleep(1);
        
        $ch = curl_init($statusUrl);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Authorization: Bearer ' . $apiKey
        ]);
        
        $statusResponse = curl_exec($ch);
        $statusHttpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($statusHttpCode !== 200 || !$statusResponse) {
            continue;
        }

        $statusData = json_decode($statusResponse, true);
        $jobStatus = $statusData['data']['status'];

        if ($jobStatus === 'finished') {
            // Find download url in the export task
            foreach ($statusData['data']['tasks'] as $task) {
                if ($task['name'] === 'export-1' && isset($task['result']['files'][0]['url'])) {
                    $downloadUrl = $task['result']['files'][0]['url'];
                    $finished = true;
                    break 2;
                }
            }
        } elseif ($jobStatus === 'error') {
            $taskError = 'Unknown error';
            foreach ($statusData['data']['tasks'] as $task) {
                if (isset($task['message'])) {
                    $taskError = $task['message'];
                    break;
                }
            }
            throw new Exception("CloudConvert job error: " . $taskError);
        }
    }

    if (!$finished || !$downloadUrl) {
        throw new Exception("CloudConvert conversion timed out.");
    }

    // 4. Download output file and return it as base64
    $ch = curl_init($downloadUrl);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
    $pdfData = curl_exec($ch);
    $downloadHttpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($downloadHttpCode !== 200 || !$pdfData) {
        throw new Exception("Failed to retrieve converted PDF.");
    }

    return base64_encode($pdfData);
}
