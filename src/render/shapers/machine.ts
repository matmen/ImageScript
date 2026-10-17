// Syllable scanners: regular expressions over shaping categories, matched like Ragel scanners (the longest match at
// each position, the first pattern on ties). HarfBuzz' syllable grammars (*.rl) are written with these combinators

export type Expression =
    | { kind: 'set', categories: Set<number> | null, negated: boolean }
    | { kind: 'seq', items: Expression[] }
    | { kind: 'alt', items: Expression[] }
    | { kind: 'repeat', item: Expression, min: 0 | 1, max: 1 | number };

/** one of the categories */
export const cat = (...categories: number[]): Expression => ({ kind: 'set', categories: new Set(categories), negated: false });
/** any category but these */
export const not = (...categories: number[]): Expression => ({ kind: 'set', categories: new Set(categories), negated: true });
export const any: Expression = { kind: 'set', categories: null, negated: false };
export const seq = (...items: Expression[]): Expression => ({ kind: 'seq', items });
export const alt = (...items: Expression[]): Expression => ({ kind: 'alt', items });
export const opt = (...items: Expression[]): Expression => ({ kind: 'repeat', item: seq(...items), min: 0, max: 1 });
export const star = (...items: Expression[]): Expression => ({ kind: 'repeat', item: seq(...items), min: 0, max: Infinity });
export const plus = (...items: Expression[]): Expression => ({ kind: 'repeat', item: seq(...items), min: 1, max: Infinity });

// a Thompson NFA: per state, its symbol test (null for epsilon) and next states
interface State {
    test: ((category: number) => boolean) | null;
    next: number[];
    accept: number;
}

/**
 * A scanner for patterns (with their result types): the syllables of a category sequence as [start, end, type]
 */
export function scanner(patterns: Array<[Expression, number]>): (categories: ArrayLike<number>) => Array<[number, number, number]> {
    const states: State[] = [];
    const add = (): number => states.push({ test: null, next: [], accept: -1 }) - 1;

    // builds the expression from state start, returns its end state
    const build = (e: Expression, start: number): number => {
        switch (e.kind) {
            case 'set': {
                const end = add(), { categories, negated } = e;
                const s = add();
                states[start].next.push(s);
                states[s].test = categories === null ? () => true : negated ? c => !categories.has(c) : c => categories.has(c);
                states[s].next.push(end);
                return end;
            }
            case 'seq': {
                let s = start;
                for (const item of e.items) s = build(item, s);
                return s;
            }
            case 'alt': {
                const end = add();
                for (const item of e.items) {
                    const s = add();
                    states[start].next.push(s);
                    states[build(item, s)].next.push(end);
                }
                return end;
            }
            case 'repeat': {
                // one, then the rest optionally
                if (e.min === 1) return build({ ...e, min: 0 }, build(e.item, start));
                const end = add();
                if (e.max === 1) {
                    states[start].next.push(end);
                    states[build(e.item, start)].next.push(end);
                    return end;
                }
                const loop = add();
                states[start].next.push(loop);
                states[loop].next.push(end);
                states[build(e.item, loop)].next.push(loop);
                return end;
            }
        }
    };

    const root = add();
    for (const [i, [pattern]] of patterns.entries()) {
        const s = add();
        states[root].next.push(s);
        states[build(pattern, s)].accept = i;
    }

    // the epsilon closure of a set of states
    const closure = (set: number[]): number[] => {
        const seen = new Uint8Array(states.length), out: number[] = [];
        const stack = set.slice();
        while (stack.length) {
            const s = stack.pop() as number;
            if (seen[s]) continue;
            seen[s] = 1;
            out.push(s);
            if (states[s].test === null) for (const n of states[s].next) stack.push(n);
        }
        return out;
    };
    // a DFA built as it is used: a state per set of NFA states, its transitions by category
    interface DFAState {
        next: Map<number, DFAState | null>;
        /** the pattern it accepts (the first one), -1 if none */
        accept: number;
        states: number[];
    }
    const dfaStates = new Map<string, DFAState>();
    const dfa = (set: number[]): DFAState => {
        set.sort((a, b) => a - b);
        const key = set.join(',');
        let state = dfaStates.get(key);
        if (!state) {
            let accept = -1;
            for (const s of set) if (states[s].accept >= 0 && (accept < 0 || states[s].accept < accept)) accept = states[s].accept;
            dfaStates.set(key, state = { next: new Map(), accept, states: set });
        }
        return state;
    };
    const step = (state: DFAState, category: number): DFAState | null => {
        let next = state.next.get(category);
        if (next === undefined) {
            const targets: number[] = [];
            for (const s of state.states) {
                const test = states[s].test;
                if (test && test(category)) targets.push(...states[s].next);
            }
            next = targets.length ? dfa(closure(targets)) : null;
            if (next && !next.states.length) next = null;
            state.next.set(category, next);
        }
        return next;
    };
    const start = dfa(closure([root]));

    return categories => {
        const syllables: Array<[number, number, number]> = [];
        for (let p = 0; p < categories.length;) {
            let state: DFAState | null = start, bestLength = 0, bestPattern = -1;
            for (let q = p; q < categories.length && state; q++) {
                state = step(state, categories[q]);
                if (state && state.accept >= 0) {
                    bestLength = q - p + 1;
                    bestPattern = state.accept;
                }
            }
            // (patterns end with one that matches anything)
            if (bestLength === 0) {
                bestLength = 1;
                bestPattern = patterns.length - 1;
            }
            syllables.push([p, p + bestLength, patterns[bestPattern][1]]);
            p += bestLength;
        }
        return syllables;
    };
}

/** a scanner built when first used */
export function lazyScanner(patterns: () => Array<[Expression, number]>): (categories: ArrayLike<number>) => Array<[number, number, number]> {
    let scan: ((categories: ArrayLike<number>) => Array<[number, number, number]>) | null = null;
    return categories => (scan ??= scanner(patterns()))(categories);
}
