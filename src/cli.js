#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GalleryCrawler, DEFAULT_LOAD_MORE } from './crawler.js';
import { Downloader } from './downloader.js';
import { sanitizeName, slugFor } from './urls.js';
import { renderIndexHtml } from './report.js';

export const DEFAULT_URL = 'https://www.bananaclub.es/gallery';

const HELP = `
Banana Club Mallorca – Fotogalerie-Downloader

Lädt ALLE Bilder ALLER Alben (Sub-Events) der Galerie herunter. Klickt dabei so lange
auf "Mehr laden" / scrollt (Endlos-Scroll) / folgt Seitenzahlen, bis nichts Neues mehr kommt –
sowohl in der Album-Übersicht als auch in jedem einzelnen Album.

Aufruf:
  node src/cli.js [Optionen]

Optionen:
  --url <URL>            Galerie-Startseite (mehrfach möglich). Standard: ${DEFAULT_URL}
  --out <Ordner>         Zielordner. Standard: ./downloads
  --concurrency <n>      Parallele Bild-Downloads. Standard: 8
  --pages <n>            Parallel geöffnete Album-Seiten im Browser. Standard: 3
  --max-albums <n>       Nur die ersten n Alben (zum Ausprobieren)
  --depth <n>            Wie tief Unteralben verfolgt werden (1 = nur Alben). Standard: 2
  --album-pattern <re>   Regex für Album-Links, falls die automatische Erkennung nicht passt
  --load-more <re>       Regex für den "Mehr laden"-Button (ersetzt den Standard)
  --max-rounds <n>       Max. Nachlade-Runden pro Seite. Standard: 400
  --dry-run              Nur finden und auflisten (manifest.json), nichts herunterladen
  --headful              Browser sichtbar starten (zum Zuschauen/Debuggen)
  --proxy <URL>          HTTP(S)-Proxy für Browser und Downloads
  -h, --help             Diese Hilfe

Erneutes Ausführen setzt fort: bereits geladene Bilder werden übersprungen.
`;

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function folderName(album) {
  const slug = slugFor(album.url);
  const title = album.title && album.title !== album.url ? album.title : '';
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!title || norm(title) === norm(slug)) return sanitizeName(slug);
  return sanitizeName(`${title} [${slug}]`, 150);
}

export async function run(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string', multiple: true },
      out: { type: 'string', default: 'downloads' },
      concurrency: { type: 'string', default: '8' },
      pages: { type: 'string', default: '3' },
      'max-albums': { type: 'string' },
      depth: { type: 'string', default: '2' },
      'album-pattern': { type: 'string' },
      'load-more': { type: 'string' },
      'max-rounds': { type: 'string', default: '400' },
      'dry-run': { type: 'boolean', default: false },
      headful: { type: 'boolean', default: false },
      proxy: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    io.log(HELP);
    return { exitCode: 0 };
  }

  const urls = values.url?.length ? values.url : [DEFAULT_URL];
  const outDir = path.resolve(values.out);
  const t0 = Date.now();
  const crawler = new GalleryCrawler({
    headless: !values.headful,
    pageConcurrency: Number(values.pages),
    maxAlbums: values['max-albums'] ? Number(values['max-albums']) : Infinity,
    maxDepth: Number(values.depth),
    maxRounds: Number(values['max-rounds']),
    albumPattern: values['album-pattern'] ? new RegExp(values['album-pattern'], 'i') : null,
    loadMore: values['load-more'] || DEFAULT_LOAD_MORE,
    proxy: values.proxy || null,
  });
  crawler.on('log', (m) => io.log(m));
  crawler.on('gallery', (g) =>
    io.log(`✔ Galerie ${g.url}: ${g.albums} Alben gefunden (${g.clicks}× "Mehr laden" geklickt, ${g.pages} Seite(n))`),
  );

  const albums = [];
  const pending = [];
  const usedFolders = new Set();
  let downloader;
  let lastProgress = 0;

  try {
    await crawler.start();
    downloader = await new Downloader(crawler.request, { outDir, concurrency: Number(values.concurrency) }).init();
    downloader.on('progress', (s) => {
      if (Date.now() - lastProgress > 3000) {
        lastProgress = Date.now();
        io.log(`  ⬇ ${s.done}/${s.queued} verarbeitet · ${s.downloaded} neu · ${s.skipped} vorhanden · ${s.failed} Fehler · ${fmtBytes(s.bytes)}`);
      }
    });

    crawler.on('album', (album, { finished, pending: left }) => {
      const base = album.parent ? path.join(album.parent.folder, folderName(album)) : folderName(album);
      let folder = base;
      for (let i = 2; usedFolders.has(folder.toLowerCase()); i++) folder = `${base}-${i}`;
      usedFolders.add(folder.toLowerCase());
      album.folder = folder;
      const rec = {
        title: album.title,
        url: album.url,
        folder,
        parent: album.parent?.url || null,
        pagesVisited: album.pages,
        loadMoreClicks: album.clicks,
        archives: album.archives,
        images: [],
      };
      albums.push(rec);
      const indent = '  '.repeat(album.depth - 1);
      io.log(
        `${indent}[${finished}] ${album.title} → ${album.images.length} Bilder` +
          (album.clicks ? ` (${album.clicks}× "Mehr laden")` : '') +
          (album.pages > 1 ? ` (${album.pages} Seiten)` : '') +
          (left ? ` · ${left} Alben in der Warteschlange` : ''),
      );
      for (const img of album.images) {
        const entry = { url: img.url, via: img.via };
        rec.images.push(entry);
        if (values['dry-run']) continue;
        pending.push(
          downloader.add({ folder, referer: album.url, url: img.url, alts: img.alts }).then((r) => Object.assign(entry, r, { url: img.url })),
        );
      }
    });

    await crawler.crawl(urls);
    await Promise.all(pending);
    await downloader.drain();
    await downloader.saveState();
  } finally {
    await crawler.close();
  }

  // ---- report ----
  const totals = { albums: albums.length, found: 0, downloaded: 0, skipped: 0, duplicates: 0, failed: 0, bytes: 0 };
  for (const a of albums) {
    a.counts = { found: a.images.length, downloaded: 0, skipped: 0, duplicates: 0, failed: 0 };
    for (const i of a.images) {
      totals.found++;
      if (i.status === 'downloaded') {
        a.counts.downloaded++;
        totals.downloaded++;
        totals.bytes += i.bytes;
      } else if (i.status === 'skipped') {
        a.counts.skipped++;
        totals.skipped++;
      } else if (i.status === 'duplicate' || i.status === 'duplicate-url') {
        a.counts.duplicates++;
        totals.duplicates++;
      } else if (i.status === 'failed') {
        a.counts.failed++;
        totals.failed++;
      }
    }
  }
  const manifest = {
    source: urls,
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    dryRun: values['dry-run'],
    totals,
    albums,
  };
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (!values['dry-run']) await writeFile(path.join(outDir, 'index.html'), renderIndexHtml(manifest));

  io.log('');
  io.log('──────────── Ergebnis ────────────');
  for (const a of albums) {
    const c = a.counts;
    const extra = [c.skipped && `${c.skipped} schon da`, c.duplicates && `${c.duplicates} Duplikate`, c.failed && `${c.failed} FEHLER`]
      .filter(Boolean)
      .join(', ');
    io.log(`  ${String(c.found).padStart(5)} Bilder  ${a.folder}${extra ? `  (${extra})` : ''}`);
  }
  io.log('──────────────────────────────────');
  io.log(`Alben:            ${totals.albums}`);
  io.log(`Bilder gefunden:  ${totals.found}`);
  if (!values['dry-run']) {
    io.log(`Neu geladen:      ${totals.downloaded} (${fmtBytes(totals.bytes)})`);
    io.log(`Schon vorhanden:  ${totals.skipped}`);
    io.log(`Duplikate:        ${totals.duplicates}`);
    io.log(`Fehler:           ${totals.failed}`);
  }
  io.log(`Dauer:            ${fmtDuration(Date.now() - t0)}`);
  io.log(`Ordner:           ${outDir}`);
  if (totals.failed) {
    io.error(`\n${totals.failed} Bilder konnten nicht geladen werden – Details in manifest.json. Erneut starten setzt fort.`);
  }
  if (!totals.albums) {
    io.error('\nKeine Alben gefunden. Prüfe die URL oder setze --album-pattern (siehe --help).');
  }
  return { exitCode: totals.failed || !totals.albums ? 2 : 0, manifest, outDir };
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  run()
    .then((r) => process.exit(r.exitCode))
    .catch((e) => {
      const net = /net::(ERR_[A-Z_]+)/.exec(e.message || '');
      if (net) {
        console.error(`Abbruch: Seite nicht erreichbar (${net[1]}). Internetverbindung, Proxy oder Firewall prüfen.`);
      } else {
        console.error(`Abbruch: ${e.stack || e.message}`);
      }
      process.exit(1);
    });
}
