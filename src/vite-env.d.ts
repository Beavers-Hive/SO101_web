/// <reference types="vite/client" />

interface Navigator {
  serial?: {
    requestPort: () => Promise<SerialPort>;
  };
}

interface SerialPort {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  readable?: ReadableStream<Uint8Array> | null;
  writable?: WritableStream<Uint8Array> | null;
}
