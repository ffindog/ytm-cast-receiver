// Poor man's multi-room audio ("Listen here" on the control page): a
// continuous MP3 stream of whatever the receiver is
// playing, for any browser on the LAN (GET /stream.mp3).
//
// It never touches the speaker playback. A separate ffmpeg downloads and
// decodes the same track (from where the speakers are) into raw PCM as fast
// as it can; that is buffered here and paced out in real time to one
// long-running MP3 encoder shared by every listener. Downloading ahead matters:
// decoding at real-time speed (ffmpeg -re) kept one slow connection open for
// the whole track and YouTube cut it ("tls: Error in the pull function",
// 2026-10-15). If a download still breaks, it resumes from where it got to.
// Between tracks, while paused or idle, silence keeps browsers connected.
// Nothing runs while nobody is listening.
//
// The stream is a few seconds behind the speakers (browser buffering) and has
// its own volume (the listener's device).
import { spawn } from 'node:child_process';

const RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SEC = RATE * CHANNELS * 2;
const TICK_MS = 50;
const TICK_BYTES = (BYTES_PER_SEC * TICK_MS) / 1000;
const SILENCE = Buffer.alloc(TICK_BYTES);
const BITRATE = process.env.YTCR_STREAM_BITRATE || '192k';
// Pause the download once this much audio is buffered (~6 minutes, ~63 MB).
const MAX_BUFFER_BYTES = BYTES_PER_SEC * 360;
const MAX_RESUMES = 3;

export default class HouseStream {
  #logger;
  #listeners = new Set();
  #encoder = null;
  #decoder = null;
  #pacer = null;
  #source = null; // { url, position, at, title }
  #queue = [];
  #queuedBytes = 0;
  #decodedBytes = 0; // since this decoder's start position
  #decoderStart = 0; // seconds into the track this decoder started at
  #decoderDone = false;
  #resumes = 0;
  #generation = 0;

  constructor(logger) {
    this.#logger = logger;
  }

  get listeners() {
    return this.#listeners.size;
  }

  // --- Player side -------------------------------------------------------

  // A track started (or resumed / was seeked) at `position` seconds.
  play(url, position, title) {
    this.#source = { url, position: Math.max(0, position || 0), at: Date.now(), title };
    this.#resumes = 0;
    if (this.#encoder) this.#startDecoder(this.#livePosition());
  }

  // Paused, stopped, or between tracks: feed silence.
  silence() {
    this.#source = null;
    this.#stopDecoder();
  }

  // --- HTTP side ---------------------------------------------------------

  handle(req, res) {
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'icy-name': 'Workshop'
    });
    this.#listeners.add(res);
    this.#logger.info(`[stream] listener joined (${this.#listeners.size} now)`);
    const leave = () => {
      if (!this.#listeners.delete(res)) return;
      this.#logger.info(`[stream] listener left (${this.#listeners.size} now)`);
      if (this.#listeners.size === 0) this.#stopAll();
    };
    req.on('close', leave);
    res.on('error', leave);
    if (!this.#encoder) this.#startEncoder();
  }

  // --- Internals -----------------------------------------------------------

  // Where the speakers are now in the current track.
  #livePosition() {
    if (!this.#source) return 0;
    return this.#source.position + (Date.now() - this.#source.at) / 1000;
  }

  #startEncoder() {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), '-i', 'pipe:0',
      '-c:a', 'libmp3lame', '-b:a', BITRATE, '-f', 'mp3', 'pipe:1'
    ], { stdio: [ 'pipe', 'pipe', 'pipe' ] });
    this.#encoder = ff;
    ff.stdout.on('data', (chunk) => {
      for (const res of this.#listeners) res.write(chunk);
    });
    ff.stderr.on('data', (d) => this.#logger.warn(`[stream] encoder: ${String(d).trim()}`));
    ff.stdin.on('error', () => {});
    ff.on('exit', (code) => {
      if (this.#encoder !== ff) return;
      this.#encoder = null;
      this.#stopDecoder();
      clearInterval(this.#pacer);
      this.#pacer = null;
      this.#logger.warn(`[stream] encoder exited (${code})`);
      for (const res of this.#listeners) res.end();
      this.#listeners.clear();
    });
    // One clock for everything: real-time 50 ms ticks of audio or silence.
    this.#pacer = setInterval(() => this.#tick(), TICK_MS);
    this.#logger.info('[stream] encoder started');
    if (this.#source) this.#startDecoder(this.#livePosition());
  }

  #tick() {
    if (!this.#encoder) return;
    if (this.#queuedBytes < TICK_BYTES) {
      // Nothing buffered (between tracks, paused, or still connecting).
      this.#encoder.stdin.write(SILENCE);
      return;
    }
    let need = TICK_BYTES;
    const parts = [];
    while (need > 0) {
      const head = this.#queue[0];
      if (head.length <= need) {
        parts.push(head);
        this.#queue.shift();
        need -= head.length;
      }
      else {
        parts.push(head.subarray(0, need));
        this.#queue[0] = head.subarray(need);
        need = 0;
      }
    }
    this.#queuedBytes -= TICK_BYTES;
    this.#encoder.stdin.write(Buffer.concat(parts));
    if (this.#decoder?.stdout.isPaused() && this.#queuedBytes < MAX_BUFFER_BYTES / 2) {
      this.#decoder.stdout.resume();
    }
  }

  #startDecoder(position) {
    this.#stopDecoder();
    const source = this.#source;
    if (!source || !this.#encoder) return;
    const generation = ++this.#generation;
    this.#decoderStart = position;
    this.#decodedBytes = 0;
    this.#decoderDone = false;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5'
    ];
    if (position > 0) args.push('-ss', position.toFixed(2));
    args.push('-i', source.url, '-vn', '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), 'pipe:1');
    const ff = spawn('ffmpeg', args, { stdio: [ 'ignore', 'pipe', 'pipe' ] });
    this.#decoder = ff;
    ff.stdout.on('data', (chunk) => {
      if (generation !== this.#generation) return;
      this.#queue.push(chunk);
      this.#queuedBytes += chunk.length;
      this.#decodedBytes += chunk.length;
      if (this.#queuedBytes > MAX_BUFFER_BYTES) ff.stdout.pause();
    });
    let errText = '';
    ff.stderr.on('data', (d) => { errText += String(d); });
    ff.on('exit', (code) => {
      if (generation !== this.#generation) return;
      this.#decoder = null;
      if (code === 0) {
        this.#decoderDone = true;
        return; // whole track buffered; the pacer plays it out, then silence
      }
      const reached = this.#decoderStart + this.#decodedBytes / BYTES_PER_SEC;
      this.#logger.warn(`[stream] download broke at ${Math.round(reached)}s (${errText.trim().slice(0, 200) || `exit ${code}`})`);
      if (this.#source === source && this.#resumes < MAX_RESUMES) {
        this.#resumes += 1;
        // Keep what is buffered and carry on from where the download got to.
        const queued = this.#queue;
        const bytes = this.#queuedBytes;
        this.#startDecoder(reached);
        this.#queue = queued;
        this.#queuedBytes = bytes;
        this.#logger.info(`[stream] resuming download from ${Math.round(reached)}s (${this.#resumes}/${MAX_RESUMES})`);
      }
    });
    this.#logger.info(`[stream] now streaming "${source.title || '?'}" from ${Math.round(position)}s`);
  }

  #stopDecoder() {
    this.#generation += 1;
    const ff = this.#decoder;
    this.#decoder = null;
    if (ff && ff.exitCode === null) ff.kill('SIGKILL');
    this.#queue = [];
    this.#queuedBytes = 0;
  }

  #stopAll() {
    this.#stopDecoder();
    clearInterval(this.#pacer);
    this.#pacer = null;
    const enc = this.#encoder;
    this.#encoder = null;
    if (enc && enc.exitCode === null) enc.kill('SIGKILL');
    this.#logger.info('[stream] nobody listening; stopped');
  }
}
