#!/usr/bin/env node
// standalone-repro2.js — more aggressive approach: forces GC while
// Array.map (Sparkplug-compiled) is on the call stack, interleaved
// with NAPI ResolverFactory churn.
//
// The crash requires GC to fire during StackGuard::HandleInterrupts
// while BaselineOutOfLinePrologue (Sparkplug) is on the stack.
// Calling gc() inside a .map() callback creates exactly that condition.
//
// Run:
//   node --no-maglev --expose-gc --max-old-space-size=128 standalone-repro2.js
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
const WORKERS = 8;
const ITERATIONS = 3000;

if (isMainThread) {
  console.log(`Starting ${WORKERS} workers, ${ITERATIONS} iterations each...`);
  console.log(
    `Heap limit: ${process.env.NODE_OPTIONS || "--max-old-space-size=128"}`,
  );
  const workers = [];
  let crashed = false;

  for (let w = 0; w < WORKERS; w++) {
    const worker = new Worker(__filename, {
      workerData: { id: w },
      // Each worker gets its own tight heap to trigger frequent GC
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    worker.on("exit", (code) => {
      if (code !== 0 && !crashed) {
        crashed = true;
        console.error(
          `\n*** Worker ${w} exited with code ${code} — possible SIGSEGV! ***`,
        );
        process.exit(1);
      }
    });
    worker.on("error", (err) => {
      if (!crashed) console.error(`Worker ${w} error:`, err.message);
    });
    worker.on("message", (msg) => {
      if (msg.done)
        console.log(`\nWorker ${w} done (${msg.iterations} iterations)`);
    });
    workers.push(worker);
  }

  Promise.all(workers.map((w) => new Promise((r) => w.on("exit", r)))).then(
    () => {
      if (!crashed) console.log("\nAll workers completed without crash.");
    },
  );
} else {
  (async () => {
    const wid = workerData.id;
    const doGc = typeof gc === "function" ? gc : () => {};

    // Pre-warm Array.prototype.map to Sparkplug tier
    for (let warm = 0; warm < 1000; warm++) {
      [1, 2, 3, 4, 5].map((x) => x * 2);
    }

    for (let i = 0; i < ITERATIONS; i++) {
      // Phase 1: Create many ResolverFactory NAPI handles
      const factories = [];
      for (let r = 0; r < 30; r++) {
        const f = new ResolverFactory({
          conditionNames: ["require", "node", "default"],
          roots: [ROOT],
        });
        factories.push(f);
        try {
          f.sync(ROOT, `./src/mod${((i * 7 + r) % 200) + 1}`);
        } catch (_) {}
      }

      // Phase 2: Discard references → all 30 factories become GC-eligible
      factories.length = 0;

      // Phase 3: Array.map with GC inside the callback
      // This is the critical moment: Array.map (Sparkplug-compiled) is on the
      // call stack, and GC fires. If a ResolverFactory destructor runs during
      // this GC cycle, the stale pointer condition may occur.
      const arr = new Array(200).fill(0).map((_, j) => j + i);
      const result = arr.map((x, idx) => {
        // Force GC periodically while we're inside Array.map's Sparkplug frame
        if (idx % 50 === 0) doGc();
        return x * 2 + wid;
      });

      // Phase 4: More NAPI churn + Array.map interleaving
      for (let r = 0; r < 10; r++) {
        const f = new ResolverFactory({ roots: [ROOT] });
        const clone = f.cloneWithOptions({
          conditionNames: ["import", "default"],
        });
        // map() while NAPI handles are fresh
        result.map((x) => x + r);
        try {
          clone.sync(ROOT, `./src/mod${((i + r * 13 + wid) % 200) + 1}`);
        } catch (_) {}
      }

      // Phase 5: Left-trim trigger
      const big = new Array(1024).fill(i);
      for (let s = 0; s < 500; s++) big.shift();

      // Phase 6: Async microtask processing (mirrors crash trace pattern)
      if (i % 10 === 0) {
        await new Promise((resolve) => {
          let pending = 20;
          for (let j = 0; j < 20; j++) {
            Promise.resolve(j).then((v) => {
              const f = new ResolverFactory({ roots: [ROOT] });
              try {
                f.sync(ROOT, `./src/mod${((v + i) % 200) + 1}`);
              } catch (_) {}
              if (--pending === 0) resolve();
            });
          }
        });
      }

      // Phase 7: Force GC again after all the NAPI handles from this iteration
      doGc();

      if (i % 500 === 0) process.stdout.write(`W${wid}:${i} `);
    }

    parentPort.postMessage({ done: true, iterations: ITERATIONS });
  })();
}
