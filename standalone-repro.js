#!/usr/bin/env node
// standalone-repro.js — attempts to reproduce the V8 Sparkplug SIGSEGV
// without Jest, using direct ResolverFactory NAPI churn + Array.map + GC pressure.
//
// Run with:
//   node --no-maglev --max-old-space-size=128 standalone-repro.js
//
// Or in a loop:
//   for i in $(seq 1 50); do echo "=== $i ==="; node --no-maglev --max-old-space-size=128 standalone-repro.js || break; done
"use strict";

const { ResolverFactory } = require("unrs-resolver");
const path = require("path");
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");

const ROOT = __dirname;
const WORKERS = 6;
const ITERATIONS = 5000;

if (isMainThread) {
  console.log(`Starting ${WORKERS} workers, ${ITERATIONS} iterations each...`);
  const workers = [];
  let crashed = false;

  for (let w = 0; w < WORKERS; w++) {
    const worker = new Worker(__filename, { workerData: { id: w } });
    worker.on("exit", (code) => {
      if (code !== 0 && !crashed) {
        crashed = true;
        console.error(`Worker ${w} exited with code ${code} — possible crash!`);
        process.exit(1);
      }
    });
    worker.on("error", (err) => {
      console.error(`Worker ${w} error:`, err);
    });
    worker.on("message", (msg) => {
      if (msg.done)
        console.log(`Worker ${w} done (${msg.iterations} iterations)`);
    });
    workers.push(worker);
  }

  Promise.all(workers.map((w) => new Promise((r) => w.on("exit", r)))).then(
    () => {
      if (!crashed) console.log("All workers completed without crash.");
    },
  );
} else {
  // Worker thread — this is where the crash should happen
  const wid = workerData.id;

  // Build a large array of functions to keep Array.map Sparkplug-hot
  function doMapWork(arr) {
    return arr.map((x) => x * 2 + 1);
  }
  function doFilterShift(arr) {
    const work = arr.slice();
    while (work.length > 16) work.shift();
    return work;
  }

  for (let i = 0; i < ITERATIONS; i++) {
    // Create ResolverFactory NAPI instances — the main heap churn trigger
    for (let r = 0; r < 20; r++) {
      const factory = new ResolverFactory({
        conditionNames: ["require", "node", "default"],
        roots: [ROOT],
      });
      try {
        factory.sync(ROOT, `./src/mod${((i * 7 + r) % 200) + 1}`);
      } catch (_) {}
      const clone = factory.cloneWithOptions({
        conditionNames: ["import", "node", "default"],
      });
      try {
        clone.sync(ROOT, `./src/mod${((i * 3 + r + wid) % 200) + 1}`);
      } catch (_) {}
    }

    // Array.map calls — the crash trace shows Builtins_ArrayMap as the
    // Sparkplug frame holding the stale pointer
    const nums = new Array(256).fill(0).map((_, j) => j + i);
    const result1 = doMapWork(nums);
    const result2 = doMapWork(result1);
    doFilterShift(result2);

    // More diverse map calls to create different FeedbackVector entries
    const objs = nums.map((n) => ({ v: n, tags: ["a", "b"] }));
    objs.map((o) => o.v * 2);
    objs.map((o) => o.tags.join("-"));

    // Closure churn — creates many short-lived function objects
    const fns = [];
    for (let f = 0; f < 50; f++) {
      const val = f + i;
      fns.push((v) => v + val);
    }
    fns.reduce((acc, fn) => fn(acc), 0);

    // Array.shift() left-trim trigger
    const big = new Array(512).fill(i);
    for (let s = 0; s < 128; s++) big.shift();

    // Buffer allocation — heap pressure
    const bufs = [];
    for (let b = 0; b < 50; b++) {
      bufs.push(Buffer.alloc(4096, (i + b) & 0xff));
    }

    if (i % 500 === 0) {
      process.stdout.write(`W${wid}:${i} `);
    }
  }

  parentPort.postMessage({ done: true, iterations: ITERATIONS });
}
