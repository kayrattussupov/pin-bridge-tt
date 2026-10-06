import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'src/generated/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // Standalone examples for agencies, run directly with Node.js.
    files: ['docs/examples/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', fetch: 'readonly', console: 'readonly', Buffer: 'readonly' },
    },
  },
);
