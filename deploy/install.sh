#!/usr/bin/env bash
# Instalacja albo aktualizacja Krypto Radaru jako usługi systemd (Orange Pi / Armbian / Debian / Ubuntu).
# Uruchom z rozpakowanego katalogu aplikacji:   sudo bash deploy/install.sh
# Ponowne uruchomienie aktualizuje kod, a konfigurację i dane zostawia bez zmian.
set -euo pipefail

APP_DIR=/opt/krypto-radar
STATE_DIR=/var/lib/krypto-radar
SVC_USER=krypto-radar
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mBłąd:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Uruchom przez sudo:  sudo bash deploy/install.sh"
[ -f "$SRC_DIR/server.js" ] || die "Nie widzę server.js w $SRC_DIR – uruchom skrypt z katalogu aplikacji."
command -v systemctl >/dev/null || die "Ten system nie używa systemd."

# --- Node.js 18+ --------------------------------------------------------------
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] || [ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  cat >&2 <<'MSG'

Potrzebny jest Node.js 18 lub nowszy. Na Orange Pi (ARM) najprościej:
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
Na Debianie 12 / Armbianie bookworm wystarczy też:  sudo apt-get install -y nodejs
Potem uruchom ten skrypt ponownie.
MSG
  exit 1
fi
case "$NODE_BIN" in
  /home/*|/root/*) die "Node.js jest zainstalowany w katalogu domowym ($NODE_BIN, np. przez nvm). Usługa nie ma tam dostępu – zainstaluj Node.js systemowo (instrukcja wyżej w skrypcie)." ;;
esac
say "Node.js $("$NODE_BIN" -v) – $NODE_BIN"
for c in git ssh ssh-keygen runuser shuf; do
  command -v "$c" >/dev/null || die "Brakuje programu $c. Zainstaluj:  sudo apt-get install -y git openssh-client coreutils util-linux"
done

# --- Użytkownik usługi i katalogi ----------------------------------------------
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  say "Utworzono użytkownika systemowego $SVC_USER"
fi
install -d -m 0755 "$APP_DIR"
install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$STATE_DIR" "$STATE_DIR/data"

# --- Kod aplikacji (bez konfiguracji i danych) -----------------------------------
say "Kopiuję aplikację do $APP_DIR"
find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
for f in server.js lib public docs test deploy README.md config.json; do
  [ -e "$SRC_DIR/$f" ] && cp -r "$SRC_DIR/$f" "$APP_DIR/"
done
chown -R root:root "$APP_DIR"
chmod -R u=rwX,go=rX "$APP_DIR"

# --- Konfiguracja (tylko przy pierwszej instalacji) ------------------------------
CFG="$STATE_DIR/config.json"
as_svc() { runuser -u "$SVC_USER" -- "$@"; }
cfg_get() { as_svc "$NODE_BIN" "$APP_DIR/deploy/cfg.js" "$CFG" get "$1"; }
cfg_set() { as_svc "$NODE_BIN" "$APP_DIR/deploy/cfg.js" "$CFG" set "$1"; }
ask() { local a=""; if [ -t 0 ]; then read -r -p "$1" a || true; fi; printf '%s' "$a"; }

if [ ! -f "$CFG" ]; then
  install -m 0600 -o "$SVC_USER" -g "$SVC_USER" "$SRC_DIR/config.json" "$CFG"
  # Panel lokalny tylko na tym urządzeniu (127.0.0.1). Z zewnątrz korzystasz ze strony na GitHub Pages.
  cfg_set "{\"host\":\"127.0.0.1\",\"port\":$PORT}"
  say "Utworzono konfigurację $CFG"
else
  say "Konfiguracja $CFG już istnieje – zostawiam ustawienia"
fi

# --- Telegram --------------------------------------------------------------------
if [ -z "$(cfg_get telegram.token)" ]; then
  say "Telegram (Enter = pomiń, dodasz później)"
  echo "Załóż NOWEGO bota u @BotFather (/newbot) i wklej jego token. Nie używaj tokenu innego bota –"
  echo "Telegram pozwala odbierać wiadomości bota tylko jednemu programowi naraz."
  TG="$(ask 'Token bota: ')"
  TG="$(printf '%s' "$TG" | tr -d '[:space:]')"
  if [ -n "$TG" ]; then
    if printf '%s' "$TG" | grep -Eq '^[0-9]{5,}:[A-Za-z0-9_-]{20,}$'; then
      CODE="$(shuf -i 100000-999999 -n 1)"
      cfg_set "{\"telegram\":{\"token\":\"$TG\",\"chatId\":\"\",\"pairCode\":\"$CODE\"}}"
      PAIR_MSG="Wyślij swojemu nowemu botowi na Telegramie wiadomość z kodem:  $CODE"
    else
      echo "To nie wygląda na token bota – pomijam. Możesz uruchomić instalator ponownie."
    fi
  fi
elif [ -z "$(cfg_get telegram.chatId)" ] && [ -n "$(cfg_get telegram.pairCode)" ]; then
  PAIR_MSG="Telegram czeka na sparowanie – wyślij botowi kod:  $(cfg_get telegram.pairCode)"
fi

# --- GitHub: klucz i repozytorium ---------------------------------------------------
KEY="$STATE_DIR/deploy_key"
REPO_SSH="$(cfg_get publish.repo)"
if [ -z "$REPO_SSH" ]; then
  say "Strona na GitHub Pages (Enter = pomiń)"
  echo "Załóż na github.com PUSTE, PUBLICZNE repozytorium (bez README) i podaj je jako login/nazwa,"
  echo "np. jan/krypto-radar."
  REPO="$(ask 'Repozytorium: ')"
  REPO="$(printf '%s' "$REPO" | sed -E 's#^(https://|git@)github\.com[:/]##; s#\.git$##; s#/$##' | tr -d '[:space:]')"
  if [ -n "$REPO" ]; then
    printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' || die "„$REPO” nie wygląda na login/nazwa."
    REPO_SSH="git@github.com:$REPO.git"
  fi
fi

if [ -n "$REPO_SSH" ]; then
  if [ ! -f "$KEY" ]; then
    as_svc ssh-keygen -q -t ed25519 -N '' -C "krypto-radar@$(hostname)" -f "$KEY"
  fi
  GIT_SSH="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$STATE_DIR/known_hosts"
  TRIES=0
  until as_svc env GIT_SSH_COMMAND="$GIT_SSH" git ls-remote "$REPO_SSH" >/dev/null 2>&1; do
    TRIES=$((TRIES + 1))
    [ "$TRIES" -le 5 ] || die "Nadal brak dostępu do $REPO_SSH. Sprawdź nazwę repozytorium i klucz, potem uruchom instalator ponownie."
    say "Dodaj ten klucz do repozytorium – tylko ono będzie dostępne dla Orange Pi"
    echo "GitHub → repozytorium → Settings → Deploy keys → Add deploy key"
    echo "Title: Orange Pi, zaznacz „Allow write access”, wklej:"
    echo
    cat "$KEY.pub"
    echo
    [ -t 0 ] || die "Brak dostępu do $REPO_SSH – dodaj klucz i uruchom instalator ponownie."
    ask 'Naciśnij Enter, gdy klucz będzie dodany (Ctrl+C przerywa)… ' >/dev/null
  done
  say "Dostęp do $REPO_SSH działa"

  # Kod aplikacji (z katalogiem docs/ dla strony) na gałąź main – tylko jeśli repozytorium jest puste.
  if [ -z "$(as_svc env GIT_SSH_COMMAND="$GIT_SSH" git ls-remote --heads "$REPO_SSH" main)" ]; then
    # Wysyłamy jako root (kod może leżeć w Twoim katalogu domowym), ale tym samym kluczem repozytorium.
    TMP="$(mktemp -d)"
    ROOT_SSH="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$TMP/known_hosts"
    if [ -d "$SRC_DIR/.git" ]; then
      git -c safe.directory='*' clone -q --no-hardlinks "$SRC_DIR" "$TMP/src"
    else
      mkdir "$TMP/src" && cp -r "$APP_DIR"/. "$TMP/src"/
      git -C "$TMP/src" init -q && git -C "$TMP/src" add -A
      git -C "$TMP/src" -c user.name="Krypto Radar" -c user.email=radar@localhost commit -qm "Krypto Radar"
    fi
    GIT_SSH_COMMAND="$ROOT_SSH" git -C "$TMP/src" push -q "$REPO_SSH" HEAD:refs/heads/main
    rm -rf "$TMP"
    say "Kod wysłany na gałąź main"
  else
    say "Gałąź main już istnieje – nie ruszam jej"
  fi
  cfg_set "{\"publish\":{\"enabled\":true,\"repo\":\"$REPO_SSH\",\"branch\":\"data\",\"keyPath\":\"$KEY\"}}"
  OWNER="$(printf '%s' "$REPO_SSH" | sed -E 's#^git@github\.com:([^/]+)/.*#\1#')"
  NAME="$(printf '%s' "$REPO_SSH" | sed -E 's#^git@github\.com:[^/]+/(.*)\.git$#\1#')"
  if [ "$(printf '%s' "$NAME" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$OWNER" | tr 'A-Z' 'a-z').github.io" ]; then SITE="https://$OWNER.github.io/"; else SITE="https://$OWNER.github.io/$NAME/"; fi
  PAGES_MSG="Włącz stronę: GitHub → repozytorium → Settings → Pages → Source: „Deploy from a branch”,
  Branch: main, folder: /docs → Save. Po 1–2 minutach panel będzie pod adresem:
    $SITE"
fi

# --- Usługa systemd ----------------------------------------------------------------
sed "s#@NODE@#$NODE_BIN#" "$SRC_DIR/deploy/krypto-radar.service" > /etc/systemd/system/krypto-radar.service
systemctl daemon-reload
systemctl enable --now systemd-timesyncd.service >/dev/null 2>&1 || true
systemctl enable krypto-radar.service >/dev/null
systemctl restart krypto-radar.service
sleep 3

if systemctl is-active --quiet krypto-radar.service; then
  say "Krypto Radar działa jako usługa i uruchomi się sam po restarcie Orange Pi."
  PORT_NOW="$("$NODE_BIN" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port' "$CFG")"
  [ -n "${PAGES_MSG:-}" ] && say "$PAGES_MSG"
  [ -n "${PAIR_MSG:-}" ] && say "$PAIR_MSG"
  cat <<MSG

Panel z ustawieniami na samym Orange Pi: http://localhost:$PORT_NOW (przeglądarka na pulpicie Orange Pi
albo z laptopa przez tunel SSH: ssh -L $PORT_NOW:localhost:$PORT_NOW bot@orangepi5ultra).

Przydatne polecenia:
  journalctl -u krypto-radar -f          podgląd logów na żywo
  sudo systemctl restart krypto-radar    restart
  sudo systemctl stop krypto-radar       zatrzymanie
  sudo bash deploy/install.sh             aktualizacja (z nowej wersji kodu)
MSG
else
  journalctl -u krypto-radar -n 30 --no-pager || true
  die "Usługa nie wystartowała – logi powyżej."
fi
