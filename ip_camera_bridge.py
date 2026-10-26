#!/usr/bin/env python3
"""
ASAP Command Post — Python IP Camera Connector (Main Gate CAM 2)
Target IP Camera: http://192.168.120.220:8080/

Supports two automatic modes:
1. OpenCV (cv2.VideoCapture) + MJPEG HTTP Relay Server (http://127.0.0.1:5050/video)
2. Standard Library (urllib.request) Zero-Dependency MJPEG / Snapshot Relay & Cloud Frame Pusher

Usage:
  python3 ip_camera_bridge.py --url http://192.168.120.220:8080/ --port 5050
  python3 ip_camera_bridge.py --url http://192.168.120.220:8080/ --server https://ais-dev-kr4szag5hw4bm6myfylh6j-775876566007.asia-east1.run.app
"""

import argparse
import base64
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import cv2  # type: ignore
    HAS_OPENCV = True
except ImportError:
    HAS_OPENCV = False

DEFAULT_CAMERA_URL = "http://192.168.120.220:8080/"
LATEST_JPEG_FRAME: bytes | None = None
FRAME_LOCK = threading.Lock()


def normalize_stream_endpoints(base_url: str) -> list[str]:
    base = base_url.rstrip("/")
    return [
        f"{base}/video",
        f"{base}/shot.jpg",
        f"{base}/videofeed",
        f"{base}/",
    ]


def push_frame_to_command_post(server_url: str, jpeg_bytes: bytes, cam_url: str) -> None:
    """Optionally pushes base64 JPEG frames to the ASAP Command Post backend."""
    if not server_url:
        return
    try:
        b64_data = "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes).decode("ascii")
        payload = json.dumps({
            "zoneId": "main_gate",
            "cameraId": "cam-mg-02",
            "cameraUrl": cam_url,
            "frameBase64": b64_data,
            "timestamp": int(time.time() * 1000),
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{server_url.rstrip('/')}/api/camera/push-frame",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2.5) as _:
            pass
    except Exception:
        pass


def capture_loop_opencv(camera_url: str, server_url: str) -> bool:
    """Captures frames from http://192.168.120.220:8080/video using OpenCV (cv2.VideoCapture)."""
    global LATEST_JPEG_FRAME
    if not HAS_OPENCV:
        return False

    for endpoint in normalize_stream_endpoints(camera_url):
        print(f"[Python OpenCV] Connecting to IP Camera at {endpoint} ...")
        cap = cv2.VideoCapture(endpoint)
        if not cap.isOpened():
            continue

        print(f"[Python OpenCV] Connected to Main Gate CAM 2 ({endpoint})")
        last_push = 0.0
        while True:
            ret, frame = cap.read()
            if not ret or frame is None:
                print("[Python OpenCV] Frame read lost, reconnecting...")
                break

            ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            if ok:
                jpeg_bytes = buffer.tobytes()
                with FRAME_LOCK:
                    LATEST_JPEG_FRAME = jpeg_bytes

                now = time.time()
                if server_url and (now - last_push) >= 0.25:
                    last_push = now
                    threading.Thread(
                        target=push_frame_to_command_post,
                        args=(server_url, jpeg_bytes, camera_url),
                        daemon=True,
                    ).start()

            time.sleep(0.03)
        cap.release()
    return False


def capture_loop_urllib(camera_url: str, server_url: str) -> None:
    """Zero-dependency Python MJPEG & snapshot reader using urllib.request."""
    global LATEST_JPEG_FRAME
    base = camera_url.rstrip("/")
    video_url = f"{base}/video"
    shot_url = f"{base}/shot.jpg"

    while True:
        # 1. Try reading continuous MJPEG stream (/video or root)
        for stream_target in [video_url, f"{base}/"]:
            try:
                print(f"[Python urllib] Opening MJPEG stream {stream_target} ...")
                req = urllib.request.Request(stream_target, headers={"User-Agent": "ASAP-Python-IPCam/1.0"})
                with urllib.request.urlopen(req, timeout=4.0) as stream:
                    buffer = b""
                    last_push = 0.0
                    while True:
                        chunk = stream.read(4096)
                        if not chunk:
                            break
                        buffer += chunk
                        start = buffer.find(b"\xff\xd8")
                        end = buffer.find(b"\xff\xd9")
                        if start != -1 and end != -1 and end > start:
                            jpg = buffer[start : end + 2]
                            buffer = buffer[end + 2 :]
                            with FRAME_LOCK:
                                LATEST_JPEG_FRAME = jpg
                            now = time.time()
                            if server_url and (now - last_push) >= 0.25:
                                last_push = now
                                threading.Thread(
                                    target=push_frame_to_command_post,
                                    args=(server_url, jpg, camera_url),
                                    daemon=True,
                                ).start()
            except Exception:
                pass

        # 2. Fallback: Poll /shot.jpg snapshots
        try:
            req = urllib.request.Request(
                f"{shot_url}?t={int(time.time() * 1000)}",
                headers={"User-Agent": "ASAP-Python-IPCam/1.0"},
            )
            with urllib.request.urlopen(req, timeout=2.5) as resp:
                jpg = resp.read()
                if jpg.startswith(b"\xff\xd8"):
                    with FRAME_LOCK:
                        LATEST_JPEG_FRAME = jpg
                    if server_url:
                        push_frame_to_command_post(server_url, jpg, camera_url)
        except Exception as err:
            print(f"[Python Bridge] Waiting for IP Camera at {camera_url} ({err})...")
            time.sleep(1.5)


class MJPEGRelayHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        return

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.startswith("/status"):
            self.send_response(200)
            self.send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            with FRAME_LOCK:
                has_frame = LATEST_JPEG_FRAME is not None
            self.wfile.write(
                json.dumps({
                    "online": True,
                    "hasFrame": has_frame,
                    "opencv": HAS_OPENCV,
                    "cameraUrl": DEFAULT_CAMERA_URL,
                }).encode("utf-8")
            )
            return

        if self.path.startswith("/shot.jpg") or self.path.startswith("/snapshot"):
            with FRAME_LOCK:
                frame = LATEST_JPEG_FRAME
            if frame is None:
                self.send_response(503)
                self.send_cors_headers()
                self.end_headers()
                return
            self.send_response(200)
            self.send_cors_headers()
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(frame)))
            self.end_headers()
            self.wfile.write(frame)
            return

        # Default: /video or / serves multipart MJPEG stream
        self.send_response(200)
        self.send_cors_headers()
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()

        try:
            while True:
                with FRAME_LOCK:
                    frame = LATEST_JPEG_FRAME
                if frame:
                    self.wfile.write(b"--frame\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n")
                    self.wfile.write(f"Content-Length: {len(frame)}\r\n\r\n".encode("ascii"))
                    self.wfile.write(frame)
                    self.wfile.write(b"\r\n")
                time.sleep(0.05)
        except (BrokenPipeError, ConnectionResetError):
            pass


def fetch_single_snapshot_stdout(camera_url: str) -> int:
    """One-shot helper invoked by server.ts via child_process to grab a frame in Python."""
    for target in normalize_stream_endpoints(camera_url):
        try:
            req = urllib.request.Request(target, headers={"User-Agent": "ASAP-Python-IPCam/1.0"})
            with urllib.request.urlopen(req, timeout=2.5) as resp:
                data = resp.read(262144)
                start = data.find(b"\xff\xd8")
                end = data.find(b"\xff\xd9")
                if start != -1 and end != -1 and end > start:
                    jpg = data[start : end + 2]
                    sys.stdout.buffer.write(jpg)
                    sys.stdout.buffer.flush()
                    return 0
        except Exception:
            continue
    return 1


def main() -> None:
    parser = argparse.ArgumentParser(description="ASAP Python IP Camera Bridge for Main Gate CAM 2")
    parser.add_argument("--url", default=DEFAULT_CAMERA_URL, help="IP Camera URL (default: http://192.168.120.220:8080/)")
    parser.add_argument("--port", type=int, default=5050, help="Local relay port (default: 5050)")
    parser.add_argument("--server", default="http://localhost:3000", help="ASAP Command Post server URL to push frames to")
    parser.add_argument("--one-shot", action="store_true", help="Fetch a single JPEG frame to stdout and exit")
    args = parser.parse_args()

    if args.one_shot:
        sys.exit(fetch_single_snapshot_stdout(args.url))

    def worker():
        while True:
            if HAS_OPENCV:
                capture_loop_opencv(args.url, args.server)
            capture_loop_urllib(args.url, args.server)
            time.sleep(1.0)

    t = threading.Thread(target=worker, daemon=True)
    t.start()

    server = ThreadingHTTPServer(("0.0.0.0", args.port), MJPEGRelayHandler)
    print(f"============================================================")
    print(f" ASAP PYTHON IP CAMERA BRIDGE ACTIVE (Main Gate - CAM 2)")
    print(f" Source IP Camera : {args.url}")
    print(f" Local MJPEG Feed : http://127.0.0.1:{args.port}/video")
    print(f" Command Post Push: {args.server}/api/camera/push-frame")
    print(f"============================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
