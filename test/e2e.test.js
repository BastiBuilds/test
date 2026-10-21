// End-to-end: real headless Chromium against the local fixture gallery (test/fixture-site.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixtureSite, markerOf } from './fixture-site.js';
import { run } from '../src/cli.js';

let site;
let out;
let total;
const quiet = { log: () => {}, error: () => {} };

before(async () => {
  site = await startFixtureSite();
  out = await mkdtemp(path.join(os.tmpdir(), 'bgdl-e2e-'));
  total = [...site.expected.values()].reduce((s, v) => s + v.length, 0);
});

after(async () => {
  await site?.close();
  if (out) await rm(out, { recursive: true, force: true });
});

async function downloadedMarkers(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const res = [];
  for (const e of entries) {
    if (!e.isFile() || !/\.(png|jpe?g|gif|webp)$/i.test(e.name)) continue;
    const p = path.join(e.parentPath ?? e.path, e.name);
    res.push({ marker: markerOf(await readFile(p)), folder: path.relative(dir, path.dirname(p)) });
  }
  return res;
}

test('lädt ALLE Fotos ALLER Alben (Alcúdia + Cala Rajada-Tab, "Mehr laden", Endlos-Scroll, Seiten, Unteralben) in voller Größe', { timeout: 600_000 }, async () => {
  const logs = [];
  // /cala-rajada/gallery does not exist on the fixture (HTTP 404) and must simply be skipped.
  const r = await run(['--url', `${site.url}/gallery`, '--url', `${site.url}/cala-rajada/gallery`, '--out', out], {
    log: (m) => logs.push(m),
    error: (m) => logs.push(m),
  });
  assert.equal(r.exitCode, 0, logs.join('\n'));
  assert.ok(logs.some((l) => l.includes('Filter "Cala Rajada"')), 'Cala Rajada-Tab wurde geöffnet');
  const calaAlbums = site.albums.filter((a) => a.venue === 'cala-rajada');
  for (const a of calaAlbums) assert.ok(r.manifest.albums.some((m) => m.url.endsWith(`/gallery/${a.slug}`)), `Cala Rajada-Album ${a.slug}`);

  const files = await downloadedMarkers(out);
  const kinds = new Set(files.map((f) => f.marker?.split(':')[0]));
  assert.deepEqual([...kinds], ['full'], 'nur Vollbilder – keine Thumbnails, Logos, Icons, Cover oder Platzhalter');
  assert.equal(files.length, total);

  for (const [key, expected] of site.expected) {
    const mine = files.filter((f) => f.marker.split(':')[1] === key);
    assert.deepEqual(mine.map((f) => f.marker).sort(), [...expected].sort(), `Album ${key}`);
    assert.ok(new Set(mine.map((f) => f.folder)).size <= 1, `Album ${key} liegt in genau einem Ordner`);
  }
  // Sub-albums are nested in their parent's folder.
  const night1 = files.find((f) => f.marker.includes('/night-1:'));
  const night2 = files.find((f) => f.marker.includes('/night-2:'));
  assert.equal(path.dirname(night1.folder), path.dirname(night2.folder));

  assert.equal(r.manifest.totals.downloaded, total);
  assert.equal(r.manifest.totals.failed, 0);
});

test('zweiter Lauf setzt fort: nichts wird doppelt geladen', { timeout: 600_000 }, async () => {
  const before = site.requests.filter((p) => p.startsWith('/img/full/') || p.startsWith('/download/')).length;
  const r = await run(['--url', `${site.url}/gallery`, '--out', out], quiet);
  const afterCount = site.requests.filter((p) => p.startsWith('/img/full/') || p.startsWith('/download/')).length;
  assert.equal(r.exitCode, 0);
  assert.equal(r.manifest.totals.found, total);
  assert.equal(r.manifest.totals.downloaded, 0);
  assert.equal(r.manifest.totals.skipped, total);
  assert.equal(afterCount, before, 'keine erneuten Bild-Downloads');
});

test('--dry-run listet nur und lädt nichts', { timeout: 600_000 }, async () => {
  const dry = await mkdtemp(path.join(os.tmpdir(), 'bgdl-dry-'));
  try {
    const r = await run(['--url', `${site.url}/gallery`, '--out', dry, '--dry-run', '--max-albums', '3'], quiet);
    assert.equal(r.manifest.albums.length, 3);
    assert.ok(r.manifest.totals.found > 0);
    assert.equal((await downloadedMarkers(dry)).length, 0);
  } finally {
    await rm(dry, { recursive: true, force: true });
  }
});
