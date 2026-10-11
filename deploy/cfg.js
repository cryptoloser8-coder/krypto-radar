'use strict';
// Pomocnik instalatora do pliku konfiguracji.
//   node cfg.js PLIK get telegram.token        → wypisuje wartość (pusty napis, gdy brak)
//   node cfg.js PLIK set '{"publish":{...}}'   → scala podany JSON z konfiguracją
const fs = require('fs');
const [file, cmd, arg] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

function merge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], v);
    else a[k] = v;
  }
  return a;
}

if (cmd === 'get') {
  const v = String(arg).split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg);
  process.stdout.write(v == null ? '' : String(v));
} else if (cmd === 'set') {
  merge(cfg, JSON.parse(arg));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
} else {
  console.error('użycie: cfg.js PLIK get KLUCZ | set JSON');
  process.exit(2);
}
