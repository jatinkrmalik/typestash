# Roadmap

Where Typestash is heading. Nothing here has a date: it's a list of directions, roughly in
the order I expect to work on them. Ideas, votes and pull requests are welcome in
[issues](https://github.com/jatinkrmalik/typestash/issues).

Status: 🔨 next up · 🧭 planned · 💭 exploring

## 1. Your own font registry 🔨

The big one. Serve the fonts in your library as web fonts to your own sites and projects,
from your own server, the way Google Fonts works, but for fonts you own.

- **Publish a family** with one switch. Only published families are served, and the library
  itself stays private.
- **A stylesheet URL per family**, Google Fonts style: `/css?family=Fraunces:wght@400..700&display=swap`,
  generating `@font-face` rules (variable fonts included).
- **WOFF2 on the fly**, split into per-script `unicode-range` subsets so browsers only fetch
  what a page needs. Long-lived, versioned URLs and correct CORS headers.
- **Licence guard rails:** read each font's embedding permissions (`fsType`) and licence
  text, warn before publishing a font that doesn't allow web use, and keep OFL and Apache
  fonts one click away.
- **A public, read-only endpoint** that can sit behind a cache or CDN on its own hostname,
  separate from the private library.
- Copy-paste snippets for HTML, CSS `@import`, Tailwind and Next.js.

## 2. Organise better 🧭

- **Tags and smart collections**, for example "variable serif with italics".
- **Multi-select and bulk actions:** add many fonts to a collection, recategorise or download
  them at once.
- **Licence and purchase tracking:** attach the licence file, receipt, seats and where a
  font is used to each family, with a filter for "licensed for web" or "desktop only".
- **Versions:** spot the same family in different versions, and pick which one wins.
- **A merge assistant** for duplicates, with the same promise as today: nothing is
  deleted without you saying so.
- **Watch the fonts folder** and pick up changes instantly instead of on the rescan timer.

## 3. Find the right font faster 🧭

- **"Fonts that have…"** search: a character (₹, ß, ŋ), a language, an OpenType feature, or
  a variable axis.
- **Similar fonts:** show the closest matches to the family you're looking at, from your own
  library.
- **Language coverage report:** which languages each family fully supports.
- **Better pairing:** contrast and harmony hints, and saved pairings you can share.

## 4. Use your fonts everywhere 💭

- **Desktop sync:** a small helper for macOS, Windows and Linux that installs a collection
  locally and keeps it in sync, so a project's fonts follow you to any machine.
- **API and tokens** for scripts and other tools, plus a tiny CLI (`typestash pull "Inter"`).
- **Design tool plugins** (Figma first) to browse and use your library inside the tool.
- **Exports:** download a family as WOFF2, TTF or a static instance of a variable font at a
  chosen weight.

## 5. Share and collaborate 💭

- **Share links** for a family, collection or specimen, read-only and optionally expiring,
  so a client can see the shortlist without an account.
- **Users and roles** with SSO (OIDC, for Authelia, Authentik and friends) for teams and
  studios.
- **Specimen templates:** posters and sheets you can design once and export for any family.

## 6. Run it anywhere 🧭

- App-store listings: Unraid Community Apps, TrueNAS, CasaOS, Umbrel, Synology.
- A Helm chart for Kubernetes.
- Performance work for very large libraries (50,000+ files): incremental indexing and
  thumbnail caching.
- Translations of the interface.

## Done

- **On main, next release:** a welcome tour on first visit (replay it from Settings), a demo
  tour button, the tour video on the website.
- **0.3:** website and a 445-family live demo, phone and foldable layouts, pinned card
  footers, an end-to-end test suite in CI.
- **0.2:** twelve themes, side-by-side compare with metrics, a command bar, preview presets
  and a Scripts menu, a brand row on specimen PNGs.
- **0.1:** the library itself: gallery, family pages, glyph maps, collections, uploads,
  Docker images for amd64 and arm64.
