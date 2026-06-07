"""Minimal Feetech / STS serial driver.

This mirrors the packet format used by the web console (src/feetech.ts):
checksum = ~sum(bytes[2:-1]) & 0xff, WRITE = 3, SYNC_WRITE = 131,
TORQUE_ENABLE @ 40, GOAL_POSITION @ 42 (2 bytes, little-endian).

Only the write side is implemented because playback never needs to read.
"""

from __future__ import annotations

import time
from typing import Iterable, Mapping, Optional

import serial
from serial.tools import list_ports

INST_WRITE = 3
INST_SYNC_WRITE = 131

ADDR_TORQUE_ENABLE = 40
ADDR_GOAL_POSITION = 42

POSITION_MIN = 0
POSITION_MAX = 4095


def _checksum(packet: list[int]) -> int:
    return (~sum(packet[2:-1])) & 0xFF


def _clamp_position(value: float) -> int:
    return max(POSITION_MIN, min(POSITION_MAX, int(round(value))))


def find_serial_port(usb_vendor_id: Optional[int], usb_product_id: Optional[int]) -> Optional[str]:
    """Return a serial device path matching the given USB VID/PID, if unique."""
    candidates = []
    for port in list_ports.comports():
        if usb_vendor_id is not None and port.vid != usb_vendor_id:
            continue
        if usb_product_id is not None and port.pid != usb_product_id:
            continue
        candidates.append(port.device)
    if len(candidates) == 1:
        return candidates[0]
    # Ambiguous (or none): caller must decide / pass --port explicitly.
    return None


class Feetech:
    def __init__(self, port: str, baudrate: int = 1_000_000):
        self.ser = serial.Serial(port, baudrate, timeout=0.05, write_timeout=0.5)

    def close(self) -> None:
        try:
            self.ser.close()
        except Exception:
            pass

    def _send(self, packet: list[int]) -> None:
        packet[0] = 0xFF
        packet[1] = 0xFF
        packet[-1] = _checksum(packet)
        self.ser.write(bytes(packet))

    def write_register(self, servo_id: int, address: int, data: list[int]) -> None:
        length = len(data) + 3
        packet = [0xFF, 0xFF, servo_id, length, INST_WRITE, address, *data, 0]
        self._send(packet)

    def set_torque(self, servo_id: int, enabled: bool) -> None:
        self.write_register(servo_id, ADDR_TORQUE_ENABLE, [1 if enabled else 0])

    def set_all_torque(self, servo_ids: Iterable[int], enabled: bool) -> None:
        for servo_id in servo_ids:
            self.set_torque(servo_id, enabled)
            time.sleep(0.02)

    def sync_write_positions(self, positions: Mapping[int, float]) -> None:
        """Sync-write GOAL_POSITION (2 bytes each) for several servos at once."""
        params: list[int] = []
        for servo_id, value in positions.items():
            clamped = _clamp_position(value)
            params += [servo_id, clamped & 0xFF, (clamped >> 8) & 0xFF]
        if not params:
            return
        length = len(params) + 4
        packet = [0xFF, 0xFF, 254, length, INST_SYNC_WRITE, ADDR_GOAL_POSITION, 2, *params, 0]
        self._send(packet)
