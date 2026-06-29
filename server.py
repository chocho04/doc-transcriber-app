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
        
        if path == '/api/upload-file':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                filename = data.get('filename')
                base64_data = data.get('base64Data')
                
                # Split at ";base64," to get the actual base64 string
                if ';base64,' in base64_data:
                    base64_content = base64_data.split(';base64,')[1]
                else:
                    base64_content = base64_data
                
                file_bytes = base64.b64decode(base64_content)
                
                if not os.path.exists('uploads'):
                    os.makedirs('uploads')
                
                ext = os.path.splitext(filename)[1].lower()
                safe_name = "".join([c for c in os.path.splitext(filename)[0] if c.isalnum() or c in ('_', '-')])
                if not safe_name:
                    safe_name = "file"
                unique_filename = f"{safe_name}_{int(time.time())}_{os.urandom(4).hex()}{ext}"
                target_path = os.path.join('uploads', unique_filename)
                
                with open(target_path, 'wb') as f:
                    f.write(file_bytes)
                
                # Use forward slashes for relative URL path
                url_path = f"uploads/{unique_filename}"
                
                response_obj = {
                    'success': True,
                    'url': url_path
                }
                response_bytes = json.dumps(response_obj).encode('utf-8')
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(response_bytes)))
                self.end_headers()
                self.wfile.write(response_bytes)
                print(f"[Upload] File uploaded successfully: {url_path}")
            except Exception as e:
                print(f"[Server Error] Upload failed: {str(e)}")
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
            return

        # Accept all typical routes for compatibility
        valid_routes = ['/api/convert-doc', '/api/convert-rtf', '/api/convert-xls', '/api/convert-to-pdf']
        
        if path in valid_routes:
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            
            try:
                data = json.loads(post_data.decode('utf-8'))
                filename = data.get('filename')
                target_format = data.get('targetFormat', 'pdf').lower()
                
                if target_format == 'png':
                    # Dummy 1x1 PNG base64
                    dummy_data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
                else:
                    # Dummy converted PDF base64
                    dummy_data = "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iagogIDw8IC9UeXBlIC9DYXRhbG9nCiAgICAgL1BhZ2VzIDIgMCBSCiAgPj4KZW5kb2JqCjIgMCBvYmoKICA8PCAvVHlwZSAvUGFnZXMKICAgICAvS2lkcyBbIDMgMCBSIF0KICAgICAvQ291bnQgMQogID4+CmVuZG9iagozIDAgb2JqCiAgPDwgL1R5cGUgL1BhZ2UKICAgICAvUGFyZW50IDIgMCBSCiAgICAgL1Jlc291cmNlcyA8PAogICAgICAgL0ZvbnQgPDwKICAgICAgICAgL0YxIDQgMCBSCiAgICAgICA+PgogICAgID4+CiAgICAgL01lZGlhQm94IFsgMCAwIDU5NSA4NDIgXQogICAgIC9Db250ZW50cyA1IDAgUgogID4+CmVuZG9iago0IDAgb2JqCiAgPDwgL1R5cGUgL0ZvbnQKICAgICAvU3VidHlwZSAvVHlwZTEKICAgICAvQmFzZUZvbnQgL0hlbHZldGljYQogID4+CmVuZG9iago1IDAgb2JqCiAgPDwgL0xlbmd0aCA0NCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcwIDcwMCBUZCAoRG9jdW1lbnQgQ29udmVydGVkKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNyAwMDAwMCBuIAowMDAwMDAwMDgwIDAwMDAwIG4gCjAwMDAwMDAxNDkgMDAwMDAgbiAKMDAwMDAwMDI5NiAwMDAwMCBuIAowMDAwMDAwMzc5IDAwMDAwIG4gCnRyYWlsZXIKICA8PCAvU2l6ZSA2CiAgICAgL1Jvb3QgMSAwIFIKICA+PgpzdGFydHhyZWYKNDc0CiUlRU9GCg=="
                
                response_obj = {
                    'success': True,
                    'base64Data': dummy_data
                }
                response_bytes = json.dumps(response_obj).encode('utf-8')
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(response_bytes)))
                self.end_headers()
                self.wfile.write(response_bytes)
                print(f"[Convert] Mock conversion to {target_format} for: {filename}")
                
            except Exception as e:
                print(f"[Server Error] Mock conversion failed: {str(e)}")
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
