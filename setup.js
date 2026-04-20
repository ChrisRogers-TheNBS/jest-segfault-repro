// setup.js — runs in every Jest worker before tests.
"use strict";

// Zone.js patches Promise.prototype.then, setTimeout, addEventListener, etc.
// This changes the microtask processing path — the crash stack shows the
// segfault occurring through RunMicrotasks → AsyncFunctionAwaitResolveClosure
// → BaselineOutOfLinePrologue. Zone.js wrapping creates additional function
// objects and closures on every async operation, increasing both heap pressure
// and the diversity of functions Sparkplug compiles.
require("zone.js");

// Load RxJS operators eagerly — this is a large module tree (~200 files) that
// creates many distinct function objects for Sparkplug to compile, mirroring
// the Angular project's heavy RxJS usage.
require("rxjs");
require("rxjs/operators");
