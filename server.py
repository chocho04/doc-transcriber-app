import http.server
import socketserver
import os
import json
import urllib.request
import urllib.parse
import urllib.error
import base64
import time
import re
import secrets

PORT = 8080

# Maps a data URL MIME type to the file extension used when saving into uploads/.
MIME_TO_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg',
    'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv',
    'application/rtf': 'rtf', 'text/rtf': 'rtf'
}


def save_uploaded_file(filename, base64_data):
    """Decodes a base64 data URL and writes it into the local uploads/ folder.
    Returns the relative URL (e.g. "uploads/invoice_1700000000_ab12cd34.jpg")."""
    mime = 'application/octet-stream'
    b64 = base64_data or ''
    if b64.startswith('data:'):
        header, _, b64 = b64.partition(',')
        m = re.match(r'data:([^;]+)', header)
        if m:
            mime = m.group(1).lower()

    file_bytes = base64.b64decode(b64)
    if not file_bytes:
        raise Exception("Decoded file is empty.")

    # Pick an extension from the MIME type, falling back to the original filename's.
    ext = MIME_TO_EXT.get(mime)
    if not ext:
        ext = os.path.splitext(filename or '')[1].lstrip('.').lower() or 'bin'

    base = os.path.splitext(os.path.basename(filename or 'file'))[0]
    base = re.sub(r'[^A-Za-z0-9_\-]', '', base) or 'file'

    uploads_dir = os.path.join(os.getcwd(), 'uploads')
    os.makedirs(uploads_dir, exist_ok=True)

    unique_name = f"{base}_{int(time.time())}_{secrets.token_hex(4)}.{ext}"
    target = os.path.join(uploads_dir, unique_name)
    with open(target, 'wb') as f:
        f.write(file_bytes)

    print(f"[Upload] Saved {len(file_bytes)} bytes -> uploads/{unique_name}")
    return f"uploads/{unique_name}"


def delete_uploaded_file(url):
    """Deletes a file from the uploads/ folder given its "uploads/<name>" URL.
    Returns True if a file was actually removed. Path-traversal safe: only the
    basename inside uploads/ is ever touched."""
    if not url or not str(url).startswith('uploads/'):
        raise Exception("Only uploads/ paths can be deleted.")
    name = os.path.basename(url[len('uploads/'):].replace('\\', '/'))
    if not name or name in ('.', '..'):
        raise Exception("Invalid filename.")

    uploads_dir = os.path.realpath(os.path.join(os.getcwd(), 'uploads'))
    target = os.path.realpath(os.path.join(uploads_dir, name))
    if os.path.dirname(target) != uploads_dir:
        raise Exception("Path escapes the uploads folder.")

    if os.path.isfile(target):
        os.remove(target)
        print(f"[Delete] Removed {url}")
        return True
    print(f"[Delete] Not found (already gone): {url}")
    return False


def convert_file(filename, base64_data, api_key, output_format='pdf'):
    print(f"[CloudConvert] Starting conversion job for: {filename} -> {output_format}")

    # 1. Create a job
    url = "https://api.cloudconvert.com/v2/jobs"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    payload = {
        "tasks": {
            "import-1": {
                "operation": "import/upload"
            },
            "convert-1": {
                "operation": "convert",
                "input": "import-1",
                "output_format": output_format
            },
            "export-1": {
                "operation": "export/url",
                "input": "convert-1"
            }
        }
    }
    
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req) as resp:
            job_data = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        err_info = e.read().decode('utf-8')
        print(f"[CloudConvert Error] Job creation failed: {err_info}")
        raise Exception(f"CloudConvert Job Creation failed: {err_info}")

    # 2. Extract upload task details and form parameters
    tasks = job_data['data']['tasks']
    upload_task = next(t for t in tasks if t['name'] == 'import-1')
    upload_url = upload_task['result']['form']['url']
    upload_params = upload_task['result']['form']['parameters']
    
    # Decode base64 input file data
    if ';base64,' in base64_data:
        base64_content = base64_data.split(';base64,')[1]
    else:
        base64_content = base64_data
    file_bytes = base64.b64decode(base64_content)
    
    # 3. Perform multipart form-data upload to CloudConvert
    boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
    body = []
    for key, value in upload_params.items():
        body.append(f"--{boundary}\r\n".encode('utf-8'))
        body.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode('utf-8'))
        body.append(f"{value}\r\n".encode('utf-8'))
    
    # File field must be last
    body.append(f"--{boundary}\r\n".encode('utf-8'))
    body.append(f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode('utf-8'))
    body.append(b"Content-Type: application/octet-stream\r\n\r\n")
    body.append(file_bytes)
    body.append(b"\r\n")
    body.append(f"--{boundary}--\r\n".encode('utf-8'))
    
    upload_body = b"".join(body)
    
    upload_headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(upload_body))
    }
    
    print(f"[CloudConvert] Uploading file data ({len(file_bytes)} bytes) to storage...")
    upload_req = urllib.request.Request(upload_url, data=upload_body, headers=upload_headers, method='POST')
    try:
        with urllib.request.urlopen(upload_req) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        err_info = e.read().decode('utf-8')
        print(f"[CloudConvert Error] File upload failed: {err_info}")
        raise Exception(f"CloudConvert File Upload failed: {err_info}")
        
    # 4. Poll job status
    job_id = job_data['data']['id']
    status_url = f"https://api.cloudconvert.com/v2/jobs/{job_id}"
    
    pdf_url = None
    print("[CloudConvert] Polling job status...")
    for attempt in range(60): # 60 seconds timeout
        time.sleep(1)
        status_req = urllib.request.Request(status_url, headers=headers, method='GET')
        try:
            with urllib.request.urlopen(status_req) as resp:
                status_data = json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            err_info = e.read().decode('utf-8')
            print(f"[CloudConvert Error] Job status check failed: {err_info}")
            raise Exception(f"CloudConvert Job Status check failed: {err_info}")
            
        job_status = status_data['data']['status']
        if job_status == 'finished':
            export_task = next(t for t in status_data['data']['tasks'] if t['name'] == 'export-1')
            pdf_url = export_task['result']['files'][0]['url']
            print(f"[CloudConvert] Job completed successfully in {attempt + 1}s.")
            break
        elif job_status == 'failed':
            err_msg = "Unknown conversion failure"
            for t in status_data['data']['tasks']:
                if t.get('status') == 'failed':
                    err_msg = t.get('message', err_msg)
            print(f"[CloudConvert Error] Job failed status: {err_msg}")
            raise Exception(f"CloudConvert Job failed: {err_msg}")
            
    if not pdf_url:
        print("[CloudConvert Error] Job timed out.")
        raise Exception("CloudConvert Job timed out or output URL not found.")
        
    # 5. Download the converted file and return it as a base64 data URL
    print("[CloudConvert] Downloading converted file...")
    pdf_req = urllib.request.Request(pdf_url, method='GET')
    try:
        with urllib.request.urlopen(pdf_req) as resp:
            pdf_bytes = resp.read()
    except urllib.error.HTTPError as e:
        err_info = e.read().decode('utf-8')
        print(f"[CloudConvert Error] Downloading file failed: {err_info}")
        raise Exception(f"Failed to download converted file from CloudConvert: {err_info}")

    out_base64 = base64.b64encode(pdf_bytes).decode('utf-8')
    mime = 'image/png' if output_format == 'png' else 'application/pdf'
    print("[CloudConvert] Conversion finished successfully.")
    return f"data:{mime};base64,{out_base64}"


class MyHandler(http.server.BaseHTTPRequestHandler):
    def end_headers(self):
        # CORS Headers to support file:// origins and other ports
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path
        if path == '/':
            path = '/index.html'
        
        # Prevent directory traversal
        path = path.replace('..', '')
        local_path = os.path.join(os.getcwd(), path.lstrip('/'))
        
        if os.path.exists(local_path) and os.path.isfile(local_path):
            self.send_response(200)
            
            # Simple Content-Type mapping
            ext = os.path.splitext(local_path)[1].lower()
            content_type = {
                '.html': 'text/html; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.js': 'application/javascript; charset=utf-8',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.svg': 'image/svg+xml',
                '.ico': 'image/x-icon',
                '.json': 'application/json; charset=utf-8',
                '.pdf': 'application/pdf',
                '.txt': 'text/plain; charset=utf-8',
                '.csv': 'text/csv; charset=utf-8',
                '.rtf': 'application/rtf'
            }.get(ext, 'application/octet-stream')
            
            self.send_header('Content-Type', content_type)
            with open(local_path, 'rb') as f:
                content = f.read()
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        else:
            self.send_response(404)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b"404 - File Not Found")

    def do_POST(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path

        # ----- File upload: save the posted file into the uploads/ folder -----
        if path == '/api/upload-file':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                filename = data.get('filename')
                base64_data = data.get('base64Data')
                if not base64_data:
                    raise Exception("Missing base64Data in upload request.")

                url = save_uploaded_file(filename, base64_data)
                response_bytes = json.dumps({'success': True, 'url': url}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(response_bytes)))
                self.end_headers()
                self.wfile.write(response_bytes)
            except Exception as e:
                print(f"[Upload Error] {str(e)}")
                response_bytes = json.dumps({'success': False, 'error': str(e)}).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(response_bytes)))
                self.end_headers()
                self.wfile.write(response_bytes)
            return

        # ----- File delete: remove a file from the uploads/ folder -----
        if path == '/api/delete-file':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                deleted = delete_uploaded_file(data.get('url'))
                response_bytes = json.dumps({'success': True, 'deleted': deleted}).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(response_bytes)))
                self.end_headers()
                self.wfile.write(response_bytes)
            except Exception as e:
                print(f"[Delete Error] {str(e)}")
                response_bytes = json.dumps({'success': False, 'error': str(e)}).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(response_bytes)))
                self.end_headers()
                self.wfile.write(response_bytes)
            return

        # Accept all typical routes for compatibility
        valid_routes = ['/api/convert-doc', '/api/convert-rtf', '/api/convert-xls', '/api/convert-to-pdf']

        if path in valid_routes:
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            
            try:
                data = json.loads(post_data.decode('utf-8'))
                filename = data.get('filename')
                base64_data = data.get('base64Data')
                
                # Retrieve CloudConvert API Key from the frontend payload
                api_key = data.get('cloudConvertApiKey')

                if not api_key:
                    raise Exception("CloudConvert API Key is not configured. Please configure it in Settings.")

                # Target format chosen in Settings: 'pdf' (default) or 'png' image
                output_format = data.get('outputFormat', 'pdf')
                if output_format not in ('pdf', 'png'):
                    output_format = 'pdf'

                pdf_base64_url = convert_file(filename, base64_data, api_key, output_format)
                
                response_obj = {
                    'success': True,
                    'base64Data': pdf_base64_url
                }
                response_bytes = json.dumps(response_obj).encode('utf-8')
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(response_bytes)))
                self.end_headers()
                self.wfile.write(response_bytes)
                
            except Exception as e:
                print(f"[Server Error] {str(e)}")
                response_obj = {
                    'success': False,
                    'error': str(e)
                }
                response_bytes = json.dumps(response_obj).encode('utf-8')
                
                self.send_response(500)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(response_bytes)))
                self.end_headers()
                self.wfile.write(response_bytes)
        else:
            self.send_response(404)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b"404 - Endpoint Not Found")

if __name__ == "__main__":
    # Ensure serving from workspace directory
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    with socketserver.TCPServer(("127.0.0.1", PORT), MyHandler) as httpd:
        print("==============================================")
        print("  DocuScribe Dev Server (Python) Running")
        print(f"  URL: http://127.0.0.1:{PORT}/")
        print("  Press Ctrl+C to stop the server")
        print("==============================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
