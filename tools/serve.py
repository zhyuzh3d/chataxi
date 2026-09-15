#!/usr/bin/env python3
"""Serve chataxi source and release artifacts on a trusted LAN."""

from __future__ import annotations

import argparse
import http.server
import pathlib
import socket
import sys
import urllib.parse


ROOT = pathlib.Path(__file__).resolve().parents[1]


class chataxiHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".webmanifest": "application/manifest+json; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        request_path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        parts = tuple(part for part in pathlib.PurePosixPath(request_path).parts if part != "/")
        allowed_file = request_path in {"/", "/index.html", "/hermit.json", "/hermit-install.json"}
        allowed_tree = bool(parts) and parts[0] in {"app", "styles", "release"}
        hidden_or_parent = any(part.startswith(".") or part == ".." for part in parts)
        if hidden_or_parent or not (allowed_file or allowed_tree):
            self.send_error(404, "Not found")
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def log_message(self, format_string, *args):
        sys.stdout.write("%s - %s\n" % (self.log_date_time_string(), format_string % args))
        sys.stdout.flush()


def lan_addresses() -> list[str]:
    addresses: set[str] = set()
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = item[4][0]
            if not address.startswith("127."):
                addresses.add(address)
    except OSError:
        pass
    return sorted(addresses)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0", help="listen address; default: 0.0.0.0")
    parser.add_argument("--port", type=int, default=4180, help="listen port; default: 4180")
    args = parser.parse_args()
    server = http.server.ThreadingHTTPServer((args.host, args.port), chataxiHandler)
    print(f"chataxi root: {ROOT}")
    print(f"Local: http://127.0.0.1:{args.port}/")
    for address in lan_addresses():
        print(f"LAN:   http://{address}:{args.port}/")
    print("Only expose this HTTP service on a trusted local network.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
