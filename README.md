# MGU Media Client

A media client app for the BMW MGU head unit (iDrive 7) that plays from your own **[Jellyfin](https://jellyfin.org) server**:

- **Video on the instrument cluster or the HUD.** You choose where in Settings → *Video on*: the cluster middle (between the gauges), the whole cluster, or the head-up display.
  - The picture shows **only while the car is parked**: under 1 km/h and the selector in P. Anything unknown counts as not parked. When you drive off, the picture goes at once.
  - The sound keeps playing through the car's speakers.
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

## Known limits (0.2.3)

- **H.264 profile:** If the server sends H.264 Main or High despite the Baseline request, the picture stays empty. Diag then names the profile.
- **Not yet available:**
  - Pausing and seeking. Changing the target or the quality restarts the video where it was.
  - Subtitles.
