# ytm-cast-receiver

Cast from the **YouTube Music** (or YouTube) app on your phone to a Linux box with speakers,
and optionally a screen. It shows up in the app's cast menu like a smart TV, plays through
the box's sound card, and **keeps playing when the phone is locked, out of range or off
Wi-Fi**. Age-restricted tracks play too, with no cookies or sign-in on the box.

**Status: work in progress.** It works and is in daily use (since October 2026, one receiver,
iPhone + YouTube Music), but it's still being soak-tested and changed, so expect rough edges.
Built for a workshop; shared as-is. Issues and ideas welcome.

## How it works

- **[yt-cast-receiver](https://github.com/patrickkfkan/yt-cast-receiver)** implements DIAL
  discovery and YouTube's "Lounge" TV protocol, so the phone sees a TV. No Google Cast
  certificates are involved.
- **The queue lives with YouTube's TV service, not the phone.** The receiver fetches every
  track itself, so the phone can lock, leave Wi-Fi or switch off. AirPlay, by contrast, sends
  the audio from the phone, so it stops when the phone goes.
- **Age-restricted tracks without sign-in.** With every track the phone sends a credential
  transfer token (`ctt`). `VideoLoader.mjs` puts it in YouTube's `/player` request
  (`context.user.credentialTransferTokens`), and YouTube serves the stream as the phone's
  account would see it. "Explicit" and "age-restricted" are different: explicit tracks play
  anonymously; age-restricted ones need this token.
- **mpv** plays the audio (ALSA). Music videos and videos cast from the YouTube app play full
  screen through mpv's DRM output, if a GPU and screen are attached. Songs vs videos are told
  apart by YouTube's `musicVideoType`.
- **Optional screen** (`kiosk/`): a now-playing page (art, title, progress, volume pop-up,
  clock when idle) shown by **Cog** (WPE WebKit) straight on DRM: no desktop, compositor
  or login session needed. It steps aside while a video plays.

## Behaviour worth knowing

- **The music never just stops at the end of the queue.** In YouTube Music the phone tops up
  the queue, which doesn't happen while it's locked or away. With `YTCR_FORCE_AUTOPLAY=1` the
  receiver carries on by itself through **YouTube Music's radio** for the last queued track
  (`RDAMVM<videoId>`), in order, skipping anything played recently (`MusicRadio.mjs`).
  YouTube's plain TV autoplay was tried first and drifted into non-music videos.
- **Failed tracks are skipped**, at most 3 in a row, then it stops (so an outage can't race
  through the queue).
- **Volume** from the phone is confirmed once, 0.33 s after the last press (per-press
  confirmations made the phone's slider jump around), and is **kept across restarts**.
- **Screen off or unplugged:** videos play as audio from the same spot instead of failing.
- **Picks up where it left off after a restart** (deploy, crash, reboot): queue, track,
  position and play/pause are saved every 5 s (`data/resume.json`). If it was playing less
  than 5 minutes ago it carries straight on; otherwise the queue comes back paused and play
  continues from the saved spot. An explicitly emptied queue stays empty (`Resume.mjs`).
- **YouTube Music's Song/Video switch flips back to "Song"** after you choose Video. The video
  still plays; only the phone's switch is wrong. This is a **YouTube Music bug**: an LG TV with
  the official YouTube app does exactly the same. Swaps themselves are clean here: no
  "stopped" blip, instant reply, and playback continues from the same position.

## Control page and poor man's multi-room audio

`http://<receiver>:8098/control` from any phone, tablet or PC on the LAN (no app, no login):
now playing at the top, then **Workshop speakers** (play/pause, previous/next, volume
buttons and slider, mute), then **This device** (Listen here, with its own volume and mute
for the stream only, remembered per device). It fits one screen with no scrolling: on wide
screens the art sits left and the three sections stack on the right; on a phone held upright
the art shrinks to a thumbnail beside the song. While listening, the phone's lock screen
shows the song and art (pause stops the stream; skip skips the workshop). iPhones ignore a
page's volume setting, so there the local slider defers to the phone's buttons.

**Poor man's multi-room audio:** the page's **Listen here** button plays a live MP3 stream of
whatever the receiver is playing on that device
(`/stream.mp3`) - e.g. to hear the workshop music in the house. It never touches the speaker
playback: a separate ffmpeg downloads the same track ahead into memory and paces it out in
real time to one shared encoder, with silence between tracks so players stay connected. A
broken download resumes from where it got to; the page reconnects by itself after a dropout
or a receiver restart. A few seconds behind the speakers; the listener's own volume. Nothing
runs while nobody listens. (Decoding at real-time speed with `ffmpeg -re` held one slow
connection open per track and YouTube cut it - hence the download-ahead design.)

## Control API

LAN only, no login. POST only (so a link preview can never skip a track); each reply is the
now-playing JSON plus `"ok"`. The phone app and the screen follow along.

```bash
curl -X POST http://<receiver>:8098/api/control/play-pause   # also: play, pause
curl -X POST http://<receiver>:8098/api/control/next          # also: previous
curl -X POST "http://<receiver>:8098/api/control/volume?step=5"   # or ?step=-5, ?level=40
curl -X POST "http://<receiver>:8098/api/control/mute"        # ?on=1 | 0 | toggle (default)
```

Read-only: `GET /api/now-playing`. Unmute restores the level from before muting (YouTube
Music on iOS can't mute, so the library mutes by setting the level to 0).

## What's in here

| Path | What |
|---|---|
| `ytcr-player/index.mjs` | Receiver setup, data store, the now-playing HTTP server |
| `ytcr-player/VideoLoader.mjs` | Track → stream URLs, with the `ctt` handling (adapted from [volumio-ytcr](https://github.com/patrickkfkan/volumio-ytcr), MIT) |
| `ytcr-player/Control.mjs` | Control API (play/pause, next/previous, volume, mute) |
| `ytcr-player/MusicRadio.mjs` | End-of-queue suggestions from YouTube Music's radio |
| `ytcr-player/HouseStream.mjs` | Poor man's multi-room audio: live MP3 stream of what's playing |
| `ytcr-player/Resume.mjs` | Save the queue and pick up again after a restart |
| `ytcr-player/control.html` | The control page (mounted, so edits need no receiver restart - but overwrite the file in place; replacing it leaves the container on the old copy until restarted) |
| `ytcr-player/MpvPlayer.mjs` | Player: long-running audio mpv + per-video DRM mpv, skip/volume logic |
| `ytcr-player/patch-ytcr.cjs` | Build-time patches to yt-cast-receiver; each must match exactly once or the build fails |
| `ytcr-player/nowplaying.html` | The screen page (mounted, so edits need only a kiosk restart) |
| `kiosk/` | Optional screen container (Cog on DRM) |
| `compose.yaml` | Example Docker Compose setup; all settings documented inline |
| `cast-audio-sound.service` | Example systemd unit: sound-device permissions + mixer restore at boot |

Dependencies are pinned to the builds shipped by volumio-ytcr (commit `7a315b3`):
`yt-cast-receiver 2.1.1-volumio-ytcr` and `volumio-yt-support 2.1.1` (which runs a small Deno
helper for YouTube's PO tokens).

## Setup

Tested on Debian 12 (an unprivileged LXC container on Proxmox) with Docker.

1. A Linux host with Docker, a sound card, and (for video/screen) a GPU with a DRM device.
2. Copy this folder over, check `compose.yaml` (name, timezone, devices), then:
   ```bash
   docker compose up -d --build
   ```
3. In YouTube Music, tap the cast icon and pick the name you set (`YTCR_NAME`).

Notes:
- The container runs as uid 1000 with no audio group, so the sound nodes need to be readable
  and writable by it. ALSA's default (dmix) device also needs `/dev/snd/timer`, which some
  hosts reset to 0660 at boot; `cast-audio-sound.service` fixes that before Docker starts.
- Host networking is required (DIAL uses SSDP multicast).
- Without a screen, drop the `kiosk` service and the `/dev/dri` volume. Videos then play as
  audio.
- Logs: `docker logs ytcr`. **Never share debug-level logs**: they contain the phone's tokens.

## Gotchas found along the way

- **Docker on ZFS inside LXC:** `-slim` base images upgrade base packages during the build,
  which crawls (overlay copy-up waits on ZFS syncs). The full `node:20-bookworm` /
  `debian:bookworm` images avoid it.
- **cage/wlroots can't get a seat in a container**; Cog's DRM platform needs none.
- **Cog won't start without a connected screen** (`Failed to initialize DRM`); `kiosk.sh` waits
  for a connector reading `connected`.
- **Swapping the screen between GPU outputs while running** can leave the old output reserved.
  Fix: stop `kiosk`, show anything with `mpv --vo=drm --drm-connector=<new output>` for a few
  seconds, then start `kiosk`.
- **Some TVs halo light text** on anything brighter than pure black; the page uses `#000`
  behind all text for that reason.
- **The browser's memory grew** to ~730 MB over hours with an earlier, blurred-backdrop page;
  the kiosk is capped (`mem_limit`) so only the screen ever restarts.
- yt-cast-receiver's pairing needs `cst=m`; without it the phone can't connect.
- **It shows as a TV, not a speaker, in the cast menu**, and that can't be changed from the
  receiver: an audio-only `clientName` (`TVHTML5_AUDIO`), capabilities without `dsp`, and
  pointing the phone at the YouTube Music lounge screen (DIAL `additionalData` theme `m`) all
  left the TV icon. Most likely the app shows every DIAL/Lounge screen as a TV.

## Roadmap

1. ~~**Control API**~~ **done** (see above). Everything below builds on it.
2. ~~**Browser control page**~~ **done**, plus poor man's multi-room audio (a live stream to any browser) and resume after restart.
3. **Physical remote**: e.g. an ESP32 button remote (via an ESP-NOW bridge) or Zigbee
   buttons, calling the control API.
4. **Idle screen content**: useful panels when nothing is playing.
5. **Later, optional**: an MQTT / Home Assistant link (media player entity, automations),
   kept as an add-on so the music never depends on it.

Not planned for now: starting music from the browser without a phone (casting relies on the
phone to start the session).

## Open / ideas

- One unexplained stall in testing: after the queue ended and an overnight internet dropout,
  the phone paired but its commands never arrived; a restart fixed it. Not seen since.
- If tracks stop resolving after a YouTube change, look for a newer volumio-ytcr release (it
  ships fixed builds of both dependencies), update `package.json`, rebuild.

## Credits

- [yt-cast-receiver](https://github.com/patrickkfkan/yt-cast-receiver) and
  [volumio-ytcr](https://github.com/patrickkfkan/volumio-ytcr) by patrickkfkan (MIT). This
  project builds on both and would not exist without them.
- [mpv](https://mpv.io/), [Cog / WPE WebKit](https://wpewebkit.org/).

## Licence

MIT, see [LICENSE](LICENSE).
