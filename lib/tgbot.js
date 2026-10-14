'use strict';
// Odbieranie komend z Telegrama (długie odpytywanie getUpdates). Komendy przyjmujemy wyłącznie od właściciela:
// w prywatnej rozmowie ze sparowanym kontem albo w grupie – ale tylko wysłane z tego samego konta.
// Wiadomości od innych osób (także członków grupy) są pomijane bez odpowiedzi.

const { fetchJson, API_DEFAULTS, sleep } = require('./sources');

const COMMANDS = [
  ['status', 'stan radaru i czołówka sygnałów'],
  ['skanuj', 'skan od razu'],
  ['wyniki', 'skuteczność alertów, np. /wyniki 7d, /wyniki solana albo /wyniki odrzucone'],
  ['eksport', 'cała historia alertów jako plik CSV (Excel)'],
  ['ustawienia', 'aktualne progi i przełączniki'],
  ['ustaw', 'zmiana ustawienia, np. /ustaw wczesny 50'],
  ['tutaj', 'alerty w tej grupie / temacie (w prywatnej rozmowie: z powrotem tutaj)'],
  ['pauza', 'wstrzymaj alerty'],
  ['wznow', 'wznów alerty'],
  ['pomoc', 'lista komend'],
];

const base = (cfg) => `${Object.assign({}, API_DEFAULTS, cfg.api || {}).telegram}/bot${cfg.telegram.token}`;

// state.tgOffset – numer następnej wiadomości do odebrania (zapisywany w stanie aplikacji).
function startPolling({ getCfg, state, onCommand, send, onError, markDirty }) {
  let stopped = false;
  let registeredFor = null;
  let backoffLogged = false;
  (async () => {
    while (!stopped) {
      const cfg = getCfg();
      if (!cfg.telegram.token || !cfg.telegram.chatId) {
        await sleep(5000);
        continue;
      }
      try {
        if (registeredFor !== cfg.telegram.token) {
          // Menu komend w Telegramie (przycisk „/” w rozmowie z botem).
          await fetchJson(base(cfg) + '/setMyCommands', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ commands: COMMANDS.map(([command, description]) => ({ command, description })) }),
          }).catch(() => {});
          registeredFor = cfg.telegram.token;
        }
        const q = `?offset=${state.tgOffset || 0}&timeout=25&allowed_updates=%5B%22message%22%5D`;
        const d = await fetchJson(base(cfg) + '/getUpdates' + q, { timeout: 35000 });
        backoffLogged = false;
        for (const u of (d && d.result) || []) {
          state.tgOffset = u.update_id + 1;
          markDirty();
          const m = u.message;
          if (!m || !m.chat) continue;
          const owner = String(cfg.telegram.chatId);
          const isPrivate = m.chat.type === 'private' && String(m.chat.id) === owner;
          const inGroup = (m.chat.type === 'group' || m.chat.type === 'supergroup') && m.from && String(m.from.id) === owner;
          if (!isPrivate && !inGroup) continue;
          // Komendy wysłane, gdy Orange Pi był wyłączony, nie wykonują się z opóźnieniem.
          if (m.date && Date.now() / 1000 - m.date > 600) continue;
          const text = String(m.text || '').trim();
          if (!text.startsWith('/')) continue;
          // Skąd przyszła komenda – tam idzie odpowiedź (grupa i temat, jeśli to forum).
          const ctx = { id: m.chat.id, thread: m.is_topic_message && m.message_thread_id ? m.message_thread_id : null, type: m.chat.type, title: m.chat.title || '' };
          let reply;
          try {
            reply = await onCommand(text, ctx);
          } catch (e) {
            reply = '⚠️ ' + e.message;
          }
          if (reply) await send(reply, isPrivate ? null : ctx).catch((e) => onError(e));
        }
      } catch (e) {
        // Przerwa po „za dużo zapytań”: czekamy do jej końca i nie zapisujemy tego co 10 s w logu.
        const m = e.backoff && String(e.message).match(/jeszcze (\d+) s/);
        if (m) {
          if (!backoffLogged) onError(e);
          backoffLogged = true;
          await sleep(Math.min(+m[1] * 1000 + 1000, 120000));
          continue;
        }
        backoffLogged = false;
        onError(e);
        // 409: ten sam bot jest odpytywany przez inny program albo ma ustawiony webhook.
        await sleep(e.status === 409 ? 60000 : 10000);
      }
    }
  })();
  return () => (stopped = true);
}

// „20k”, „1,5m”, „0.5” → liczba
function parseNum(v) {
  const m = String(v || '').trim().toLowerCase().replace(',', '.').match(/^(-?\d+(?:\.\d+)?)\s*(k|tys|m|mln)?$/);
  if (!m) return NaN;
  const mult = { k: 1e3, tys: 1e3, m: 1e6, mln: 1e6 }[m[2]] || 1;
  return parseFloat(m[1]) * mult;
}
function parseOnOff(v) {
  const s = String(v || '').trim().toLowerCase().replace(/\.$/, ''); // „wł.” i „wył.” z kropką też
  if (['on', 'tak', 'wl', 'wł', '1', 'true'].includes(s)) return true;
  if (['off', 'nie', 'wyl', 'wył', '0', 'false'].includes(s)) return false;
  return undefined;
}

// klucz komendy /ustaw → [opis, funkcja budująca zmianę, odczyt bieżącej wartości]
const SETTINGS = {
  wczesny: ['minimalny wynik wczesnego sygnału (1–100)', (v) => ({ early: { minScore: parseNum(v) } }), (c) => c.early.minScore],
  goracy: ['minimalny wynik „gorące teraz” (1–100)', (v) => ({ alerts: { minScore: parseNum(v) } }), (c) => c.alerts.minScore],
  plynnosc: ['„gorące”: minimalna płynność $', (v) => ({ alerts: { minLiquidityUsd: parseNum(v) } }), (c) => c.alerts.minLiquidityUsd],
  wolumen: ['„gorące”: minimalny wolumen 1 h $', (v) => ({ alerts: { minVolume1hUsd: parseNum(v) } }), (c) => c.alerts.minVolume1hUsd],
  wczesna_plynnosc: ['wczesne: minimalna płynność $', (v) => ({ early: { minLiquidityUsd: parseNum(v) } }), (c) => c.early.minLiquidityUsd],
  wczesny_wolumen: ['wczesne: minimalny wolumen 1 h $', (v) => ({ early: { minVolume1hUsd: parseNum(v) } }), (c) => c.early.minVolume1hUsd],
  wczesna_wycena: ['wczesne: maksymalna wycena $', (v) => ({ early: { maxMarketCapUsd: parseNum(v) } }), (c) => c.early.maxMarketCapUsd],
  przerwa: ['godziny między alertami o tym samym tokenie', (v) => ({ alerts: { cooldownHours: parseNum(v) } }), (c) => c.alerts.cooldownHours],
  max: ['najwięcej alertów na skan', (v) => ({ alerts: { maxPerScan: parseNum(v) } }), (c) => c.alerts.maxPerScan],
  nft_wynik: ['minimalny wynik kolekcji NFT', (v) => ({ alerts: { nftMinScore: parseNum(v) } }), (c) => c.alerts.nftMinScore],
  interwal: ['sekundy między skanami', (v) => ({ scanIntervalSec: parseNum(v) }), (c) => c.scanIntervalSec],
  sieci: ['tylko te sieci (np. solana,base) albo „wszystkie”', (v) => ({ alerts: { chains: /^(wszystkie|all|-)$/i.test(v.trim()) ? [] : v.toLowerCase().split(/[,\s]+/).filter(Boolean) } }), (c) => (c.alerts.chains.length ? c.alerts.chains.join(', ') : 'wszystkie')],
  alerty: ['alerty wł./wył.', (v) => ({ alerts: { enabled: parseOnOff(v) } }), (c) => (c.alerts.enabled ? 'wł.' : 'wył.')],
  wczesne: ['wczesne sygnały wł./wył.', (v) => ({ early: { enabled: parseOnOff(v) } }), (c) => (c.early.enabled ? 'wł.' : 'wył.')],
  nft: ['alerty NFT wł./wył.', (v) => ({ alerts: { nft: parseOnOff(v) } }), (c) => (c.alerts.nft ? 'wł.' : 'wył.')],
  solana_tg: ['Solana: powiadomienia na Telegram wł./wył. (wyłączone – alerty tylko zapisywane w tle)', (v) => ({ solana: { telegram: parseOnOff(v) } }), (c) => (c.solana && c.solana.telegram ? 'wł.' : 'wył.')],
  solana_osobno: ['Solana: osobna zakładka na stronie wł./wył.', (v) => ({ solana: { separate: parseOnOff(v) } }), (c) => (!c.solana || c.solana.separate !== false ? 'wł.' : 'wył.')],
  bramka: ['gorące: bramka „za późno” wł./wył. (odrzucone alerty są tylko zapisywane – /wyniki odrzucone)', (v) => ({ alerts: { gate: { enabled: parseOnOff(v) } } }), (c) => (c.alerts.gate && c.alerts.gate.enabled === false ? 'wył.' : 'wł.')],
  bramka_1h: ['bramka: najwyższy wzrost ceny w 1 h w % (wyżej = za późno)', (v) => ({ alerts: { gate: { maxChgH1: parseNum(v) } } }), (c) => (c.alerts.gate || {}).maxChgH1],
  bramka_24h: ['bramka: najwyższy wzrost ceny w 24 h w %', (v) => ({ alerts: { gate: { maxChgH24: parseNum(v) } } }), (c) => (c.alerts.gate || {}).maxChgH24],
  bramka_wczesny: ['bramka: najniższy wynik wczesny tokena (0–100)', (v) => ({ alerts: { gate: { minEarlyScore: parseNum(v) } } }), (c) => (c.alerts.gate || {}).minEarlyScore],
  akcje: ['tokenizowane akcje (AAPLc, NVDAc…) – pomijać wł./wył.', (v) => ({ alerts: { excludeStocks: parseOnOff(v) } }), (c) => (c.alerts.excludeStocks === false ? 'wył.' : 'wł.')],
  krzywa: ['tokeny na krzywej pump.fun wł./wył.', (v) => ({ alerts: { allowBondingCurve: parseOnOff(v) } }), (c) => (c.alerts.allowBondingCurve ? 'wł.' : 'wył.')],
};

module.exports = { startPolling, parseNum, parseOnOff, SETTINGS, COMMANDS };
