#!/usr/bin/env bash
# Roda dentro do cage: espera o daemon subir e abre o Chromium em modo kiosk.
set -euo pipefail

URL="http://127.0.0.1:${PLAYZIN_PORT:-7777}/"

for _ in $(seq 1 60); do
  if curl -fsS "${URL}api/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

CHROMIUM="$(command -v chromium || command -v chromium-browser)"

exec "$CHROMIUM" \
  --kiosk \
  --ozone-platform=wayland \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-session-crashed-bubble \
  --disable-features=Translate,MediaRouter \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --ignore-gpu-blocklist \
  --enable-gpu-rasterization \
  --user-data-dir="$HOME/.config/playzin-chromium" \
  "$URL"
