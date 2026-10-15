// Resolves a cast video to a playable audio stream URL.
//
// Ported from volumio-ytcr src/lib/VideoLoader.ts (MIT, patrickkfkan, commit
// 7a315b3), minus Volumio config/i18n and live-stream quality selection. The
// key part is the `ctt` handling: the phone sends a credential transfer token
// with each video, and putting it in the Innertube session context makes
// YouTube serve the stream as the phone's signed-in account. That is what
// lets age-restricted tracks play without any cookies on this machine.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InnertubeFactory } = require('volumio-yt-support');
const InnertubeLib = require('volumio-yt-support/dist/innertube.js');

const BEST_AUDIO_FORMAT = { type: 'audio', format: 'any', quality: 'best' };

function largestThumbnail(thumbnails) {
  const best = [ ...(thumbnails || []) ].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  let url = best?.url;
  if (!url) return null;
  if (url.startsWith('//')) url = `https:${url}`;
  // YouTube Music art comes as ...=w544-h544-...; Google's image server will
  // render any size, so ask for one that stays sharp on a 1080p screen.
  return url.replace(/=w\d+-h\d+/, '=w1200-h1200');
}

const ITAG_TO_BITRATE = {
  139: '48', 140: '128', 141: '256', 171: '128',
  249: 'VBR 50', 250: 'VBR 70', 251: 'VBR 160', 774: 'VBR 256'
};

export default class VideoLoader {
  #logger;
  #wrapperPromise = null;
  #lock = Promise.resolve();

  constructor(logger, { region = 'AU', language = 'en' } = {}) {
    this.#logger = logger;
    this.locale = { region, language };
  }

  #wrapper() {
    if (!this.#wrapperPromise) {
      this.#wrapperPromise = InnertubeFactory.getWrappedInstance({
        locale: this.locale,
        logger: {
          info: (msg) => this.#logger.info(`[loader] ${msg}`),
          warn: (msg) => this.#logger.warn(`[loader] ${msg}`),
          error: (msg) => this.#logger.error(`[loader] ${msg}`)
        }
      });
    }
    return this.#wrapperPromise;
  }

  async #innertube() {
    return (await this.#wrapper()).getInnertube();
  }

  async dispose() {
    if (this.#wrapperPromise) {
      const wrapper = await this.#wrapperPromise;
      await wrapper.dispose();
      this.#wrapperPromise = null;
    }
  }

  // One lookup at a time: getInfo puts the track's sign-in token (ctt) on the
  // shared session, so an up-next lookup must never run in the middle of one.
  #exclusive(fn) {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.catch(() => {});
    return run;
  }

  getInfo(video, abortSignal) {
    return this.#exclusive(() => this.#getInfo(video, abortSignal));
  }

  // Title, artist and art only (for "up next" and preloading the artwork):
  // one /player request, no stream lookup, and the session is left alone.
  getDetails(video) {
    return this.#exclusive(async () => {
      const innertube = await this.#innertube();
      const response = await innertube.actions.execute('/player', {
        videoId: video.id, racyCheckOk: true, contentCheckOk: true, client: 'YTMUSIC'
      });
      const d = response.data?.videoDetails;
      if (!d) return null;
      return {
        id: video.id,
        title: d.title || '',
        artist: (d.author || '').replace(/ - Topic$/, ''),
        thumbnail: largestThumbnail(d.thumbnail?.thumbnails)
      };
    });
  }

  async #getInfo(video, abortSignal) {
    const innertube = await this.#innertube();
    const checkAbort = () => {
      if (abortSignal?.aborted) {
        const error = new Error(`getInfo aborted for ${video.id}`);
        error.name = 'AbortError';
        throw error;
      }
    };

    let contentPoToken;
    try {
      contentPoToken = (await (await this.#wrapper()).generatePoToken(video.id)).poToken;
    }
    catch (error) {
      this.#logger.error(`[loader] PO token for ${video.id} failed: ${error?.message || error}`);
    }
    checkAbort();

    const payload = {
      videoId: video.id,
      racyCheckOk: true,
      contentCheckOk: true,
      serviceIntegrityDimensions: { poToken: contentPoToken },
      enableMdxAutoplay: true,
      isMdxPlayback: true,
      playbackContext: {
        contentPlaybackContext: {
          vis: 0,
          splay: false,
          lactMilliseconds: '-1',
          signatureTimestamp: innertube.session.player?.signature_timestamp || 0
        }
      }
    };
    if (video.context?.playlistId) payload.playlistId = video.context.playlistId;
    if (video.context?.params) payload.params = video.context.params;
    if (video.context?.index !== undefined) payload.index = video.context.index;

    // The phone's credential transfer token: plays as the phone's account.
    if (video.context?.ctt) {
      innertube.session.context.user = {
        enableSafetyMode: false,
        lockedSafetyMode: false,
        credentialTransferTokens: [ { scope: 'VIDEO', token: video.context.ctt } ]
      };
    }
    else {
      delete innertube.session.context.user?.credentialTransferTokens;
    }
    const hasCtt = !!video.context?.ctt;

    const cpn = InnertubeLib.Utils.generateRandomString(16);
    try {
      const next = await innertube.actions.execute('/next', { ...payload, client: 'TV' });
      checkAbort();
      const section = next.data?.contents?.singleColumnWatchNextResults?.results?.results
        ?.contents?.[0]?.itemSectionRenderer?.contents?.[0];
      const text = (value) => new InnertubeLib.Misc.Text(value).toString();
      let basic = null;
      if (section?.videoMetadataRenderer) {
        const m = section.videoMetadataRenderer;
        basic = {
          id: video.id, src: 'yt', title: text(m.title),
          artist: text(m.owner?.videoOwnerRenderer?.title),
          isLive: !!m.viewCount?.videoViewCountRenderer?.isLive
        };
      }
      else if (section?.musicWatchMetadataRenderer) {
        const m = section.musicWatchMetadataRenderer;
        basic = {
          id: video.id, src: 'ytmusic', title: text(m.title),
          artist: text(m.byline), album: m.albumName ? text(m.albumName) : ''
        };
      }
      if (!basic) {
        throw new Error('metadata not found in /next response');
      }

      // YTMUSIC client for music, ANDROID_VR for ordinary videos, WEB for live.
      payload.client = basic.src === 'ytmusic' ? 'YTMUSIC' : (basic.isLive ? 'WEB' : 'ANDROID_VR');
      let info = await this.#player(payload, cpn);
      checkAbort();
      let { stream, validated, errMsg } = await this.#stream(info, basic, contentPoToken, abortSignal, checkAbort);
      if (stream?.url && !validated && basic.src === 'ytmusic') {
        this.#logger.info(`[loader] (${basic.title}) YTMUSIC stream did not validate; retrying with TV client`);
        payload.client = 'TV';
        info = await this.#player(payload, cpn);
        checkAbort();
        ({ stream, validated, errMsg } = await this.#stream(info, basic, contentPoToken, abortSignal, checkAbort));
      }
      // Video for anything that is not a plain audio track: YouTube Music's
      // music videos (the app's Song/Video switch sends their id) and any
      // ordinary YouTube video. Songs (MUSIC_VIDEO_TYPE_ATV) stay audio-only.
      const musicVideoType = info.musicVideoType || null;
      const wantVideo = !!stream?.url && !basic.isLive
        && (basic.src === 'yt' || (musicVideoType && musicVideoType !== 'MUSIC_VIDEO_TYPE_ATV'));
      let videoStream = null;
      if (wantVideo) {
        videoStream = await this.#videoStream(info, basic, contentPoToken, abortSignal, checkAbort);
      }
      this.#logger.info(`[loader] ${video.id} "${basic.title}" ctt=${hasCtt ? 'yes' : 'no'} `
        + `playability=${info.playability_status?.status} stream=${stream?.url ? 'yes' : 'no'}`
        + `${stream?.bitrate ? ` (${stream.bitrate})` : ''} type=${musicVideoType || basic.src}`
        + `${wantVideo ? ` video=${videoStream ? videoStream.label : 'none'}` : ''}`
        + `${errMsg ? ` error="${errMsg}"` : ''}`);
      return {
        ...basic,
        errMsg: errMsg || undefined,
        musicVideoType,
        videoUrl: videoStream?.url || null,
        videoLabel: videoStream?.label || null,
        streamUrl: stream?.url || null,
        duration: info.basic_info.duration || 0,
        thumbnail: largestThumbnail(info.basic_info.thumbnail)
      };
    }
    catch (error) {
      if (error?.name === 'AbortError') throw error;
      this.#logger.error(`[loader] ${video.id} failed: ${error?.message || error}`);
      return { id: video.id, errMsg: error?.message || 'unknown error', streamUrl: null };
    }
  }

  async #player(payload, cpn) {
    const innertube = await this.#innertube();
    const response = await innertube.actions.execute('/player', payload);
    const info = new InnertubeLib.YT.VideoInfo([ response ], innertube.actions, cpn);
    info.musicVideoType = response.data?.videoDetails?.musicVideoType;
    return info;
  }

  // Best video-only stream up to 1080p, H.264 first (cheapest to decode in
  // software), then VP9. Played by mpv alongside the audio stream.
  async #videoStream(info, basic, contentPoToken, abortSignal, checkAbort) {
    const innertube = await this.#innertube();
    const codecRank = (mime) => (/avc1/.test(mime) ? 0 : /vp0?9/.test(mime) ? 1 : 9);
    const candidates = (info.streaming_data?.adaptive_formats || [])
      .filter((f) => f.has_video && !f.has_audio && (f.height || 0) <= 1080 && (f.fps || 0) <= 60
        && codecRank(f.mime_type || '') < 9)
      .sort((a, b) => (b.height - a.height) || (codecRank(a.mime_type) - codecRank(b.mime_type))
        || ((b.bitrate || 0) - (a.bitrate || 0)));
    for (const format of candidates.slice(0, 3)) {
      checkAbort();
      let url;
      try {
        url = await format.decipher(innertube.session.player);
      }
      catch {
        continue;
      }
      if (!url) continue;
      // Like the audio: the YTMUSIC client's streams answer 403 without the
      // content-bound PO token. HEAD is refused for some clients' video
      // streams, so check with a small ranged GET instead.
      const withPot = new URL(url);
      if (contentPoToken) withPot.searchParams.set('pot', contentPoToken);
      for (const candidate of [ withPot.toString(), url ]) {
        const res = await fetch(candidate, { headers: { Range: 'bytes=0-1023' }, signal: abortSignal });
        if (res.ok) {
          const codec = /avc1/.test(format.mime_type) ? 'h264' : 'vp9';
          return { url: candidate, label: `${format.height}p${format.fps} ${codec}` };
        }
      }
      this.#logger.warn(`[loader] (${basic.title}) ${format.height}p video stream refused; trying next`);
    }
    return null;
  }

  async #stream(info, basic, contentPoToken, abortSignal, checkAbort, retries = 3) {
    let stream = null;
    let errMsg = null;
    if (info.playability_status?.status === 'UNPLAYABLE' && !info.has_trailer) {
      errMsg = info.playability_status.reason;
    }
    else if (basic.isLive) {
      stream = info.streaming_data?.hls_manifest_url ? { url: info.streaming_data.hls_manifest_url } : null;
    }
    else {
      stream = await this.#chooseFormat(info.playability_status?.status === 'UNPLAYABLE'
        ? info.getTrailerInfo() : info);
    }
    if (!stream?.url && !errMsg) {
      errMsg = info.playability_status?.reason || 'no audio stream found';
    }
    checkAbort();

    let validated = false;
    if (stream?.url) {
      if (!basic.isLive && contentPoToken) {
        // YouTube wants the content-bound PO token in `pot`, or it answers 403.
        const url = new URL(stream.url);
        url.searchParams.set('pot', contentPoToken);
        stream.url = url.toString();
      }
      for (let attempt = 0; attempt <= retries; attempt++) {
        checkAbort();
        const res = await fetch(stream.url, { method: 'HEAD', signal: abortSignal });
        if (res.ok) {
          validated = true;
          break;
        }
        this.#logger.warn(`[loader] (${basic.title}) stream check ${res.status}; retry in 2s`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    return { stream, validated, errMsg };
  }

  async #chooseFormat(info) {
    if (!info) return null;
    const innertube = await this.#innertube();
    let format;
    try {
      format = info.chooseFormat(BEST_AUDIO_FORMAT);
    }
    catch {
      return null;
    }
    const url = await format.decipher(innertube.session.player);
    const bitrate = ITAG_TO_BITRATE[format.itag];
    return { url, bitrate: bitrate ? `${bitrate} kbps` : null };
  }
}
