// @ts-check

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import nPlugin from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';

/**
 * ESLint 9 flat config.
 *
 * - `typescript-eslint` on `strictTypeChecked` + `stylisticTypeChecked` so type-aware
 *   rules (`no-floating-promises`, `no-misused-promises`, `no-unnecessary-condition`, ...)
 *   are active across the async fetch/cache/parsing layer.
 * - `eslint-plugin-n` for Node-specific correctness.
 * - `eslint-config-prettier` is applied LAST so its "turn off stylistic rules" config
 *   always wins over anything before it, keeping ESLint and Prettier from fighting.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'test/fixtures/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  nPlugin.configs['flat/recommended'],

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      n: {
        // `n` resolves imports against Node's own module resolution, which doesn't know
        // about TypeScript's NodeNext convention of importing a sibling `./foo.ts` via a
        // `./foo.js` specifier. Without this it would flag every same-project import.
        tryExtensions: ['.js', '.ts'],
      },
    },
    rules: {
      // TypeScript (via `tsc --noEmit`, run separately as `npm run typecheck`) is the
      // source of truth for whether an import resolves; `n`'s own resolver isn't aware
      // of NodeNext's ".js"-specifier-for-a-".ts"-file convention and would false-positive
      // on every relative import in this codebase.
      'n/no-missing-import': 'off',
      // Azure Functions v4 + `@modelcontextprotocol/sdk` deep import paths (e.g.
      // `@modelcontextprotocol/sdk/server/mcp.js`) are not always resolvable through the
      // `n` plugin's package.json `exports` parsing; `tsc` already validates these.
      'n/no-unpublished-import': 'off',
      'n/no-extraneous-import': 'off',
      // The codebase's own convention (cheerio's `.each`/`.map` callbacks always receive
      // an index as the first argument, which is frequently unused) is to name a
      // deliberately-unused parameter with a leading underscore, e.g. `(_i, el) => ...`.
      // `tsc`'s `noUnusedParameters` already exempts this pattern; mirror it here so
      // ESLint agrees with the compiler instead of flagging every one of those callbacks.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The MCP SDK types `structuredContent` as `{ [x: string]: unknown }`. TypeScript
      // gives object *type aliases* an implicit index signature but deliberately does not
      // give one to `interface`, so every tool's output type MUST be a type alias or it
      // fails to typecheck against `registerTool`. This rule would demand the opposite.
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },

  // The project's own dependency graph is entirely NodeNext ESM targeting Node 22 -- no
  // need for `n` to warn about syntax support in older runtimes.
  {
    rules: {
      'n/no-unsupported-features/es-syntax': 'off',
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },

  // Config files at the repo root aren't part of `tsconfig.json`'s `include`, so
  // type-aware linting has no project to check them against. Disable the typed rule sets
  // for them specifically rather than pulling them into the main TS project (which would
  // otherwise cause `tsc -p tsconfig.json` to try to emit them into `dist/`).
  {
    files: ['eslint.config.js', 'vitest.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Test files: relax a handful of rules that fight with common, legitimate Vitest
  // patterns (stubbing `fetch`, asserting on mock call args, spying on modules) without
  // giving up type-aware linting on the tests altogether.
  {
    files: ['test/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // `FetchFn` returns a Promise, so stub implementations are declared `async` to match
      // the signature even when the body has nothing to await. That is the correct shape,
      // not an oversight.
      '@typescript-eslint/require-await': 'off',
      // Fixture lookup maps are keyed by category slug; indexing them with the slug
      // variable reads better than forcing dot access on the literal cases.
      '@typescript-eslint/dot-notation': 'off',
    },
  },

  eslintConfigPrettier,
);
