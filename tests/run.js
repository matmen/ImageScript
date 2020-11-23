(async () => {
    for await (const {name: file} of Deno.readDir('./tests/')) {
        if (file === 'run.js' || file.slice(-3) !== '.js') continue;

        console.log(`running test ${file}`);
        const start = Date.now();
        const proc = Deno.run({
            cmd: ['deno', 'run', '--allow-read', '--allow-net', `./tests/${file}`],
            stdout: 'piped',
            stderr: 'piped'
        });

        await new Promise(resolve => {
            const timeout = setTimeout(() => {
                console.log('script timeout');
                proc.exitCode = 1;
                proc.kill(15);
            }, 5000);

            proc.status().then(async ({code}) => {
                clearTimeout(timeout);

                if (code) {
                    await Deno.stdout.write(await proc.stderrOutput());
                    console.error(`test ${file} failed in ${Date.now() - start}ms`);
                    Deno.exit(1);
                } else {
                    console.log(`test ${file} passed in ${Date.now() - start}ms`);
                    resolve();
                }
            });
        });
    }

    console.log('all tests passed');
})();