"""Plays back a recorded SO-101 motion onto the follower arm, triggered either
over BLE or over a local HTTP server.

Modes (--mode):
  ble  (default)  Advertise a BLE peripheral named "slider". Write 1 (0x01 or
                  ASCII '1') to the control characteristic to play, 0 to stop.
  http            Serve on localhost:<--http-port> (default 9090).
                  GET/POST /start -> play, /stop -> stop.

Usage:
    uv run main.py motion.json                      # BLE (default)
    uv run main.py motion.json --mode ble
    uv run main.py motion.json --mode http           # http://localhost:9090
    uv run main.py motion.json --mode http --http-port 9090
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from serial.tools import list_ports

from feetech import Feetech, find_serial_port
from playback import Motion, PlaybackController

# Custom 128-bit UUIDs for the slider control service/characteristic.
SERVICE_UUID = "6e6b3a00-9a01-4b8e-bf10-000000000001"
CONTROL_CHAR_UUID = "6e6b3a01-9a01-4b8e-bf10-000000000001"

PLAY_BYTES = {0x01, ord("1")}
STOP_BYTES = {0x00, ord("0")}

# The follower's serial path is stable on this machine, so use it by default.
DEFAULT_FOLLOWER_PORT = "/dev/cu.usbmodem5AB90670111"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SO-101 motion player (BLE or HTTP)")
    parser.add_argument(
        "motion",
        nargs="?",
        default="record.json",
        help="Path to an exported motion json file (default: record.json)",
    )
    parser.add_argument("--mode", choices=["ble", "http"], default="http", help="Trigger source (default: http)")
    parser.add_argument(
        "--port",
        default=DEFAULT_FOLLOWER_PORT,
        help=f"Serial device for the follower (default: {DEFAULT_FOLLOWER_PORT})",
    )
    parser.add_argument("--baud", type=int, help="Baud rate (overrides the value in the file)")
    parser.add_argument("--name", default="slider", help="BLE advertised device name (default: slider)")
    parser.add_argument("--http-port", type=int, default=9090, help="HTTP listen port (default: 9090)")
    return parser.parse_args()


def resolve_port(motion: Motion, override: str | None) -> str:
    if override:
        return override
    port = find_serial_port(motion.usb_vendor_id, motion.usb_product_id)
    if port:
        return port
    available = ", ".join(p.device for p in list_ports.comports()) or "(none)"
    raise SystemExit(
        "Could not auto-detect the follower serial port from the file's USB IDs.\n"
        f"Pass --port explicitly. Available ports: {available}"
    )


def build_controller(args: argparse.Namespace) -> tuple[PlaybackController, Feetech]:
    motion = Motion.load(args.motion)
    baud = args.baud or motion.baud_rate
    port = resolve_port(motion, args.port)
    print(f"[slider] motion: {len(motion.frames)} frames, {motion.duration_ms / 1000:.1f}s")
    print(f"[slider] follower port: {port} @ {baud} baud, ids {motion.playback_ids}")
    feetech = Feetech(port, baud)
    return PlaybackController(motion, feetech), feetech


# --------------------------------------------------------------------------- #
# BLE mode
# --------------------------------------------------------------------------- #
async def run_ble(args: argparse.Namespace, controller: PlaybackController, feetech: Feetech) -> None:
    from bless import (
        BlessServer,
        BlessGATTCharacteristic,
        GATTCharacteristicProperties,
        GATTAttributePermissions,
    )

    def read_request(characteristic: "BlessGATTCharacteristic", **kwargs: Any) -> bytearray:
        return characteristic.value or bytearray(b"\x00")

    def write_request(characteristic: "BlessGATTCharacteristic", value: Any, **kwargs: Any) -> None:
        data = bytes(value)
        characteristic.value = bytearray(value)
        if not data:
            return
        command = data[0]
        if command in PLAY_BYTES:
            print("[slider] command: PLAY")
            controller.start()
        elif command in STOP_BYTES:
            print("[slider] command: STOP")
            controller.stop()
        else:
            print(f"[slider] ignoring unknown command byte: {command}")

    server = BlessServer(name=args.name, loop=asyncio.get_running_loop())
    server.read_request_func = read_request
    server.write_request_func = write_request

    await server.add_new_service(SERVICE_UUID)
    char_flags = (
        GATTCharacteristicProperties.read
        | GATTCharacteristicProperties.write
        | GATTCharacteristicProperties.write_without_response
    )
    permissions = GATTAttributePermissions.readable | GATTAttributePermissions.writeable
    await server.add_new_characteristic(
        SERVICE_UUID, CONTROL_CHAR_UUID, char_flags, bytearray(b"\x00"), permissions
    )

    await server.start()
    print(f"[slider] BLE advertising as '{args.name}'. Write 1 to play, 0 to stop. Ctrl-C to quit.")

    stop = asyncio.Event()
    try:
        await stop.wait()
    finally:
        controller.shutdown()
        feetech.close()
        await server.stop()


# --------------------------------------------------------------------------- #
# HTTP mode
# --------------------------------------------------------------------------- #
def make_http_handler(controller: PlaybackController):
    class Handler(BaseHTTPRequestHandler):
        def _dispatch(self) -> None:
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            if path == "/start":
                print("[slider] command: PLAY")
                controller.start()
                self._respond(200, "started")
            elif path == "/stop":
                print("[slider] command: STOP")
                controller.stop()
                self._respond(200, "stopped")
            else:
                self._respond(404, "not found (use /start or /stop)")

        def _respond(self, code: int, message: str) -> None:
            body = (message + "\n").encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = _dispatch
        do_POST = _dispatch

        def log_message(self, *args: Any) -> None:  # quieter default logging
            return

    return Handler


def run_http(args: argparse.Namespace, controller: PlaybackController, feetech: Feetech) -> None:
    httpd = ThreadingHTTPServer(("localhost", args.http_port), make_http_handler(controller))
    print(
        f"[slider] HTTP listening on http://localhost:{args.http_port} "
        f"(GET/POST /start to play, /stop to stop). Ctrl-C to quit."
    )
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        controller.shutdown()
        feetech.close()


def main() -> None:
    args = parse_args()
    controller, feetech = build_controller(args)
    try:
        if args.mode == "http":
            run_http(args, controller, feetech)
        else:
            asyncio.run(run_ble(args, controller, feetech))
    except KeyboardInterrupt:
        print("\n[slider] shutting down")
        controller.shutdown()
        feetech.close()
        sys.exit(0)


if __name__ == "__main__":
    main()
