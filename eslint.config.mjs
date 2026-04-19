import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // CLI entrypoint + one-shot scripts: console output is the UI, not a smell.
    files: ['**/cli.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
)
