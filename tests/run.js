const fs = require('fs');
const child_process = require('child_process');

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
                    console.error(`test ${file} failed`);
                    process.exit(1);
                } else resolve();
            });
        });
    }

    console.log('all tests passed');
})();