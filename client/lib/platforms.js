// Console platform detection — the single source lives in the server
// (server/src/platforms.cjs). The packaged app carries it in client/embedded;
// a dev checkout falls back to the server folder.
let impl;
try {
  impl = require('../embedded/platforms.cjs');
} catch {
  impl = require('../../server/src/platforms.cjs');
}
module.exports = impl;
