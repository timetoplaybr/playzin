#!/bin/bash
# Roda antes de cada início do daemon (ExecStartPre do playzin-daemon.service).
#
# Logo depois de uma atualização, /var/lib/playzin/update/pending guarda qual era a versão
# anterior. O daemon novo apaga esse arquivo quando a TV abre e conecta (a versão funcionou).
# Se o daemon novo não consegue nem subir, o systemd tenta de novo; na 4ª tentativa, este
# script volta o link /opt/playzin/current para a versão anterior e avisa (arquivo failed).
#
# Fica fora das versões (em /opt/playzin) de propósito: uma versão quebrada não quebra a volta.
STATE=/var/lib/playzin/update
ROOT=/opt/playzin
MAX_TRIES=3

[ -f "$STATE/pending" ] || exit 0
previous="$(tr -d '[:space:]' < "$STATE/pending")"
tries=$(( $(cat "$STATE/attempts" 2>/dev/null || echo 0) + 1 ))
echo "$tries" > "$STATE/attempts"
[ "$tries" -le "$MAX_TRIES" ] && exit 0

if [ -n "$previous" ] && [ -d "$ROOT/releases/$previous" ]; then
  broken="$(basename "$(readlink -f "$ROOT/current")")"
  ln -sfn "releases/$previous" "$ROOT/current.rollback"
  mv -Tf "$ROOT/current.rollback" "$ROOT/current"
  printf '{"from":"%s","to":"%s"}\n' "$broken" "$previous" > "$STATE/failed"
  echo "playzin: a versão $broken não subiu depois de $MAX_TRIES tentativas; voltei para $previous" >&2
fi
rm -f "$STATE/pending" "$STATE/attempts" "$STATE/last-update"
exit 0
