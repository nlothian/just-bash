// Browser stub for `node:zlib`.
//
// The just-bash browser bundle eagerly imports `constants`, `gzipSync`, and
// `gunzipSync` from node:zlib (the gzip/gunzip/zcat commands use them).
// This stub satisfies the import-time module resolution; calling any of the
// functions throws, since the demo doesn't exercise gzip codepaths.
//
// If you need real gzip support in the browser, point the importmap entry
// for "node:zlib" at a polyfill (e.g. https://esm.sh/browserify-zlib) instead.

const unsupported = (name) => () => {
  throw new Error(
    `node:zlib.${name}() is not available in this browser demo — ` +
      `swap zlib-stub.js for a polyfill if you need it.`,
  );
};

export const constants = {};
export const gzipSync = unsupported("gzipSync");
export const gunzipSync = unsupported("gunzipSync");
export default { constants, gzipSync, gunzipSync };
