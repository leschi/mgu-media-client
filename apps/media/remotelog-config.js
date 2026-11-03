'use strict';
/**
 * remotelog-config.js - the online test log (./remotelog): a jsonbin.io access key and the directory
 * bin (VIN -> the car's bin). A THROWAWAY KEY FOR TESTING, given by the owner to be put here (the same
 * key a prior project uses); it will be deleted and deactivated when testing ends - remove this file (and the
 * key from git history, or just revoke it) before the repository goes public. This repository is
 * private for now, so the key lives here as in a prior project. Without this file, or with an empty key,
 * nothing is sent. The directory bin is this app's own (not a prior project's), so the two never collide.
 */
module.exports = {
    accessKey: '',
    directoryBin: '',
    maxRequests: 2000,          // the app's own cap per car (the free plan has 9000 in all)
};
