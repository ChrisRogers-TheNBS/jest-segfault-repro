# jest-unrs-segfault-repro

**Reliably reproduces** a `SIGSEGV` crash in V8 Sparkplug triggered by Jest ≥ `30.0.0-beta.6` via [jestjs/jest#15619](https://github.com/jestjs/jest/pull/15619).

> **Root cause:** V8 Sparkplug (Baseline JIT) leaves a stale near-null pointer in an `InternalFrame` slot. When GC fires and `ClearStaleLeftTrimmedPointerVisitor` scans stack roots, it dereferences the stale slot and segfaults. `unrs-resolver`'s NAPI object churn creates the heap pressure that triggers this. Running with `--no-sparkplug` prevents the crash entirely. This is a **V8 bug**, not a bug in `napi-rs` or `unrs-resolver`.

## Environment

| | |
|---|---|
| **OS** | macOS arm64 (Apple Silicon) |
| **Hardware** | Apple M3 Pro - 18GB Memory |
| **Node** | Reproduced on Node 22.X, `24.14.1` and `24.15.0` |
| **Jest** | `30.0.0-beta.6` through `30.3.0` (latest). Safe on `30.0.0-beta.5` (pure-JS resolver - does not utilise `unrs-resolver` package) |
| **unrs-resolver** | `v1.7.11`, `v1.11.1` confirmed |
| **Crash rate** | ~100% of runs with this reproduction |
| **Crash timing** | ~4 - 97 seconds of runtime |

## Quick start

```bash
npm install        # patches jest-resolve, generates tests, warms transform cache

npm run test:crash                # single run — crashes within seconds
npm run test:crash:loop           # loop 50 attempts
npm run test:safe:nosparkplug     # --no-sparkplug → no crash (confirms root cause)
```

Or simply: `npx jest` — crashes without any special flags.

## How the reproduction works

### The trigger: NAPI handle churn

`jest-resolve` creates a new `ResolverFactory` NAPI instance (wrapping Rust `Arc<Resolver>`) on every `require()`. The `postinstall` script patches `jest-resolve` to disable its resolver cache, so every module resolution creates a fresh instance. This produces sustained heap churn — many promoted-then-discarded objects — that drives V8's left-trimming into the buggy code path.

### Key ingredients

1. **`transformIgnorePatterns: []`** — transforms ALL `node_modules` through ts-jest, creating massive resolver cascades
2. **Angular/rxjs re-imports every cycle** — each `jest.resetModules()` + re-require of `@angular/core`, `rxjs`, `zone.js` etc. triggers hundreds of nested resolver calls
3. **200 test files × 15 reset cycles each** — sustained module churn across 4 workers
4. **500 `.ts` source modules** — cross-dependent (non-circular) to maximize resolver activity
5. **`--no-maglev --max-old-space-size=256`** — keeps Sparkplug hot and increases GC pressure
6. **Warm transform cache** — `postinstall` primes the ts-jest cache so tests run fast, concentrating NAPI churn

### Files

| File | Purpose |
|------|---------|
| `patch-jest-resolve.js` | Disables resolver caching (`getResolver` → `undefined`) |
| `generate-tests.js` | Generates 500 source modules + 200 test files |
| `warm-cache.js` | Primes ts-jest transform cache during `postinstall` |
| `setup.ts` | Jest setup — `setupZoneTestEnv()` from `jest-preset-angular` |
| `segfault-bail-reporter.js` | Jest reporter that exits immediately on worker SIGSEGV |
| `src/mod*.ts` | Generated source modules with cross-dependencies |
| `__tests__/test*.spec.ts` | Generated test files with module churn + NAPI churn |

## Diagnostic test matrix

| Configuration | Result | Conclusion |
|---|---|---|
| Default run (4 workers) | **SIGSEGV** | Baseline crash |
| `MallocScribble=1 MallocGuardEdges=1` | **SIGSEGV at same address** | Rules out userspace heap corruption |
| `--no-maglev` | **Still crashes** (faster) | Rules out Maglev JIT |
| `--no-sparkplug` | **No crash** | Confirms Sparkplug as the root cause |
| `--detectOpenHandles` (1 worker) | **SIGSEGV** | Not a concurrency bug — single process crashes too |
| Jest `30.0.0-beta.5` | No crash | Uses pure-JS `resolve` — no NAPI churn |

## Crash trace (representative)

```
v8::ClearStaleLeftTrimmedPointerVisitor::VisitRootPointers  ← SIGSEGV at 0x6
v8::InternalFrame::Iterate
v8::Heap::IterateRoots
v8::MarkCompactCollector::MarkRoots
v8::MarkCompactCollector::CollectGarbage
v8::StackGuard::HandleInterrupts
Builtins_BaselineOutOfLinePrologue              ← Sparkplug frame holding stale pointer
Builtins_ArrayMap                               ← Array.prototype.map() hot path
```

The faulting address is always near-null (`0x6`, `0xe`) — a stale tagged pointer inside V8's own frame, not in addon memory.

## Workarounds

**Disable Sparkplug** (recommended):
```bash
node --no-sparkplug ./node_modules/.bin/jest
```

**Or** downgrade to Jest `30.0.0-beta.5` which uses the pure-JS `resolve` package instead of `unrs-resolver`.
