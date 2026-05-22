// Build the extension icon from `media/icon.svg` into the repo-root `icon.png`
// referenced by `package.json#icon`.
//
// Usage:
//   node scripts/build-icon.mjs           # rebuilds icon.png at 128x128
//   node scripts/build-icon.mjs --check   # exits non-zero if PNG is stale
//
// Requires an SVG→PNG rasterizer. The script tries, in order:
//   1. `sharp` (npm i -D sharp) — fastest, deterministic.
//   2. `@resvg/resvg-js`        — pure JS, no native deps beyond the prebuilt.
//   3. Inkscape CLI on PATH     — `inkscape --export-type=png ...`.
//   4. ImageMagick `magick`     — `magick -background none -resize 128x128 ...`.
//
// If none are available, the script prints clear instructions and exits 1
// without touching `icon.png`. Pick the option that fits your environment;
// none of them are committed as runtime deps.

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = path.join(repoRoot, 'media', 'icon.svg');
const pngPath = path.join(repoRoot, 'icon.png');
const SIZE = 128;

const args = new Set(process.argv.slice(2));
const checkMode = args.has('--check');

async function readSvg() {
    try {
        return await fs.readFile(svgPath);
    } catch (err) {
        console.error(`Unable to read ${svgPath}: ${err.message}`);
        process.exit(1);
    }
}

async function tryRunCli(cmd, argv) {
    return new Promise((resolve) => {
        const proc = spawn(cmd, argv, { stdio: 'inherit' });
        proc.on('error', () => resolve(false));
        proc.on('exit', (code) => resolve(code === 0));
    });
}

async function renderWithSharp(svg) {
    try {
        const sharp = (await import('sharp')).default;
        return await sharp(svg).resize(SIZE, SIZE).png().toBuffer();
    } catch {
        return undefined;
    }
}

async function renderWithResvg(svg) {
    try {
        const { Resvg } = await import('@resvg/resvg-js');
        const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: SIZE } });
        return resvg.render().asPng();
    } catch {
        return undefined;
    }
}

async function renderWithInkscape() {
    return tryRunCli('inkscape', [
        svgPath,
        `--export-filename=${pngPath}`,
        `--export-width=${SIZE}`,
        `--export-height=${SIZE}`,
    ]);
}

async function renderWithMagick() {
    return tryRunCli('magick', [
        '-background', 'none',
        '-resize', `${SIZE}x${SIZE}`,
        svgPath,
        pngPath,
    ]);
}

async function existingPng() {
    try {
        return await fs.readFile(pngPath);
    } catch {
        return undefined;
    }
}

async function main() {
    const svg = await readSvg();

    let buf = await renderWithSharp(svg);
    if (!buf) buf = await renderWithResvg(svg);

    if (!buf) {
        // Try CLI tools — these write the PNG directly, so reload after.
        if (await renderWithInkscape() || await renderWithMagick()) {
            buf = await fs.readFile(pngPath);
        }
    }

    if (!buf) {
        console.error([
            'No SVG→PNG rasterizer found. Install one of:',
            '',
            '  npm i -D sharp           # native, fastest',
            '  npm i -D @resvg/resvg-js # pure-ish JS',
            '',
            'or have `inkscape` or `magick` (ImageMagick) on PATH, then re-run',
            '`node scripts/build-icon.mjs`.',
        ].join('\n'));
        process.exit(1);
    }

    if (checkMode) {
        const current = await existingPng();
        if (!current || !current.equals(buf)) {
            console.error('icon.png is stale — run `node scripts/build-icon.mjs`.');
            process.exit(1);
        }
        console.log('icon.png is up to date.');
        return;
    }

    await fs.writeFile(pngPath, buf);
    console.log(`Wrote ${pngPath} (${buf.length} bytes, ${SIZE}x${SIZE}).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
