# Optional screen: Cog (WPE WebKit) full-screen, drawing straight to DRM - no
# compositor, seat or login session needed. (cage/wlroots was tried first and
# cannot start without a seat in a container: "Timeout waiting session to
# become active".) Shows the now-playing page from ytcr.
# debian:bookworm (not -slim) so apt only adds packages - see README.
FROM debian:bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends cog libgl1-mesa-dri libegl-mesa0 libgles2 \
       fonts-dejavu-core ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*
COPY kiosk.sh /usr/local/bin/kiosk.sh
RUN chmod 755 /usr/local/bin/kiosk.sh
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kiosk.sh"]
