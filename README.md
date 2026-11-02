# MGU Media Client

A media client app for the BMW MGU head unit (iDrive 7) that plays from your own **Media Media Server**:

- **Video on the instrument cluster or the HUD.** You choose where in Settings → *Video on*: the cluster middle (between the gauges), the whole cluster, or the head-up display.
  - The picture shows **only while the car is parked**: under 1 km/h and the selector in P. Anything unknown counts as not parked. When you drive off, the picture goes at once.
  - The sound keeps playing through the car's speakers.
- **Music.** Tracks play through the car's speakers, also while driving.
- **Sign in without typing.**
  - The app shows a code. You enter it at [media.tv/link](https://media.tv/link) on your phone.
  - Or you type the server's address (`http://192.168.x.x:32400`) and a Media token with the on-screen keyboard.

Media is a trademark of Media, Inc. This project is not affiliated with or endorsed by Media or BMW.

## How it works



**Picture**
1. The server transcodes the video to HLS: H.264 and AAC in TS segments, 480×270 by default.
   - That size fits cluster-render's upload limit of about 5.5 MB/s.
   - The client profile asks for H.264 Baseline, because the decoder takes Baseline only.
2. The app fetches the segments and takes them apart (`tsdemux.js`).
3. It decodes the H.264 itself (`h264dec.js`, h264bsd as WebAssembly from tinyh264).
4. It sends the frames to a cluster-render video layer (`clustervideo.js`).

**Sound**
- BMW's media player plays local files only; it rejects every URL.
- So the app appends the AAC sound to a local file in `/tmp` and connects its own source to the media sink through the AudioManager (`oapmedia.js`).
- The picture follows the player's own clock.
- Music works the same way: each track's file is fetched to `/tmp`, played, and deleted afterwards.

**Park check:** `parkgate.js`, a strict check of speed and selector position.

## Needs

- **The MGU Store**, with the cluster-render service (Store source `robertnisipeanu/idrive-apps`). The service is needed for the cluster and the HUD.
- **A Media Media Server** that can transcode, and internet or the home network in the car (for example a phone hotspot).

## Install on the car

Add this repository as a source in the MGU Store. The Store builds `apps/media` with `kit/tools/build.py`; see `mgu-repo.json`.

## Develop

```bash
node test/run.js
```

The tests also run on Node 8.16, the version on the car. `test/fixtures` holds small generated H.264 / AAC TS segments.

## Known limits (0.1.0)

- **H.264 profile:** If the server sends H.264 Main or High despite the Baseline request, the picture stays empty. Diag then names the profile.
- **Not yet available:**
  - Pausing and seeking. Changing the target or the quality restarts the video where it was.
  - Subtitles other than the server burning them in.
