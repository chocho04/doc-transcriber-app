import http.server
import socketserver
import os
import json
import urllib.request
import urllib.parse
import urllib.error
import base64
import time

PORT = 8080

def convert_to_pdf(filename, base64_data, api_key):
    print(f"[CloudConvert] Starting conversion job for: {filename}")
    
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
                "output_format": "pdf"
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
        
    # 5. Download the converted PDF and return it as base64
    print("[CloudConvert] Downloading converted PDF...")
    pdf_req = urllib.request.Request(pdf_url, method='GET')
    try:
        with urllib.request.urlopen(pdf_req) as resp:
            pdf_bytes = resp.read()
    except urllib.error.HTTPError as e:
        err_info = e.read().decode('utf-8')
        print(f"[CloudConvert Error] Downloading PDF failed: {err_info}")
        raise Exception(f"Failed to download PDF from CloudConvert: {err_info}")
        
    pdf_base64 = base64.b64encode(pdf_bytes).decode('utf-8')
    print("[CloudConvert] Conversion finished successfully.")
    return f"data:application/pdf;base64,{pdf_base64}"


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
                '.svg': 'image/svg+xml',
                '.ico': 'image/x-icon',
                '.json': 'application/json; charset=utf-8'
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
                
                pdf_base64_url = convert_to_pdf(filename, base64_data, api_key)
                
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
