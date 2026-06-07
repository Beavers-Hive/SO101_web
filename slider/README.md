# slider — motion player for SO-101

Replays a motion recorded in the web console onto the **follower** arm. The
playback trigger comes from one of two sources, selected with `--mode`:

- **`ble`** (default): advertises a BLE peripheral named **`slider`**.
  - Write **`1`** (byte `0x01` or ASCII `'1'`) to the control characteristic → **play**
  - Write **`0`** (byte `0x00` or ASCII `'0'`) → **stop**
- **`http`**: serves on `localhost:<--http-port>` (default `9090`).
  - `GET`/`POST` **`/start`** → **play**
  - `GET`/`POST` **`/stop`** → **stop**

Playback drives the follower over the Feetech serial protocol using the
connection info embedded in the exported file.

## 1. Export a motion from the web console

In the teleop screen's **モーション録画** panel, record a motion and press
**書き出し**. This downloads `so101-motion-*.json`, which contains the recorded
frames plus the leader/follower connection info (USB VID/PID, baud rate, motor
IDs).

## 2. Install

```bash
cd slider
uv sync
```

## 3. Run

BLE mode (default):

```bash
uv run main.py path/to/so101-motion-2026-06-07T00-00-00.json
# same as: --mode ble
```

HTTP mode:

```bash
uv run main.py motion.json --mode http              # http://localhost:9090
uv run main.py motion.json --mode http --http-port 9090
```

The follower serial port is auto-detected from the USB VID/PID stored in the
file. If detection is ambiguous (e.g. leader and follower use identical USB
adapters) pass it explicitly:

```bash
uv run main.py motion.json --port /dev/tty.usbmodemXXXX --baud 1000000
```

Options:

| flag | meaning |
|------|---------|
| `--mode` | `ble` (default) or `http` |
| `--port` | serial device for the follower (overrides auto-detect) |
| `--baud` | baud rate (overrides the value in the file) |
| `--name` | BLE advertised device name (default: `slider`) |
| `--http-port` | HTTP listen port (default: `9090`) |

## 4. Control

### BLE mode

Connect with any BLE central (e.g. **nRF Connect**, **LightBlue**), find the
`slider` device, and write to the control characteristic:

- Service UUID: `6e6b3a00-9a01-4b8e-bf10-000000000001`
- Control characteristic UUID: `6e6b3a01-9a01-4b8e-bf10-000000000001`

Write `01` to start playback, `00` to stop. Reading the characteristic returns
the last command byte.

### HTTP mode

```bash
curl http://localhost:9090/start   # play
curl http://localhost:9090/stop    # stop
```

(`/start` and `/stop` accept both GET and POST, so you can also just open the
URLs in a browser.)

## Notes & permissions

- **macOS**: the first run prompts for Bluetooth permission. If advertising
  fails, grant Bluetooth access to your terminal in System Settings → Privacy
  & Security → Bluetooth.
- **Linux**: `bless` uses BlueZ; you may need to run with privileges to
  advertise (`sudo` or the right `CAP_NET_*` capabilities).
- Playback enables follower torque for the motors in the recording, replays the
  frames on an absolute wall-clock timeline (so timing matches the recording),
  and disables torque again when it finishes or is stopped.

## Files

- `main.py` — BLE server + command handling
- `playback.py` — motion file parsing and the playback thread
- `feetech.py` — minimal Feetech/STS serial driver (mirrors the web app)
