FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
ENV NODE_ENV=production RADGOTCHI_MONITORING_MODE=1 RADGOTCHI_MONITORING_HOST=0.0.0.0 RADGOTCHI_MONITORING_PORT=3000
COPY headless.js monitoring.html LICENSE README.md login.html ./
COPY src/main/monitoring-server.js src/main/dappnode-public-packages.js src/main/companion-game-core.js src/main/companion-store.js ./src/main/
COPY src/web/monitoring-panel.js src/web/companion-interactions.js src/web/companion-activities.js src/web/companion-bootstrap.js src/web/companion-transport.js src/web/companion-arcade.js src/web/companion-audio.js src/web/companion-audio-bootstrap.js ./src/web/
COPY src/styles/monitoring.css src/styles/chat-window.css src/styles/monitoring-login.css src/styles/companion-interactions.css src/styles/companion-activities.css src/styles/companion-arcade.css ./src/styles/
COPY assets/gotchi/AWAKE.png assets/gotchi/BROKEN.png assets/gotchi/MOTIVATED.png assets/gotchi/BORED.png assets/gotchi/COOL.png assets/gotchi/UPLOAD.png assets/gotchi/LONELY.png assets/gotchi/ANGRY.png ./assets/gotchi/
COPY assets/radbro.png ./assets/
COPY packaging/entrypoint.cjs ./packaging/
RUN mkdir -p /data/companion && chown -R 1000:1000 /data && chmod 0700 /data/companion
ENV RADGOTCHI_COMPANION_DIR=/data/companion
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["node", "/app/packaging/entrypoint.cjs"]
