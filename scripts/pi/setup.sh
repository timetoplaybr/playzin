#!/usr/bin/env bash
# Transforma um Raspberry Pi OS Lite (64-bit) recém-instalado num Playzin.
#
# Uso (no Pi, a partir da pasta do projeto):
#   sudo ./scripts/pi/setup.sh
#
# Pode rodar de novo quando atualizar o código: ele recopia, recompila e reinicia.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Rode com sudo: sudo $0" >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR=/opt/playzin
APP_USER=playzin
NODE_MAJOR=22

step() { echo -e "\n\033[1;33m==> $*\033[0m"; }

step "Pacotes do sistema (cage, Chromium, UDisks2, Bluetooth)"
apt-get update
apt-get install -y --no-install-recommends \
  cage curl ca-certificates rsync udisks2 bluez \
  fonts-dejavu-core
apt-get install -y --no-install-recommends polkitd || apt-get install -y --no-install-recommends policykit-1
# O nome do pacote do Chromium mudou entre versões do Raspberry Pi OS.
apt-get install -y --no-install-recommends chromium || apt-get install -y --no-install-recommends chromium-browser

step "Node.js $NODE_MAJOR"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v

step "Usuário $APP_USER"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$APP_USER"
fi
for group in video render input audio plugdev bluetooth; do
  getent group "$group" >/dev/null && usermod -aG "$group" "$APP_USER"
done

step "Código em $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude 'dev-slot/*' --exclude .git \
  "$SRC_DIR/" "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod +x "$APP_DIR/scripts/pi/kiosk.sh"

step "Dependências e build (pode levar alguns minutos no Pi)"
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm install --no-audit --no-fund && npm run build"

step "Permissão para montar pendrives (polkit)"
install -m 644 "$APP_DIR/scripts/pi/files/50-playzin-udisks.rules" /etc/polkit-1/rules.d/50-playzin-udisks.rules

step "Serviços systemd"
install -m 644 "$APP_DIR/scripts/pi/files/playzin-kiosk.pam" /etc/pam.d/playzin-kiosk
install -m 644 "$APP_DIR/scripts/pi/files/playzin-daemon.service" /etc/systemd/system/playzin-daemon.service
install -m 644 "$APP_DIR/scripts/pi/files/playzin-kiosk.service" /etc/systemd/system/playzin-kiosk.service
systemctl daemon-reload
systemctl enable udisks2.service bluetooth.service playzin-daemon.service playzin-kiosk.service
systemctl set-default graphical.target
systemctl restart playzin-daemon.service

step "Pronto!"
cat <<EOF
O Playzin vai abrir sozinho na TV no próximo boot:
  sudo reboot

Comandos úteis:
  journalctl -u playzin-daemon -f     # logs do daemon (cartuchos)
  journalctl -u playzin-kiosk -f      # logs do Chromium/cage
  sudo systemctl restart playzin-kiosk

Opcional, depois de parear os controles: deixar o sistema somente leitura
(aguenta ser desligado da tomada):
  sudo raspi-config  →  Performance Options  →  Overlay File System
EOF
