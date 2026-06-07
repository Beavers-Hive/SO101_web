/// <reference types="vite/client" />

interface Navigator {
  serial?: {
    requestPort: () => Promise<SerialPort>;
  };
}

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialPort {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  getInfo: () => SerialPortInfo;
  readable?: ReadableStream<Uint8Array> | null;
  writable?: WritableStream<Uint8Array> | null;
}
