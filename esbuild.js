const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'out/extension.js',
    external: ['vscode'],
    logLevel: 'info',
    sourcemap: !production,
    minify: production,
};

async function main() {
    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('[esbuild] watching for changes...');
    } else {
        await esbuild.build(buildOptions);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
