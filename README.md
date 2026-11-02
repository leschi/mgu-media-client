# MGU Media Client

A media client app for the BMW MGU head unit (iDrive 7) that plays from your own **[Jellyfin](https://jellyfin.org) server**:

- **Video on the instrument cluster or the HUD.** You choose where in Settings → *Video on*: the cluster middle (between the gauges), the whole cluster, or the head-up display.
  - The picture shows **only while the car is parked**: under 1 km/h and the selector in P. Anything unknown counts as not parked. When you drive off, the picture goes at once.
  - The sound keeps playing through the car's speakers.
- **Video on the MGU display** too (Settings → *Video on* → MGU display): big on the Player page, the same park check. The frames go to a `/dev/shm` file the GPU renderer reads itself (`shmvideo.js`), so cluster-render's upload limit does not apply there.
- **Pause / play:** the button on the Player page, a press of the controller, or a tap on the picture (MGU display).
- **A buffer on the unit's flash** (Settings → *Video buffer*: 10 minutes by default, about 100 MB): the segments are fetched ahead into the app's data folder and deleted once played and at the end (`buffer.js`). It always leaves 1 GB free on the disk and holds 600 MB at most. Turn off *Throttle transcodes* in Jellyfin (Dashboard → Playback → Transcoding), or the server stops a few minutes ahead.
- **Debug on** (Settings) shows the technical details on the Player page and the Diag page; off by default.
- **Music.** Tracks play through the car's speakers, also while driving.
- **Sign in.** Type the server's address with the on-screen keyboard (`http://192.168.x.x:8096`, or your https address; port 8096 is added to a plain http address). Then either:
  - **Quick Connect:** the app shows a code. You enter it in a signed-in Jellyfin app or the web page (your profile → *Quick Connect*). No password is typed in the car. Quick Connect must be on in the server's dashboard (*General → Quick Connect*).
  - **User name and password** with the on-screen keyboard.

  Either way the app keeps only the server's access token (in its data folder, readable by the app only), not the password. *Sign out* in Settings forgets the token.
- **Browse:** your libraries (movies, shows, music) and *Continue watching*, with the chosen item's poster or cover beside the list (fetched once the selection rests; `png.js` decodes it, no image library needed; it reaches the screen as a renderer pixmap, as a prior project's picture). Videos resume where you stopped, and the server learns how far you got.

This project is not affiliated with or endorsed by Jellyfin or BMW.

## How it works



**Picture**
1. The server transcodes the video to HLS: H.264 and AAC in TS segments, 480×270 by default (`/Videos/{id}/master.m3u8`).
   - That size fits cluster-render's upload limit of about 5.5 MB/s.
   - The URL asks for H.264 Baseline (`Profile=baseline`), because the decoder takes Baseline only.
   - The playlist lists the whole video; to start at a position, the app starts at the segment holding it, and the server transcodes from there.
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
- **A Jellyfin server** (10.8 or newer) that can transcode, reachable from the car: on the home network, or over the internet (for example by a phone hotspot) at an address you set up for it.

## Install on the car

Add this repository as a source in the MGU Store. The Store builds `apps/media` with `kit/tools/build.py`; see `mgu-repo.json`.

## Develop

```bash
node test/run.js
```

The tests also run on Node 8.16, the version on the car. `test/fixtures` holds small generated H.264 / AAC TS segments.

## Cluster middle

As for waze-on-cluster: the middle is the app's only while the cluster's **Central display area** is set to **Map view** (or Off): Instrument cluster settings. In other views BMW's content keeps it, and the Player page says so. The app keeps one layer for the whole video and hides it when not parked (not dropped and made again), and the layer stays wanted for 30 s without a frame, so a slow segment does not give the middle back to BMW's map.

## Known limits (0.3.1)

- **H.264 profile:** If the server sends H.264 Main or High despite the Baseline request, the picture stays empty. Diag then names the profile.
- **Sound:** BMW's player keeps the length a file had when it opened it, so the sound goes on in a fresh file now and then (a short gap): with the disk buffer every few minutes, with the 15-second buffer about every 10 seconds.
- **Not yet available:**
  - Seeking. Changing the target or the quality restarts the video where it was.
  - Subtitles.
