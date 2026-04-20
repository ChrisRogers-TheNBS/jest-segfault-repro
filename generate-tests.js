#!/usr/bin/env node
// generate-tests.js — creates a realistic module graph and many test files.
//
// Strategy: Instead of 4 long-running stress tests, create MANY short test files
// that each import a different subset of cross-dependent modules. Each worker
// processes test files sequentially, and between files the module cache is rebuilt.
// This creates the natural build-up/teardown cycle seen in the original crash
// environment (Angular project with hundreds of test files).
//
// Key differences from previous approach:
// - 100 test files instead of 4 (many module load/unload cycles per worker)
// - 500 modules with cross-dependencies (cascading resolver calls)
// - No explicit gc() — let GC fire naturally during StackGuard interrupts
// - Diverse code patterns (async, promises, closures, classes, Array.map/shift)
// - RxJS-style observable patterns with subscribe/unsubscribe churn
"use strict";
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "src");
const TEST_DIR = path.join(__dirname, "__tests__");

// Tuning parameters
const MODULE_COUNT = 500; // Total source modules
const TEST_COUNT = 200; // Total test files (original has ~1000, we use 200)
const MODS_PER_TEST = 60; // How many modules each test file imports
const DEPS_PER_MOD = 6; // Cross-dependencies per module
const ROUNDS_PER_TEST = 15; // resetModules() + re-require cycles per test

// --- Clean directories ---
function cleanDir(dir, pattern) {
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((f) => f.match(pattern))) {
      fs.unlinkSync(path.join(dir, f));
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
}
cleanDir(SRC_DIR, /^mod\d+\.(js|ts)$/);
cleanDir(TEST_DIR, /\.(test|spec)\.(js|ts)$/);

// --- Generate source modules with cross-dependencies ---
// Each module imports DEPS_PER_MOD other modules, creating deep require chains.
// Every require() goes through jest-resolve → unrs-resolver NAPI binding.
// With the resolver cache patch, each resolve creates a NEW ResolverFactory.
// Diverse code patterns ensure many different FeedbackVectors for Sparkplug.

const codePatterns = [
  // Pattern 0: Class with array manipulation (shift/splice → left-trim trigger)
  (i, deps) => `'use strict';
${deps.map((d) => `const Dep${d} = require('./mod${d}');`).join("\n")}

class ArrayService${i} {
  constructor() {
    this.id = ${i};
    this.items = new Array(64).fill(null).map((_, j) => ({ k: j, v: j * ${i} }));
    this.observers = [];
  }
  subscribe(fn) {
    this.observers.push(fn);
    return () => {
      const idx = this.observers.indexOf(fn);
      if (idx >= 0) this.observers.splice(idx, 1);
    };
  }
  emit(v) { this.observers.forEach(fn => fn(v)); }
  process() {
    // Array.shift() triggers V8 left-trimming on the backing FixedArray
    const work = this.items.slice();
    while (work.length > 16) work.shift();
    return work.map(x => x.v * 2);
  }
  transform(arr) {
    return arr.map(x => x + this.id).filter(x => x % 2 === 0);
  }
  getDeps() { return [${deps.map((d) => `Dep${d}`).join(", ")}]; }
}
module.exports = ArrayService${i};`,

  // Pattern 1: Promise/async patterns (drives microtask processing → RunMicrotasks path)
  (i, deps) => `'use strict';
${deps.map((d) => `const Dep${d} = require('./mod${d}');`).join("\n")}

class AsyncService${i} {
  constructor() {
    this.id = ${i};
    this.cache = new Map();
  }
  async compute(n) {
    const results = [];
    for (let j = 0; j < n; j++) {
      results.push(await Promise.resolve(j * this.id));
    }
    return results;
  }
  async processAll(items) {
    return Promise.all(items.map(item => 
      Promise.resolve().then(() => item * this.id + ${i})
    ));
  }
  mapValues(arr) {
    return arr.map(v => {
      this.cache.set(v, v * this.id);
      return this.cache.get(v);
    });
  }
  getDeps() { return [${deps.map((d) => `Dep${d}`).join(", ")}]; }
}
module.exports = AsyncService${i};`,

  // Pattern 2: Higher-order functions and closures (diverse IC entries)
  (i, deps) => `'use strict';
${deps.map((d) => `const Dep${d} = require('./mod${d}');`).join("\n")}

class FnService${i} {
  constructor() {
    this.id = ${i};
    this.fns = [];
  }
  register(fn) { this.fns.push(fn); }
  runAll(input) {
    return this.fns.reduce((acc, fn) => fn(acc), input);
  }
  createPipeline() {
    const id = this.id;
    return [
      x => x + id,
      x => x * 2,
      x => Array.isArray(x) ? x.map(v => v + id) : [x],
      arr => arr.filter(v => v > id),
      arr => { const a = arr.slice(); while(a.length > 4) a.shift(); return a; },
    ];
  }
  execute(data) {
    const pipeline = this.createPipeline();
    let result = data;
    for (const step of pipeline) result = step(result);
    return result;
  }
  getDeps() { return [${deps.map((d) => `Dep${d}`).join(", ")}]; }
}
module.exports = FnService${i};`,

  // Pattern 3: Property access patterns (getter/setter ICs)
  (i, deps) => `'use strict';
${deps.map((d) => `const Dep${d} = require('./mod${d}');`).join("\n")}

class PropService${i} {
  constructor() {
    this._id = ${i};
    this._data = {};
    this._tags = ['a', 'b', 'c-${i}'];
    this._subscribers = new Map();
  }
  get id() { return this._id; }
  get tags() { return this._tags.slice(); }
  set tags(v) { this._tags = v; }
  on(event, fn) {
    if (!this._subscribers.has(event)) this._subscribers.set(event, []);
    this._subscribers.get(event).push(fn);
    return () => {
      const list = this._subscribers.get(event);
      if (list) {
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      }
    };
  }
  fire(event, data) {
    const list = this._subscribers.get(event);
    if (list) list.forEach(fn => fn(data));
  }
  update(key, value) {
    this._data[key] = value;
    this._tags.push('u-' + key);
    if (this._tags.length > 10) this._tags.shift();
    return this._data;
  }
  getDeps() { return [${deps.map((d) => `Dep${d}`).join(", ")}]; }
}
module.exports = PropService${i};`,

  // Pattern 4: WeakRef + FinalizationRegistry (GC-sensitive objects)
  (i, deps) => `'use strict';
${deps.map((d) => `const Dep${d} = require('./mod${d}');`).join("\n")}

class GcService${i} {
  constructor() {
    this.id = ${i};
    this.refs = [];
    this.registry = new FinalizationRegistry(held => {
      this.refs = this.refs.filter(r => r.deref() !== undefined);
    });
  }
  track(obj) {
    const ref = new WeakRef(obj);
    this.refs.push(ref);
    this.registry.register(obj, this.id);
    return ref;
  }
  createAndTrack(n) {
    const results = [];
    for (let j = 0; j < n; j++) {
      const obj = { id: j, data: new Array(16).fill(j * this.id) };
      results.push(this.track(obj));
    }
    return results;
  }
  collectLive() {
    return this.refs.filter(r => r.deref() !== undefined).map(r => r.deref());
  }
  getDeps() { return [${deps.map((d) => `Dep${d}`).join(", ")}]; }
}
module.exports = GcService${i};`,
];

for (let i = 1; i <= MODULE_COUNT; i++) {
  // Non-circular dependencies — each module only depends on modules with LOWER index
  // This prevents TypeScript from hitting stack overflow during type checking
  const deps = [];
  if (i > 1) {
    for (
      let d = 0;
      d < DEPS_PER_MOD && deps.length < Math.min(DEPS_PER_MOD, i - 1);
      d++
    ) {
      const dep = ((i - 2 + d * 7 + 13) % (i - 1)) + 1;
      if (!deps.includes(dep)) deps.push(dep);
    }
  }
  // Use different code patterns cyclically for diversity
  const pattern = codePatterns[i % codePatterns.length];
  const code = pattern(i, deps);
  fs.writeFileSync(path.join(SRC_DIR, `mod${i}.ts`), code);
}

console.log(
  `[generate] Created ${MODULE_COUNT} source modules with cross-dependencies`,
);

// --- Generate test files ---
// Many short test files — each worker processes them sequentially.
// Between files, the module registry is rebuilt from scratch, creating
// the build-up/teardown cycle that stresses the resolver.

for (let t = 1; t <= TEST_COUNT; t++) {
  // Each test imports a different sliding window of modules
  const startMod = (((t - 1) * 7) % MODULE_COUNT) + 1;
  const modIndices = [];
  for (let m = 0; m < MODS_PER_TEST; m++) {
    modIndices.push(((startMod + m * 3) % MODULE_COUNT) + 1);
  }

  const content = `// @ts-nocheck
// Test file ${t} — imports ${MODS_PER_TEST} modules, runs ${ROUNDS_PER_TEST} reset cycles.
export {};

const { ResolverFactory } = require('unrs-resolver');
const path = require('path');

test('module churn cycle ${t}', async () => {
  const rootDir = path.resolve(__dirname, '..');

  for (let round = 0; round < ${ROUNDS_PER_TEST}; round++) {
    jest.resetModules();

    // --- Direct ResolverFactory NAPI churn ---
    // Create and immediately discard ResolverFactory instances.
    // Each one creates a Rust Arc<Resolver> wrapped in a NAPI handle.
    // When GC'd, the destructor runs through the reference release path.
    // This is the core trigger: rapid NAPI handle allocation pushes V8's
    // heap toward the state that exposes the Sparkplug stale-pointer bug.
    for (let r = 0; r < 50; r++) {
      const factory = new ResolverFactory({
        conditionNames: ['require', 'node', 'default'],
        roots: [rootDir],
      });
      // Actually use it — resolve a real file to force the native code path
      try { factory.sync(rootDir, './src/mod${((t + 1) % 500) + 1}'); } catch(_) {}
      // Clone creates another NAPI handle from the same Rust resolver
      const clone = factory.cloneWithOptions({ conditionNames: ['import', 'node', 'default'] });
      try { clone.sync(rootDir, './src/mod${((t + 2) % 500) + 1}'); } catch(_) {}
      // Both factory and clone become GC-eligible here
    }

    // Re-require heavy Angular/RxJS packages — this is the KEY difference.
    // In the original project, every test imports @angular/core, rxjs, etc.
    // Each import triggers hundreds of nested resolver calls through the dependency tree.
    // With transformIgnorePatterns:[], each file also gets transformed via ts-jest.
    // This creates massive resolver + NAPI churn per reset cycle.
    try { require('@angular/core'); } catch(_) {}
    try { require('@angular/compiler'); } catch(_) {}
    try { require('@angular/platform-browser'); } catch(_) {}
    try { require('rxjs'); } catch(_) {}
    try { require('rxjs/operators'); } catch(_) {}
    try { require('zone.js'); } catch(_) {}

    // Re-require modules — each goes through jest-resolve → unrs-resolver
    const mods = [${modIndices.map((i) => `\n      require('../src/mod${i}')`).join(",")}
    ];

    // Instantiate via Array.prototype.map — this is the specific Sparkplug
    // frame (Builtins_ArrayMap) seen in the crash trace holding the stale pointer.
    const instances = mods.map(M => new M());

    // Exercise instances to create diverse IC feedback and heap objects
    for (const inst of instances) {
      if (typeof inst.process === 'function') inst.process();
      if (typeof inst.compute === 'function') await inst.compute(8);
      if (typeof inst.processAll === 'function') await inst.processAll([1, 2, 3, 4]);
      if (typeof inst.execute === 'function') inst.execute(round + 1);
      if (typeof inst.mapValues === 'function') inst.mapValues([1, 2, 3, 4, 5]);
      if (typeof inst.createAndTrack === 'function') inst.createAndTrack(20);
      if (typeof inst.update === 'function') inst.update('r' + round, round);
      if (typeof inst.transform === 'function') inst.transform([1,2,3,4,5,6,7,8]);
    }

    // More Array.map calls to keep it Sparkplug-hot while NAPI handles are pending GC
    for (let rep = 0; rep < 20; rep++) {
      instances.map(inst => inst.id || inst._id || 0);
      instances.map(inst => typeof inst.process === 'function' ? inst.process() : null);
    }

    // Subscribe/unsubscribe churn — creates many closures that become GC-eligible
    const unsubs = [];
    for (const inst of instances) {
      if (typeof inst.subscribe === 'function') {
        for (let s = 0; s < 5; s++) {
          unsubs.push(inst.subscribe(v => v + s));
        }
        inst.emit(round);
      }
      if (typeof inst.on === 'function') {
        for (let s = 0; s < 5; s++) {
          unsubs.push(inst.on('evt' + s, v => v));
        }
        inst.fire('evt0', round);
      }
    }
    // Unsubscribe all — splice() calls trigger left-trim on observer arrays
    for (const unsub of unsubs) unsub();

    // DOM manipulation — drives jsdom internals into Sparkplug tier
    const container = document.createElement('div');
    document.body.appendChild(container);
    for (let d = 0; d < 50; d++) {
      const el = document.createElement('span');
      el.className = 'item-' + d;
      el.dataset.round = String(round);
      el.dataset.extra = 'padding-' + d + '-' + round;
      el.textContent = 'v' + d;
      container.appendChild(el);
      const inner = document.createElement('em');
      inner.textContent = String(d * round);
      el.appendChild(inner);
    }
    const nodes = Array.from(container.querySelectorAll('span'));
    nodes.map(n => n.textContent);
    const inners = Array.from(container.querySelectorAll('em'));
    inners.map(n => n.textContent);
    document.body.innerHTML = '';

    // Create more ResolverFactory instances interleaved with Array.map
    // This is the critical window: NAPI handles from earlier iterations
    // are being GC'd while Sparkplug-compiled .map() is on the stack
    const mapResults = [];
    for (let r = 0; r < 30; r++) {
      const f = new ResolverFactory({ roots: [rootDir] });
      mapResults.push(...instances.map(inst => inst.id || inst._id || 0));
      try { f.sync(rootDir, './src/mod' + ((round * 7 + r) % 500 + 1)); } catch(_) {}
    }

    // Heap pressure — short-lived buffers
    const ephemeral = [];
    for (let h = 0; h < 300; h++) {
      ephemeral.push(Buffer.alloc(2048, h & 0xff));
    }
    while (ephemeral.length > 10) ephemeral.shift();
  }
});
`;

  fs.writeFileSync(path.join(TEST_DIR, `test${t}.spec.ts`), content);
}

console.log(
  `[generate] Created ${TEST_COUNT} test files (${MODS_PER_TEST} modules × ${ROUNDS_PER_TEST} rounds each)`,
);
console.log(`[generate] Run: npm run test:crash        (single attempt)`);
console.log(`[generate] Run: npm run test:crash:loop   (50 attempts)`);
console.log(
  `[generate] Run: npm run test:crash:detect (--detectOpenHandles, single worker)`,
);
