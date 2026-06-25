$port = 8080
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Start()
Write-Host "=============================================="
Write-Host "  DocuScribe Dev Server Running"
Write-Host "  URL: http://127.0.0.1:$port/"
Write-Host "  Press Ctrl+C to stop the server"
Write-Host "=============================================="

$currentDir = Get-Location

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        # CORS Headers to support file:// origins
        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.Headers.Add("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        
        if ($request.HttpMethod -eq "OPTIONS") {
            $response.StatusCode = 200
            $response.Close()
            continue
        }
        
        $url = $request.Url.LocalPath
        
        if (($url -eq "/api/convert-rtf" -or $url -eq "/api/convert-doc") -and $request.HttpMethod -eq "POST") {
            $docPath = $null
            $pdfPath = $null
            $word = $null
            $doc = $null
            try {
                $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                $body = $reader.ReadToEnd()
                $reader.Close()
                
                $json = ConvertFrom-Json $body
                $base64Data = $json.base64Data
                $filename = $json.filename
                
                # Split at ";base64," to get the actual base64 string
                $parts = $base64Data -split ';base64,'
                $base64Content = if ($parts.Length -gt 1) { $parts[1] } else { $parts[0] }
                $bytes = [System.Convert]::FromBase64String($base64Content)
                
                $ext = [System.IO.Path]::GetExtension($filename)
                if (-not $ext) { $ext = ".rtf" }
                
                $tempGuid = [System.Guid]::NewGuid().ToString()
                $tempDir = [System.IO.Path]::GetTempPath()
                $docPath = [System.IO.Path]::Combine($tempDir, "convert_$tempGuid$ext")
                $pdfPath = [System.IO.Path]::Combine($tempDir, "convert_$tempGuid.pdf")
                
                [System.IO.File]::WriteAllBytes($docPath, $bytes)
                
                # Use COM object for Word conversion
                $word = New-Object -ComObject Word.Application
                $word.Visible = $false
                $word.DisplayAlerts = 0 # wdAlertsNone
                
                $doc = $word.Documents.Open($docPath, $false, $true) # Open(FileName, ConfirmConversions, ReadOnly)
                # 17 is wdFormatPDF
                $doc.SaveAs([ref]$pdfPath, [ref]17)
                $doc.Close($false)
                $word.Quit()
                
                # Release COM references immediately
                [System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null
                [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
                $doc = $null
                $word = $null
                [System.GC]::Collect()
                [System.GC]::WaitForPendingFinalizers()
                
                if (Test-Path $pdfPath) {
                    $pdfBytes = [System.IO.File]::ReadAllBytes($pdfPath)
                    $pdfBase64 = [System.Convert]::ToBase64String($pdfBytes)
                    
                    Remove-Item $docPath -ErrorAction SilentlyContinue
                    Remove-Item $pdfPath -ErrorAction SilentlyContinue
                    
                    $responseObj = @{
                        success = $true
                        base64Data = "data:application/pdf;base64,$pdfBase64"
                    }
                    $responseJson = ConvertTo-Json $responseObj
                    $responseBytes = [System.Text.Encoding]::UTF8.GetBytes($responseJson)
                    
                    $response.ContentType = "application/json; charset=utf-8"
                    $response.ContentLength64 = $responseBytes.Length
                    $response.OutputStream.Write($responseBytes, 0, $responseBytes.Length)
                } else {
                    throw "PDF output file was not created by Microsoft Word."
                }
            } catch {
                # Ensure word/doc are closed/released on error
                if ($null -ne $doc) {
                    try { $doc.Close($false) } catch {}
                    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null
                }
                if ($null -ne $word) {
                    try { $word.Quit() } catch {}
                    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
                }
                [System.GC]::Collect()
                [System.GC]::WaitForPendingFinalizers()
                
                if ($null -ne $docPath -and (Test-Path $docPath)) { Remove-Item $docPath -ErrorAction SilentlyContinue }
                if ($null -ne $pdfPath -and (Test-Path $pdfPath)) { Remove-Item $pdfPath -ErrorAction SilentlyContinue }
                
                $errMsg = $_.ToString()
                $responseObj = @{
                    success = $false
                    error = $errMsg
                }
                $responseJson = ConvertTo-Json $responseObj
                $responseBytes = [System.Text.Encoding]::UTF8.GetBytes($responseJson)
                
                $response.StatusCode = 500
                $response.ContentType = "application/json; charset=utf-8"
                $response.ContentLength64 = $responseBytes.Length
                $response.OutputStream.Write($responseBytes, 0, $responseBytes.Length)
            }
            $response.Close()
            continue
        }
        
        if ($url -eq "/") {
            $url = "/index.html"
        }
        
        # Sanitize path to prevent directory traversal
        $url = $url.Replace("..", "")
        $path = [System.IO.Path]::Combine($currentDir, $url.TrimStart('/'))
        
        if (Test-Path $path -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($path)
            
            # Simple Content-Type mapping
            $ext = [System.IO.Path]::GetExtension($path).ToLower()
            $contentType = switch ($ext) {
                ".html" { "text/html; charset=utf-8" }
                ".css"  { "text/css; charset=utf-8" }
                ".js"   { "application/javascript; charset=utf-8" }
                ".png"  { "image/png" }
                ".jpg"  { "image/jpeg" }
                ".jpeg" { "image/jpeg" }
                ".gif"  { "image/gif" }
                ".svg"  { "image/svg+xml" }
                ".ico"  { "image/x-icon" }
                ".json" { "application/json; charset=utf-8" }
                default { "application/octet-stream" }
            }
            
            $response.ContentType = $contentType
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            Write-Host "404 - Not Found: $url"
            $response.StatusCode = 404
            $errBytes = [System.Text.Encoding]::UTF8.GetBytes("404 - File Not Found")
            $response.ContentType = "text/plain"
            $response.ContentLength64 = $errBytes.Length
            $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
        }
        $response.Close()
    }
} catch {
    Write-Host "Server encountered an error: $_"
} finally {
    if ($listener) {
        $listener.Stop()
        $listener.Close()
        Write-Host "Server stopped."
    }
}
