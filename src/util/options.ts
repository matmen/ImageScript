/** Whether an argument is an options object rather than a positional value */
export function isOptions<T>(value: T): value is Extract<T, object> {
    return typeof value === 'object' && value !== null && !ArrayBuffer.isView(value);
}
