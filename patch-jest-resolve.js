// patch-jest-resolve.js — postinstall script that patches jest-resolve to
// defeat resolver caching. This forces a NEW ResolverFactory per resolve() call
// instead of reusing/cloning the cached one. This dramatically increases the
// rate of NAPI handle creation/destruction and makes the segfault more likely.
"use strict";

const fs = require("fs");
const path = require("path");

const TARGET = path.join(
  __dirname,
  "node_modules",
  "jest-resolve",
  "build",
  "index.js",
);

let src = fs.readFileSync(TARGET, "utf8");

// Patch 1: Make getResolver() always return undefined so a new factory is
// created on every resolve call (instead of cloning the cached one).
// Original: function getResolver() { return unrsResolver; }
// Patched:  function getResolver() { return undefined; }
const getResolverOld = "function getResolver() {\n  return unrsResolver;\n}";
const getResolverNew =
  "function getResolver() {\n  return undefined; /* PATCHED: force new factory per resolve */\n}";

if (src.includes(getResolverOld)) {
  src = src.replace(getResolverOld, getResolverNew);
  console.log("[patch] Disabled resolver caching (getResolver → undefined)");
} else {
  console.log(
    "[patch] WARNING: getResolver pattern not found — already patched or changed",
  );
}

fs.writeFileSync(TARGET, src);
console.log("[patch] jest-resolve patched successfully");
