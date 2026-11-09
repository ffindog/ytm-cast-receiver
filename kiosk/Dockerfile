# Optional screen: Cog (WPE WebKit) full-screen, drawing straight to DRM - no
# compositor, seat or login session needed. (cage/wlroots was tried first and
# cannot start without a seat in a container: "Timeout waiting session to
# become active".) Shows the now-playing page from ytcr.
# GStreamer plugins: WebKit plays the page's music videos through them
# (h264 via libav, VP9 via vpx; decoded on the CPU).
# debian:bookworm (not -slim) so apt only adds packages - see README.
FROM debian:bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends cog libgl1-mesa-dri libegl-mesa0 libgles2 \
       fonts-dejavu-core ca-certificates curl tini \
       gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
       gstreamer1.0-libav gstreamer1.0-gl \
    && rm -rf /var/lib/apt/lists/*
COPY kiosk.sh /usr/local/bin/kiosk.sh
RUN chmod 755 /usr/local/bin/kiosk.sh
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kiosk.sh"]
