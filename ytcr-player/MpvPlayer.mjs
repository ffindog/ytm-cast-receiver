// yt-cast-receiver Player backed by mpv on the ALSA line-out. The receiver
// owns the queue; this class only plays what it is told and reports track end
// so the receiver can move on.
//
// Audio tracks play in one long-running, audio-only mpv. Videos (YouTube
// Music's music videos, ordinary YouTube videos) get their own mpv process
// that draws full screen via DRM (YTCR_DRM_DEVICE) and exits when the video
// ends. Only one program can drive the screen, so before a video starts the
// kiosk container is asked (through /api/now-playing's `mode`) to close its
// browser, and it confirms with POST /api/screen-released.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// The Volumio build of yt-cast-receiver is CommonJS.
const { Player, Constants } = createRequire(import.meta.url)('yt-cast-receiver');

// Failed tracks skipped in a row before stopping, so an outage cannot run
// through the whole queue. Both kinds of failure count: no stream from
// YouTube, and mpv failing to play the stream it was given. The count resets
// only once mpv actually starts playing.
const MAX_SKIPS = 3;

// Volume changes from the phone are confirmed back once, this long after the
// last button press. Confirming every press made the phone jump back to stale
// levels; never confirming left the phone with no volume indicator.
const VOLUME_CONFIRM_DELAY_MS = 330;

// How long to wait for the kiosk to hand the screen over before starting the
// video anyway (kiosk not running, TV off).
const SCREEN_RELEASE_TIMEOUT_MS = 5000;

// How long to wait for the first video frame before reporting "playing" anyway.
const VIDEO_START_TIMEOUT_MS = 8000;

// How often the phone is sent the playback position while playing.
const POSITION_UPDATE_MS = 5000;

const DRM_DEVICE = process.env.YTCR_DRM_DEVICE || '/dev/dri/card1';

class Mpv {
  #socketPath;
  #socket = null;
  #nextId = 1;
  #pending = new Map();
  #buffer = '';
  onEvent = () => {};
  onExit = () => {};

  constructor(logger, socketPath) {
    this.logger = logger;
    this.#socketPath = socketPath;
  }

  async start(args) {
    rmSync(this.#socketPath, { force: true });
    this.process = spawn('mpv', [ ...args, `--input-ipc-server=${this.#socketPath}` ],
      { stdio: [ 'ignore', 'ignore', 'pipe' ] });
    this.process.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      // PipeWire probing noise on every start; mpv then uses ALSA.
      if (text && !/pw\.conf/.test(text)) this.logger.warn(`[mpv] ${text}`);
    });
    this.exited = false;
    this.process.on('exit', (code, signal) => {
      this.exited = true;
      for (const { resolve } of this.#pending.values()) resolve({ error: 'mpv exited' });
      this.#pending.clear();
      this.onExit(code, signal);
    });
    for (let i = 0; i < 100 && !this.#socket && !this.exited; i++) {
      try {
        const socket = net.createConnection(this.#socketPath);
        await once(socket, 'connect');
        this.#socket = socket;
      }
      catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!this.#socket) throw new Error('could not connect to mpv IPC socket');
    this.#socket.on('data', (data) => this.#onData(data));
    this.#socket.on('error', () => {});
  }

  #onData(data) {
    this.#buffer += data.toString();
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      }
      catch {
        continue;
      }
      if (message.request_id && this.#pending.has(message.request_id)) {
        const { resolve } = this.#pending.get(message.request_id);
        this.#pending.delete(message.request_id);
        resolve(message);
      }
      else if (message.event) {
        this.onEvent(message);
      }
    }
  }

  command(...command) {
    if (this.exited || !this.#socket) return Promise.resolve({ error: 'mpv not running' });
    const request_id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(request_id, { resolve });
      this.#socket.write(`${JSON.stringify({ command, request_id })}\n`);
    });
  }

  async get(property) {
    const reply = await this.command('get_property', property);
    return reply.error === 'success' ? reply.data : null;
  }

  async set(property, value) {
    const reply = await this.command('set_property', property, value);
    return reply.error === 'success';
  }

  kill() {
    if (!this.exited) this.process.kill('SIGTERM');
  }
}

export default class MpvPlayer extends Player {
  #audio;
  #video = null;
  #loader;
  #volume = { level: 100, muted: false };
  #duration = 0;
  #loadingId = null;
  #playingEntry = null;
  #failures = 0;
  #abort = null;
  #volumeTimer = null;
  #nowPlaying = null;
  #mode = 'audio';
  #screenReleased = null;
  #startPosition = 0;

  constructor(loader, mpvOptions = {}) {
    super();
    this.#loader = loader;
    this.mpvOptions = mpvOptions;
  }

  async start() {
    // Volume survives restarts (deploys, reboots): saved on every change.
    if (this.mpvOptions.volumeFile) {
      try {
        const saved = JSON.parse(readFileSync(this.mpvOptions.volumeFile, 'utf8'));
        if (Number.isFinite(saved.level) && saved.level >= 0 && saved.level <= 100) {
          this.#volume = { level: saved.level, muted: !!saved.muted };
          this.logger.info(`[player] volume restored to ${saved.level}%${saved.muted ? ' (muted)' : ''}`);
        }
      }
      catch {
        // First run, or unreadable: keep the default.
      }
    }
    this.#audio = new Mpv(this.logger, '/tmp/ytcr-mpv.sock');
    this.#audio.onEvent = (event) => this.#onAudioEvent(event);
    this.#audio.onExit = (code, signal) => {
      // Let the supervisor (Docker restart policy) bring everything back.
      this.logger.error(`[mpv] exited (code ${code}, signal ${signal}); quitting`);
      process.exit(1);
    };
    const args = [
      '--idle=yes', '--no-video', '--no-terminal', '--audio-display=no',
      '--ytdl=no', `--volume=${this.#volume.level}`, `--mute=${this.#volume.muted ? 'yes' : 'no'}`,
      '--cache=yes', '--demuxer-max-bytes=64MiB'
    ];
    if (this.mpvOptions.audioDevice) args.push(`--audio-device=${this.mpvOptions.audioDevice}`);
    await this.#audio.start(args);
    // Keep the phone's idea of the position current, as a TV does. Without
    // it the phone's position goes stale and a Song/Video tap asks for 0:00.
    setInterval(() => {
      if (this.status !== Constants.PLAYER_STATUSES.PLAYING) return;
      this.notifyExternalStateChange().catch((error) =>
        this.logger.error(`[player] position update failed: ${error?.message || error}`));
    }, POSITION_UPDATE_MS);
  }

  // The kiosk calls this (via HTTP) once its browser has let go of the screen.
  screenReleased() {
    this.#screenReleased?.();
  }

  #active() {
    return this.#video && !this.#video.exited ? this.#video : this.#audio;
  }

  #onAudioEvent(event) {
    if (this.#video) return;
    if (event.event === 'playback-restart') {
      // Audio is really flowing for our current file.
      if (this.#playingEntry !== null) this.#failures = 0;
      return;
    }
    if (event.event !== 'end-file') return;
    // 'stop' means we replaced or stopped the file ourselves.
    if (event.reason !== 'eof' && event.reason !== 'error') return;
    if (event.playlist_entry_id !== this.#playingEntry) return;
    this.#playingEntry = null;
    if (event.reason === 'error') {
      void this.#skipOrStop(`mpv could not play the stream (${event.file_error || 'error'})`);
    }
    else {
      void this.#advance();
    }
  }

  async #skipOrStop(reason) {
    if (this.#failures < MAX_SKIPS) {
      this.#failures += 1;
      this.logger.warn(`[player] ${reason}; skipping to next track (${this.#failures}/${MAX_SKIPS} in a row)`);
      await this.#advance();
      return;
    }
    this.logger.warn(`[player] ${reason}; ${MAX_SKIPS} failures in a row, stopping`);
    try {
      await this.notifyExternalStateChange(Constants.PLAYER_STATUSES.STOPPED);
    }
    catch (error) {
      this.logger.error(`[player] could not report stop: ${error?.message || error}`);
    }
  }

  async #advance() {
    try {
      await this.next();
    }
    catch (error) {
      this.logger.error(`[player] next() failed: ${error?.message || error}`);
    }
  }

  // Ends any video and gives the screen back to the kiosk.
  async #stopVideo() {
    const video = this.#video;
    this.#video = null;
    this.#mode = 'audio';
    if (video && !video.exited) {
      video.onExit = () => {};
      video.kill();
      await Promise.race([ once(video.process, 'exit'), new Promise((r) => setTimeout(r, 3000)) ]);
    }
  }

  async #takeScreen() {
    this.#mode = 'video';
    const released = new Promise((resolve) => { this.#screenReleased = resolve; });
    const timedOut = new Promise((resolve) => setTimeout(() => resolve('timeout'), SCREEN_RELEASE_TIMEOUT_MS));
    const result = await Promise.race([ released, timedOut ]);
    this.#screenReleased = null;
    if (result === 'timeout') this.logger.warn('[player] kiosk did not release the screen; starting video anyway');
  }

  async doPlay(video, position) {
    this.#abort?.abort();
    const abort = this.#abort = new AbortController();
    this.#loadingId = video.id;
    // Song <-> Video swap of the same track (flag set by patch-ytcr.cjs):
    // carry on from where we are, as a TV does, not from the phone's guess.
    if (this.ytcrSwapping && this.#playingEntry !== null) {
      const from = await this.doGetPosition();
      this.logger.info(`[player] swap: continuing from ${from}s (phone asked for ${position || 0}s)`);
      position = from;
    }
    this.#startPosition = position || 0;
    await this.#audio.command('stop');
    this.#playingEntry = null;

    let info;
    try {
      info = await this.#loader.getInfo(video, abort.signal);
    }
    catch (error) {
      if (error?.name === 'AbortError') return false;
      throw error;
    }
    if (abort.signal.aborted || this.#loadingId !== video.id) return false;

    if (!info.streamUrl) {
      await this.#stopVideo();
      const reason = `cannot play ${video.id} "${info.title || ''}": ${info.errMsg || 'no stream'}`;
      // After play() has reported this attempt as stopped.
      setTimeout(() => void this.#skipOrStop(reason), 0);
      return false;
    }

    this.#duration = info.duration || 0;
    this.#nowPlaying = {
      id: video.id, title: info.title || '', artist: info.artist || '',
      album: info.album || '', thumbnail: info.thumbnail || null,
      video: info.videoLabel || null
    };
    // TV off or unplugged: there is nowhere to show the video, so play the
    // track's audio instead (mpv's DRM output fails without a connected screen).
    const asVideo = !!info.videoUrl && this.#screenConnected();
    if (info.videoUrl && !asVideo) this.logger.info('[player] screen not connected; playing the audio only');
    const ok = asVideo
      ? await this.#playVideo(video, info, position)
      : await this.#playAudio(video, info, position);
    if (ok) {
      this.logger.info(`[player] playing ${this.#mode === 'video' ? `video (${info.videoLabel})` : 'audio'} `
        + `"${info.title}"${info.artist ? ` - ${info.artist}` : ''}`);
    }
    return ok;
  }

  // Whether a screen is connected to the DRM card mpv draws on.
  #screenConnected() {
    const card = basename(DRM_DEVICE);
    try {
      return readdirSync('/sys/class/drm')
        .filter((name) => name.startsWith(`${card}-`))
        .some((name) => readFileSync(`/sys/class/drm/${name}/status`, 'utf8').trim() === 'connected');
    }
    catch {
      return true; // Cannot tell: try the video, which falls back to audio on failure.
    }
  }

  async #playAudio(video, info, position) {
    await this.#stopVideo();
    // mpv 0.35 (Debian 12): loadfile <url> [<flags> [<options>]], no index argument.
    const args = [ 'loadfile', info.streamUrl, 'replace' ];
    if (position > 0) args.push(`start=${position}`);
    const reply = await this.#audio.command(...args);
    if (reply.error !== 'success') {
      this.logger.error(`[player] mpv refused ${video.id}: ${reply.error}`);
      return false;
    }
    this.#playingEntry = reply.data?.playlist_entry_id ?? null;
    await this.#audio.set('pause', false);
    return true;
  }

  async #playVideo(video, info, position) {
    await this.#stopVideo();
    await this.#takeScreen();
    if (this.#loadingId !== video.id) return false;
    const mpv = new Mpv(this.logger, '/tmp/ytcr-video.sock');
    const args = [
      '--idle=no', '--no-terminal', '--ytdl=no', `--vo=drm`, `--drm-device=${DRM_DEVICE}`,
      '--hwdec=no', '--osd-level=1', '--osd-bar-h=2.5', '--osd-font-size=40', '--keep-open=no', '--cache=yes', '--demuxer-max-bytes=150MiB',
      `--volume=${this.#volume.level}`, `--mute=${this.#volume.muted ? 'yes' : 'no'}`,
      `--audio-file=${info.streamUrl}`
    ];
    if (this.mpvOptions.audioDevice) args.push(`--audio-device=${this.mpvOptions.audioDevice}`);
    if (position > 0) args.push(`--start=${position}`);
    args.push(info.videoUrl);
    // Report "playing" only once the first frame is up, so the phone is not
    // told playback started (at 0:00) while mpv is still opening the stream.
    let started;
    const firstFrame = new Promise((resolve) => { started = resolve; });
    let shown = false;
    let waiting = true;
    let failedEarly = false;
    mpv.onEvent = (event) => {
      if (event.event !== 'playback-restart') return;
      shown = true;
      this.#failures = 0;
      started();
    };
    mpv.onExit = (code) => {
      started();
      if (this.#video !== mpv) return;
      this.#video = null;
      this.#mode = 'audio';
      this.#playingEntry = null;
      // mpv exits 0 at the end of the file, 2 when it could not play it.
      if (code === 0) {
        void this.#advance();
      }
      else if (!shown) {
        // Never got a picture up (screen off, display busy): the track itself
        // is fine, so carry on with its audio rather than skipping it.
        this.logger.warn(`[player] video output failed (exit ${code}); playing the audio only`);
        failedEarly = true;
        if (!waiting) void this.#playAudio(video, info, this.#startPosition);
      }
      else {
        void this.#skipOrStop(`mpv could not play the video (exit ${code})`);
      }
    };
    this.#video = mpv;
    this.#mode = 'video';
    try {
      await mpv.start(args);
    }
    catch (error) {
      this.logger.error(`[player] video player failed to start: ${error?.message || error}`);
      this.#video = null;
      this.#mode = 'audio';
      return false;
    }
    const timedOut = new Promise((resolve) => setTimeout(() => resolve('timeout'), VIDEO_START_TIMEOUT_MS));
    if (await Promise.race([ firstFrame, timedOut ]) === 'timeout') {
      this.logger.warn('[player] video slow to start; reporting it as playing anyway');
    }
    waiting = false;
    if (failedEarly && this.#loadingId === video.id) return this.#playAudio(video, info, position);
    if (this.#video !== mpv) return false;
    this.#playingEntry = 'video';
    return true;
  }

  async doPause() {
    return this.#active().set('pause', true);
  }

  async doResume() {
    return this.#active().set('pause', false);
  }

  async doStop() {
    this.#abort?.abort();
    this.#playingEntry = null;
    this.#nowPlaying = null;
    await this.#stopVideo();
    await this.#audio.command('stop');
    return true;
  }

  async doSeek(position) {
    const reply = await this.#active().command('seek', position, 'absolute');
    return reply.error === 'success';
  }

  async doSetVolume(volume) {
    this.#volume = { level: volume.level, muted: !!volume.muted };
    for (const mpv of [ this.#audio, this.#video ]) {
      if (!mpv || mpv.exited) continue;
      await mpv.set('mute', !!volume.muted);
      if (mpv === this.#video) {
        // The kiosk page (and its volume pop-up) is off screen during a video:
        // let mpv show its own volume bar instead.
        await mpv.command('osd-msg-bar', 'set', 'volume', volume.level);
      }
      else {
        await mpv.set('volume', volume.level);
      }
    }
    // Returning true would make the library confirm every press straight
    // away; while a button is held those confirmations arrive late and the
    // phone jumps back. Confirm once, after the presses stop.
    clearTimeout(this.#volumeTimer);
    this.#volumeTimer = setTimeout(() => {
      this.notifyExternalStateChange().catch((error) =>
        this.logger.error(`[player] volume confirm failed: ${error?.message || error}`));
      if (this.mpvOptions.volumeFile) {
        writeFile(this.mpvOptions.volumeFile, JSON.stringify(this.#volume)).catch((error) =>
          this.logger.error(`[player] could not save volume: ${error?.message || error}`));
      }
    }, VOLUME_CONFIRM_DELAY_MS);
    return false;
  }

  // For the now-playing screen and the kiosk. `state` is the receiver's
  // player status; `mode` tells the kiosk whether it may hold the screen.
  async nowPlaying() {
    const playing = this.#playingEntry !== null ? this.#nowPlaying : null;
    return {
      mode: this.#mode,
      state: playing ? (this.status === Constants.PLAYER_STATUSES.PAUSED ? 'paused' : 'playing') : 'idle',
      track: playing,
      position: playing ? await this.doGetPosition() : 0,
      duration: playing ? await this.doGetDuration() : 0,
      volume: this.#volume
    };
  }

  async doGetVolume() {
    return this.#volume;
  }

  async doGetPosition() {
    // Until mpv has opened the stream it has no time-pos; report where we
    // were asked to start rather than 0:00, which looks like a new track.
    const pos = await this.#active().get('time-pos');
    return Math.max(0, Math.floor(typeof pos === 'number' ? pos : this.#startPosition));
  }

  async doGetDuration() {
    return Math.floor((await this.#active().get('duration')) || this.#duration || 0);
  }
}
