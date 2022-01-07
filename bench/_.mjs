// https://gist.github.com/evanwashere/7ee592870e46f80405b9776dcd56e1e8#file-bench-js

const now = performance.now.bind(performance);

function sort(a, b) {
  if (a > b) return 1;
  if (a < b) return -1;

  return 0;
};

function stats(n, avg, min, max, jit, all) {
  return {
    min: Math.ceil(min * 1e6),
    max: Math.ceil(max * 1e6),
    avg: Math.ceil(avg / n * 1e6),
    jit: jit.map(x => Math.ceil(x * 1e6)),
    '50th': Math.ceil(1e6 * all[Math.ceil(n * (50 / 100)) - 1]),
    '75th': Math.ceil(1e6 * all[Math.ceil(n * (75 / 100)) - 1]),
    '99th': Math.ceil(1e6 * all[Math.ceil(n * (99 / 100)) - 1]),
    '99.5th': Math.ceil(1e6 * all[Math.ceil(n * (99.5 / 100)) - 1]),
    '99.9th': Math.ceil(1e6 * all[Math.ceil(n * (99.9 / 100)) - 1]),
  };
}

export function sync(n, fn) {
  let avg = 0;
  let min = Infinity;
  let max = -Infinity;
  const all = new Array(n);
  const jit = new Array(10);

  warmup: {
    let offset = 0;
    let iterations = 10;
    while (iterations--) {
      const t1 = now();

      fn();
      jit[offset++] = now() - t1;
    }

    iterations = 1e3 - 10;
    while (iterations--) fn();
  }

  measure: {
    let offset = 0;
    let iterations = n;
    while (iterations--) {
      const t1 = now();

      fn();
      const t2 = now() - t1;
      if (t2 < min) min = t2;
      if (t2 > max) max = t2;
      avg += (all[offset++] = t2);
    }
  }

  all.sort(sort);
  return stats(n, avg, min, max, jit, all);
}

export async function async(n, fn) {
  let avg = 0;
  let min = Infinity;
  let max = -Infinity;
  const all = new Array(n);
  const jit = new Array(10);

  warmup: {
    let offset = 0;
    let iterations = 10;
    while (iterations--) {
      const t1 = now();

      await fn();
      jit[offset++] = now() - t1;
    }

    iterations = 1e3 - 10;
    while (iterations--) await fn();
  }

  measure: {
    let offset = 0;
    let iterations = n;
    while (iterations--) {
      const t1 = now();

      await fn();
      const t2 = now() - t1;
      if (t2 < min) min = t2;
      if (t2 > max) max = t2;
      avg += (all[offset++] = t2);
    }
  }

  all.sort(sort);
  return stats(n, avg, min, max, jit, all);
}

export function format({ results, title = '', unit = 'ns', percentiles = true }) {
  const h = '─';
  const v = '│';

  let s = '';
  unit = `${unit}/iter`;
  const rk = Object.keys(results);
  const rv = Object.values(results);
  const ra = rv.map(x => x.avg.toLocaleString('en-us'));
  const r50 = rv.map(x => x['50th'].toLocaleString('en-us'));
  const r75 = rv.map(x => x['75th'].toLocaleString('en-us'));
  const r99 = rv.map(x => x['99th'].toLocaleString('en-us'));
  const r995 = rv.map(x => x['99.5th'].toLocaleString('en-us'));
  const r999 = rv.map(x => x['99.9th'].toLocaleString('en-us'));
  const rmm = rv.map(x => [x.min.toLocaleString('en-us'), x.max.toLocaleString('en-us')]);

  const us = unit.length;
  const rks = Math.max(...rk.map(x => x.length));
  const ras = Math.max(...ra.map(x => x.length));
  const r50s = Math.max(...r50.map(x => x.length));
  const r75s = Math.max(...r75.map(x => x.length));
  const r99s = Math.max(...r99.map(x => x.length));
  const r995s = Math.max(...r995.map(x => x.length));
  const r999s = Math.max(...r999.map(x => x.length));
  const rmns = Math.max(...rmm.map(x => x[0].length));
  const rmxs = Math.max(...rmm.map(x => x[1].length));

  const bks = 1 + rks + 1;
  const b50s = 1 + r50s + 1 + us + 1;
  const b75s = 1 + r75s + 1 + us + 1;
  const b99s = 1 + r99s + 1 + us + 1;
  const b995s = 1 + r995s + 1 + us + 1;
  const b999s = 1 + r999s + 1 + us + 1;
  const bimms = 1 + rmns + 2 + rmxs + 1 + us + 1;
  const bas = 1 + (ras + 1 + us) + 1 + bimms + 1;
  const ls = 1 + bks + 1 + bas + 1 + b50s + 1 + b75s + 1 + b99s + 1 + b995s + 1 + b999s + 1;

  if (!percentiles) s += title ? ` ${title}` : '';

  else {
    s += ' '.repeat(3 + bks + bas);
    s += '┌' + h.repeat(ls - 4 - bks - bas) + '┐';
    s += '\n' + ` ${title.padEnd(2 + bks + bas, ' ')}`;
  }

  if (percentiles) s += v
    + '50th'.padEnd((b50s + 4) / 2, ' ').padStart(b50s, ' ') + v
    + '75th'.padEnd((b75s + 4) / 2, ' ').padStart(b75s, ' ') + v
    + '99th'.padEnd((b99s + 4) / 2, ' ').padStart(b99s, ' ') + v
    + '99.5th'.padEnd((b995s + 6) / 2, ' ').padStart(b995s, ' ') + v
    + '99.9th'.padEnd((b999s + 6) / 2, ' ').padStart(b999s, ' ') + v;

  s += (title || percentiles ? '\n' : '') + '┌' + h.repeat(1 + bks + bas) + '┐' + (percentiles ? '├' + h.repeat(ls - 4 - bks - bas) + '┤' : '');

  for (let i = 0; i < rk.length; i++) {
    s += '\n' + v + ` ${rk[i].padEnd(rks, ' ')} ` + v + ` ${ra[i].padStart(ras, ' ')} ${unit} ${`(${rmm[i][0]}..${rmm[i][1]} ${unit})`.padStart(bimms, ' ')} ` + v
    if (percentiles) s += v + ` ${r50[i].padStart(r50s, ' ')} ${unit} ` + v + ` ${r75[i].padStart(r75s, ' ')} ${unit} ` + v + ` ${r99[i].padStart(r99s, ' ')} ${unit} ` + v + ` ${r995[i].padStart(r995s, ' ')} ${unit} ` + v + ` ${r999[i].padStart(r999s, ' ')} ${unit} ` + v;
  }

  s += '\n' + '└' + h.repeat(1 + bks + bas) + '┘' + (percentiles ? '└' + h.repeat(ls - 4 - bks - bas) + '┘' : '');

  return s;
}