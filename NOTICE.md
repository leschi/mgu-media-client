# Third-party notices

- **`kit/`** is vendored so that the MGU Store can build the app on the head unit directly from this repository. It is not original to this project:
  - **`kit/runtime`, `kit/tools`, `kit/platform`** come from the MGU App Kit, [`cauliflowermossgrape/idrive7-apps`](https://github.com/cauliflowermossgrape/idrive7-apps). They are MIT licensed (see that project's `LICENSE`). The kit's diagnostic modules and tools and the other apps' icons are left out: this app does not use them.
  - **`kit/renderd/prebuilt`** contains the GPU renderer binary `mgu-renderd` (mgu-render) and the `mgu-inputgate` controller gate, taken unchanged from idrive7-apps' `kit/renderd/prebuilt`.
    - **`mgu-renderd`** (and the scripts beside it) is **GPL-3.0-or-later**, Copyright (C) 2026 Robert Nisipeanu and IterioDev (`kit/renderd/LICENSE`); the parts it took from idrive7-apps' first renderer stay MIT as well (`kit/renderd/LICENSE.mgu-renderd`). Its source is [`kit/renderd`](https://github.com/cauliflowermossgrape/idrive7-apps/tree/main/kit/renderd) in idrive7-apps; `kit/renderd/prebuilt/SOURCE_SHA256` names the source tree the binary was built from. The app only talks to the renderer over its socket.
    - **`mgu-inputgate.so`** is idrive7-apps' own, MIT (its vsomeip headers MPL-2.0).
- **`apps/media/cluster_render_client.js`** is the reference Node client for the cluster-render service, from [`robertnisipeanu/idrive-apps`](https://github.com/robertnisipeanu/idrive-apps) (`native/cluster-render/js`). It is **MPL-2.0**, (C) Robert Nisipeanu, and used verbatim.
- **`apps/media/h264.wasm`** is the H.264 decoder h264bsd compiled to WebAssembly. It is taken unchanged from [`udevbe/tinyh264`](https://github.com/udevbe/tinyh264) 0.0.7 (npm `tinyh264`) and is **Apache-2.0**; see `third_party/tinyh264-LICENSE.txt`. h264bsd itself comes from the Android project (Apache-2.0). `apps/media/h264dec.js` is this project's own loader for it.

The other files under `apps/media/` and all of `test/` are original to this project (MIT, see `LICENSE`). `test/fixtures` holds small TS segments generated with FFmpeg.
