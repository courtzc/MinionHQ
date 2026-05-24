// Binary frame layout for PTY data transport (avoids base64-in-JSON overhead).
//
//   byte 0    : type tag
//   bytes 1-16: session UUID as raw 16 bytes
//   bytes 17+ : payload
//
// JSON envelopes remain for control messages (session.list, status, exit, ...).

export const BIN_PTY_DATA  = 0x01; // server → client : terminal output
export const BIN_PTY_INPUT = 0x02; // client → server : keystrokes

export const BIN_HEADER_SIZE = 17;

/** Parse a "550e8400-e29b-41d4-a716-446655440000" UUID into 16 raw bytes. */
export function uuidToBytes(uuid: string, out: Uint8Array, offset: number): void {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`invalid uuid: ${uuid}`);
  for (let i = 0; i < 16; i++) {
    out[offset + i] = parseInt(hex.substr(i * 2, 2), 16);
  }
}

/** Encode 16 raw bytes back into "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx". */
export function bytesToUuid(bytes: Uint8Array, offset: number): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    hex.push(bytes[offset + i].toString(16).padStart(2, '0'));
  }
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}
