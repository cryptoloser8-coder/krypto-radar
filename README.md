# Krypto Radar

Skaner tokenów i kolekcji NFT. Co minutę zbiera dane z DexScreener, GeckoTerminal, CoinGecko,
pump.fun i OpenSea, liczy wynik momentum, dokleja flagi ryzyka i wysyła alerty na Telegram.
Liczenie działa na Orange Pi, a panel jest stroną na GitHub Pages, którą otworzysz z dowolnego miejsca.
Nie potrzeba żadnych płatnych kluczy.

To narzędzie pokazuje, gdzie rośnie aktywność i uwaga, i mierzy, co działo się z ceną po każdym
sygnale. Nie przewiduje cen i nie jest poradą inwestycyjną.

## Jak to działa

    Orange Pi (usługa krypto-radar)                 GitHub
    ├─ skan co 60 s, alerty na Telegram  ──push──►   gałąź data: data.json (co 2 min, 1 commit bez historii)
    ├─ komendy z Telegrama (/status, /ustaw…)       gałąź main: kod + docs/ (strona)
    └─ panel lokalny http://localhost:8787            │
                                                      ▼
                                       https://LOGIN.github.io/REPO/  ← telefon, laptop, gdziekolwiek

- **Strona na GitHub Pages** pokazuje to samo co panel lokalny, tylko do odczytu. Dane mają do ~2 minut opóźnienia.
  Odświeża się sama co 1,5 minuty i ostrzega, gdy Orange Pi długo nic nie wysłał.
- **Ustawienia zmieniasz komendami w Telegramie** (lista niżej) albo w panelu lokalnym na Orange Pi.
- **Strona i dane są publiczne** (darmowe GitHub Pages zawsze są). Nie trafiają tam żadne sekrety: token
  bota, numer rozmowy, kod parowania, klucz do repozytorium ani hasło zostają na Orange Pi.
- **Orange Pi ma dostęp tylko do tego jednego repozytorium** – przez klucz „deploy”, nie przez Twoje konto GitHub.
- **Usługa działa na Twoim koncie** (`bot`); dane i sekrety leżą w `~/krypto-radar-dane`, dostępne tylko dla Ciebie.

## Instalacja na Orange Pi

Potrzebne: Node.js 18+ (na Orange Pi 5 Ultra z Ubuntu 22.04 jest już v20), `git` i `ssh`.

1. Wgraj kod do **publicznego** repozytorium na GitHubie (np. przez przeglądarkę: „uploading an existing file”).
2. Na Orange Pi, ze swojego konta:

       cd ~ && git clone https://github.com/LOGIN/krypto-radar.git
       sudo bash ~/krypto-radar/deploy/install.sh

3. Skrypt zapyta o **token bota** (nowy bot od @BotFather) i **repozytorium** (`login/nazwa`), wygeneruje klucz
   do dodania w GitHub → repozytorium → Settings → **Deploy keys** (z zaznaczonym „Allow write access”) i poda
   kod parowania, który wysyłasz botowi.
4. Włącz stronę: Settings → Pages → Branch `main`, folder `/docs`. Panel: `https://LOGIN.github.io/NAZWA/`.

Usługa działa na Twoim koncie i startuje sama po włączeniu Orange Pi. Kod zostaje w `~/krypto-radar`,
a ustawienia, token bota, klucz GitHuba i historia alertów są w `~/krypto-radar-dane` – poza repozytorium,
więc nie da się ich przypadkiem wypchnąć na GitHuba.

    journalctl -u krypto-radar -f                                  # logi na żywo
    sudo systemctl restart krypto-radar                            # restart
    cd ~/krypto-radar && git pull && sudo systemctl restart krypto-radar   # aktualizacja

Ponowne uruchomienie instalatora niczego nie kasuje – uzupełnia tylko to, czego brakuje.

## Komendy w Telegramie

Bot słucha tylko Twojej sparowanej rozmowy; wiadomości od innych osób ignoruje. Komendy wysłane, gdy
Orange Pi był wyłączony, przepadają po 10 minutach (nie wykonają się z opóźnieniem).

| Komenda | Co robi |
|---|---|
| `/status` | stan radaru, czołówka wczesnych i gorących, liczba alertów z 24 h |
| `/skanuj` | skan od razu (strona zaktualizuje się zaraz po nim) |
| `/ustawienia` | wszystkie progi z aktualnymi wartościami |
| `/ustaw klucz wartość` | zmiana, np. `/ustaw wczesny 50`, `/ustaw sieci solana,base`, `/ustaw plynnosc 30k` |
| `/pauza`, `/wznow` | wstrzymanie i wznowienie alertów |
| `/pomoc` | lista komend |

Klucze: `wczesny`, `goracy`, `plynnosc`, `wolumen`, `wczesna_plynnosc`, `wczesny_wolumen`, `wczesna_wycena`,
`przerwa`, `max`, `nft_wynik`, `interwal`, `sieci`, `alerty`, `wczesne`, `nft`, `krzywa`. Wartości liczbowe
przyjmują `20k`, `1,5m`; przełączniki `on`/`off`.

## Panel lokalny

Na samym Orange Pi działa pełny panel z edycją ustawień i Telegrama: http://localhost:8787 (przeglądarka
na pulpicie Orange Pi albo z laptopa przez tunel SSH: `ssh -L 8787:localhost:8787 bot@orangepi5ultra`).
Domyślnie nie jest widoczny w sieci. Gdybyś chciał go otworzyć dla sieci domowej, ustaw `"host": "0.0.0.0"`
w `~/krypto-radar-dane/config.json` i hasło:
`RADAR_CONFIG=~/krypto-radar-dane/config.json node ~/krypto-radar/server.js --set-password`
(bez hasła aplikacja w takim trybie nie wystartuje; jest też blokada zgadywania i lista dozwolonych adresów).

## Skąd dane

| Co | Źródło | Uwagi |
|---|---|---|
| Ceny, wolumen, płynność, transakcje | DexScreener | wszystkie sieci, które obsługuje |
| Trendujące pule (dobowe i 5-minutowe), unikalni kupujący | GeckoTerminal | wszystkie sieci |
| Najczęściej wyszukiwane | CoinGecko | odświeżane co 5 minut |
| Transmisje, komentarze, aktywne tokeny, tokeny po migracji | pump.fun | nieoficjalne API – może przestać działać bez ostrzeżenia |
| Kolekcje NFT | OpenSea | darmowy klucz pobierany automatycznie, odnawiany co tydzień |
| Kontrola kontraktu | RugCheck (Solana), GoPlus (sieci EVM) | 10 tokenów na skan, wynik pamiętany 30 minut |

Danych z X nie ma, bo API X jest płatne. Zastępują je wskaźniki uwagi z powyższych źródeł.

## Wczesne sygnały

Zakładka „Wczesne sygnały” szuka tokenów, w których popyt rośnie, a cena jeszcze nie uciekła.
Zakres: po migracji z krzywej pump.fun i na innych sieciach, płynność od 20 tys. USD, wycena do
10 mln USD, co najmniej 30 minut historii.

Wynik wczesny (0–100) to suma pięciu składników:

- rosnący popyt: wolumen ostatniej godziny względem własnej średniej z 6 i 24 godzin oraz impuls
  z ostatnich 5 minut (do 30); pełna waga dopiero od 10 tys. USD wolumenu na godzinę i 2% płynności,
- kupujący: udział zakupów, przyspieszenie liczby transakcji i przewaga unikalnych portfeli
  kupujących nad sprzedającymi (do 20),
- zapas ceny: najwięcej punktów, gdy cena w 1, 6 i 24 godziny prawie stoi (do 20),
- wycena: mała kapitalizacja przy płynności, która nie jest symboliczna (do 15),
- świeżość: token dopiero pojawił się na listach, w trendach 5-minutowych albo jest młody (do 15).

Zapas ceny i wycena liczą się tylko razem z popytem, więc token, w którym nic się nie dzieje,
nie zbiera punktów. Odejmujemy do 26 punktów za wzrost, który już był, oraz kary za flagi ryzyka.
Alert „wczesny” wychodzi od wyniku 45, jeśli token nie ma flagi krytycznej i nie jest już „gorący”.

Aplikacja obserwuje też do 400 tokenów przez 48 godzin od pierwszego pojawienia, nawet gdy zejdą
z list, żeby wyłapać ruch, zanim wrócą do trendów.

## Pomiar skuteczności

Przy każdym alercie aplikacja zapisuje cenę i sprawdza ją po 1, 6 i 24 godzinach. Zakładka „Alerty”
pokazuje, jaki procent sygnałów był na plusie, medianę zmiany i najwyższą cenę w ciągu 24 godzin.
Token, który zniknął z DexScreenera, liczy się jako −100%. Kontrola wymaga działającej aplikacji;
jeśli aplikacja wtedy nie działała, pomiar jest oznaczony jako pominięty i nie wchodzi do statystyk.
Poniżej około 30 zamkniętych sygnałów wynik niewiele mówi.

## Jak powstaje wynik „gorące teraz”

Momentum (0–100) to suma pięciu składników:

- przyspieszenie wolumenu: ostatnia godzina względem średniej z 6 i 24 godzin oraz ostatnie 5 minut względem godziny (do 28),
- aktywność: liczba transakcji i wolumen z ostatniej godziny (do 20),
- przewaga kupujących w ostatniej godzinie, liczona od 20 transakcji (do 15),
- wzrost ceny w 1, 6 i 24 godziny (do 20),
- uwaga: w ilu miejscach token jest teraz widoczny (do 17).

Wynik końcowy = momentum minus kary: 30 punktów za każdą flagę krytyczną, 6 za ostrzeżenie.
Alert wychodzi, gdy wynik przekroczy próg z Ustawień, token nie ma flagi krytycznej, a jego
płynność i wolumen są powyżej minimów. O tym samym tokenie alert wraca najwcześniej po 6 godzinach.

## Pliki

- `docs/index.html`, `docs/app.js` – panel (ten sam na GitHub Pages i lokalnie),
- `config.json` – ustawienia domyślne; działająca konfiguracja jest w `~/krypto-radar-dane/config.json`,
- `~/krypto-radar-dane/data/state.json` – historia alertów i pamięć aplikacji; można usunąć, żeby zacząć od zera,
- `lib/score.js` – reguły punktacji i progi flag, jeśli zechcesz je dostroić,
- `lib/outcomes.js` – pomiar skuteczności alertów,
- `lib/publish.js` – wysyłanie danych na GitHuba, `lib/tgbot.js` – komendy z Telegrama, `lib/auth.js` – hasło panelu lokalnego,
- `deploy/` – skrypt instalacyjny (tworzy też usługę systemd),
- `test/run.js` – test całości bez internetu: `node test/run.js`.

## Zmiany względem wersji oryginalnej

- logowanie hasłem, blokada zgadywania, lista dozwolonych adresów, nagłówki bezpieczeństwa (CSP ze skrótem skryptu,
  zakaz osadzania w ramce),
- parowanie Telegrama kodem – wcześniej alerty szły do pierwszej osoby, która napisała do bota,
- alert, którego nie udało się wysłać na połączony Telegram, jest ponawiany w następnym skanie (wcześniej przepadał
  na 6 godzin),
- po odpowiedzi 429 dany serwis dostaje przerwę (Retry-After albo 1, 2, 4… min), a kontrola kontraktów nie oznacza
  wtedy tokenów jako „nie udało się sprawdzić”,
- najkrótszy odstęp skanów to 45 s (GeckoTerminal bez klucza przyjmuje ok. 10 zapytań na minutę),
- alert o tokenie z sieci, której RugCheck i GoPlus nie obsługują, mówi wprost, że kontrakt nie był sprawdzony,
- stan zapisywany od razu po nowym alercie, poza tym co 5 minut (oszczędza kartę SD), i przy zatrzymaniu usługi (SIGTERM),
- start czeka na synchronizację zegara (Orange Pi nie ma zegara z baterią),
- poprawione kodowanie cudzysłowów w linkach w wiadomościach Telegram,
- usunięty `start.command` (macOS), dodana instalacja jako usługa systemd,
- panel na GitHub Pages (dane wypychane z Orange Pi) i sterowanie komendami z Telegrama.
