// A local stand-in for the real gallery that reproduces the tricky parts:
// AJAX "Mehr laden" on the album overview, a 2nd overview page, a cookie banner,
// albums with load-more buttons, infinite scroll, Next.js image proxy URLs,
// per-photo download buttons, numbered pages, an empty album and an album with
// sub-albums. Site chrome (logo, icons, covers, lazy placeholder) must NOT be downloaded.

import http from 'node:http';
import zlib from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Solid-colour PNG with a tEXt marker so tests can tell full-size from thumbnails. */
export function png(w, h, marker) {
  let hash = 0;
  for (const ch of marker) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const rgb = [hash & 0xff, (hash >> 8) & 0xff, (hash >> 16) & 0xff];
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`bgdl\0${marker}`, 'latin1')),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
export function markerOf(buf) {
  const i = buf.indexOf('bgdl\0');
  if (i < 0) return null;
  const end = buf.indexOf('IDAT', i);
  return buf.subarray(i + 5, end - 8).toString('latin1');
}
const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

const PARTIES = ['DISCO 51', 'GLOW SAFARI', 'BURNING WEST', 'DURO', 'OASIS', 'LE CIRQUE DE LA LUNE', 'WELCOME TO FABULOUS CABARET'];
const TYPES = ['button', 'infinite', 'next', 'download', 'paged'];
const COUNTS = [57, 33, 41, 25, 47, 70, 0, 12, 45, 29, 60, 18, 37, 22, 50, 15, 9, 0];
// Cala Rajada albums are only listed after clicking the "Cala Rajada" tab of the overview.
const CALA = [
  ['OPENING CALA RAJADA', 35],
  ['SATURDAYS', 28],
  ['DISCO 51', 44],
  ['GLOW SAFARI', 19],
  ['BURNING WEST', 52],
  ['SATURDAYS', 23],
  ['DURO', 31],
  ['OASIS', 16],
];
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function buildAlbums() {
  const albums = [];
  for (let i = 0; i < COUNTS.length; i++) {
    const d = new Date(Date.UTC(2026, 8, 4 - i));
    const iso = d.toISOString().slice(0, 10);
    const title = PARTIES[i % PARTIES.length];
    const slug = `${slugify(title)}-${iso}`;
    const a = { i, venue: 'alcudia', slug, title, date: iso.split('-').reverse().join('.'), type: TYPES[i % TYPES.length], count: COUNTS[i], subs: [] };
    if (i === 6) a.type = 'plain';
    if (i === COUNTS.length - 1) {
      a.type = 'parent';
      a.title = 'BURNING WEST WEEKEND';
      a.subs = [
        { slug: `${slug}/night-1`, title: 'Night 1', type: 'button', count: 30, subs: [] },
        { slug: `${slug}/night-2`, title: 'Night 2', type: 'infinite', count: 26, subs: [] },
      ];
    }
    albums.push(a);
  }
  CALA.forEach(([title, count], j) => {
    const d = new Date(Date.UTC(2026, 8, 5 - j * 7));
    const iso = d.toISOString().slice(0, 10);
    albums.push({
      i: COUNTS.length + j,
      venue: 'cala-rajada',
      slug: `cala-rajada-${slugify(title)}-${iso}`,
      title,
      date: iso.split('-').reverse().join('.'),
      type: TYPES[(j + 2) % TYPES.length],
      count,
      subs: [],
    });
  });
  return albums;
}

// Albums of the overview for a venue tab (page 1 only; page 2 is server rendered).
function listFor(albums, venue) {
  const alc = albums.filter((a) => a.venue === 'alcudia').slice(0, 15);
  const cala = albums.filter((a) => a.venue === 'cala-rajada');
  return venue === 'cala-rajada' ? cala : venue === 'all' ? [...alc, ...cala] : alc;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const n4 = (n) => String(n).padStart(4, '0');
const full = (key, n) => `/img/full/${key}/IMG_${n4(n)}.png`;
const thumb = (key, n) => `/img/thumb/${key}/IMG_${n4(n)}.png`;
const nextImg = (key, n, w) => `/_next/image?url=${encodeURIComponent(full(key, n))}&w=${w}&q=75`;

function layout(title, body, script = '') {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(title)} | Banana Club Mallorca</title>
<style>
 body{font-family:sans-serif;margin:0} header{display:flex;gap:12px;align-items:center;padding:8px;background:#ffd400}
 .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px} .grid img{width:100%;height:220px;object-fit:cover;display:block}
 .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:12px} .card img{width:100%;height:260px;object-fit:cover}
 #cookie{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center;padding:40px;z-index:99}
 #cookie div{background:#fff;padding:20px} footer{padding:30px;background:#222;color:#fff} #sentinel{height:4px}
 aside{padding:12px} aside img{width:120px;height:80px;object-fit:cover}
</style></head><body>
<header><img src="/static/logo.png" alt="Banana Club" width="120" height="40">
<nav><a href="/">Home</a> <a href="/gallery">Galerie</a> <a href="/es/gallery">ES</a> <a href="/de/gallery">DE</a> <a href="/impressum">Impressum</a></nav></header>
<main>${body}</main>
<footer><img src="/static/icon-fb.png" width="24" height="24" alt="Facebook"> © Banana Club</footer>
<div id="cookie"><div>Wir verwenden Cookies. <button onclick="document.getElementById('cookie').remove()">Alle akzeptieren</button></div></div>
<script>${script}</script>
</body></html>`;
}

const cardHtml = (a) =>
  `<a class="card" href="/gallery/${a.slug}"><img src="/img/cover/${a.slug}.png" alt=""><h3>${esc(a.title)}</h3><time>${a.date}</time></a>`;

function photoHtml(type, key, n) {
  switch (type) {
    case 'button':
      return `<figure class="photo"><a href="${full(key, n)}" data-lightbox="album"><img class="lazy" src="/static/placeholder.gif" data-src="${thumb(key, n)}" alt=""></a></figure>`;
    case 'infinite':
      return `<div class="photo"><img loading="lazy" src="${thumb(key, n)}" srcset="${thumb(key, n)} 400w, ${full(key, n)} 1600w" sizes="25vw" alt=""></div>`;
    case 'next':
      return `<div class="photo"><img src="${nextImg(key, n, 640)}" srcset="${nextImg(key, n, 640)} 1x, ${nextImg(key, n, 1080)} 2x" alt=""></div>`;
    case 'download':
      return `<div class="card-photo"><img src="${thumb(key, n)}" alt=""><a class="dl" download href="/download/${key}/${n}">⬇ Download</a></div>`;
    case 'paged':
      return `<a href="${full(key, n)}"><img src="${thumb(key, n)}" alt=""></a>`;
    default:
      throw new Error(type);
  }
}

const BATCH = { button: 24, infinite: 15, next: 20, download: 10, paged: 20 };

function albumPage(a, related, query) {
  const key = a.slug;
  let body = `<h1>${esc(a.title)}</h1><p>${a.date || ''}</p>`;
  let script = '';
  if (a.type === 'plain') body += `<p>Fotos folgen in Kürze.</p>`;
  else if (a.type === 'parent') {
    body += `<div class="cards">${a.subs
      .map((s) => `<a class="card" href="/gallery/${s.slug}"><img src="/img/cover/${s.slug}.png" alt=""><span>${esc(s.title)}</span></a>`)
      .join('')}</div>`;
  } else if (a.type === 'paged') {
    const pages = Math.max(1, Math.ceil(a.count / BATCH.paged));
    const p = Math.min(pages, Math.max(1, Number(query.get('page') || 1)));
    const from = (p - 1) * BATCH.paged + 1;
    const to = Math.min(a.count, p * BATCH.paged);
    let photos = '';
    for (let n = from; n <= to; n++) photos += photoHtml('paged', key, n);
    const nav = Array.from({ length: pages }, (_, i) => `<a href="/gallery/${key}?page=${i + 1}">${i + 1}</a>`).join(' ');
    body += `<div class="grid">${photos}</div><nav class="pagination">${nav}${p < pages ? ` <a rel="next" href="/gallery/${key}?page=${p + 1}">Weiter ›</a>` : ''}</nav>`;
  } else {
    const first = Math.min(a.count, BATCH[a.type]);
    let photos = '';
    for (let n = 1; n <= first; n++) photos += photoHtml(a.type, key, n);
    body += `<div class="grid" id="grid">${photos}</div>`;
    const api = `/api/albums/${key}/photos`;
    const tpl = `(${photoHtml.toString()})`;
    const helpers = `const n4=${n4.toString()};const full=${full.toString()};const thumb=${thumb.toString()};const nextImg=${nextImg.toString()};`;
    const append = `${helpers}const photoHtml=${tpl};let offset=${first};const total=${a.count};
      async function more(){const r=await fetch('${api}?offset='+offset+'&limit=${BATCH[a.type]}');const j=await r.json();
        const g=document.getElementById('grid');for(const n of j.photos){g.insertAdjacentHTML('beforeend',photoHtml('${a.type}','${key}',n));}
        offset+=j.photos.length;lazy();return j.hasMore;}
      function lazy(){document.querySelectorAll('img.lazy[data-src]').forEach(img=>io.observe(img));}
      const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){const i=e.target;i.src=i.dataset.src;i.removeAttribute('data-src');io.unobserve(i);}}));
      lazy();`;
    const has = first < a.count;
    if (a.type === 'button') {
      body += has ? `<button id="more" class="btn">Mehr laden</button>` : '';
      script = `${append}const b=document.getElementById('more');if(b)b.onclick=async()=>{b.disabled=true;b.textContent='Lädt…';const h=await more();if(h){b.disabled=false;b.textContent='Mehr laden';}else b.remove();};`;
    } else if (a.type === 'next') {
      body += has ? `<div class="actions"><button type="button" id="more">Load more photos</button></div>` : '';
      script = `${append}const b=document.getElementById('more');if(b)b.addEventListener('click',async()=>{const h=await more();if(!h)b.style.display='none';});`;
    } else if (a.type === 'download') {
      body += has ? `<p><a href="#" class="load-more">Ver más fotos</a></p>` : '';
      script = `${append}const b=document.querySelector('.load-more');if(b)b.onclick=async(e)=>{e.preventDefault();const h=await more();if(!h)b.remove();};`;
    } else if (a.type === 'infinite') {
      body += `<div id="sentinel"></div>`;
      script = `${append}let busy=false,done=${!has};const s=document.getElementById('sentinel');
        new IntersectionObserver(async es=>{if(es[0].isIntersecting&&!busy&&!done){busy=true;done=!(await more());busy=false;}}).observe(s);`;
    }
  }
  if (related.length) body += `<aside><h4>Mehr Events</h4>${related.map(cardHtml).join('')}</aside>`;
  return layout(a.title, body, script);
}

function galleryPage(albums, page) {
  const FIRST = 6;
  const alc = albums.filter((a) => a.venue === 'alcudia');
  const nav = `<nav class="pagination"><a href="/gallery?page=1">1</a> <a href="/gallery?page=2">2</a>${page === 1 ? ' <a rel="next" href="/gallery?page=2">Weiter ›</a>' : ''}</nav>`;
  if (page === 2) return layout('Fotogalerie – Seite 2', `<h1>Fotogalerie</h1><div class="cards">${alc.slice(15).map(cardHtml).join('')}</div>${nav}`);
  const tabs = `<div class="gallery-filter" role="tablist">
      <button role="tab" data-venue="alcudia" aria-selected="true">Alcúdia</button>
      <button role="tab" data-venue="cala-rajada">Cala Rajada</button></div>`;
  const body = `<h1>Fotogalerie</h1>${tabs}<div class="cards" id="cards">${listFor(albums, 'alcudia').slice(0, FIRST).map(cardHtml).join('')}</div>
    <div class="load-more-wrap"><button class="btn-load">Mehr laden</button></div>${nav}`;
  const script = `const card=${cardHtml.toString()};const esc=${esc.toString()};let venue='alcudia';let offset=${FIRST};
    const wrap=document.querySelector('.load-more-wrap');const c=document.getElementById('cards');
    async function load(n){const r=await fetch('/api/albums?venue='+venue+'&offset='+offset+'&limit='+n);const j=await r.json();
      j.items.forEach(a=>c.insertAdjacentHTML('beforeend',card(a)));offset+=j.items.length;wrap.style.display=j.hasMore?'':'none';}
    document.querySelector('.btn-load').addEventListener('click',()=>load(4));
    document.querySelectorAll('[role=tab]').forEach(t=>t.addEventListener('click',()=>{
      document.querySelectorAll('[role=tab]').forEach(x=>x.setAttribute('aria-selected',String(x===t)));
      venue=t.dataset.venue;offset=0;c.innerHTML='';load(${FIRST});}));`;
  return layout('Fotogalerie', body, script);
}

export async function startFixtureSite({ latency = [40, 220] } = {}) {
  const albums = buildAlbums();
  const all = new Map();
  const walk = (a) => {
    all.set(a.slug, a);
    a.subs.forEach(walk);
  };
  albums.forEach(walk);
  const requests = [];
  const delay = () => new Promise((r) => setTimeout(r, latency[0] + Math.random() * (latency[1] - latency[0])));

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/';
    requests.push(p + u.search);
    const send = (code, type, body, headers = {}) => {
      res.writeHead(code, { 'content-type': type, ...headers });
      res.end(body);
    };
    const html = (s) => send(200, 'text/html; charset=utf-8', s);
    let m;
    if (p === '/' || p === '/impressum') return html(layout('Banana Club', '<h1>Banana Club Mallorca</h1>'));
    if (/^\/(es|de|en)?\/?gallery$/.test(p) || p === '/gallery') return html(galleryPage(albums, Number(u.searchParams.get('page') || 1)));
    if (p === '/api/albums') {
      await delay();
      const off = Number(u.searchParams.get('offset'));
      const lim = Number(u.searchParams.get('limit'));
      const list = listFor(albums, u.searchParams.get('venue') || 'alcudia');
      const items = list.slice(off, off + lim);
      return send(200, 'application/json', JSON.stringify({ items, hasMore: off + lim < list.length }));
    }
    if ((m = /^\/api\/albums\/(.+)\/photos$/.exec(p))) {
      await delay();
      const a = all.get(m[1]);
      if (!a) return send(404, 'application/json', '{}');
      const off = Number(u.searchParams.get('offset'));
      const lim = Number(u.searchParams.get('limit'));
      const photos = [];
      for (let n = off + 1; n <= Math.min(a.count, off + lim); n++) photos.push(n);
      return send(200, 'application/json', JSON.stringify({ photos, hasMore: off + lim < a.count }));
    }
    if ((m = /^\/gallery\/(.+)$/.exec(p))) {
      const a = all.get(m[1]);
      if (!a) return send(404, 'text/html', '<h1>404</h1>');
      const same = albums.filter((x) => x.venue === a.venue);
      const top = same.indexOf(a);
      const related = top >= 0 ? [same[(top + 1) % same.length], same[(top + 2) % same.length]] : [];
      return html(albumPage(a, related, u.searchParams));
    }
    if ((m = /^\/img\/(full|thumb)\/(.+)\/IMG_(\d+)\.png$/.exec(p))) {
      const a = all.get(m[2]);
      const n = Number(m[3]);
      if (!a || n < 1 || n > a.count) return send(404, 'text/plain', 'nope');
      return m[1] === 'full' ? send(200, 'image/png', png(160, 120, `full:${m[2]}:${n}`)) : send(200, 'image/png', png(40, 30, `thumb:${m[2]}:${n}`));
    }
    if ((m = /^\/img\/cover\/(.+)\.png$/.exec(p))) return send(200, 'image/png', png(80, 60, `cover:${m[1]}`));
    if (p === '/_next/image') {
      const inner = /^\/img\/full\/(.+)\/IMG_(\d+)\.png$/.exec(u.searchParams.get('url') || '');
      if (!inner) return send(400, 'text/plain', 'bad');
      return send(200, 'image/png', png(64, 48, `next${u.searchParams.get('w')}:${inner[1]}:${Number(inner[2])}`));
    }
    if ((m = /^\/download\/(.+)\/(\d+)$/.exec(p))) {
      const a = all.get(m[1]);
      const n = Number(m[2]);
      if (!a || n < 1 || n > a.count) return send(404, 'text/plain', 'nope');
      const fname = `BANANA_${m[1].replace(/\//g, '_')}_${n4(n)}.png`;
      return send(200, 'application/octet-stream', png(160, 120, `full:${m[1]}:${n}`), { 'content-disposition': `attachment; filename="${fname}"` });
    }
    if (p === '/static/logo.png') return send(200, 'image/png', png(120, 40, 'chrome:logo'));
    if (p === '/static/icon-fb.png') return send(200, 'image/png', png(24, 24, 'chrome:fb'));
    if (p === '/static/placeholder.gif') return send(200, 'image/gif', GIF_1PX);
    return send(404, 'text/html', '<h1>404</h1>');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  // Expected: every photo of every (sub-)album, as "full:<key>:<n>" markers.
  const expected = new Map();
  for (const a of all.values()) {
    if (a.type === 'parent') continue;
    expected.set(a.slug, Array.from({ length: a.count }, (_, i) => `full:${a.slug}:${i + 1}`));
  }
  return {
    url,
    albums,
    expected,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

// `node test/fixture-site.js` starts the site for manual runs.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const site = await startFixtureSite();
  const total = [...site.expected.values()].reduce((s, v) => s + v.length, 0);
  console.log(`Fixture-Galerie läuft auf ${site.url}/gallery  (${site.expected.size} Alben, ${total} Fotos)`);
}
