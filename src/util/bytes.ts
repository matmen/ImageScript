// base64 is decoded natively: Uint8Array.fromBase64 where available, atob everywhere else (browsers, Node, Deno, Bun)
declare const atob: (data: string) => string;
const fromBase64 = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }).fromBase64;

/** Decodes base64 (of embedded data tables) */
export function base64(text: string): Uint8Array {
    if (fromBase64) return fromBase64(text);
    const binary = atob(text), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** A byte buffer that grows as it is written (doubling its capacity) */
export class ByteWriter {
    buffer: Uint8Array;
    length = 0;

    constructor(capacity = 1024) {
        this.buffer = new Uint8Array(Math.max(16, capacity));
    }

    /** makes room for size more bytes */
    reserve(size: number): void {
        if (this.length + size <= this.buffer.length) return;
        const buffer = new Uint8Array(Math.max(this.buffer.length * 2, this.length + size));
        buffer.set(this.buffer.subarray(0, this.length));
        this.buffer = buffer;
    }

    byte(value: number): void {
        this.reserve(1);
        this.buffer[this.length++] = value;
    }

    bytes(...values: number[]): void {
        this.reserve(values.length);
        for (const value of values) this.buffer[this.length++] = value;
    }

    array(values: ArrayLike<number>): void {
        this.reserve(values.length);
        this.buffer.set(values, this.length);
        this.length += values.length;
    }

    /** the written bytes */
    finish(): Uint8Array {
        return this.buffer.slice(0, this.length);
    }
}
