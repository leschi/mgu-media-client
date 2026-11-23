# Third-party notices

- **`kit/`** is vendored so that the MGU Store can build the app on the head unit directly from this repository. It is not original to this project:
  - **`kit/runtime`, `kit/tools`, `kit/platform`** come from the MGU App Kit, [`cauliflowermossgrape/idrive7-apps`](https://github.com/cauliflowermossgrape/idrive7-apps). They are MIT licensed (see that project's `LICENSE`). The kit's diagnostic modules and tools and the other apps' icons are left out: this app does not use them.
- **`apps/media/cluster_render_client.js`** is the reference Node client for the cluster-render service, from [`robertnisipeanu/idrive-apps`](https://github.com/robertnisipeanu/idrive-apps) (`native/cluster-render/js`, as of cluster-render 0.8.6). It is **MPL-2.0**, (C) Robert Nisipeanu, and used verbatim.
- **`apps/media/h264.wasm`** is the H.264 decoder h264bsd compiled to WebAssembly. It is taken unchanged from [`udevbe/tinyh264`](https://github.com/udevbe/tinyh264) 0.0.7 (npm `tinyh264`) and is **Apache-2.0**; see `third_party/tinyh264-LICENSE.txt`. h264bsd itself comes from the Android project (Apache-2.0). `apps/media/h264dec.js` is this project's own loader for it.
- **`tools/airplay`** (the AirPlay receiver, a program of its own) is **GPL-3.0-or-later** (`tools/airplay/LICENSE`).
  - `src/receiver.c` is this project's; `prebuilt/mgu-airplay` is built from it by `src/build.sh`, with the source of [UxPlay](https://github.com/FDH2/UxPlay) `lib/` (GPL-3.0 and LGPL-2.1), [FFmpeg](https://ffmpeg.org) 7.1.1 (LGPL-3.0), OpenSSL 3.0.15 (Apache-2.0), [libplist](https://github.com/libimobiledevice/libplist) 2.6.0 (LGPL-2.1) and Apple's mDNSResponder client (BSD), all statically linked; `LICENSES.txt` names them.
  - `launch.js`, `network.js` and `src/mdns_route.c` are after [`pllanaio/bmw-airplay`](https://github.com/pllanaio/bmw-airplay), (C) 2026 Leon Pllana IT-Solutions, GPL-3.0-or-later. Nothing of that project is needed on the car.

The other files under `apps/media/` and all of `test/` are original to this project (MIT, see `LICENSE`). `test/fixtures` holds small TS segments generated with FFmpeg.
