// Build-time patches to yt-cast-receiver (run once by the Dockerfile).
// Each replacement must match exactly once or the build fails, so a library
// update cannot silently drop a patch.
const fs = require('node:fs');

const LIB = 'node_modules/yt-cast-receiver/dist/lib';

function patch(file, from, to) {
  const path = `${LIB}/${file}`;
  const src = fs.readFileSync(path, 'utf8');
  const count = src.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: expected 1 match, found ${count}: ${from.slice(0, 80)}`);
  }
  fs.writeFileSync(path, src.replace(from, to));
  console.log(`patched ${file}`);
}

// Song <-> Video switch in YouTube Music swaps the video id at the same queue
// position. The library stopped playback first, so the phone saw "stopped"
// then "loading" - what a track change looks like - and replayed its last
// skip animation and dropped back to Song. Skip the stop for a same-position
// swap; doPlay() replaces the running stream itself.
patch('app/YouTubeApp.js',
  `                if (__classPrivateFieldGet(this, _YouTubeApp_player, "f").status !== Constants_js_1.PLAYER_STATUSES.STOPPED) {
                    await __classPrivateFieldGet(this, _YouTubeApp_player, "f").stop(AID);
                }
                const currentVideo = stateAfterSet.current;
                if (currentVideo) {
                    await __classPrivateFieldGet(this, _YouTubeApp_player, "f").play(currentVideo, parseInt(payload.currentTime, 10) || 0, AID);
                }`,
  `                const ytcrSwap = stateBeforeSet.current && stateAfterSet.current &&
                    stateBeforeSet.current.context?.playlistId === stateAfterSet.current.context?.playlistId &&
                    stateBeforeSet.current.context?.index === stateAfterSet.current.context?.index;
                if (!ytcrSwap && __classPrivateFieldGet(this, _YouTubeApp_player, "f").status !== Constants_js_1.PLAYER_STATUSES.STOPPED) {
                    await __classPrivateFieldGet(this, _YouTubeApp_player, "f").stop(AID);
                }
                const currentVideo = stateAfterSet.current;
                if (currentVideo) {
                    __classPrivateFieldGet(this, _YouTubeApp_player, "f").ytcrSwap = !!ytcrSwap;
                    await __classPrivateFieldGet(this, _YouTubeApp_player, "f").play(currentVideo, parseInt(payload.currentTime, 10) || 0, AID);
                }`);

patch('Player.js',
  `        if (this.status === Constants_js_1.PLAYER_STATUSES.PLAYING) {
            await this.stop();
        }
        __classPrivateFieldGet(this, _Player_logger, "f").info(\`[yt-cast-receiver] Player.play(): \${video.id} @ \${position || 0}s\`);`,
  `        const ytcrSwap = this.ytcrSwap;
        this.ytcrSwap = false;
        this.ytcrSwapping = !!ytcrSwap;
        if (this.status === Constants_js_1.PLAYER_STATUSES.PLAYING && !ytcrSwap) {
            await this.stop();
        }
        __classPrivateFieldGet(this, _Player_logger, "f").info(\`[yt-cast-receiver] Player.play(): \${video.id} @ \${position || 0}s\${ytcrSwap ? ' (swap, no stop)' : ''}\`);`);

// The library blanked previous/next while looking them up (1-3 s), so the
// phone was told "no previous, no next" mid-switch. Keep the old values until
// the lookup answers; clear them only when there is nothing to look up.
patch('app/Playlist.js',
  `    __classPrivateFieldSet(this, _Playlist_previous, null, "f");
    __classPrivateFieldSet(this, _Playlist_next, null, "f");
    const currentIndex = __classPrivateFieldGet(this, _Playlist_current, "f")?.context?.index !== undefined ? __classPrivateFieldGet(this, _Playlist_current, "f").context.index : -1;
    if (currentIndex >= 0) {`,
  `    const currentIndex = __classPrivateFieldGet(this, _Playlist_current, "f")?.context?.index !== undefined ? __classPrivateFieldGet(this, _Playlist_current, "f").context.index : -1;
    if (currentIndex < 0) {
        __classPrivateFieldSet(this, _Playlist_previous, null, "f");
        __classPrivateFieldSet(this, _Playlist_next, null, "f");
    }
    if (currentIndex >= 0) {`);

// Pairing description overrides, used while chasing the Song/Video switch
// (2026-10-14; it turned out to be a YouTube Music bug - an LG TV does the
// same). Unset = library defaults: os 'Windows' 10.0, no extra fields.
patch('app/BindParams.js',
  `    os: 'Windows',
    osVersion: '10.0',`,
  `    os: process.env.YTCR_DEVICE_OS || 'Windows',
    osVersion: process.env.YTCR_DEVICE_OS_VERSION || '10.0',`);

// Extra device-description fields as JSON (YTCR_DEVICE_INFO), e.g. the LG's
// dialAdditionalDataSupportLevel "full".
patch('app/BindParams.js',
  `            brand: options.brand,
            model: options.model
        };`,
  `            brand: options.brand,
            model: options.model,
            ...JSON.parse(process.env.YTCR_DEVICE_INFO || '{}')
        };`);

// A real TV's DIAL app reply carries <additionalData> (screenId, theme,
// deviceId, brand, model); the library sends none. Opt-in via
// YTCR_DIAL_ADDITIONAL_DATA=1 (index.mjs provides globalThis.ytcrDialAdditionalData).
patch('dial/DialServer.js',
  `        getApp: (appName) => {
            return apps[appName];
        },`,
  `        getApp: (appName) => {
            const app = apps[appName];
            if (app && typeof globalThis.ytcrDialAdditionalData === 'function') {
                app.additionalData = globalThis.ytcrDialAdditionalData() || undefined;
            }
            return app;
        },`);

// Keep playing at the end of the queue (2026-10-15). In YouTube Music
// the phone app tops up the queue itself, so with the phone locked or away the
// music stopped at the last track. The library's own autoplay (the TV's pick
// from /next) only switches on if every phone advertises 'atp', which YouTube
// Music doesn't. YTCR_FORCE_AUTOPLAY=1 treats every phone as supporting it.
patch('app/Sender.js',
  `        return this.capabilities.includes('atp');`,
  `        return this.capabilities.includes('atp') || process.env.YTCR_FORCE_AUTOPLAY === '1';`);

// ...and keep going: an autoplay pick has no queue position, so the library
// never looked up the one after it and stopped after a single extra track.
// Append it to the queue as the new last item and look up its successor.
patch('app/Playlist.js',
  `        if (this.autoplay?.id === video.id) {
            __classPrivateFieldSet(this, _Playlist_next, null, "f");
        }
        __classPrivateFieldSet(this, _Playlist_current, video, "f");`,
  `        const ytcrChain = this.autoplay?.id === video.id;
        if (ytcrChain) {
            __classPrivateFieldSet(this, _Playlist_next, null, "f");
            __classPrivateFieldGet(this, _Playlist_videoIds, "f").push(video.id);
            video = { ...video, context: { ...(video.context || {}), index: __classPrivateFieldGet(this, _Playlist_videoIds, "f").length - 1 } };
        }
        __classPrivateFieldSet(this, _Playlist_current, video, "f");
        if (ytcrChain) {
            __classPrivateFieldGet(this, _Playlist_logger, "f").info(\`[yt-cast-receiver] End of queue: playing suggestion \${video.id}\`);
            __classPrivateFieldGet(this, _Playlist_instances, "m", _Playlist_refreshPreviousNext).call(this)
                .catch((error) => __classPrivateFieldGet(this, _Playlist_logger, "f").error('[yt-cast-receiver] Next-suggestion lookup failed:', error));
        }`);

// The previous/next lookup takes 1-3 s and the phone heard nothing until it
// finished. For a Song/Video swap (same list, same position) the neighbours
// do not change, so answer straight away and look them up in the background.
patch('app/Playlist.js',
  `        const data = message.payload;
        if (!data.listId) {`,
  `        const data = message.payload;
        const ytcrBefore = __classPrivateFieldGet(this, _Playlist_current, "f")?.context;
        if (!data.listId) {`);

patch('app/Playlist.js',
  `        await __classPrivateFieldGet(this, _Playlist_instances, "m", _Playlist_refreshPreviousNext).call(this);
        let event = null;`,
  `        const ytcrAfter = __classPrivateFieldGet(this, _Playlist_current, "f")?.context;
        if (message.name === 'setPlaylist' && ytcrBefore && ytcrAfter &&
            ytcrBefore.playlistId === ytcrAfter.playlistId && ytcrBefore.index === ytcrAfter.index) {
            __classPrivateFieldGet(this, _Playlist_instances, "m", _Playlist_refreshPreviousNext).call(this)
                .catch((error) => __classPrivateFieldGet(this, _Playlist_logger, "f").error('[yt-cast-receiver] Background previous/next lookup failed:', error));
        }
        else {
            await __classPrivateFieldGet(this, _Playlist_instances, "m", _Playlist_refreshPreviousNext).call(this);
        }
        let event = null;`);

patch('app/Playlist.js',
  `        __classPrivateFieldSet(this, _Playlist_previous, nav?.previous || null, "f");
        if (!this.isLast`,
  `        __classPrivateFieldSet(this, _Playlist_previous, nav?.previous || null, "f");
        __classPrivateFieldSet(this, _Playlist_next, null, "f");
        if (!this.isLast`);
