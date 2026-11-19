#!/usr/bin/env bash
# Transforma um Raspberry Pi OS Lite (64-bit) recém-instalado num Playzin.
#
# Uso (no Pi, a partir da pasta do projeto):
#   sudo ./scripts/pi/setup.sh
#   sudo ./scripts/pi/setup.sh --sem-xpadneo   # pula o driver de controles de Xbox
#
# Pode rodar de novo quando atualizar o código: ele recopia, recompila e reinicia.
set -euo pipefail

INSTALL_XPADNEO=1
for arg in "$@"; do
  case "$arg" in
    --sem-xpadneo | --no-xpadneo) INSTALL_XPADNEO=0 ;;
    -h | --help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "Opção desconhecida: $arg" >&2
      exit 1
      ;;
  esac
done

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
  cage curl ca-certificates rsync udisks2 bluez network-manager \
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

step "Permissões: montar pendrives e escolher o Wi-Fi (polkit)"
install -m 644 "$APP_DIR/scripts/pi/files/50-playzin-udisks.rules" /etc/polkit-1/rules.d/50-playzin-udisks.rules
install -m 644 "$APP_DIR/scripts/pi/files/50-playzin-network.rules" /etc/polkit-1/rules.d/50-playzin-network.rules

step "Bluetooth (permissão para o console parear controles)"
install -m 644 "$APP_DIR/scripts/pi/files/playzin-bluetooth.conf" /etc/dbus-1/system.d/playzin-bluetooth.conf
rfkill unblock bluetooth 2>/dev/null || true

# ---------------------------------------------------------------------------
# xpadneo: driver para controles de Xbox por Bluetooth (mapeamento certo dos botões
# e vibração). Não interfere em outros controles. É compilado no próprio Pi via DKMS,
# que recompila sozinho quando o kernel é atualizado. Se falhar, o console segue
# funcionando: o controle de Xbox só fica com o driver genérico.
# ---------------------------------------------------------------------------
install_kernel_headers() {
  local release flavor
  release="$(uname -r)"
  # 1) pacote exato do kernel em uso; 2) metapacote do modelo (rpi-v8, rpi-2712...);
  # 3) nome antigo do Raspberry Pi OS (até o bullseye).
  if apt-get install -y --no-install-recommends "linux-headers-$release"; then return 0; fi
  flavor="$(echo "$release" | sed -n 's/.*\(rpi-[a-z0-9]*\)$/\1/p')"
  if [[ -n "$flavor" ]] && apt-get install -y --no-install-recommends "linux-headers-$flavor"; then return 0; fi
  apt-get install -y --no-install-recommends raspberrypi-kernel-headers
}

install_xpadneo() {
  local dir=/opt/xpadneo
  apt-get install -y --no-install-recommends dkms git || return 1
  install_kernel_headers || return 1
  if [[ ! -d "/lib/modules/$(uname -r)/build" ]]; then
    echo "Os cabeçalhos instalados não batem com o kernel em uso ($(uname -r))."
    echo "Isso costuma acontecer logo depois de uma atualização do kernel: reinicie e rode o setup de novo."
    return 1
  fi
  if [[ -d "$dir/.git" ]]; then
    git -C "$dir" pull --ff-only || return 1
  else
    rm -rf "$dir"
    git clone --depth 1 https://github.com/atar-axis/xpadneo.git "$dir" || return 1
  fi
  if dkms status 2>/dev/null | grep -q hid-xpadneo; then
    (cd "$dir" && ./update.sh) || return 1
  else
    (cd "$dir" && ./install.sh) || return 1
  fi
}

if [[ "$INSTALL_XPADNEO" == 1 ]]; then
  step "Driver xpadneo para controles de Xbox (compila no Pi, pode levar alguns minutos)"
  if install_xpadneo; then
    echo "xpadneo instalado."
  else
    echo -e "\033[1;31m!! Não consegui instalar o xpadneo.\033[0m O console funciona normalmente;"
    echo "   controles de Xbox ficam com o driver genérico (botões podem vir trocados, sem vibração)."
    echo "   Para tentar de novo depois: sudo ./scripts/pi/setup.sh"
  fi
fi

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
