// Fixed-capacity byte ring buffer. Used as a session replay buffer so we
// can hand the last N KB of PTY output to clients that attach (or re-attach
// after reconnect) without doing O(n²) Buffer.concat on every chunk.

export class RingBuffer {
  private buf: Buffer;
  private head = 0;          // next write index
  private size = 0;          // number of valid bytes

  constructor(public readonly capacity: number) {
    if (capacity <= 0) throw new Error('capacity must be > 0');
    this.buf = Buffer.allocUnsafe(capacity);
  }

  get length(): number { return this.size; }

  /** Append bytes; oldest content is overwritten when capacity is exceeded. */
  append(chunk: Buffer): void {
    if (chunk.length === 0) return;

    // If chunk is larger than capacity, only the tail survives.
    if (chunk.length >= this.capacity) {
      chunk.copy(this.buf, 0, chunk.length - this.capacity);
      this.head = 0;
      this.size = this.capacity;
      return;
    }

    // Write first slice up to end of underlying buffer
    const space = this.capacity - this.head;
    const first = Math.min(space, chunk.length);
    chunk.copy(this.buf, this.head, 0, first);
    const remaining = chunk.length - first;
    if (remaining > 0) chunk.copy(this.buf, 0, first, first + remaining);
    this.head = (this.head + chunk.length) % this.capacity;
    this.size = Math.min(this.capacity, this.size + chunk.length);
  }

  /** Snapshot the current contents (oldest → newest) as a single Buffer. */
  snapshot(): Buffer {
    if (this.size === 0) return Buffer.alloc(0);
    if (this.size < this.capacity) {
      // contiguous from 0..size
      return Buffer.from(this.buf.subarray(0, this.size));
    }
    // Wrapped: head is the start of the oldest byte
    const out = Buffer.allocUnsafe(this.size);
    const tail = this.capacity - this.head;
    this.buf.copy(out, 0, this.head, this.capacity);
    this.buf.copy(out, tail, 0, this.head);
    return out;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }
}
