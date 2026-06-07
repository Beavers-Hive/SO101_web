"""Load an exported motion file and replay it on the follower arm."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Optional

from feetech import Feetech


class Motion:
    """Parsed representation of a so101-motion-*.json export."""

    def __init__(self, data: dict):
        self.raw = data
        self.frames = data.get("frames", [])
        follower = data.get("follower", {}) or {}
        connection = follower.get("connection") or {}
        self.follower_motor_ids = [int(i) for i in follower.get("motorIds", [])]
        self.usb_vendor_id = connection.get("usbVendorId")
        self.usb_product_id = connection.get("usbProductId")
        self.baud_rate = int(connection.get("baudRate") or data.get("baudRate") or 1_000_000)

        # Motor ids that are both controllable on the follower and present in
        # the recording. Frame position keys are strings (JSON object keys).
        present: set[int] = set()
        for frame in self.frames:
            for key in frame.get("positions", {}):
                present.add(int(key))
        if self.follower_motor_ids:
            self.playback_ids = [i for i in self.follower_motor_ids if i in present]
        else:
            self.playback_ids = sorted(present)

    @classmethod
    def load(cls, path: str | Path) -> "Motion":
        with open(path, "r", encoding="utf-8") as handle:
            return cls(json.load(handle))

    @property
    def duration_ms(self) -> int:
        return self.frames[-1]["time"] if self.frames else 0


class PlaybackController:
    """Plays a Motion on a Feetech bus in a background thread.

    `start()` / `stop()` are safe to call from a BLE callback; playback runs on
    its own thread and an Event makes the inter-frame waits interruptible.
    """

    def __init__(self, motion: Motion, feetech: Feetech):
        self.motion = motion
        self.feetech = feetech
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()

    @property
    def is_playing(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        with self._lock:
            if self.is_playing:
                # Restart from the beginning.
                self._stop_event.set()
                self._thread.join()
            if not self.motion.frames:
                print("[playback] nothing to play: motion has no frames")
                return
            self._stop_event = threading.Event()
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()
            print(f"[playback] started: {len(self.motion.frames)} frames, ids {self.motion.playback_ids}")

    def stop(self) -> None:
        with self._lock:
            thread = self._thread
            if thread is None or not thread.is_alive():
                return
            self._stop_event.set()
        thread.join()
        print("[playback] stopped")

    def shutdown(self) -> None:
        self.stop()
        try:
            self.feetech.set_all_torque(self.motion.playback_ids, False)
        except Exception:
            pass

    def _run(self) -> None:
        ids = self.motion.playback_ids
        frames = self.motion.frames
        try:
            self.feetech.set_all_torque(ids, True)
            # Absolute wall-clock schedule anchored at the first frame so a slow
            # write never accumulates drift (matches the web playback).
            start = time.perf_counter()
            first_offset = frames[0]["time"]
            for frame in frames:
                if self._stop_event.is_set():
                    break
                target = start + (frame["time"] - first_offset) / 1000.0
                wait = target - time.perf_counter()
                if wait > 0 and self._stop_event.wait(wait):
                    break  # stop requested during the wait
                positions = {}
                for key, value in frame.get("positions", {}).items():
                    motor_id = int(key)
                    if motor_id in ids and value is not None:
                        positions[motor_id] = value
                if positions:
                    self.feetech.sync_write_positions(positions)
        except Exception as error:  # noqa: BLE001
            print(f"[playback] error: {error}")
        finally:
            cancelled = self._stop_event.is_set()
            try:
                self.feetech.set_all_torque(ids, False)
            except Exception:
                pass
            print("[playback] cancelled" if cancelled else "[playback] finished")
