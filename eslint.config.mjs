import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      'specs/**',
      'docs/maintainer/**',
      '**/next-env.d.ts',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Money and authority rules are enforced by types and tests; these lint rules exist to
      // stop the specific shortcuts that would quietly weaken them.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Math'][property.name='round']",
          message: 'Money never rounds implicitly. Use an explicit FLOOR/CEIL/EXACT conversion.',
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message:
            'parseFloat introduces binary floating point. Use exact decimal or atom parsing.',
        },
        {
          selector: "MemberExpression[object.name='Number'][property.name='parseFloat']",
          message: 'Number.parseFloat introduces binary floating point on a money path.',
        },
      ],
    },
  },
  {
    // Test files, tooling and root config are typed by tsconfig.tools.json: they are
    // deliberately outside the build projects so they cannot reach a published dist/.
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      'tools/**/*.ts',
      'vitest.config.ts',
      'apps/*/scripts/**/*.mjs',
    ],
    languageOptions: {
      // Build scripts run in Node, so the Node globals are defined for them.
      globals: { process: 'readonly', console: 'readonly' },
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.tools.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Tests omit a variable by destructuring it away to prove it is required.
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
