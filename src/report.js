// Writes downloads/index.html – a local overview of everything that was downloaded.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fileUrl = (rel) => rel.split(/[\\/]/).map(encodeURIComponent).join('/');

export function renderIndexHtml(manifest) {
  const t = manifest.totals;
  const sections = manifest.albums
    .map((a) => {
      const files = [...new Set(a.images.filter((i) => i.file).map((i) => i.file))];
      const thumbs = files
        .map((f) => `<a href="${fileUrl(f)}" target="_blank"><img loading="lazy" src="${fileUrl(f)}" alt=""></a>`)
        .join('');
      const failed = a.counts.failed ? ` · <span class="bad">${a.counts.failed} Fehler</span>` : '';
      return `<section>
  <h2>${esc(a.title)}</h2>
  <p class="meta">${a.counts.found} Bilder · <a href="${esc(a.url)}">${esc(a.url)}</a> · Ordner <code>${esc(a.folder)}</code>${failed}</p>
  <div class="grid">${thumbs || '<em>keine Bilder</em>'}</div>
</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Galerie-Download</title>
<style>
  :root { --bg: #fafaf7; --fg: #1d1d1b; --muted: #6b6b66; --line: #e4e3dc; --bad: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe6; --muted: #a09f98; --line: #2c2c2a; --bad: #f2b8b5; } }
  body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 26px; }
  h2 { margin: 32px 0 2px; font-size: 18px; }
  .meta { margin: 0 0 10px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .meta a { color: inherit; }
  .bad { color: var(--bad); font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; }
  .grid img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; border-radius: 4px; background: var(--line); }
  section { border-top: 1px solid var(--line); }
</style>
</head>
<body>
<main>
  <h1>Galerie-Download</h1>
  <p class="meta">${t.albums} Alben · ${t.found} Bilder gefunden · ${t.downloaded} neu geladen · ${t.skipped} schon vorhanden · ${t.duplicates} Duplikate · ${t.failed} Fehler · ${esc(manifest.finishedAt)}</p>
${sections}
</main>
</body>
</html>
`;
}
