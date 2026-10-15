// Workshop YouTube Music receiver. Appears in the YouTube / YouTube Music cast
// menu as a TV (DIAL + YouTube Lounge, via yt-cast-receiver) and plays through
// mpv. No Google Cast certificates and no account cookies: audio is fetched
// with the per-track sign-in token the phone sends.
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { control, ControlError } from './Control.mjs';
import HouseStream from './HouseStream.mjs';
import { restoreAndKeepSaving } from './Resume.mjs';
import MpvPlayer from './MpvPlayer.mjs';
import { useMusicRadio } from './MusicRadio.mjs';
import VideoLoader from './VideoLoader.mjs';

// The Volumio build of yt-cast-receiver is CommonJS.
const ytcr = createRequire(import.meta.url)('yt-cast-receiver');
const { Constants, DataStore } = ytcr;
const YouTubeCastReceiver = ytcr.default;

const env = process.env;
const NAME = env.YTCR_NAME || 'Workshop';
const PORT = Number(env.YTCR_PORT || 8099);
const DATA_DIR = env.YTCR_DATA_DIR || '/data';
const LOG_LEVEL = (env.YTCR_LOG_LEVEL || 'info').toLowerCase();
const HTTP_PORT = Number(env.YTCR_HTTP_PORT || 8098);

// Keeps the pairing identity across restarts so the phone remembers us.
class FileDataStore extends DataStore {
  #file = `${DATA_DIR}/datastore.json`;

  async set(key, value) {
    const data = await this.#read();
    data[key] = value;
    await writeFile(this.#file, JSON.stringify(data, null, 2));
  }

  async get(key) {
    return (await this.#read())[key] ?? null;
  }

  async clear() {
    await writeFile(this.#file, '{}');
  }

  async #read() {
    try {
      return JSON.parse(await readFile(this.#file, 'utf8'));
    }
    catch {
      return {};
    }
  }
}

mkdirSync(DATA_DIR, { recursive: true });
const dataStore = new FileDataStore();

const loaderLogger = {
  info: (...a) => receiver.logger.info(...a),
  warn: (...a) => receiver.logger.warn(...a),
  error: (...a) => receiver.logger.error(...a),
  debug: (...a) => receiver.logger.debug(...a)
};
// End-of-queue suggestions come from YouTube Music's radio (MusicRadio.mjs).
if (env.YTCR_FORCE_AUTOPLAY === '1') useMusicRadio(loaderLogger);

// Poor man's multi-room audio: MP3 stream of what's playing (HouseStream.mjs).
const houseStream = new HouseStream(loaderLogger);

const player = new MpvPlayer(new VideoLoader(loaderLogger), {
  houseStream,
  audioDevice: env.YTCR_AUDIO_DEVICE,
  volumeFile: `${DATA_DIR}/volume.json`
});
const receiver = new YouTubeCastReceiver(player, {
  // Brand/model are reported to YouTube when pairing; see README (Song/Video switch).
  device: { name: NAME, screenName: NAME, brand: env.YTCR_DEVICE_BRAND || 'RAGE', model: env.YTCR_DEVICE_MODEL || 'Workshop' },
  dial: { port: PORT },
  app: {
    // Keep playing when the phone drops off Wi-Fi; only stop when every
    // sender explicitly disconnects.
    resetPlayerOnDisconnectPolicy: Constants.RESET_PLAYER_ON_DISCONNECT_POLICIES.ALL_EXPLICITLY_DISCONNECTED,
    enableAutoplayOnConnect: true,
    // App name reported to YouTube when pairing (library default 'ytcr').
    // Real TVs report 'lb-v4'; see README (Song/Video switch).
    screenApp: env.YTCR_SCREEN_APP || undefined
  },
  dataStore,
  logLevel: LOG_LEVEL
});

receiver.on('senderConnect', (sender) => {
  receiver.logger.info(`[ytcr] sender connected: ${sender.device?.name || sender.name || 'unknown'}`);
});
receiver.on('senderDisconnect', (sender, implicit) => {
  receiver.logger.info(`[ytcr] sender disconnected${implicit ? ' (implicit)' : ''}: ${sender.device?.name || sender.name || 'unknown'}`);
});
receiver.on('error', (error) => {
  receiver.logger.error(`[ytcr] receiver error: ${error?.message || error}`);
});
receiver.on('terminate', (error) => {
  receiver.logger.error(`[ytcr] receiver terminated: ${error?.message || error}; quitting`);
  process.exit(1);
});

await player.start();
await receiver.start();

// Carry on with what was playing before a restart (Resume.mjs).
let finalResumeSave = async () => {};
try {
  finalResumeSave = await restoreAndKeepSaving(player, `${DATA_DIR}/resume.json`, receiver.logger);
}
catch (error) {
  receiver.logger.error(`[resume] could not restore: ${error?.message || error}`);
}

// DIAL <additionalData> like a real TV's (see patch-ytcr.cjs): which screen
// the phone should join. Off unless YTCR_DIAL_ADDITIONAL_DATA is "1" (the
// YouTube / cl screen) or "m" (the YouTube Music screen - tried 2026-10-15 to
// see whether the cast menu then shows a speaker instead of a TV).
const DIAL_THEME = { 1: 'cl', cl: 'cl', m: 'm' }[env.YTCR_DIAL_ADDITIONAL_DATA];
if (DIAL_THEME) {
  const ctx = await dataStore.get(`mdxContext.${DIAL_THEME}`);
  if (ctx?.screenId) {
    const additionalData = {
      screenId: ctx.screenId, theme: DIAL_THEME, deviceId: ctx.deviceId,
      brand: env.YTCR_DEVICE_BRAND || 'RAGE', model: env.YTCR_DEVICE_MODEL || 'Workshop'
    };
    globalThis.ytcrDialAdditionalData = () => additionalData;
    receiver.logger.info(`[ytcr] DIAL additionalData on (screen for theme ${DIAL_THEME})`);
  }
}

// Now-playing page for the screen (read-only, LAN). Read on every
// request: compose mounts the page from /opt/cast-audio, so page edits only
// need the kiosk to reload, not a receiver restart.
const PAGE = env.YTCR_PAGE || new URL('./nowplaying.html', import.meta.url);
// Remote-control page for any phone or browser on the LAN (Control.mjs API).
const CONTROL_PAGE = new URL('./control.html', import.meta.url);
http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url, 'http://receiver');
    const controlAction = url.pathname.match(/^\/api\/control\/([a-z-]+)$/)?.[1];
    if (controlAction) {
      // Control API (Control.mjs): POST only, so a link preview or prefetch
      // can never skip a track.
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end();
        return;
      }
      let ok;
      try {
        ok = await control(player, controlAction, url.searchParams);
      }
      catch (error) {
        if (!(error instanceof ControlError)) throw error;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
        return;
      }
      receiver.logger.info(`[control] ${controlAction}${url.search} -> ${ok ? 'ok' : 'no effect'}`);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok, ...(await player.nowPlaying()) }));
    }
    else if (url.pathname === '/stream.mp3' || url.pathname === '/stream') {
      houseStream.handle(req, res);
    }
    else if (url.pathname === '/control' || url.pathname === '/remote') {
      const page = await readFile(CONTROL_PAGE);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
    }
    else if (req.url === '/' || req.url === '/now-playing') {
      const page = await readFile(PAGE);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
    }
    else if (req.url === '/api/screen-released' && req.method === 'POST') {
      // The kiosk has closed its browser; a pending video may take the screen.
      player.screenReleased();
      res.writeHead(204).end();
    }
    else if (req.url === '/api/now-playing') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(await player.nowPlaying()));
    }
    else {
      res.writeHead(404).end();
    }
  })().catch((error) => {
    receiver.logger.error(`[http] ${req.url}: ${error?.message || error}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(HTTP_PORT, () => receiver.logger.info(`[http] now playing on port ${HTTP_PORT}`));

receiver.logger.info(`[ytcr] "${NAME}" ready (DIAL port ${PORT})`);

for (const signal of [ 'SIGINT', 'SIGTERM' ]) {
  process.on(signal, () => {
    void (async () => {
      try {
        // Before stop(): stopping empties the queue (Resume.mjs).
        await finalResumeSave();
        await receiver.stop();
      }
      finally {
        process.exit(0);
      }
    })();
  });
}
