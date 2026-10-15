# Workshop YouTube Music receiver (yt-cast-receiver + mpv). See README.
FROM node:20-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends mpv tini ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error \
    && npm ls yt-cast-receiver volumio-yt-support
# How the screen describes itself when pairing with YouTube. The library
# hard-codes capabilities 'dsp,mic,dpa,ntb' and cst 'm'. Made overridable
# (YTCR_CAPABILITIES / YTCR_CST; empty CST = leave out) while chasing the
# Song/Video switch - a YouTube Music bug, see README. Defaults are what we run.
RUN f=node_modules/yt-cast-receiver/dist/lib/app/BindParams.js \
    && grep -q "this.capabilities = 'dsp,mic,dpa,ntb';" $f && grep -q "this.cst = 'm';" $f \
    && sed -i -e "s/this.capabilities = 'dsp,mic,dpa,ntb';/this.capabilities = process.env.YTCR_CAPABILITIES ?? 'dsp,mic,dpa,ntb';/" \
              -e "s/this.cst = 'm';/this.cst = process.env.YTCR_CST === undefined ? 'm' : (process.env.YTCR_CST || undefined);/" $f \
    && grep -c "process.env.YTCR_C" $f | grep -qx 2
# Song/Video switch fixes (see patch-ytcr.cjs).
COPY patch-ytcr.cjs ./
RUN node patch-ytcr.cjs
COPY *.mjs *.html ./
# uid 1000; /dev/snd is passed in world-writable by the CT config.
USER node
ENV YTCR_DATA_DIR=/data
ENTRYPOINT ["/usr/bin/tini", "--", "node", "index.mjs"]
