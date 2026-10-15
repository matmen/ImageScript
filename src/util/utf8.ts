// TextEncoder and TextDecoder are web APIs, not part of the es2022 lib: declare the parts used here
declare const TextEncoder: { new(): { encode(text: string): Uint8Array } };
declare const TextDecoder: { new(): { decode(bytes: Uint8Array): string } };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(text: string): Uint8Array {
    return encoder.encode(text);
}

/**
 * Decodes UTF-8, replacing invalid sequences with U+FFFD and skipping a leading byte order mark
 */
export function decode(bytes: Uint8Array): string {
    return decoder.decode(bytes);
}
