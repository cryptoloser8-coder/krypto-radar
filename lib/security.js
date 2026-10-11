'use strict';
// Darmowe sprawdzenie kontraktu: RugCheck (Solana) i GoPlus (sieci EVM).
// Wynik to lista flag w tym samym formacie co w score.js.

const { fetchJson, API_DEFAULTS, sleep } = require('./sources');

const GOPLUS_CHAIN = {
  ethereum: 1, bsc: 56, base: 8453, arbitrum: 42161, polygon: 137, avalanche: 43114,
  optimism: 10, linea: 59144, zksync: 324, scroll: 534352, mantle: 5000, fantom: 250,
  cronos: 25, blast: 81457,
};

const TTL = 30 * 60 * 1000;
const yes = (v) => String(v) === '1';
const pct = (v) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : null;
};

function goplusFlags(r) {
  const f = [];
  const add = (sev, code, text) => f.push({ sev, code, text });
  if (yes(r.is_honeypot)) add('crit', 'honeypot', 'Honeypot – tokena nie da się sprzedać');
  if (yes(r.cannot_sell_all)) add('crit', 'cannot-sell-all', 'Nie da się sprzedać całej pozycji');
  if (yes(r.honeypot_with_same_creator)) add('crit', 'creator-honeypot', 'Twórca wypuszczał wcześniej honeypoty');
  if (yes(r.owner_change_balance)) add('crit', 'owner-balance', 'Właściciel może zmieniać salda portfeli');
  if (yes(r.cannot_buy)) add('warn', 'cannot-buy', 'Zakup zablokowany w kontrakcie');
  const st = pct(r.sell_tax), bt = pct(r.buy_tax);
  if (st != null && st >= 0.3) add('crit', 'sell-tax', `Podatek od sprzedaży ${Math.round(st * 100)}%`);
  else if (st != null && st > 0.1) add('warn', 'sell-tax', `Podatek od sprzedaży ${Math.round(st * 100)}%`);
  if (bt != null && bt > 0.1) add('warn', 'buy-tax', `Podatek od zakupu ${Math.round(bt * 100)}%`);
  if (String(r.is_open_source) === '0') add('warn', 'closed-source', 'Kod kontraktu niezweryfikowany');
  if (yes(r.is_mintable)) add('warn', 'mintable', 'Można dodrukować tokeny');
  if (yes(r.hidden_owner)) add('warn', 'hidden-owner', 'Ukryty właściciel kontraktu');
  if (yes(r.slippage_modifiable)) add('warn', 'tax-modifiable', 'Podatek transakcyjny można zmienić');
  if (yes(r.transfer_pausable)) add('info', 'pausable', 'Transfery można wstrzymać');
  if (yes(r.is_blacklisted)) add('info', 'blacklist', 'Kontrakt ma czarną listę adresów');
  const holders = Array.isArray(r.holders) ? r.holders : [];
  if (holders.length) {
    const top = holders
      .filter((h) => !yes(h.is_locked) && !yes(h.is_contract))
      .slice(0, 10)
      .reduce((s, h) => s + (pct(h.percent) || 0), 0);
    if (top >= 0.8) add('crit', 'top10', `Top 10 portfeli trzyma ${Math.round(top * 100)}% podaży`);
    else if (top >= 0.5) add('warn', 'top10', `Top 10 portfeli trzyma ${Math.round(top * 100)}% podaży`);
  }
  const hc = parseInt(r.holder_count, 10);
  if (Number.isFinite(hc) && hc < 200) add('warn', 'holders', `Tylko ${hc} posiadaczy`);
  return f;
}

// Dane liczbowe z odpowiedzi GoPlus (bez dodatkowych zapytań): posiadacze, twórca, zablokowana płynność.
function goplusInfo(r) {
  const p100 = (v) => {
    const x = pct(v);
    return x == null ? null : Math.round(x * 1000) / 10;
  };
  const lp = Array.isArray(r.lp_holders) ? r.lp_holders : [];
  const lpLocked = lp.filter((h) => yes(h.is_locked) || /dead|0x0{30,}/i.test(String(h.address))).reduce((s, h) => s + (pct(h.percent) || 0), 0);
  const holders = Array.isArray(r.holders) ? r.holders : [];
  const top10 = holders.filter((h) => !yes(h.is_locked) && !yes(h.is_contract)).slice(0, 10).reduce((s, h) => s + (pct(h.percent) || 0), 0);
  const hc = parseInt(r.holder_count, 10);
  return {
    holders: Number.isFinite(hc) ? hc : null,
    top10Pct: holders.length ? Math.round(top10 * 1000) / 10 : null,
    creatorPct: p100(r.creator_percent),
    ownerPct: p100(r.owner_percent),
    lpLockedPct: lp.length ? Math.round(lpLocked * 1000) / 10 : null,
    lpHolders: Number.isFinite(parseInt(r.lp_holder_count, 10)) ? parseInt(r.lp_holder_count, 10) : null,
    buyTax: p100(r.buy_tax),
    sellTax: p100(r.sell_tax),
    src: 'goplus',
  };
}

function rugcheckFlags(d) {
  const f = [];
  for (const r of d.risks || []) {
    if (/^low liquidity/i.test(r.name || '')) continue; // płynność oceniamy sami
    const sev = r.level === 'danger' ? 'crit' : r.level === 'warn' ? 'warn' : 'info';
    f.push({ sev, code: 'rugcheck', text: `RugCheck: ${r.name}${r.value ? ` (${r.value})` : ''}` });
  }
  return f;
}

function supported(t) {
  return t.chain === 'solana' || GOPLUS_CHAIN[t.chain] != null;
}

async function checkOne(t, cfg) {
  const api = Object.assign({}, API_DEFAULTS, cfg.api || {});
  if (t.chain === 'solana') {
    const d = await fetchJson(`${api.rugcheck}/v1/tokens/${encodeURIComponent(t.address)}/report/summary`, { timeout: 10000 });
    const lp = pct(d.lpLockedPct);
    return { flags: rugcheckFlags(d), info: { lpLockedPct: lp == null ? null : Math.round(lp * 10) / 10, score: pct(d.score_normalised), src: 'rugcheck' } };
  }
  const id = GOPLUS_CHAIN[t.chain];
  const d = await fetchJson(`${api.goplus}/api/v1/token_security/${id}?contract_addresses=${encodeURIComponent(t.address)}`, { timeout: 10000 });
  const res = d && d.result ? d.result[t.address.toLowerCase()] || Object.values(d.result)[0] : null;
  if (!res) throw new Error('brak danych');
  return { flags: goplusFlags(res), info: goplusInfo(res) };
}

// Sprawdza najwyżej `limit` tokenów z listy (w podanej kolejności), resztę bierze z pamięci.
async function annotate(tokens, cfg, cache, limit, report) {
  cache.security = cache.security || new Map();
  const now = Date.now();
  let done = 0, failed = 0;
  const limited = new Set(); // serwisy, które w tym skanie odpowiedziały „za dużo zapytań”
  for (const t of tokens) {
    if (!supported(t)) {
      t.security = 'unsupported';
      continue;
    }
    const c = cache.security.get(t.key);
    if (c && now - c.at < TTL) {
      t.securityFlags = c.flags;
      t.secInfo = c.info || null;
      t.security = c.ok ? 'checked' : 'failed';
      continue;
    }
    if (done + failed >= limit) continue;
    const svc = t.chain === 'solana' ? 'rugcheck' : 'goplus';
    if (limited.has(svc)) continue; // token zostaje „w kolejce”, więc nie wywoła alertu bez kontroli
    try {
      const { flags, info } = await checkOne(t, cfg);
      cache.security.set(t.key, { at: now, flags, info, ok: true });
      t.securityFlags = flags;
      t.secInfo = info;
      t.security = 'checked';
      done++;
    } catch (e) {
      if (e.status === 429) {
        // Limit to nie wada tokena – nie oznaczamy go jako „nie udało się sprawdzić”.
        limited.add(svc);
        continue;
      }
      // Nieudane sprawdzenie pamiętamy krócej, żeby spróbować ponownie.
      cache.security.set(t.key, { at: now - TTL + 5 * 60 * 1000, flags: [], ok: false });
      t.security = 'failed';
      failed++;
    }
    await sleep(250);
  }
  for (const [k, v] of cache.security) if (now - v.at > 2 * TTL) cache.security.delete(k);
  const notes = [];
  if (failed) notes.push(`${failed} nieudanych`);
  if (limited.size) notes.push('limit zapytań: ' + [...limited].join(', '));
  if (done + failed + limited.size > 0) report('Kontrola kontraktów (RugCheck, GoPlus)', done > 0 || (failed === 0 && !limited.size), done, notes.join('; ') || undefined);
}

module.exports = { annotate, goplusFlags, goplusInfo, rugcheckFlags, supported, GOPLUS_CHAIN };
