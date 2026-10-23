// ESLint for the bugs a type checker misses, not for style: the recommended JavaScript and type-checked TypeScript
// rules, and SonarJS's bug detection. npm run lint
import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'docs/', 'bench/', 'coverage/', 'node_modules/'] },
    {
        files: ['src/**/*.ts'],
        extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
        plugins: { sonarjs },
        languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
        rules: {
            // every encoder and renderer returns a Promise (as since 1.x), also the ones that work synchronously
            // (JPEG, WebP, TGA, GIF, SVG): async turns their errors into rejections like the others'
            '@typescript-eslint/require-await': 'off',
            // const enums are compared with the numbers of the tables they were made from (the HarfBuzz port)
            '@typescript-eslint/no-unsafe-enum-comparison': 'off',
            // categories with two names (HarfBuzz's)
            '@typescript-eslint/no-duplicate-enum-values': 'off',
            // ({ removed: _, ...rest }) leaves out a property
            '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],

            // SonarJS: code that does nothing or something else than it reads like
            'sonarjs/array-callback-without-return': 'error',
            'sonarjs/no-all-duplicated-branches': 'error',
            'sonarjs/no-collection-size-mischeck': 'error',
            'sonarjs/no-dead-store': 'error',
            'sonarjs/no-element-overwrite': 'error',
            'sonarjs/no-empty-collection': 'error',
            'sonarjs/no-gratuitous-expressions': 'error',
            'sonarjs/no-identical-conditions': 'error',
            'sonarjs/no-identical-expressions': 'error',
            'sonarjs/no-identical-functions': 'error',
            'sonarjs/no-ignored-return': 'error',
            'sonarjs/no-misleading-array-reverse': 'error',
            'sonarjs/no-unenclosed-multiline-block': 'error',
            'sonarjs/no-unused-collection': 'error',
            'sonarjs/no-use-of-empty-return-value': 'error',
            // regular expressions that backtrack superlinearly (ReDoS)
            'sonarjs/slow-regex': 'error'
        }
    }
);
