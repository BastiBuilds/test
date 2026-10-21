import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSrcset,
  upgradeCandidates,
  pickAlbumLinks,
  pickChildLinks,
  isPaginationOf,
  mergeItems,
  fileNameFor,
  stripLocale,
  slugFor,
} from '../src/urls.js';
import { sniffImage } from '../src/downloader.js';

test('parseSrcset: Breiten, Dichten und Kommas in URLs', () => {
  assert.deepEqual(parseSrcset('a.jpg 400w, b.jpg 1600w'), [
    { url: 'a.jpg', w: 400 },
    { url: 'b.jpg', w: 1600 },
  ]);
  assert.deepEqual(parseSrcset('x.jpg 1x,y.jpg 2x'), [
    { url: 'x.jpg', w: 1000 },
    { url: 'y.jpg', w: 2000 },
  ]);
  const cl = parseSrcset('https://c.example/w_300,c_fill/a.jpg 300w, https://c.example/w_900,c_fill/a.jpg 900w');
  assert.equal(cl[1].url, 'https://c.example/w_900,c_fill/a.jpg');
  assert.equal(cl[1].w, 900);
});

test('upgradeCandidates: Next.js-Bildproxy und WordPress-Thumbnails → Original zuerst', () => {
  assert.deepEqual(upgradeCandidates('https://s.es/_next/image?url=%2Fup%2Fa.jpg&w=640&q=75'), [
    'https://s.es/up/a.jpg',
    'https://s.es/_next/image?url=%2Fup%2Fa.jpg&w=640&q=75',
  ]);
  assert.deepEqual(upgradeCandidates('https://s.es/wp-content/uploads/foto-300x200.jpg'), [
    'https://s.es/wp-content/uploads/foto.jpg',
    'https://s.es/wp-content/uploads/foto-300x200.jpg',
  ]);
  assert.deepEqual(upgradeCandidates('https://s.es/a.jpg'), ['https://s.es/a.jpg']);
});

test('pickAlbumLinks: nur Alben unter /gallery, ohne Sprachvarianten/Paginierung/Bilder', () => {
  const g = 'https://www.bananaclub.es/gallery';
  const links = [
    { href: 'https://www.bananaclub.es/gallery/disco-51-2026-09-04', text: 'DISCO 51\n04.09.2026', hasImage: true },
    { href: 'https://bananaclub.es/es/gallery/disco-51-2026-09-04', text: '', hasImage: true }, // same album, other locale/host
    { href: 'https://www.bananaclub.es/gallery/glow-safari-2026-09-03#top', text: 'GLOW SAFARI', hasImage: true },
    { href: 'https://www.bananaclub.es/es/gallery', text: 'ES' },
    { href: 'https://www.bananaclub.es/gallery?page=2', text: '2' },
    { href: 'https://www.bananaclub.es/gallery/page/3', text: '3' },
    { href: 'https://www.bananaclub.es/gallery/x/IMG_1.jpg', text: '' },
    { href: 'https://www.bananaclub.es/parties/duro', text: 'DURO' },
    { href: 'https://www.instagram.com/gallery/abc', text: 'insta' },
  ];
  const got = pickAlbumLinks(links, g);
  assert.deepEqual(
    got.map((a) => [a.url, a.title]),
    [
      ['https://www.bananaclub.es/gallery/disco-51-2026-09-04', 'DISCO 51 · 04.09.2026'],
      ['https://www.bananaclub.es/gallery/glow-safari-2026-09-03', 'GLOW SAFARI'],
    ],
  );
  // custom pattern
  const custom = pickAlbumLinks(links, g, { albumPattern: /\/parties\// });
  assert.deepEqual(custom.map((a) => a.url), ['https://www.bananaclub.es/parties/duro']);
});

test('pickAlbumLinks: Fallback wenn Alben nicht unter dem Galerie-Pfad liegen', () => {
  const got = pickAlbumLinks(
    [
      { href: 'https://s.es/fotos/party-1', text: 'Party 1', hasImage: true },
      { href: 'https://s.es/kontakt', text: 'Kontakt', hasImage: false },
    ],
    'https://s.es/gallery',
  );
  assert.deepEqual(got.map((a) => a.url), ['https://s.es/fotos/party-1']);
});

test('pickChildLinks: Unteralben (Karten mit Bild) unterhalb des Albums', () => {
  const got = pickChildLinks(
    [
      { href: 'https://s.es/gallery/a/night-1', text: 'Night 1', hasImage: true },
      { href: 'https://s.es/gallery/a?page=2', text: '2', hasImage: false },
      { href: 'https://s.es/gallery/b', text: 'B', hasImage: true },
      { href: 'https://s.es/gallery/a/info', text: 'Info', hasImage: false },
    ],
    'https://s.es/gallery/a',
  );
  assert.deepEqual(got.map((a) => a.url), ['https://s.es/gallery/a/night-1']);
});

test('isPaginationOf', () => {
  assert.equal(isPaginationOf('https://s.es/gallery?page=2', 'https://s.es/gallery'), true);
  assert.equal(isPaginationOf('https://s.es/gallery/page/2', 'https://s.es/gallery'), true);
  assert.equal(isPaginationOf('https://s.es/es/gallery?page=2', 'https://s.es/gallery'), true);
  assert.equal(isPaginationOf('https://s.es/gallery/album', 'https://s.es/gallery'), false);
  assert.equal(isPaginationOf('https://s.es/gallery?sort=new', 'https://s.es/gallery'), false);
  assert.equal(isPaginationOf('https://s.es/gallery', 'https://s.es/gallery'), false);
});

test('mergeItems: Lazy-Loading-Snapshots desselben Fotos werden zusammengeführt, bestes zuerst', () => {
  const merged = mergeItems([
    { cands: [{ url: 'thumb1', score: 5000, via: 'data-src' }], linkHref: null },
    { cands: [{ url: 'thumb2', score: 5000, via: 'data-src' }], linkHref: null },
    {
      cands: [
        { url: 'full1', score: 1e9, via: 'link' },
        { url: 'thumb1', score: 3000, via: 'currentSrc' },
      ],
      linkHref: null,
    },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].url, 'full1');
  assert.deepEqual(merged[0].alts, ['thumb1']);
  assert.equal(merged[1].url, 'thumb2');
});

test('fileNameFor: Endung aus echtem Bildtyp, Content-Disposition bevorzugt', () => {
  assert.equal(fileNameFor('https://s.es/download/a/12', 'image/png', 'attachment; filename="BANANA_12.png"'), 'BANANA_12.png');
  assert.equal(fileNameFor('https://s.es/download/a/12', 'image/jpeg', ''), '12.jpg');
  assert.equal(fileNameFor('https://s.es/x/IMG_1.jpg', 'image/webp', ''), 'IMG_1.webp');
  assert.equal(fileNameFor('https://s.es/x/IMG_1.JPEG', 'image/jpeg', ''), 'IMG_1.JPEG');
});

test('stripLocale / slugFor', () => {
  assert.equal(stripLocale('/es/gallery/x/'), '/gallery/x');
  assert.equal(stripLocale('/cala-rajada/gallery'), '/cala-rajada/gallery');
  assert.equal(slugFor('https://s.es/de/gallery/disco-51-2026-09-04'), 'disco-51-2026-09-04');
});

test('sniffImage erkennt echte Bilder und lehnt HTML ab', () => {
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('<!doctype html><html>')), null);
});
