// Control API: lets a browser page or a hardware remote drive the player the
// same way the phone does. LAN only, no login (open to the network by design).
//
//   POST /api/control/play-pause | play | pause | next | previous
//   POST /api/control/seek?position=seconds
//   POST /api/control/volume?level=0..100   or   ?step=+5 / -5
//   POST /api/control/mute?on=1 | 0 | toggle   (default toggle)
//
// Replies with the now-playing JSON (plus "ok"). Commands go through the
// library's own Player methods, so the phone app and the screen update too.
import { createRequire } from 'node:module';

const { Constants } = createRequire(import.meta.url)('yt-cast-receiver');
const S = Constants.PLAYER_STATUSES;

// The library ignores next/previous while it is looking up the neighbouring
// tracks (1-3 s after a track starts); wait that out rather than drop the press.
const QUEUE_WAIT_MS = 8000;

async function queueSettled(player) {
  for (let waited = 0; player.queue.isUpdating && waited < QUEUE_WAIT_MS; waited += 200) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

export const ACTIONS = {
  async 'play-pause'(player) {
    return player.status === S.PLAYING ? player.pause() : player.resume();
  },
  async play(player) {
    return player.resume();
  },
  async pause(player) {
    return player.pause();
  },
  async next(player) {
    await queueSettled(player);
    return player.next();
  },
  async previous(player) {
    await queueSettled(player);
    return player.previous();
  },
  // Jump within the current song (the control page's draggable progress bar).
  // Like the phone's seek, it plays from there even if paused (library behaviour).
  async seek(player, params) {
    const position = Number(params.get('position'));
    if (!Number.isFinite(position) || position < 0) throw new ControlError('seek needs ?position=seconds');
    return player.seek(Math.floor(position));
  },
  async volume(player, params) {
    const current = await player.getVolume();
    let level;
    if (params.has('level')) level = Number(params.get('level'));
    else if (params.has('step')) level = current.level + Number(params.get('step'));
    if (!Number.isFinite(level)) throw new ControlError('volume needs ?level=0..100 or ?step=N');
    await player.setVolume({ level: clamp(level), muted: false });
    return true;
  },
  async mute(player, params) {
    const current = await player.getVolume();
    const on = params.get('on') ?? 'toggle';
    const muted = on === 'toggle' ? !current.muted : on === '1' || on === 'true';
    // With senders that can't mute (YouTube Music on iOS) the library mutes by
    // dropping the level to 0, so remember the level to come back to.
    if (muted && current.level > 0) levelBeforeMute = current.level;
    const level = !muted && current.level === 0 ? levelBeforeMute : current.level;
    await player.setVolume({ level, muted });
    return true;
  }
};

let levelBeforeMute = 50;

export class ControlError extends Error {}

export async function control(player, action, params) {
  const fn = ACTIONS[action];
  if (!fn) throw new ControlError(`unknown action "${action}"; try ${Object.keys(ACTIONS).join(', ')}`);
  return !!(await fn(player, params));
}
