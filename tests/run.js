const fs = require('fs');
const child_process = require('child_process');

let failed = false;
(async () => {
    for (const file of fs.readdirSync('./tests/')) {
        if (file === 'run.js' || file.slice(-3) !== '.js') continue;

        console.log(`running test ${file}`);
        const proc = child_process.exec(`node --unhandled-rejections=strict ./tests/${file}`);
        proc.stderr.pipe(process.stderr);
        proc.stdout.pipe(process.stdout);
        await new Promise(resolve => {
            proc.on('exit', code => {
                if (code) {
                    failed = true;
                    console.error(`test ${file} failed`);
                }
                resolve();
            });
        });
    }

    if (failed) process.exit(1);
    else console.log('all tests passed');
})();