'use strict';
const { fetchJson, API_DEFAULTS } = require('./sources');

// Cudzysłów też, bo adresy trafiają do atrybutu href – nazwa albo link z API mógłby inaczej zepsuć wiadomość.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function base(cfg) {
  const api = Object.assign({}, API_DEFAULTS, cfg.api || {});
  return `${api.telegram}/bot${cfg.telegram.token}`;
}

// Odpowiedź z błędem Telegrama: opis i parametry (np. nowy numer grupy po zmianie w supergrupę).
function tgError(e) {
  try {
    return JSON.parse(e.body || '{}');
  } catch (x) {
    return {};
  }
}

// to – { id, thread } (grupa i wątek/temat) albo nic: prywatna rozmowa z właścicielem.
// Zwraca { migrated } gdy grupa zmieniła numer (zwykła grupa → supergrupa) – wiadomość i tak wychodzi.
async function send(cfg, html, to) {
  if (!cfg.telegram || !cfg.telegram.token || !cfg.telegram.chatId) throw new Error('Telegram nie jest jeszcze połączony');
  const target = to && to.id ? to : { id: cfg.telegram.chatId };
  const post = (id) => fetchJson(base(cfg) + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ chat_id: id, text: html, parse_mode: 'HTML', disable_web_page_preview: true }, target.thread ? { message_thread_id: target.thread } : {})),
  });
  let d, migrated = null;
  try {
    d = await post(target.id);
  } catch (e) {
    const p = tgError(e).parameters;
    if (!(p && p.migrate_to_chat_id)) {
      const desc = tgError(e).description;
      if (desc) e.message = `Telegram: ${desc}`;
      throw e;
    }
    migrated = p.migrate_to_chat_id;
    d = await post(migrated);
  }
  if (!d.ok) throw new Error(d.description || 'Telegram odrzucił wiadomość');
  return { migrated };
}

// Plik jako załącznik (np. eksport CSV). Telegram przyjmuje do 50 MB.
async function sendDocument(cfg, filename, content, caption, to) {
  if (!cfg.telegram || !cfg.telegram.token || !cfg.telegram.chatId) throw new Error('Telegram nie jest jeszcze połączony');
  const form = new FormData();
  form.append('chat_id', String(to && to.id ? to.id : cfg.telegram.chatId));
  if (to && to.thread) form.append('message_thread_id', String(to.thread));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([content], { type: 'text/csv' }), filename);
  const d = await fetchJson(base(cfg) + '/sendDocument', { method: 'POST', body: form, timeout: 60000 });
  if (!d.ok) throw new Error(d.description || 'Telegram odrzucił plik');
  return true;
}

// Parowanie: aplikacja pokazuje jednorazowy kod, a użytkownik wysyła go botowi w prywatnej rozmowie.
// Bierzemy tylko rozmowę, z której przyszedł ten kod – bota może znaleźć każdy, więc „pierwsza
// wiadomość od kogokolwiek” mogłaby podpiąć alerty pod obcą osobę.
async function discoverChat(cfg) {
  const code = cfg.telegram && cfg.telegram.pairCode;
  if (!cfg.telegram || !cfg.telegram.token || !code) return null;
  const d = await fetchJson(base(cfg) + '/getUpdates?limit=100&timeout=0&allowed_updates=%5B%22message%22%5D');
  const ups = (d && d.result) || [];
  for (let i = ups.length - 1; i >= 0; i--) {
    const m = ups[i].message;
    if (!m || !m.chat || m.chat.id == null || m.chat.type !== 'private') continue;
    if (String(m.text || '').replace(/\D/g, '') !== code) continue;
    return { chatId: m.chat.id, title: m.chat.first_name || m.chat.username || '', updateId: ups[i].update_id };
  }
  return null;
}

// Potwierdza odczytane wiadomości, żeby stare (w tym kod) nie wracały przy kolejnym parowaniu.
async function ackUpdates(cfg, updateId) {
  await fetchJson(base(cfg) + `/getUpdates?offset=${Number(updateId) + 1}&limit=1&timeout=0`).catch(() => {});
}

async function botName(cfg) {
  const d = await fetchJson(base(cfg) + '/getMe');
  return d && d.result ? d.result.username : null;
}

const usd = (x) => {
  if (x == null || !Number.isFinite(x)) return '–';
  const a = Math.abs(x);
  if (a >= 1e9) return '$' + (x / 1e9).toFixed(2) + ' mld';
  if (a >= 1e6) return '$' + (x / 1e6).toFixed(2) + ' mln';
  if (a >= 1e3) return '$' + (x / 1e3).toFixed(1) + ' tys.';
  return '$' + x.toFixed(0);
};
const price = (x) => {
  if (x == null || !Number.isFinite(x)) return '–';
  if (x >= 1) return '$' + x.toFixed(2);
  if (x <= 0) return '$0';
  // trzy cyfry znaczące bez notacji wykładniczej, np. $0.00000615
  const decimals = Math.min(18, Math.max(2, 2 - Math.floor(Math.log10(x))));
  return '$' + x.toFixed(decimals);
};
const pc = (x) => (x == null || !Number.isFinite(x) ? '–' : (x > 0 ? '+' : '') + (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1)) + '%');
const age = (h) => (h == null ? '–' : h < 1 ? Math.round(h * 60) + ' min' : h < 48 ? Math.round(h) + ' h' : Math.round(h / 24) + ' dni');

const RISK_LABEL = { none: 'brak flag', med: 'podwyższone', high: 'wysokie', crit: 'krytyczne' };
const SOURCE_LABEL = {
  'gt-trending': 'trendy GeckoTerminal',
  'gt-trending-5m': 'trendy 5-minutowe GeckoTerminal',
  'pump-migrated': 'świeżo po migracji z pump.fun',
  'cg-trending': 'trendy CoinGecko',
  'ds-boost-top': 'top boosty DexScreener',
  'ds-boost-new': 'nowy boost DexScreener',
  'ds-profile': 'nowy profil DexScreener',
  'ds-cto': 'przejęcie społeczności',
  'pump-live': 'pump.fun na żywo',
  'pump-replies': 'komentowane na pump.fun',
  'pump-active': 'aktywne na pump.fun',
};

// Telegram tokena: publiczny (nazwa, członkowie), prywatny, brak.
const nInt = (x) => Math.round(x).toLocaleString('pl-PL');
function tgLine(t) {
  const g = t.tg || { s: t.socials && t.socials.telegram ? 'public' : 'none' };
  if (g.s === 'public') {
    const what = g.type === 'channel' ? 'kanał' : g.type === 'group' ? 'grupa' : 'publiczny';
    if (g.unchecked || g.n == null) return `📢 Telegram: ${what}${g.name ? ' @' + esc(g.name) : ''}` + (g.unchecked ? ' (niesprawdzony)' : '');
    return `📢 Telegram: ${what}${g.title ? ' „' + esc(g.title) + '”' : ''} – ${nInt(g.n)} członków`;
  }
  return {
    private: '🔒 Telegram: prywatny (tylko link z zaproszeniem)',
    none: '➖ Telegram: brak',
    notfound: `❓ Telegram: @${esc(g.name || '')} nie istnieje albo to konto osoby, nie kanał`,
    bot: `🤖 Telegram: tylko bot @${esc(g.name || '')}`,
    folder: '📁 Telegram: folder kanałów',
    invalid: '❓ Telegram: nieprawidłowy link',
  }[g.s] || '❓ Telegram: nieznany';
}
function tgHref(t) {
  const u = t.socials && t.socials.telegram;
  const g = t.tg || {};
  return u && /^https?:\/\//i.test(u) && ['public', 'private', 'folder'].includes(g.s) ? ` | <a href="${esc(u)}">Telegram</a>` : '';
}

function tokenAlert(t) {
  const s = t.s;
  const srcs = (t.sources || []).map((x) => SOURCE_LABEL[x]).filter(Boolean);
  for (const m of t.metas || []) if (m.hot) srcs.push('narracja „' + m.name + '”');
  const flags = s.flags.filter((f) => f.sev !== 'info').map((f) => f.text);
  const lines = [
    `🚨 <b>${esc(t.symbol)}</b> (${esc(t.name)}) – ${esc(t.chain)}`,
    `Wynik <b>${Math.round(s.score)}/100</b>, momentum ${Math.round(s.momentum)}, ryzyko: ${RISK_LABEL[s.risk]}`,
    `Cena ${price(t.priceUsd)} | 1 h ${pc(t.chg.h1)} | 6 h ${pc(t.chg.h6)} | 24 h ${pc(t.chg.h24)}`,
    `Wolumen 1 h ${usd(t.vol.h1)} | 24 h ${usd(t.vol.h24)}`,
    `Płynność ${t.liquidityUsd == null ? 'brak puli' : usd(t.liquidityUsd)} | wycena ${usd(t.marketCap || t.fdv)}`,
    `Kupujący 1 h: ${s.parts.buyRatio == null ? '–' : Math.round(s.parts.buyRatio * 100) + '%'} z ${s.parts.tx1} transakcji | wiek ${age(s.parts.ageH)}`,
  ];
  if (srcs.length) lines.push('Gdzie gorąco: ' + esc(srcs.join(', ')));
  if (flags.length) lines.push('⚠️ ' + esc(flags.join('; ')));
  if (t.security === 'failed') lines.push('ℹ️ Nie udało się sprawdzić kontraktu');
  if (t.security === 'unsupported') lines.push('ℹ️ Kontrakt niesprawdzony – RugCheck i GoPlus nie obsługują tej sieci');
  lines.push(tgLine(t));
  lines.push(`<a href="${esc(t.url)}">Wykres</a>` + (t.pumpUrl ? ` | <a href="${esc(t.pumpUrl)}">pump.fun</a>` : '') + tgHref(t));
  lines.push('<i>Sygnał aktywności, nie rekomendacja.</i>');
  return lines.join('\n');
}

function earlyAlert(t) {
  const s = t.s, e = t.e;
  const srcs = (t.sources || []).map((x) => SOURCE_LABEL[x]).filter(Boolean);
  const flags = s.flags.filter((f) => f.sev !== 'info').map((f) => f.text);
  const u = t.uniq && t.uniq.h1;
  const lines = [
    `🌱 Wczesny sygnał: <b>${esc(t.symbol)}</b> (${esc(t.name)}) – ${esc(t.chain)}`,
    `Wynik wczesny <b>${Math.round(e.score)}/100</b>, ryzyko: ${RISK_LABEL[s.risk]}`,
    `Wolumen 1 h ${usd(t.vol.h1)}` + (e.volX != null ? ` (${e.volX}× własnej średniej)` : '') + (e.txX != null ? `, transakcje ${e.txX}×` : ''),
    `Kupujący 1 h: ${s.parts.buyRatio == null ? '–' : Math.round(s.parts.buyRatio * 100) + '%'} z ${s.parts.tx1} transakcji` + (u ? `, portfele: ${u.buyers} kupujących / ${u.sellers} sprzedających` : ''),
    `Cena ${price(t.priceUsd)} | 1 h ${pc(t.chg.h1)} | 6 h ${pc(t.chg.h6)} | 24 h ${pc(t.chg.h24)}`,
    `Płynność ${usd(t.liquidityUsd)} | wycena ${usd(t.marketCap || t.fdv)} | wiek ${age(s.parts.ageH)}`,
  ];
  if (srcs.length) lines.push('Gdzie widoczny: ' + esc(srcs.join(', ')));
  if (flags.length) lines.push('⚠️ ' + esc(flags.join('; ')));
  if (t.security === 'failed') lines.push('ℹ️ Nie udało się sprawdzić kontraktu');
  if (t.security === 'unsupported') lines.push('ℹ️ Kontrakt niesprawdzony – RugCheck i GoPlus nie obsługują tej sieci');
  lines.push(tgLine(t));
  lines.push(`<a href="${esc(t.url)}">Wykres</a>` + (t.pumpUrl ? ` | <a href="${esc(t.pumpUrl)}">pump.fun</a>` : '') + tgHref(t));
  lines.push('<i>Wczesny sygnał aktywności, nie rekomendacja. Aplikacja sprawdzi cenę po 1, 6 i 24 h.</i>');
  return lines.join('\n');
}

// Nowy token na Robinhood – sygnał „pierwsze minuty” (wersja 13). Bez kontroli kontraktu na tej sieci.
function rhAlert(t) {
  const s = t.s;
  const lines = [
    `🆕 Nowy token na Robinhood: <b>${esc(t.symbol)}</b> (${esc(t.name)})`,
    `Wiek ${age(s.parts.ageH)} | widziany pierwszy raz ${t.seenMin == null ? 'teraz' : t.seenMin + ' min temu'}`,
    `Cena ${price(t.priceUsd)} | płynność ${usd(t.liquidityUsd)} | wycena ${usd(t.marketCap || t.fdv)}`,
    `Wolumen 1 h ${usd(t.vol.h1)} | kupujący ${s.parts.buyRatio == null ? '–' : Math.round(s.parts.buyRatio * 100) + '%'} z ${s.parts.tx1} transakcji`,
    '⚠️ Kontrakt niesprawdzony – na tej sieci nie ma kontroli (możliwy honeypot lub podatek od sprzedaży).',
    `<a href="${esc(t.url)}">Wykres</a>` + tgHref(t),
    '<i>Plan z analizy taśmy (pomiar, nie rekomendacja): wejście po ok. 5 min, TP +100%, SL −40%, wyjście najpóźniej po 6 h. Aplikacja mierzy to w tle.</i>',
  ];
  return lines.join('\n');
}

function nftAlert(c) {
  const s = c.s;
  const flags = s.flags.filter((f) => f.sev !== 'info').map((f) => f.text);
  const lines = [
    `🖼 <b>${esc(c.name)}</b> – nowa kolekcja w trendach OpenSea${c.chain ? ' (' + esc(c.chain) + ')' : ''}`,
    `Wynik <b>${Math.round(s.score)}/100</b>, ryzyko: ${RISK_LABEL[s.risk]}`,
    `Floor ${c.floor == null ? '–' : c.floor + ' ' + esc(c.symbol)} | 24 h: ${c.sales1d} sprzedaży, ${Number(c.vol1d).toFixed(2)} ${esc(c.symbol)}`,
    `7 dni: ${c.sales7d} sprzedaży, ${Number(c.vol7d).toFixed(2)} ${esc(c.symbol)} | posiadaczy: ${c.owners == null ? '–' : c.owners}`,
  ];
  if (flags.length) lines.push('⚠️ ' + esc(flags.join('; ')));
  lines.push(`<a href="${esc(c.url)}">OpenSea</a>`);
  lines.push('<i>Sygnał aktywności, nie rekomendacja.</i>');
  return lines.join('\n');
}

module.exports = { tgLine, send, sendDocument, discoverChat, ackUpdates, botName, tokenAlert, earlyAlert, rhAlert, nftAlert, RISK_LABEL, SOURCE_LABEL };
