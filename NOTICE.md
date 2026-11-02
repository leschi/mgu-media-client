# Third-party notices

- **`kit/`** is vendored so that the MGU Store can build the app on the head unit directly from this repository. It is not original to this project:
  - **`kit/runtime`, `kit/tools`, `kit/platform`, `kit/icons`** come from the MGU App Kit, [`cauliflowermossgrape/idrive7-apps`](https://github.com/cauliflowermossgrape/idrive7-apps). They are MIT licensed (see that project's `LICENSE`).
  - **`kit/renderd/prebuilt`** contains the `mgu-render` / `mgu-renderd` GPU renderer and the `mgu-inputgate` controller gate. They come from [`robertnisipeanu/mgu-store`](https://github.com/robertnisipeanu/mgu-store) via idrive7-apps. See `kit/renderd/LICENSE` and `kit/renderd/LICENSE.mgu-renderd`.
- **`apps/media/cluster_render_client.js`** is the reference Node client for the cluster-render service, from [`robertnisipeanu/idrive-apps`](https://github.com/robertnisipeanu/idrive-apps) (`native/cluster-render/js`). It is **MPL-2.0**, (C) Robert Nisipeanu, and used verbatim.
- **`apps/media/h264.wasm`** is the H.264 decoder h264bsd compiled to WebAssembly. It is taken unchanged from [`udevbe/tinyh264`](https://github.com/udevbe/tinyh264) 0.0.7 (npm `tinyh264`) and is **Apache-2.0**; see `third_party/tinyh264-LICENSE.txt`. h264bsd itself comes from the Android project (Apache-2.0). `apps/media/h264dec.js` is this project's own loader for it.

The other files under `apps/media/` and all of `test/` are original to this project (MIT, see `LICENSE`). Several of them come from the same author's a prior project. `test/fixtures` holds TS segments generated with FFmpeg from its test sources.
