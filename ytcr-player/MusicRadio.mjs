// End-of-queue suggestions from YouTube Music's radio instead of YouTube's TV
// autoplay. The TV pick drifted into non-music videos after a couple of
// tracks (podcast clips, "Best of ... Live" compilations; soak test
// 2026-10-15). Instead, when the queue runs out, play on through the radio
// mix of the last queued track (playlist RDAMVM<videoId>), in order, the way
// the app's own radio does. Only used at the end of the queue (and needs
// YTCR_FORCE_AUTOPLAY, see patch-ytcr.cjs); inside the queue nothing changes.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// Not in the package's "exports", so load it by file path from the package root.
const main = require.resolve('yt-cast-receiver');
const root = main.slice(0, main.lastIndexOf('yt-cast-receiver') + 'yt-cast-receiver'.length);
const Handler = require(join(root, 'dist/lib/app/DefaultPlaylistRequestHandler.js')).default;

// Skip radio entries played this recently (the radio repeats now and then).
const RECENT = 50;
// How far down the radio list to look for something not played recently.
const MAX_TRIES = 5;

export function useMusicRadio(logger) {
  const original = Handler.prototype.getPreviousNextVideos;
  const recent = [];
  const remember = (id) => {
    recent.push(id);
    if (recent.length > RECENT) recent.shift();
  };

  Handler.prototype.getPreviousNextVideos = async function (target, playlist) {
    remember(target.id);
    // A radio track carries its place in the radio; anything else starts a
    // radio from itself, but only when it's the last thing in the queue.
    let radio = target.context?.ytcrRadio;
    if (!radio) {
      const result = await original.call(this, target, playlist);
      const index = target.context?.index;
      const atEnd = index === undefined || index < 0 || index >= playlist.length - 1;
      if (!atEnd) return result;
      radio = { playlistId: `RDAMVM${target.id}`, index: 0 };
      const next = await radioNext.call(this, target, playlist, radio);
      return { previous: result.previous, next: next || result.next };
    }
    const next = await radioNext.call(this, target, playlist, radio);
    return { previous: null, next };
  };

  async function radioNext(target, playlist, radio) {
    let position = { ...radio };
    let from = target;
    for (let i = 0; i < MAX_TRIES; i++) {
      let result;
      try {
        const context = { playlistId: position.playlistId, index: position.index };
        if (from.context?.ctt) context.ctt = from.context.ctt;
        result = await original.call(this, { id: from.id, client: from.client || target.client, context }, playlist);
      }
      catch (error) {
        logger.warn(`[radio] lookup failed: ${error?.message || error}`);
        return null;
      }
      const next = result.next;
      if (!next?.id) return null;
      const nextRadio = { playlistId: position.playlistId, index: next.context?.index ?? position.index + 1 };
      if (!recent.includes(next.id)) {
        logger.info(`[radio] up next from ${position.playlistId.slice(0, 18)} #${nextRadio.index}: ${next.id}`);
        // No playlistId/index: the receiver gives it a queue position of its
        // own when it starts (patch-ytcr.cjs); ytcrRadio keeps our place.
        const context = { ytcrRadio: nextRadio };
        if (next.context?.ctt) context.ctt = next.context.ctt;
        return { id: next.id, client: next.client || target.client, context };
      }
      // Played recently: step past it and ask for the one after.
      position = nextRadio;
      from = next;
    }
    return null;
  }
}
