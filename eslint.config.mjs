// Lint rules for the app, tests and scripts (core ESLint only - no plugins to install).
const browser = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', localStorage: 'readonly', location: 'readonly', history: 'readonly',
  performance: 'readonly', requestAnimationFrame: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', ResizeObserver: 'readonly',
  HTMLInputElement: 'readonly', HTMLSelectElement: 'readonly', HTMLTextAreaElement: 'readonly', URLSearchParams: 'readonly', Option: 'readonly',
  ImageData: 'readonly', URL: 'readonly', Blob: 'readonly', Event: 'readonly', console: 'readonly', devicePixelRatio: 'readonly',
};
const node = { process: 'readonly', console: 'readonly', URL: 'readonly' };

export default [
  { ignores: ['_site/**', 'node_modules/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...browser, ...node } },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }],
      'no-dupe-keys': 'error',
      'no-dupe-class-members': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-redeclare': 'error',
      'no-self-assign': 'error',
      'no-unsafe-finally': 'error',
      'no-use-before-define': ['error', { functions: false, classes: true, variables: false }],
      'no-shadow-restricted-names': 'error',
      'no-cond-assign': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-loss-of-precision': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
];
