export const MOTOR_IDS = [1, 2, 3, 4, 5, 6] as const;

export type MotorId = (typeof MOTOR_IDS)[number];

export type MotorSnapshot = {
  id: MotorId;
  name: string;
  position: number | null;
  voltage: number | null;
  firmwareVersion: string | null;
};

export const MOTOR_NAMES: Record<MotorId, string> = {
  1: "shoulder_pan",
  2: "shoulder_lift",
  3: "elbow_flex",
  4: "wrist_flex",
  5: "wrist_roll",
  6: "gripper",
};

export const MOTOR_LIMITS: Record<MotorId, { min: number; max: number; home: number }> = {
  1: { min: 1014, max: 3120, home: 2036 },
  2: { min: 894, max: 3179, home: 2048 },
  3: { min: 1054, max: 3079, home: 2054 },
  4: { min: 694, max: 2720, home: 2049 },
  5: { min: 966, max: 3114, home: 2048 },
  6: { min: 1913, max: 3264, home: 2048 },
};

const ADDR = {
  FIRMWARE_MAJOR: 0,
  FIRMWARE_MINOR: 1,
  TORQUE_ENABLE: 40,
  ACCELERATION: 41,
  GOAL_POSITION: 42,
  PRESENT_POSITION: 56,
  PRESENT_VOLTAGE: 62,
} as const;

const INST = {
  READ: 2,
  WRITE: 3,
  SYNC_WRITE: 131,
} as const;

type TxRxResult = {
  packet: number[];
  result: number;
  error: number;
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const loByte = (value: number) => value & 0xff;
const hiByte = (value: number) => (value >> 8) & 0xff;
const makeWord = (low: number, high: number) => low | (high << 8);

function checksum(bytes: number[]) {
  let sum = 0;
  for (let index = 2; index < bytes.length - 1; index += 1) {
    sum += bytes[index] & 0xff;
  }
  return ~sum & 0xff;
}

function packetToHex(packet: number[]) {
  return packet.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

class SerialPortHandler {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private packetStart = 0;
  private packetTimeout = 0;
  private txTimePerByte = 0;

  isOpen = false;
  isUsing = false;
  baudRate = 1_000_000;

  async requestAndOpen() {
    if (!navigator.serial) {
      throw new Error("Web Serial API is not available.");
    }
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: this.baudRate });
    if (!this.port.readable || !this.port.writable) {
      throw new Error("Selected port is not readable/writable.");
    }
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.txTimePerByte = (1000 / this.baudRate) * 10;
    this.isOpen = true;
  }

  async close() {
    this.reader?.releaseLock();
    this.reader = null;
    this.writer?.releaseLock();
    this.writer = null;
    if (this.port && this.isOpen) {
      await this.port.close();
    }
    this.port = null;
    this.isOpen = false;
  }

  async clearPort() {
    if (!this.port?.readable) return;
    this.reader?.releaseLock();
    this.reader = this.port.readable.getReader();
  }

  getPortInfo() {
    if (!this.port) return null;
    const info = this.port.getInfo();
    return {
      usbVendorId: info.usbVendorId ?? null,
      usbProductId: info.usbProductId ?? null,
      baudRate: this.baudRate,
    };
  }

  async write(bytes: number[]) {
    if (!this.isOpen || !this.writer) return 0;
    await this.writer.write(new Uint8Array(bytes));
    return bytes.length;
  }

  async read(length: number) {
    if (!this.isOpen || !this.reader) return [];
    const bytes: number[] = [];
    const started = performance.now();

    while (bytes.length < length) {
      const timeout = new Promise<{ value: Uint8Array; done: false; timeout: true }>((resolve) => {
        window.setTimeout(() => resolve({ value: new Uint8Array(), done: false, timeout: true }), 100);
      });
      const result = await Promise.race([this.reader.read(), timeout]);

      if ("timeout" in result) {
        if (performance.now() - started > 500) break;
        continue;
      }
      if (result.done) break;
      if (result.value.length === 0) {
        await sleep(10);
        if (performance.now() - started > 500) break;
        continue;
      }
      bytes.push(...Array.from(result.value));
    }

    return bytes;
  }

  setPacketTimeout(byteCount: number) {
    this.packetStart = performance.now();
    this.packetTimeout = this.txTimePerByte * byteCount + 34;
  }

  isPacketTimeout() {
    if (performance.now() - this.packetStart > this.packetTimeout) {
      this.packetTimeout = 0;
      return true;
    }
    return false;
  }
}

class PacketHandler {
  async txPacket(port: SerialPortHandler, packet: number[]) {
    if (port.isUsing) return -1;
    const packetLength = packet[3] + 4;
    if (packetLength > 250) return -4;

    port.isUsing = true;
    packet[0] = 0xff;
    packet[1] = 0xff;
    packet[packetLength - 1] = checksum(packet);
    await port.clearPort();

    const written = await port.write(packet);
    if (written !== packetLength) {
      port.isUsing = false;
      return -2;
    }
    return 0;
  }

  async rxPacket(port: SerialPortHandler) {
    let packet: number[] = [];
    let result = -3;
    let requiredLength = 6;

    while (true) {
      packet.push(...(await port.read(requiredLength - packet.length)));
      if (packet.length >= requiredLength) {
        const headerIndex = packet.findIndex((byte, index) => byte === 0xff && packet[index + 1] === 0xff);
        if (headerIndex === 0) {
          if (packet[2] > 253 || packet[3] > 250) {
            packet.shift();
            continue;
          }
          if (requiredLength !== packet[3] + 4) {
            requiredLength = packet[3] + 4;
            continue;
          }
          if (packet.length < requiredLength) {
            if (port.isPacketTimeout()) {
              result = packet.length === 0 ? -6 : -7;
              break;
            }
            continue;
          }
          result = packet[requiredLength - 1] === checksum(packet) ? 0 : -7;
          break;
        }
        if (headerIndex > 0) {
          packet = packet.slice(headerIndex);
          continue;
        }
      }
      if (port.isPacketTimeout()) {
        result = packet.length === 0 ? -6 : -7;
        break;
      }
    }

    return { packet, result };
  }

  async txRxPacket(port: SerialPortHandler, packet: number[]): Promise<TxRxResult> {
    if (port.isUsing) return { packet: [], result: -1, error: 0 };

    const txResult = await this.txPacket(port, packet);
    if (txResult !== 0) return { packet: [], result: txResult, error: 0 };
    if (packet[2] === 254) {
      port.isUsing = false;
      return { packet: [], result: 0, error: 0 };
    }

    if (packet[4] === INST.READ) {
      port.setPacketTimeout(packet[6] + 10);
    } else {
      port.setPacketTimeout(10);
    }
    await port.clearPort();

    const rx = await this.rxPacket(port);
    port.isUsing = false;
    if (rx.result !== 0) return { packet: rx.packet, result: rx.result, error: 0 };
    if (rx.packet.length < 6 || rx.packet[2] !== packet[2]) {
      return { packet: rx.packet, result: -7, error: 0 };
    }
    return { packet: rx.packet, result: 0, error: rx.packet[4] };
  }

  async read(id: number, port: SerialPortHandler, address: number, length: number) {
    const packet = [0xff, 0xff, id, 4, INST.READ, address, length, 0];
    const rx = await this.txRxPacket(port, packet);
    if (rx.result !== 0) throw new Error(`Read failed for servo ${id}: ${rx.result} (${packetToHex(rx.packet)})`);
    if (rx.packet.length < 5 + length) throw new Error(`Short response from servo ${id}`);
    return rx.packet.slice(5, 5 + length);
  }

  async read1(id: number, port: SerialPortHandler, address: number) {
    const bytes = await this.read(id, port, address, 1);
    return bytes[0] ?? 0;
  }

  async read2(id: number, port: SerialPortHandler, address: number) {
    const bytes = await this.read(id, port, address, 2);
    return makeWord(bytes[0] ?? 0, bytes[1] ?? 0);
  }

  async write(id: number, port: SerialPortHandler, address: number, bytes: number[]) {
    const packet = [0xff, 0xff, id, bytes.length + 3, INST.WRITE, address, ...bytes, 0];
    const rx = await this.txRxPacket(port, packet);
    if (rx.result !== 0) throw new Error(`Write failed for servo ${id}: ${rx.result} (${packetToHex(rx.packet)})`);
  }

  async syncWrite(port: SerialPortHandler, address: number, dataLength: number, values: Map<number, number>) {
    const params: number[] = [];
    values.forEach((value, id) => {
      params.push(id, loByte(value), hiByte(value));
    });
    const packet = [0xff, 0xff, 254, params.length + 4, INST.SYNC_WRITE, address, dataLength, ...params, 0];
    const result = await this.txPacket(port, packet);
    port.isUsing = false;
    if (result !== 0) throw new Error(`Sync write failed: ${result}`);
  }
}

export class FeetechService {
  private portHandler: SerialPortHandler | null = null;
  private packetHandler = new PacketHandler();

  get connected() {
    return Boolean(this.portHandler?.isOpen);
  }

  getConnectionInfo() {
    return this.portHandler?.getPortInfo() ?? null;
  }

  async connect() {
    const port = new SerialPortHandler();
    await port.requestAndOpen();
    this.portHandler = port;
  }

  async disconnect() {
    await this.portHandler?.close();
    this.portHandler = null;
  }

  private port() {
    if (!this.portHandler?.isOpen) throw new Error("SO101 is not connected.");
    return this.portHandler;
  }

  async readPosition(id: MotorId) {
    return this.packetHandler.read2(id, this.port(), ADDR.PRESENT_POSITION);
  }

  async writePosition(id: MotorId, position: number) {
    const value = Math.max(0, Math.min(4095, Math.round(position)));
    await this.packetHandler.write(id, this.port(), ADDR.GOAL_POSITION, [loByte(value), hiByte(value)]);
  }

  async writePositions(values: Map<MotorId, number>) {
    const sanitized = new Map<number, number>();
    values.forEach((value, id) => sanitized.set(id, Math.max(0, Math.min(4095, Math.round(value)))));
    await this.packetHandler.syncWrite(this.port(), ADDR.GOAL_POSITION, 2, sanitized);
  }

  async setTorque(id: MotorId, enabled: boolean) {
    await this.packetHandler.write(id, this.port(), ADDR.TORQUE_ENABLE, [enabled ? 1 : 0]);
  }

  async setAllTorque(ids: MotorId[], enabled: boolean) {
    for (const id of ids) {
      await this.setTorque(id, enabled);
      await sleep(20);
    }
  }

  async setAcceleration(id: MotorId, acceleration: number) {
    const value = Math.max(0, Math.min(254, Math.round(acceleration)));
    await this.packetHandler.write(id, this.port(), ADDR.ACCELERATION, [value]);
  }

  async readVoltage(id: MotorId) {
    return (await this.packetHandler.read1(id, this.port(), ADDR.PRESENT_VOLTAGE)) / 10;
  }

  async readFirmwareVersion(id: MotorId) {
    const major = await this.packetHandler.read1(id, this.port(), ADDR.FIRMWARE_MAJOR);
    const minor = await this.packetHandler.read1(id, this.port(), ADDR.FIRMWARE_MINOR);
    return `${major}.${minor}`;
  }

  async scanMotors() {
    const found: MotorId[] = [];
    for (const id of MOTOR_IDS) {
      try {
        await this.readPosition(id);
        found.push(id);
      } catch {
        // Missing servos are expected during scan.
      }
      await sleep(60);
    }
    return found;
  }

  async readSnapshot(id: MotorId): Promise<MotorSnapshot> {
    let position: number | null = null;
    let voltage: number | null = null;
    let firmwareVersion: string | null = null;

    try {
      position = await this.readPosition(id);
    } catch {
      position = null;
    }
    try {
      voltage = await this.readVoltage(id);
    } catch {
      voltage = null;
    }
    try {
      firmwareVersion = await this.readFirmwareVersion(id);
    } catch {
      firmwareVersion = null;
    }

    return {
      id,
      name: MOTOR_NAMES[id],
      position,
      voltage,
      firmwareVersion,
    };
  }
}
