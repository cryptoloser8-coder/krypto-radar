'use strict';
// Pilnowanie aplikacji: gdy źródło danych albo wysyłka na GitHuba nie działa od `afterMin` minut,
// bot pisze o tym raz na Telegram, a potem jeszcze raz, gdy wszystko wróci do normy.

class Health {
  constructor({ afterMin = 30 } = {}) {
    this.afterMs = afterMin * 60e3;
    this.down = new Map(); // nazwa → { since, error, notified }
  }

  // sources – lista { name, ok, error, at }; zwraca wiadomości do wysłania.
  check(sources, now = Date.now()) {
    const out = [];
    const seen = new Set();
    for (const s of sources) {
      seen.add(s.name);
      const d = this.down.get(s.name);
      if (!s.ok) {
        if (!d) this.down.set(s.name, { since: now, error: s.error, notified: false });
        else {
          d.error = s.error;
          if (!d.notified && now - d.since >= this.afterMs) {
            d.notified = true;
            out.push(`⚠️ <b>${esc(s.name)}</b> nie działa od ${Math.round((now - d.since) / 60000)} min.\n${esc(String(s.error || '').slice(0, 200))}`);
          }
        }
      } else if (d) {
        if (d.notified) out.push(`✅ <b>${esc(s.name)}</b> znowu działa (przerwa ${Math.round((now - d.since) / 60000)} min).`);
        this.down.delete(s.name);
      }
    }
    return out;
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

module.exports = { Health };
