#!/usr/bin/env bash
# Instalacja Krypto Radaru jako usługi systemd działającej na TWOIM koncie.
# Kod zostaje tam, gdzie go sklonowałeś (np. ~/krypto-radar), a ustawienia, dane i klucz GitHuba
# trafiają do ~/krypto-radar-dane (poza repozytorium, żeby token bota nigdy nie trafił na GitHuba).
#
# Uruchom ze swojego konta:   sudo bash ~/krypto-radar/deploy/install.sh
# Aktualizacja kodu później:   cd ~/krypto-radar && git pull && sudo systemctl restart krypto-radar
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"
SVC=krypto-radar

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mBłąd:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Uruchom przez sudo:  sudo bash $APP_DIR/deploy/install.sh"
RUN_USER="${SUDO_USER:-}"
[ -n "$RUN_USER" ] && [ "$RUN_USER" != root ] || die "Uruchom przez sudo ze swojego zwykłego konta (nie jako root)."
RUN_GROUP="$(id -gn "$RUN_USER")"
HOME_DIR="$(getent passwd "$RUN_USER" | cut -d: -f6)"
DATA_DIR="$HOME_DIR/krypto-radar-dane"
CFG="$DATA_DIR/config.json"
KEY="$DATA_DIR/deploy_key"
[ -f "$APP_DIR/server.js" ] || die "Nie widzę server.js w $APP_DIR."
command -v systemctl >/dev/null || die "Ten system nie używa systemd."
cd /

as_user() { runuser -u "$RUN_USER" -- "$@"; }
ask() { local a=""; if [ -t 0 ]; then read -r -p "$1" a || true; fi; printf '%s' "$a"; }

# --- Node.js i narzędzia -----------------------------------------------------------
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] || [ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  die "Potrzebny jest Node.js 18 lub nowszy:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
fi
for c in git ssh ssh-keygen runuser shuf; do
  command -v "$c" >/dev/null || die "Brakuje programu $c. Zainstaluj:  sudo apt-get install -y git openssh-client coreutils util-linux"
done
say "Konto: $RUN_USER, kod: $APP_DIR, dane: $DATA_DIR, Node.js $("$NODE_BIN" -v)"

cfg_get() { as_user "$NODE_BIN" "$APP_DIR/deploy/cfg.js" "$CFG" get "$1"; }
cfg_set() { as_user "$NODE_BIN" "$APP_DIR/deploy/cfg.js" "$CFG" set "$1"; }

install -d -m 0700 -o "$RUN_USER" -g "$RUN_GROUP" "$DATA_DIR" "$DATA_DIR/data"

# --- Sprzątanie po poprzedniej wersji (osobny użytkownik krypto-radar) ----------------
OLD=/var/lib/krypto-radar
if [ -d "$OLD" ] || [ -d /opt/krypto-radar ] || id krypto-radar >/dev/null 2>&1; then
  say "Usuwam poprzednią instalację (użytkownik krypto-radar, /opt/krypto-radar, /var/lib/krypto-radar)"
  systemctl stop "$SVC" 2>/dev/null || true
  if [ -d "$OLD" ]; then
    # Token bota, klucz GitHuba i historię alertów przenosimy – nie trzeba ich podawać od nowa.
    for f in config.json deploy_key deploy_key.pub known_hosts; do
      if [ -e "$OLD/$f" ] && [ ! -e "$DATA_DIR/$f" ]; then cp -p "$OLD/$f" "$DATA_DIR/$f"; fi
    done
    if [ -f "$OLD/data/state.json" ] && [ ! -f "$DATA_DIR/data/state.json" ]; then cp -p "$OLD/data/state.json" "$DATA_DIR/data/"; fi
    chown -R "$RUN_USER:$RUN_GROUP" "$DATA_DIR"
    rm -rf "$OLD"
  fi
  rm -rf /opt/krypto-radar
  if id krypto-radar >/dev/null 2>&1; then userdel krypto-radar 2>/dev/null || true; fi
  if getent group krypto-radar >/dev/null; then groupdel krypto-radar 2>/dev/null || true; fi
  echo "Przeniesione do $DATA_DIR: $(ls -A "$DATA_DIR" | tr '\n' ' ')"
fi

# --- Konfiguracja --------------------------------------------------------------------
if [ ! -f "$CFG" ]; then
  install -m 0600 -o "$RUN_USER" -g "$RUN_GROUP" "$APP_DIR/config.json" "$CFG"
  cfg_set "{\"host\":\"127.0.0.1\",\"port\":$PORT}"
  say "Utworzono konfigurację $CFG"
fi
chmod 600 "$CFG"
# Bez hasła panel lokalny jest dostępny tylko na samym Orange Pi; z zewnątrz jest strona na GitHub Pages.
[ -n "$(cfg_get auth.passwordHash)" ] || cfg_set '{"host":"127.0.0.1"}'

# --- Telegram ----------------------------------------------------------------------
PAIR_MSG=""
if [ -z "$(cfg_get telegram.token)" ]; then
  say "Telegram (Enter = pomiń, dodasz później)"
  echo "Załóż NOWEGO bota u @BotFather (/newbot) i wklej jego token."
  TG="$(ask 'Token bota: ' | tr -d '[:space:]')"
  if [ -n "$TG" ]; then
    if printf '%s' "$TG" | grep -Eq '^[0-9]{5,}:[A-Za-z0-9_-]{20,}$'; then
      CODE="$(shuf -i 100000-999999 -n 1)"
      cfg_set "{\"telegram\":{\"token\":\"$TG\",\"chatId\":\"\",\"pairCode\":\"$CODE\"}}"
      PAIR_MSG="Wyślij swojemu botowi na Telegramie wiadomość z kodem:  $CODE"
    else
      echo "To nie wygląda na token bota – pomijam."
    fi
  fi
elif [ -z "$(cfg_get telegram.chatId)" ] && [ -n "$(cfg_get telegram.pairCode)" ]; then
  PAIR_MSG="Telegram czeka na sparowanie – wyślij botowi kod:  $(cfg_get telegram.pairCode)"
fi

# --- GitHub ----------------------------------------------------------------------------
PAGES_MSG=""
REPO_SSH="$(cfg_get publish.repo)"
if [ -z "$REPO_SSH" ]; then
  say "Strona na GitHub Pages (Enter = pomiń)"
  REPO="$(ask 'Repozytorium (login/nazwa): ')"
  REPO="$(printf '%s' "$REPO" | sed -E 's#^(https://|git@)github\.com[:/]##; s#\.git$##; s#/$##' | tr -d '[:space:]')"
  if [ -n "$REPO" ]; then
    printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' || die "„$REPO” nie wygląda na login/nazwa."
    REPO_SSH="git@github.com:$REPO.git"
  fi
fi

if [ -n "$REPO_SSH" ]; then
  [ -f "$KEY" ] || as_user ssh-keygen -q -t ed25519 -N '' -C "krypto-radar@$(hostname)" -f "$KEY"
  GIT_SSH="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$DATA_DIR/known_hosts"
  TRIES=0
  until ERR="$(as_user env GIT_SSH_COMMAND="$GIT_SSH" git ls-remote "$REPO_SSH" 2>&1 >/dev/null)"; do
    TRIES=$((TRIES + 1))
    [ "$TRIES" -le 5 ] || die "Nadal brak dostępu do $REPO_SSH. Ostatnia odpowiedź: $ERR"
    printf '\nGitHub odpowiedział: %s\n' "$(printf '%s' "$ERR" | grep -v 'Permanently added' | tail -2)"
    say "Dodaj ten klucz: GitHub → repozytorium → Settings → Deploy keys → Add deploy key (zaznacz „Allow write access”)"
    cat "$KEY.pub"
    [ -t 0 ] || die "Dodaj klucz i uruchom instalator ponownie."
    ask 'Naciśnij Enter, gdy klucz będzie dodany (Ctrl+C przerywa)… ' >/dev/null
  done
  say "Dostęp do $REPO_SSH działa"

  if [ -z "$(as_user env GIT_SSH_COMMAND="$GIT_SSH" git ls-remote --heads "$REPO_SSH" main)" ]; then
    [ -d "$APP_DIR/.git" ] || die "Gałąź main jest pusta, a $APP_DIR nie jest repozytorium git – wgraj kod na GitHuba ręcznie."
    as_user env GIT_SSH_COMMAND="$GIT_SSH" git -C "$APP_DIR" push -q "$REPO_SSH" HEAD:refs/heads/main
    say "Kod wysłany na gałąź main"
  fi
  cfg_set "{\"publish\":{\"enabled\":true,\"repo\":\"$REPO_SSH\",\"branch\":\"data\",\"keyPath\":\"$KEY\"}}"
  OWNER="$(printf '%s' "$REPO_SSH" | sed -E 's#^git@github\.com:([^/]+)/.*#\1#')"
  NAME="$(printf '%s' "$REPO_SSH" | sed -E 's#^git@github\.com:[^/]+/(.*)\.git$#\1#')"
  PAGES_MSG="Strona (po włączeniu Settings → Pages → Branch main, folder /docs):  https://$OWNER.github.io/$NAME/"
fi

# --- Usługa systemd (na Twoim koncie) -----------------------------------------------
cat > /etc/systemd/system/$SVC.service <<UNIT
[Unit]
Description=Krypto Radar – skaner tokenów z alertami na Telegram
Wants=network-online.target time-sync.target
After=network-online.target time-sync.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
Environment=NODE_ENV=production
Environment=RADAR_CONFIG=$CFG
Environment=RADAR_DATA=$DATA_DIR/data
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=on-failure
RestartSec=15
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SVC" >/dev/null
systemctl restart "$SVC"
sleep 3

systemctl is-active --quiet "$SVC" || { journalctl -u "$SVC" -n 30 --no-pager || true; die "Usługa nie wystartowała – logi powyżej."; }
say "Krypto Radar działa na koncie $RUN_USER i uruchomi się sam po restarcie Orange Pi."
[ -n "$PAGES_MSG" ] && echo "$PAGES_MSG"
[ -n "$PAIR_MSG" ] && say "$PAIR_MSG"
cat <<MSG

Panel lokalny z ustawieniami: http://localhost:$(cfg_get port)  (przeglądarka na Orange Pi)

  journalctl -u $SVC -f                                          logi na żywo
  sudo systemctl restart $SVC                                    restart
  cd $APP_DIR && git pull && sudo systemctl restart $SVC          aktualizacja kodu
MSG
