'use strict';
// Codzienna kopia katalogu z danymi (ustawienia, dziennik alertów, taśma, szczegóły) do pliku .tar.gz.
// Pomijamy katalog roboczy publikacji (da się go odtworzyć). Trzymamy `keep` ostatnich kopii.
// Kopię warto kierować na inny nośnik (pendrive, dysk sieciowy) – ustawienie backup.dir w config.json.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10 * 60e3 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve()));
  });
}

// src – katalog z danymi (np. ~/krypto-radar-dane), dir – katalog na kopie.
async function backup(src, dir, keep = 14, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const day = now.toISOString().slice(0, 10);
  const name = `krypto-radar-dane-${day}.tar.gz`;
  const file = path.join(dir, name);
  const tmp = file + '.tmp';
  // Taśma rośnie z dnia na dzień, więc nie trafia do każdej kopii – spakowane dni kopiujemy raz do <dir>/tape/.
  await run('tar', ['-czf', tmp, '--exclude=./data/publish', '--exclude=./data/tape', '--exclude=*.tmp', '-C', src, '.']);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  const tapeSrc = path.join(src, 'data', 'tape');
  if (fs.existsSync(tapeSrc)) {
    const tapeDst = path.join(dir, 'tape');
    fs.mkdirSync(tapeDst, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(tapeSrc)) if (f.endsWith('.gz') && !fs.existsSync(path.join(tapeDst, f))) fs.copyFileSync(path.join(tapeSrc, f), path.join(tapeDst, f));
  }
  const all = fs.readdirSync(dir).filter((f) => /^krypto-radar-dane-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, f));
  return { file, bytes: fs.statSync(file).size, kept: Math.min(all.length, keep) };
}

module.exports = { backup };
