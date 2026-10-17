const fs = require('fs');
const child_process = require('child_process');

// runs every test with the runtime running this script: node, deno or bun
const runtime = `"${process.execPath}"`;
const command = typeof Deno !== 'undefined' ? `${runtime} run -A` : typeof Bun !== 'undefined' ? runtime : `${runtime} --unhandled-rejections=strict`;

(async () => {
    for (const file of fs.readdirSync('./tests/')) {
        if (file === 'run.js' || file.slice(-3) !== '.js') continue;

        console.log(`running test ${file}`);
        const start = Date.now();
        const proc = child_process.exec(`${command} ./tests/${file}`);
        proc.stderr.pipe(process.stderr);
        proc.stdout.pipe(process.stdout);
        await new Promise(resolve => {
            let timedOut = false;
            const timeout = setTimeout(() => {
                console.log('script timeout');
                timedOut = true;
                proc.kill('SIGTERM');
            }, 30000);

            proc.on('exit', code => {
                clearTimeout(timeout);

                if (code !== 0 || timedOut) {
                    console.error(`test ${file} failed in ${Date.now() - start}ms`);
                    process.exit(1);
                } else {
                    console.log(`test ${file} passed in ${Date.now() - start}ms`);
                    resolve();
                }
            });
        });
    }

    console.log('all tests passed');
})();