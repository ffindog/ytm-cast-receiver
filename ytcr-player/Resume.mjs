// Pick up where we left off after a restart (deploy, crash, reboot).
//
// Every few seconds the queue, the current track (with its per-track token),
// the position and playing/paused are saved to the data folder. On start:
//   - played within the last RESUME_WINDOW_MS -> carry on playing from there;
//   - older -> restore the queue paused; play (phone, control page, remote)
//     continues from the saved position.
// An explicitly emptied queue (every phone disconnected) is saved as nothing
// to resume, so a deliberate stop stays stopped.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { Constants } = createRequire(import.meta.url)('yt-cast-receiver');
const S = Constants.PLAYER_STATUSES;

const SAVE_EVERY_MS = 5000;
const RESUME_WINDOW_MS = 5 * 60 * 1000;

export async function restoreAndKeepSaving(player, file, logger) {
  await restore(player, file, logger);
  let lastJson = null;
  setInterval(() => {
    snapshot(player)
      .then((state) => {
        const json = JSON.stringify(state);
        // Positions move every save; skip identical "nothing" writes.
        if (json === lastJson && !state.current) return;
        lastJson = json;
        return writeFile(file, json);
      })
      .catch((error) => logger.warn(`[resume] save failed: ${error?.message || error}`));
  }, SAVE_EVERY_MS);
}

async function snapshot(player) {
  const state = await player.getState();
  const queue = state.queue;
  const current = queue?.current;
  if (!current) return { savedAt: Date.now(), current: null };
  return {
    savedAt: Date.now(),
    playing: state.status === S.PLAYING || state.status === S.LOADING,
    position: state.position || 0,
    listId: queue.id,
    videoIds: queue.videoIds,
    current: { id: current.id, client: current.client?.key, context: current.context || {} }
  };
}

async function restore(player, file, logger) {
  let saved;
  try {
    saved = JSON.parse(await readFile(file, 'utf8'));
  }
  catch {
    return; // first run
  }
  if (!saved?.current?.id || !saved.listId) {
    logger.info('[resume] nothing to resume');
    return;
  }
  const client = Constants.CLIENTS[saved.current.client] || Constants.CLIENTS.YTMUSIC;
  const ctx = saved.current.context;
  const index = ctx.index ?? saved.videoIds.indexOf(saved.current.id);
  // Rebuild the queue the way a phone's setPlaylist would.
  const payload = {
    listId: saved.listId,
    videoIds: saved.videoIds.join(','),
    currentIndex: String(index),
    videoId: saved.current.id
  };
  if (ctx.ctt) payload.ctt = ctx.ctt;
  if (ctx.params) payload.params = ctx.params;
  if (ctx.playerParams) payload.playerParams = ctx.playerParams;
  await player.queue.updateByMessage({ name: 'setPlaylist', payload }, client);
  const position = Math.floor(saved.position || 0);
  const age = Date.now() - saved.savedAt;
  const minutes = Math.round(age / 60000);
  // MpvPlayer.doPlay uses this once for the restored track if asked to start
  // it from 0 (which is what a plain "play" does).
  player.ytcrResumeAt = { id: saved.current.id, position };
  if (saved.playing && age < RESUME_WINDOW_MS) {
    logger.info(`[resume] carrying on with ${saved.current.id} at ${position}s (stopped ${Math.round(age / 1000)}s ago)`);
    await player.play(player.queue.current, position);
  }
  else {
    logger.info(`[resume] queue restored paused at ${saved.current.id} ${position}s (${saved.playing ? `stopped ${minutes} min ago` : 'was paused'}); press play to continue`);
  }
}
