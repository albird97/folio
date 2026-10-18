import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'target/**',
      'apps/desktop/src-tauri/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // Logging must never include document content; route diagnostics through explicit code.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zod',
              message:
                "Import z from '@folio/document-model/zod' (or the extension's shared/zod): it turns off Zod's eval probe, which strict CSPs report as a violation.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/document-model/src/zod.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Playwright and axe cover autofocus on the password field deliberately.
      'jsx-a11y/no-autofocus': 'off',
    },
  },
  {
    files: ['apps/chrome-extension/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly' },
    },
  },
  {
    files: [
      'scripts/**',
      'tests/**',
      '**/*.config.ts',
      '**/vite/**',
      'apps/chrome-extension/scripts/**',
      '**/*.test.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
  {
    // Playwright fixtures use an empty destructuring pattern by convention.
    files: ['tests/e2e/**'],
    rules: { 'no-empty-pattern': 'off' },
  },
);
