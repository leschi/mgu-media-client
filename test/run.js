'use strict';
// Runs the whole suite: node test/run.js  (exit code = number of failures)
require('./clustervideo.test');
require('./jellyfin.test');
require('./png.test');
require('./buffer.test');
require('./player.test');
require('./remote.test');
require('./parkgate.test');

const { runAll } = require('./_harness');
runAll().then((failures) => process.exit(failures ? 1 : 0));
