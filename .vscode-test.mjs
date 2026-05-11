import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'out/test/test/integration/suite/**/*.test.js',
    version: 'stable',
    mocha: {
        ui: 'tdd',
        timeout: 30000,
        color: true,
    },
});
