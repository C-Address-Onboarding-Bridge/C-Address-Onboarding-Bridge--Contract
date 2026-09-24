module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.[jt]s$': 'ts-jest',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(uint8array-extras|@exodus|@noble|@stellar)/)',
  ],
};
