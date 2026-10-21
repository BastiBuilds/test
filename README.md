# Banana Club Mallorca – Fotogalerie-Downloader

Lädt **alle Bilder aller Alben (Sub-Events)** der [Banana Club Fotogalerie](https://www.bananaclub.es/gallery)
herunter – **Alcúdia, Cala Rajada & Co.** – auch alle Bilder, die erst per **„Mehr laden“**, **Endlos-Scroll**,
über **Seitenzahlen** oder nach Klick auf einen **Standort-Tab/Filter** erscheinen.

## Schnellstart

```bash
npm install
npx playwright install chromium   # einmalig, lädt den Browser
npm start                         # = node src/cli.js
```

Die Bilder landen in `./downloads/<Album-Titel [album-slug]>/…`, dazu:

- `downloads/index.html` – Übersicht aller geladenen Bilder (im Browser öffnen)
- `downloads/manifest.json` – jedes Album, jede Bild-URL, Datei, Status

Abbrechen und erneut starten ist jederzeit möglich: Bereits geladene Bilder werden übersprungen.

## Wie es funktioniert

1. Öffnet die Galerie in einem echten (headless) Chromium, akzeptiert den Cookie-Banner.
   Standard-Startseiten: `https://www.bananaclub.es/gallery` und `https://www.bananaclub.es/cala-rajada/gallery`
   (die zweite nur, falls es sie gibt – HTTP 404 wird übersprungen; doppelte Alben werden nur einmal geladen).
2. Scrollt bis ganz nach unten und klickt **„Mehr laden“ / „Load more“ / „Cargar más“ / „Ver más“ …** so lange,
   bis keine neuen Alben mehr erscheinen. Seitenzahlen (`?page=2`, `/page/2`) werden ebenfalls verfolgt.
   Danach wird **jeder Standort-/Kategorie-Filter** der Übersicht angeklickt (Tabs wie „Alle | Alcúdia | Cala Rajada“,
   Filter-Buttons, Dropdowns, Filter-Links wie `?location=…`) und jeweils wieder bis zum Ende „Mehr laden“ geklickt.
3. Erkennt alle Album-Links (`/gallery/<album>`, auch in anderen Sprachversionen `/es/gallery/…`).
4. Öffnet jedes Album und macht dort dasselbe (scrollen, „Mehr laden“, Seiten), bis wirklich alle Fotos geladen sind.
   Unteralben werden ebenfalls verfolgt.
5. Wählt pro Foto die **größte verfügbare Version**: Lightbox-/Download-Link → `data-full`/`data-original` →
   größte `srcset`-Variante → `src`. Next.js-Bildproxy-URLs (`/_next/image?url=…`) werden zum Original aufgelöst.
6. Lädt parallel herunter (mit Wiederholungen bei Fehlern), prüft, dass es wirklich Bilddateien sind,
   und erkennt doppelte Dateien. Logo, Icons, Album-Cover und Lazy-Load-Platzhalter werden ignoriert.

## Optionen

```
--url <URL>            Galerie-Startseite (mehrfach möglich). Standard: /gallery + /cala-rajada/gallery
--out <Ordner>         Zielordner. Standard: ./downloads
--concurrency <n>      Parallele Bild-Downloads. Standard: 8
--pages <n>            Parallel geöffnete Album-Seiten. Standard: 3
--max-albums <n>       Nur die ersten n Alben (zum Ausprobieren)
--depth <n>            Tiefe für Unteralben (1 = nur Alben). Standard: 2
--album-pattern <re>   Regex für Album-Links, falls die automatische Erkennung nicht passt
--load-more <re>       Regex für den "Mehr laden"-Button
--filter <re>          Regex für Filter/Tabs der Übersicht (Standard: Alle, Alcúdia, Cala Rajada, …)
--dry-run              Nur auflisten (manifest.json), nichts herunterladen
--headful              Browser sichtbar starten (zum Zuschauen/Debuggen)
--proxy <URL>          HTTP(S)-Proxy
```

Beispiele:

```bash
node src/cli.js --max-albums 2 --headful           # erst mal zuschauen, ob alles klappt
node src/cli.js --dry-run                           # nur zählen, was es gibt
node src/cli.js --url https://www.bananaclub.es/gallery --url https://www.bananaclub.es/es/gallery
```

## Tests

```bash
npm test
```

- `test/urls.test.js` – Unit-Tests (srcset, Album-Erkennung, Paginierung, Dateinamen, Bild-Erkennung …)
- `test/e2e.test.js` – Ende-zu-Ende mit echtem Chromium gegen eine lokale Nachbildung der Galerie
  (`test/fixture-site.js`). Die Nachbildung enthält: 18 Alcúdia-Alben mit AJAX-„Mehr laden“ plus Seite 2 in der
  Übersicht, 8 Cala-Rajada-Alben, die **nur über den Standort-Tab** erscheinen (mit eigenem „Mehr laden“),
  einen Cookie-Banner, Alben mit „Mehr laden“-Button, Endlos-Scroll, Next.js-Bildproxy, Download-Buttons,
  Seitenzahlen, ein leeres Album und ein Album mit Unteralben. Insgesamt 874 Fotos. Geprüft wird, dass
  **jedes einzelne Foto in voller Größe** im richtigen Ordner liegt, dass kein Logo, Icon oder Thumbnail
  dabei ist und dass ein zweiter Lauf nichts doppelt lädt.

Die Nachbildung lässt sich auch manuell starten: `node test/fixture-site.js`.
