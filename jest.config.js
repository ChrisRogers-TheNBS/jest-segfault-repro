// jest.config.js — matches original crashing project's configuration
"use strict";

module.exports = {
  preset: "jest-preset-angular",
  setupFilesAfterEnv: ["./setup.ts"],
  transformIgnorePatterns: [],
  transform: {
    "^.+\\.(ts|js|mjs|html|svg)$": [
      "jest-preset-angular",
      {
        tsconfig: "<rootDir>/tsconfig.spec.json",
        stringifyContentPathRegex: "\\.(html|svg)$",
        isolatedModules: true,
      },
    ],
  },
  testEnvironment: "jsdom",
  moduleFileExtensions: ["ts", "js", "json", "mjs"],
  maxWorkers: 4,
  workerIdleMemoryLimit: "1.5GB",
  collectCoverage: true,
  coverageReporters: ["text-summary"],
  modulePathIgnorePatterns: [
    "<rootDir>/submodule/",
    "<rootDir>/from_private_repo/",
  ],
  testPathIgnorePatterns: [
    "<rootDir>/submodule/",
    "<rootDir>/from_private_repo/",
    "<rootDir>/node_modules/",
  ],
  watchPathIgnorePatterns: [
    "<rootDir>/submodule/",
    "<rootDir>/from_private_repo/",
  ],
  testTimeout: 30000,
  reporters: ["default", "./segfault-bail-reporter.js"],
};
