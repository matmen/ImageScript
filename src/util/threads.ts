// worker threads: Web Workers (Deno, Bun, browsers) or node:worker_threads (Node), sharing memory through
// SharedArrayBuffers. Accessed through feature detection with minimal local types, like node:zlib (see zlib.ts)

// (URL and import.meta.url aren't in the es2022 lib)
declare const URL: new (url: string, base: string) => URL;
interface URL {
    readonly href: string;
}
declare global {
    interface ImportMeta {
        readonly url: string;
    }
}

interface NodeWorker {
    on(event: 'message' | 'error', listener: (value: unknown) => void): void;
    postMessage(message: unknown): void;
    terminate(): Promise<number>;
    unref(): void;
}

interface WebWorker {
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: { message?: string, preventDefault?(): void }) => void) | null;
    postMessage(message: unknown): void;
    terminate(): void;
}

declare const Worker: new (url: URL, options: { type: 'module' }) => WebWorker;

interface Globals {
    process?: { getBuiltinModule?: (id: string) => unknown };
    Worker?: unknown;
    navigator?: { hardwareConcurrency?: number };
    crossOriginIsolated?: boolean;
}

const globals = globalThis as unknown as Globals;

function builtin<T>(id: string): T | null {
    try {
        return (globals.process?.getBuiltinModule?.(id) as T | undefined) ?? null;
    } catch {
        return null;
    }
}

/** A worker running src/util/worker.ts */
export interface Thread {
    /** Runs a task (one at a time), passing the messages it posts on the way to onMessage: its result */
    run(task: unknown, onMessage?: (message: unknown) => void): Promise<unknown>;
    terminate(): void;
}

// what a worker posts: a message on the way, its task's result or the error it failed with
interface Reply {
    message?: unknown;
    result?: unknown;
    error?: string;
}

// a thread of a worker posting messages and errors to listeners set once
function thread(post: (m: unknown) => void, listen: (message: (m: Reply) => void, error: (e: Error) => void) => void, terminate: () => void): Thread {
    let current: { resolve(v: unknown): void, reject(e: Error): void, onMessage?: (m: unknown) => void } | null = null;
    listen(m => {
        if (!current) return;
        if ('message' in m) current.onMessage?.(m.message);
        else {
            const c = current;
            current = null;
            if (m.error !== undefined) c.reject(new Error(m.error));
            else c.resolve(m.result);
        }
    }, e => {
        const c = current;
        current = null;
        c?.reject(e);
    });
    return {
        run: (task, onMessage) => new Promise((resolve, reject) => {
            current = { resolve, reject, onMessage };
            post(task);
        }),
        terminate,
    };
}

/** The number of threads the runtime can run in parallel (0 if it can't start workers sharing memory) */
export function availableThreads(): number {
    if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined' || globals.crossOriginIsolated === false) return 0;
    if (!globals.Worker && !builtin('node:worker_threads')) return 0;
    const os = builtin<{ availableParallelism?(): number, cpus(): unknown[] }>('node:os');
    const n = os ? os.availableParallelism ? os.availableParallelism() : os.cpus().length : globals.navigator?.hardwareConcurrency ?? 1;
    return Math.max(1, n | 0);
}


/** Starts n workers, null if the runtime can't */
export function startThreads(n: number): Thread[] | null {
    if (n < 1 || !availableThreads()) return null;
    const threads: Thread[] = [];
    try {
        for (let i = 0; i < n; i++) {
            if (globals.Worker) {
                // (written like this, bundlers find the worker's module and bundle it too; the build points it at
                // worker.js)
                const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
                threads.push(thread(m => w.postMessage(m), (message, error) => {
                    w.onmessage = e => message(e.data as Reply);
                    w.onerror = e => {
                        e.preventDefault?.();
                        error(new Error(e.message ?? 'worker failed'));
                    };
                }, () => w.terminate()));
            } else {
                const { Worker } = builtin('node:worker_threads') as { Worker: new (url: URL) => NodeWorker };
                const w = new Worker(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url));
                // (an idle worker doesn't keep the process alive)
                w.unref();
                threads.push(thread(m => w.postMessage(m), (message, error) => {
                    w.on('message', m => message(m as Reply));
                    w.on('error', e => error(e as Error));
                }, () => void w.terminate()));
            }
        }
        return threads;
    } catch {
        for (const t of threads) t.terminate();
        return null;
    }
}

/** A task split into chunks, for runChunks: the worker task's name and its data (typed arrays in shared memory) */
export interface ChunkTask {
    task: string;
    /** the next chunk to take (an Int32Array of 1 in shared memory, set by runChunks) */
    counter?: Int32Array;
    chunks?: number;
}

/**
 * Runs chunks 0 to count - 1 of a task, each threads' next one (worker.ts runs a chunk task's chunks with the same
 * function as local, see chunkTasks there), or all of them here without threads: their results
 */
export async function runChunks<R>(threads: Thread[] | null, task: ChunkTask, count: number, local: (chunk: number) => R): Promise<R[]> {
    const results = new Array<R>(count);
    if (!threads || count < 2) {
        for (let i = 0; i < count; i++) results[i] = local(i);
        return results;
    }
    const counter = new Int32Array(new SharedArrayBuffer(4));
    await Promise.all(threads.slice(0, count).map(t => t.run({ ...task, counter, chunks: count }, m => {
        const { chunk, result } = m as { chunk: number, result: R };
        results[chunk] = result;
    })));
    return results;
}

/** A typed array in shared memory: itself if it is */
export const sharedOf = <T extends Float32Array | Int32Array | Int8Array | Uint8Array | Uint16Array>(array: T): T => array.buffer instanceof SharedArrayBuffer ? array : shared(array);

/** A copy of a typed array in shared memory (for threads) */
export function shared<T extends Float32Array | Int32Array | Int8Array | Uint8Array | Uint16Array>(array: T): T {
    const Type = array.constructor as new (buffer: SharedArrayBuffer) => T;
    const copy = new Type(new SharedArrayBuffer(array.byteLength));
    copy.set(array);
    return copy;
}
