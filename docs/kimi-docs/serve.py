#!/usr/bin/env python3
"""
Simple local server for browsing Kimi Code documentation offline.
Mounts /code/docs/ to the current directory so absolute paths in HTML work.

Usage:
    python serve.py
    # Then open http://localhost:8080/code/docs/ in your browser
"""
import http.server
import socketserver
import os
from pathlib import Path

PORT = 8888

class DocsHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Strip /code/docs/ prefix from requests
        if path.startswith('/code/docs/'):
            path = path[len('/code/docs/'):]
            # If empty, serve index.html (our custom index)
            if not path or path == '/':
                path = 'index.html'
            else:
                # HTML pages are stored under html/ subdirectory
                path = 'html/' + path
        return super().translate_path(path)

    def log_message(self, format, *args):
        # Quieter logging
        pass

def main():
    os.chdir(Path(__file__).parent)
    with socketserver.TCPServer(("", PORT), DocsHandler) as httpd:
        print(f"=" * 50)
        print(f"Kimi Code 文档本地服务器已启动")
        print(f"=" * 50)
        print(f"请在浏览器中打开以下地址：")
        print(f"  http://localhost:{PORT}/code/docs/")
        print(f"")
        print(f"按 Ctrl+C 停止服务器")
        print(f"=" * 50)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务器已停止")

if __name__ == "__main__":
    main()
