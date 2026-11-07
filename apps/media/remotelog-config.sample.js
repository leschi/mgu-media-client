'use strict';
/**
 * remotelog-config.sample.js - a template for the online diagnostics log (./remotelog).
 *
 * Copy this file to `remotelog-config.js` (same folder) and fill in a jsonbin.io access key and a
 * directory bin. WITHOUT `remotelog-config.js`, or with an empty key, nothing is ever sent - the app
 * works exactly as before. `remotelog-config.js` is git-ignored, so the key never lands in the repo.
 *
 * To make the car send its diagnostics, that file must be present in the build that is installed on the
 * car. Only add a key you are willing to expose: a disposable test key with a low request cap, revoked
 * when testing ends. The bins are private to the key, so whoever has the key can read the car's VIN and
 * log. Read the bins from a PC with tools/remotelog-read.js.
 */
module.exports = {
    accessKey: '',                 // a jsonbin.io X-Access-Key (empty = off)
    directoryBin: '',              // a jsonbin.io bin id that maps VIN -> the car's bin
    maxRequests: 2000,             // this app's own cap per car (the free plan has 9000 in all)
};
