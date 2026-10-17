/** Whether an argument is an options object rather than a positional value */
export function isOptions<T>(value: T): value is Extract<T, object> {
    return typeof value === 'object' && value !== null && !ArrayBuffer.isView(value);
}

/**
 * A number argument, converted like arithmetic does (numeric strings keep working); NaN and the infinities throw
 * a RangeError naming the argument
 */
export function finite(value: number, name: string): number {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new RangeError(`Invalid ${name}: ${value}`);
    return number;
}

/** A color argument: a finite number (as RGBA, 0xrrggbbaa) */
export const color = (value: number, name = 'color'): number => finite(value, name);
