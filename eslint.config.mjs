import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: [
            'out/**',
            'node_modules/**',
            '*.vsix',
            'esbuild.js',
            'icon.png',
            'test/mocks/**',
        ],
    },
    ...tseslint.configs.recommended,
    {
        rules: {
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'warn',
        },
    },
    {
        files: ['src/**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
        },
    },
);
