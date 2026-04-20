#!/usr/bin/env node
// warm-cache.js — primes the ts-jest transform cache after a fresh install.
//
// After `npm install`, the ts-jest transform cache is empty. The first Jest run
// has to compile every file from scratch, which is CPU-bound and slow — resolver
// calls are spread out over time. With cached transforms, tests run fast and
// NAPI churn is concentrated, triggering the V8 Sparkplug crash immediately.
//
// This script runs a single test file to build the cache, then subsequent
// `npm run test:crash` invocations crash on the first few tests.
"use strict";
const { execSync } = require("child_process");

console.log("[warm-cache] Priming ts-jest transform cache (one-time)...");
try {
  // Run a single test to cache all the heavy transforms:
  // - @angular/core, @angular/compiler, @angular/platform-browser
  // - rxjs, rxjs/operators, zone.js
  // - 60 source modules referenced by test1
  // Use --no-sparkplug to prevent crashing during warmup.
  // Use --maxWorkers=1 to keep it fast and deterministic.
  execSync(
    "node --no-sparkplug ./node_modules/.bin/jest --testPathPatterns='test1\\.spec' --maxWorkers=1 --silent 2>&1",
    {
      cwd: __dirname,
      stdio: "pipe",
      timeout: 120_000,
    },
  );
  console.log("[warm-cache] Transform cache built successfully.");
} catch (e) {
  // It's OK if this fails — the cache will be partially built at least
  console.log("[warm-cache] Warmup completed (partial cache is fine).");
}
