const fs = require('fs');
const child_process = require('child_process');

(async () => {
    for (const file of fs.readdirSync('./tests/')) {
        if (file === 'run.js' || file.slice(-3) !== '.js') continue;

        console.log(`running test ${file}`);
        const start = Date.now();
        const proc = child_process.exec(`node --unhandled-rejections=strict ./tests/${file}`);
        proc.stderr.pipe(process.stderr);
        proc.stdout.pipe(process.stdout);
        await new Promise(resolve => {
            const timeout = setTimeout(() => {
                if (proc.connected) {
                    console.log('script timeout');
                    proc.exitCode = 1;
                    proc.kill('SIGTERM');
                }
            }, 1000);

            proc.on('exit', code => {
                clearTimeout(timeout);

                if (code) {
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