import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/**', 'scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: {
      // Project rule: strict TypeScript, no escape hatches.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Architecture boundary: only the provider adapters may import vendor SDKs.
    files: ['src/**/*.ts'],
    ignores: ['src/modules/ai/providers/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'openai', message: 'Import AI vendors only inside src/modules/ai/providers. Use modelProviderService / aiRouterService.' },
            { name: '@anthropic-ai/sdk', message: 'Import AI vendors only inside src/modules/ai/providers.' },
            { name: '@google/generative-ai', message: 'Import AI vendors only inside src/modules/ai/providers.' },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'src/scripts/**/*.ts', 'src/config/env.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  }
);
