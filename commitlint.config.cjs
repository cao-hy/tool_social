/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'shared',
        'config',
        'security',
        'db',
        'adapters',
        'api',
        'worker',
        'web',
        'docker',
        'ci',
        'docs',
        'deps',
        'repo',
      ],
    ],
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
  },
};
