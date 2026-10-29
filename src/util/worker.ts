// the module worker threads run (see threads.ts): tasks posted to it, their results posted back
import { searchRows, filterTrials, type SearchTask, type FilterTask } from '../codecs/av1/encode.ts';

interface Port {
    post(message: unknown): void;
}

interface Globals {
    process?: { getBuiltinModule?: (id: string) => unknown };
    postMessage?: (message: unknown) => void;
    onmessage?: ((event: { data: unknown }) => void) | null;
}

const globals = globalThis as unknown as Globals;

function handle(port: Port, task: { task: string }): void {
    try {
        const message = (m: unknown): void => port.post({ message: m });
        let result: unknown;
        if (task.task === 'av1-search') result = searchRows(task as SearchTask, message);
        else if (task.task === 'av1-filter') result = filterTrials(task as FilterTask);
        else throw new Error(`unknown task ${task.task}`);
        port.post({ result });
    } catch (e) {
        port.post({ error: String((e as Error).stack ?? e) });
    }
}

if (typeof globals.postMessage === 'function' && 'onmessage' in globals) {
    const port = { post: (m: unknown) => (globals.postMessage as (m: unknown) => void)(m) };
    globals.onmessage = e => handle(port, e.data as { task: string });
} else {
    const { parentPort } = globals.process?.getBuiltinModule?.('node:worker_threads') as { parentPort: { on(e: 'message', l: (m: unknown) => void): void, postMessage(m: unknown): void } };
    const port = { post: (m: unknown) => parentPort.postMessage(m) };
    parentPort.on('message', m => handle(port, m as { task: string }));
}
