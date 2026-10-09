# ROADMAP — `@nera-static/plugin-images`

Responsive, modern-format images for Nera, generated at build time. It works like Statamic's Glide, but for a static site: every variant is produced during `nera build`, not on request.

**This file is the single source of truth for the plugin and for the core hook it needs. Extend it; never start a parallel document.** Each slice below is sized for one session. Work through them in order, tick the checkboxes, and add a dated `**Done YYYY-MM-DD**` note with anything learned. The next session reads this file first and continues where the last one stopped.

Written 2026-10-09. Scope was agreed in conversation: everything below. Pug-layout helpers that generate at render time, art direction and remote images are **out of scope** (see "Not in scope").

---

## The problem

`generator/src/core.js` renders Markdown with `markdown-it` (`html: true`), so

```md
![Startseite der ZerpenSafari …](/images/blog/2026/zerpensafari-iphone.jpg)
```

becomes a bare `<img src="…" alt="…">`. Phones download the full original, there is no AVIF/WebP, no `width`/`height` (layout shift), no lazy loading, and camera EXIF (including GPS) ships to every visitor.

## The goal

The same Markdown renders to:

```html
<picture>
    <source type="image/avif" srcset="/_img/zerpensafari-iphone-3f9a1c2e-480.avif 480w, /_img/zerpensafari-iphone-3f9a1c2e-800.avif 800w, …" sizes="100vw">
    <source type="image/webp" srcset="… 480w, … 800w, …" sizes="100vw">
    <img src="/_img/zerpensafari-iphone-3f9a1c2e-1200.jpg"
         srcset="… 480w, … 800w, … 1200w"
         sizes="100vw" width="1200" height="2600"
         alt="Startseite der ZerpenSafari …"
         loading="lazy" decoding="async">
</picture>
```

The author changes nothing. Per-image control is available through Glide-style query parameters (`?w=800&ratio=16:9`), a Markdown title becomes a `<figure>` caption, and frontmatter images (cover, `og:image`) get precomputed variants for templates.

---

## Verified facts this design rests on (2026-10-09, core 4.12.0)

- **Plugins see rendered HTML.** In `getMetaData`, `pagesData[i].content` is markdown-it output. `nera-plugin-link-attributes` already rewrites it with cheerio (`load(content, null, false)`). The content pass needs no core change.
- **Plugins cannot write to `public/`.** `src/index.js` runs `getPluginsData` *before* `deleteFolder(dist)`, so anything a plugin writes there is deleted. That is why the core hook (slice 1) exists.
- **Hooks are awaited** since core 4.3.0, so this plugin may be `async`. It needs core ≥ 4.13.0 (slice 1) anyway, so the "keep hooks synchronous for old clones" caution does not apply.
- **`base_path` already handles `srcset`.** `rewriteHtmlUrls` (`render.js:53`) and the hashing pass (`render.js:255`) both rewrite `srcset` lists. Root-absolute URLs emitted by the plugin are correct on subdirectory deploys without extra work.
- **The asset folder is `app.folders.assets`**, not a literal `assets/`. The field-test site uses the `theme/` layout (`theme/assets/images/blog/…`). A theme package's assets are resolvable via `resolveTheme({ app })` from `@nera-static/core/theme` (`.assetsRoot`).
- **`nera dev` watches `pages/`, `config/` and the presentation folders only** (`nera-cli/src/commands/dev.js#watchTargets`). A cache folder at the site root is not watched, so it cannot cause a rebuild loop. Changing a source image under `assets/` *does* trigger a rebuild. That is correct.
- **`@nera-static/validate` output rules see the final page.** `a11y-img-alt` keeps working because the `<img>` inside `<picture>` keeps its `alt`. The privacy rule checks `img[src|srcset]` hosts, and the plugin only emits local URLs.
- **`sharp`** 0.35.x (engines `node >=20.9.0`), with prebuilt libvips for macOS/Linux/Windows on x64 and arm64. It matches the fleet's Node ≥ 20 floor. (The package's own floor is `>=20.18.1`, set by `cheerio` 1.2; see slice 0.)
- **The npm name is free.** `@nera-static/plugin-images` returns 404 on the registry.

---

## Decisions

### D1 — Build-time generation with `sharp`
Static output only, with no runtime image server. `sharp` is a regular `dependency`, not optional: the plugin is useless without it.

### D2 — Core hook: `getAssets` (slice 1)
A third optional plugin export, additive to the contract:

```js
export async function getAssets({ app, pagesData }) {
    return [{ from: '/abs/path/to/.nera-cache/images/files', to: '_img' }]
}
```

- Called **after** every plugin's `getAppData`/`getMetaData` has run, in plugin order, with the final `app`/`pagesData`. The plugin has done its work by then and knows which files it produced.
- Returns an array of `{ from, to }`. `from` is an absolute file or directory. `to` is a path relative to `public/`.
- Core copies all entries **after the theme's assets and before the site's assets**: theme → plugins → site. The site wins on a collision, consistent with "the site always overrides". No `.neraignore` filtering (the payload is plugin-controlled, like the theme pass, `ignoreBase = null`).
- Runs before `rewriteAssetUrls` and `hashAssetUrls`, so `base_path` prefixing and `?v=` hashing cover plugin assets automatically.
- Validation matches the other hooks. A non-array result is discarded with a warning. An entry with a missing `from`, an absolute `to`, or a `to` that escapes `public/` (`..`) is skipped with a warning. The build continues.
- The hook is generic. Future plugins (OG-image generator, favicons, sitemap assets) use the same mechanism.

Semver: **minor** for `@nera-static/core` (4.13.0).

### D3 — Output URLs and file names
- Default output path `/_img/` (config `output_path`).
- File name: `<basename>-<hash8>-<width>.<ext>`. `hash8` is the first 8 hex chars of a sha256 over *source bytes + normalized transform params + plugin cache version*. Same input gives the same name, so URLs are stable across builds and safe to cache forever.

### D4 — Cache
- Location: `.nera-cache/images/` at the site root (config `cache_dir`). It holds `files/` (the variants, returned via `getAssets`) and `manifest.json` (key → `{ width, height, files[], color?, blur? }`).
- A variant is only encoded when its file is missing. Every build re-hashes the source bytes. That is cheap compared to encoding; measure it in slice 7 and add an mtime+size shortcut only if needed.
- **Pruning** (config `prune: true`, default): after a build, delete variants and manifest entries not used by this build. Builds are always full, so "unused this build" means "unused".
- Add `.nera-cache` to the CLI's scaffold `_gitignore` (`nera-cli/template/_gitignore`) in slice 8. Document CI caching (`actions/cache` on `.nera-cache`) in the README.

### D5 — Which images are processed
- **Processed:** local URLs (root-absolute or page-relative) resolving to `.jpg/.jpeg/.png/.webp/.avif/.tif/.tiff` under the site assets folder, falling back to the theme's `assetsRoot`. `base_path` is stripped before resolving.
- **Left untouched:** `.svg`, `.gif` (animation), external `http(s)://` and protocol-relative URLs, `data:` URIs, an `<img>` already inside `<picture>`, an `<img>` with a `srcset` already set, an `<img>` carrying `data-nera-skip` (the attribute is removed from output), and unresolvable files (warning naming the page and the URL, `<img>` left as-is).
- Raw HTML `<img>` inside Markdown is treated like Markdown images. It is the same HTML by the time the plugin sees it.

### D6 — Output contract
- `<picture>` with one `<source>` per configured modern format, plus an `<img>` fallback in the **source's own format** (jpeg→jpeg, png→png, webp→webp, avif→jpeg). The fallback `src` points at a **processed** variant, never the original file.
- `width`/`height` on `<img>` always reflect the largest emitted variant's intrinsic size (aspect ratio is what matters for CLS).
- `loading="lazy"` + `decoding="async"` on every image, except the **first image of each page** when `eager_first: true` (default): it gets `loading="eager"` + `fetchpriority="high"` instead.
    - *Refined 2026-10-09 (slice 3, agreed with the user):* "first image" means the first image the plugin **rewrites**. An untouched SVG or external image before it does not count. An author's own `loading`/`decoding`/`fetchpriority` on a raw HTML `<img>` wins: the author's `loading` picks the mode, and the plugin only fills in the missing hints of that mode.
- All existing attributes on the original `<img>` (`alt`, `class`, `id`, `title` unless consumed by D8, `data-*`) are preserved on the new `<img>`. A missing `alt` stays missing: that is `a11y-img-alt`'s job to report, not the plugin's to invent.
- Widths are never upscaled. Candidates above the source width are dropped, and the source width itself is added if every configured width exceeds it.
- Metadata: `sharp` applies EXIF orientation (`.rotate()`) and strips all metadata on output (its default; never call `.withMetadata()`). ICC is converted to sRGB.
- BEM classes on the generated wrapper elements (`figure.nera-image`, `figcaption.nera-image__caption`) are part of the public contract. Renaming them later is a **major**.

### D7 — Per-image options via query parameters (slice 4)
Markdown attribute syntax would need a markdown-it plugin in core, and the plugin only sees HTML. Query strings survive rendering untouched, and they match Glide's URL-parameter model.

| Param | Meaning | Example |
|---|---|---|
| `w` | max display width in px. Candidates: config widths `< w`, plus `w` and `2w` (retina), capped at source. Default `sizes` becomes `(min-width: {w}px) {w}px, 100vw` | `?w=800` |
| `h` | target height (with `w`, implies a crop by `fit`) | `?w=800&h=450` |
| `ratio` | crop to aspect ratio, `W:H` | `?ratio=16:9` |
| `fit` | `cover` (default when cropping) / `contain` / `inside` | `?fit=contain` |
| `focus` | crop focal point in percent, `x,y` (Glide `crop-x-y`); default `50,50`; `attention`/`entropy` map to sharp strategies | `?focus=30,60` |
| `q` | quality override (all formats) | `?q=60` |
| `formats` | override modern formats, `none` = plain `<img>` with `srcset` only | `?formats=webp` |
| `sizes` | override `sizes` (URL-encoded) | `?sizes=50vw` |
| `loading` | `eager` / `lazy`, overrides D6 | `?loading=eager` |
| `skip` | leave this image completely untouched | `?skip` |

Unknown parameters produce a warning (page + URL) and are ignored. All recognized parameters are removed from the emitted URLs. Invalid values (e.g. `w=abc`) produce a warning and fall back to defaults.

### D8 — `<figure>` from the Markdown title (slice 4)
`![alt](src "Caption")` sets `title="Caption"` on the `<img>`. With `figure: title` (default) that becomes:

```html
<figure class="nera-image"><picture>…</picture><figcaption class="nera-image__caption">Caption</figcaption></figure>
```

and the `title` attribute is dropped (a duplicated tooltip helps nobody). `figure: false` disables it. markdown-it wraps a lone image in `<p>`, and `<figure>` inside `<p>` is invalid HTML. When the image is the paragraph's only child, the plugin **replaces the `<p>`**. Otherwise (image inline with text) it emits no figure and keeps the title.

### D9 — Frontmatter images (slice 5)
Config `frontmatter_keys` (default `[image]`). For each listed key holding a local image path, the plugin generates variants and writes

```js
meta.images = {
    image: {
        src, srcset, sizes, width, height, type,       // fallback img
        sources: [{ type: 'image/avif', srcset }, …],  // modern formats
        og: { src, width, height },                    // when og preset enabled
        color?, blur?                                   // when placeholders enabled
    }
}
```

**The original `meta.image` string is never modified.** Existing templates and plugins (`canonical-links`, social) keep working; replacing a string with an object would be a breaking change for every site. A shipped Pug mixin (`views/vendor/plugin-images/picture.pug`, published via `npm run publish-template` / `nera-images` bin) renders `+picture(meta.images.image, { alt, class, loading })`. That is pure markup from precomputed data, not render-time generation.

The `og` preset (config `og: { width: 1200, height: 630, fit: cover }`, `og: false` disables it) produces one JPEG for `og:image`.

### D10 — Placeholders (slice 6)
Config `placeholder: none | color | blur` (default `none`).
- `color`: dominant color (`sharp().stats().dominant`), emitted as `style="background-color:#rrggbb"` on `<img>`.
- `blur`: a ~16 px wide WebP, base64-inlined as `background-image` + `background-size: cover`. Roughly 300–600 bytes of HTML per image, documented as a trade-off.
- Inline `style` conflicts with a strict CSP (`style-src` without `'unsafe-inline'`). The README says so. That is why the default is `none`.
- *Refined 2026-10-09 (slice 6, agreed with the user):* an image that is not fully opaque (alpha, or transparent `fit=contain` padding) gets **no** placeholder, because the background would stay visible through it after loading.

### D11 — Keeping originals out of `public/`
The plugin reads sources from `app.folders.assets` **regardless of `.neraignore`**. A site that lists its photo folder (e.g. `images`) in `.neraignore` publishes only the processed, metadata-stripped variants, and the originals with their EXIF/GPS never leave the repo. No extra config. The README documents this prominently, with the caveat that anything in that folder the plugin does not process (SVG, GIF, linked downloads) is then unpublished too.

### D12 — Compatibility guard
- `peerDependencies: { "@nera-static/core": ">=4.13.0" }`. npm reports an incompatible core at install time.
- Runtime safety net: in `getMetaData`, after generating, set a flag. If core is older and never calls `getAssets`, pages would reference missing files. Detect this by checking core's version via `@nera-static/core/package.json` (exported) and **fail loudly** (throw with a message naming the required version) rather than shipping broken image URLs.
- *Refined 2026-10-09 (slice 3, agreed with the user):* the check runs at the first image that will actually be generated, **before** anything is encoded, not after. A site with no processable image still builds on an older core. An undeterminable core version warns and builds.

### D13 — Concurrency and determinism
- Encode with bounded concurrency (config `concurrency`, default `os.availableParallelism() - 1`, min 1) via a small internal queue (no extra dependency). The same source+params used on several pages is encoded once (in-flight promise map).
- Output markup is deterministic (attribute order, srcset order ascending by width, source order = `formats` order).

---

## Configuration — `config/images.yaml`

Optional. Every key has a default, and the plugin works with no file at all. `getConfig` returns `{}` when the file is missing, so every key needs a JS fallback.

```yaml
# Which modern formats get a <source>, in order of preference.
formats: [avif, webp]
# Candidate widths for srcset (px). Never upscaled.
widths: [480, 800, 1200, 1600]
# Default sizes attribute.
sizes: 100vw
# Encoder quality per format.
quality:
    avif: 50
    webp: 75
    jpeg: 78
    png: 80        # palette quantisation off; png stays lossless-ish
# First image on each page: eager + fetchpriority=high.
eager_first: true
# "title" turns ![alt](src "Caption") into <figure>; false disables.
figure: title
# Frontmatter keys holding an image path → meta.images.<key>.
frontmatter_keys: [image]
# og:image preset for frontmatter images; false disables.
og:
    width: 1200
    height: 630
    fit: cover
# none | color | blur
placeholder: none
# Public URL path for generated files.
output_path: /_img
# Cache folder (site-root relative) and pruning of unused variants.
cache_dir: .nera-cache/images
prune: true
# Parallel encodes; default = CPU count - 1.
# concurrency: 4
```

---

## Slices

Each slice ends with: `npx vitest run && npm run lint` green, the ROADMAP checkboxes ticked, a dated note, and a commit on `main`. Until slice 8, nothing is published. The plugin is developed and field-tested against a local core via `npm install ../generator --no-save`, as `nera-cli` did with validate.

### Slice 0 — Repository scaffold
- [x] `nera-plugin-images/` (this folder): `git init -b main`, `package.json` (`@nera-static/plugin-images`, `0.0.0`, `"type": "module"`, `engines.node >=20.18.1` (cheerio's floor, not sharp's `>=20.9.0`; see the done-note), `exports`, `files`, `publishConfig.access: public`, `peerDependencies` per D12), `index.js` stub exporting nothing yet, `LICENSE` (MIT), `CHANGELOG.md` (Keep a Changelog, `## [Unreleased]`), `README.md` stub linking https://nera.js.org.
- [x] Copy `eslint.config.js`, `.github/workflows/test.yml` and `publish.yml` verbatim from `nera-plugin-link-attributes` (identical across the fleet). Copy `.husky/` plus a `prepare: husky` script.
- [x] Dependencies: `sharp`, `cheerio`, `@nera-static/plugin-utils`. Dev: `vitest`, `eslint`, `husky`, `@nera-static/core` (for integration tests).
- [x] `npm install` → **commit the lockfile in the first commit** (CLAUDE.md ordering rule 1: before `test.yml` can pass).
- [x] `test/fixtures/make-images.js`: generates fixture images with sharp at test time (a 2000×1500 JPEG with EXIF orientation 6 + GPS, a 300×200 PNG with alpha, an SVG, a GIF), so no binary blobs land in git.
- [x] Do **not** create the GitHub repo yet (outward-facing; slice 8).

**Done 2026-10-09.** Scaffold committed as the first commit on `main`, lockfile included. 5 tests (fixture self-checks), lint clean. What was learned or decided differently:

- **`engines.node` is `>=20.18.1`, not `>=20.9.0`** (decided with the user). `sharp` alone needs `>=20.9.0`, but `cheerio` 1.2 is a runtime dependency and needs `>=20.18.1`. Same floor as `plugin-link-attributes`, for the same reason.
- **Peer + dev on core coexist.** `peerDependencies: { "@nera-static/core": ">=4.13.0" }` (D12) sits next to `devDependencies: { "@nera-static/core": "^4.12.0" }`. npm lets the root's dev edge win, so the install resolves to 4.12.0 without complaint. With the peer alone, `npm install` fails with `ETARGET` (4.13.0 does not exist yet). **Slice 1/3:** after core 4.13.0 ships, raise the devDependency to `^4.13.0`. Until then, integration tests run against `npm install ../generator --no-save`.
- **Generate the lockfile with npm ≥ 10.9 (Node 22).** On Node 20.20 (npm 10.8.2), a fresh `npm install` crashes in Arborist with `Cannot read properties of null (reading 'edgesOut')` while resolving vitest 5's peer set. `npm ci` from the committed lockfile and `npx vitest run` both work on Node 20, which is what the CI matrix needs. vitest 5 declares `node ^22.12.0 || …`, but it runs on Node 20 in practice, as across the fleet.
- `npm ls` lists `@img/sharp-wasm32`, `@emnapi/runtime` and `tslib` as *extraneous*. They are sharp's optional WASM fallback and are harmless.
- `npm audit` reports 11 findings (5 moderate, 6 high), all reached through the **dev** dependency `@nera-static/core` (gray-matter/js-yaml, markdown-it-meta, cpy/globby/micromatch/braces). `npm audit --omit=dev` is clean. Fixing them belongs in core, not here.
- **Fixtures** (`test/fixtures/make-images.js`, `makeImages(dir)` + `FIXTURES`): `photo.jpg` gets GPS via `withExif({ IFD3: … })` and orientation via `withMetadata({ orientation: 6 })`. The fixture code may use `withMetadata`; D6 forbids it only in the plugin's output pipeline. The photo is red on the left and blue on the right, so slice 2 can check *where* a color lands after rotation, not only the swapped dimensions. GPS presence is checked by looking for TIFF tag `0x8825` (GPS IFD pointer) in the EXIF buffer, in either byte order. A negative control (EXIF without GPS) returns false. Slice 2 can reuse this check to prove stripping. `anim.gif` is a real 2-frame animation (`sharp([...], { join: { animated: true } })`). `test/fixtures.test.js` verifies that every fixture carries what it claims.
- `files` currently lists only `index.js` + `CHANGELOG.md`. **Slice 2 must add `src`** (and slice 5 `bin`/`views`), or the modules will be missing from the tarball.
- `test.yml`/`publish.yml`/`eslint.config.js`/`.husky/` (`pre-commit` lint, `pre-push` vitest) are verbatim fleet copies, `.gitignore` too. The `test.yml` comment about cheerio applies here as well. `LICENSE` is MIT, `2026`.

### Slice 1 — Core: `getAssets` hook (`generator/`, core 4.13.0)
- [x] `src/setup-plugins.js#getPluginsData`: after the existing hook loop, call each plugin's optional `getAssets({ app, pagesData })` in plugin order, validate per D2, return `assets: [{ from, to, plugin }]` alongside `app`/`pagesData`.
- [x] `src/index.js`: copy `data.assets` between the theme pass and the site pass (`copyFolder` for directories with `ignoreBase = null`, a plain file copy for files, `to` resolved under `dist`).
- [x] Tests: hook absent (byte-identical build), file entry, directory entry, site file overrides plugin file, theme file overridden by plugin file, invalid return (non-array) → warning, `to` escaping `public/` → skipped + warning, `base_path` + `asset_hashing` applied to plugin assets.
- [x] Docs: plugin contract in `generator/README.md` (next to `getAppData`/`getMetaData`), `nera-website/pages/{,de/,es/}docs/plugins.md` (trilingual). The local-plugin tutorial needs no change.
- [x] Workspace `CLAUDE.md` "Plugin contract" section: add the third hook.
- [x] `npm version minor --no-git-tag-version`, CHANGELOG `### Added`, commit, tag `v4.13.0`, push → CI publishes. **Confirm with the user before pushing the tag.** The website doc change is pushed in the same session (plain `git push`).

**Done 2026-10-09.** Core 4.13.0 committed on `generator` `main` (version bump + CHANGELOG in the same commit); 128 tests (16 new in `src/test/plugin-assets.test.js`), lint clean. Website docs (en/de/es) built and `nera validate` clean. What was learned or decided where D2 left a gap (none of it contradicts D2):

- **Where things live.** Validation is `validateAsset(entry)` in `src/setup-plugins.js` (exported from that module, not from the `src/index.js` barrel); `getPluginsData` now also returns `assets: [{ from, to, plugin }]` (`[]` when no plugin has the hook). The copy is `copyPluginAssets(assets, dist)` in `src/render.js`, called from `src/index.js` between the theme pass and the site pass.
- **`to` for a file entry is the target *file* path** (`{ from: '/x/og.png', to: 'og/home.png' }`); for a directory it is the folder the *contents* go into (via `copyFolder(from, target, null)`, so dotfiles copy too). D2 did not say which. A file entry with `to: ''` (public/ itself) is skipped with a warning.
- **`to` is normalized** with `path.posix.normalize` after turning `\` into `/`: trailing slash dropped, `''`/`'.'` mean public/ itself, `a/../../x` counts as escaping. Absolute means `/…`, a Windows drive (`C:…`) or `path.isAbsolute`.
- **`from` must be absolute**, not just present (D2 says "absolute"; now enforced, a relative `from` is skipped with a warning). A `from` that is well-formed but **does not exist** is skipped *at copy time* with a warning (`asset not found`), so a plugin's empty cache on a first build cannot fail the build.
- **A `getAssets` that throws fails the build**, exactly like a throwing `getAppData`/`getMetaData` today. Only a wrong return type is soft. Slice 3's plugin should therefore catch its own per-image errors.
- **"Byte-identical" test** compares a build with no plugins against the same build plus a plugin that has no `getAssets`. The `base_path` + `asset_hashing` test puts an `<img src srcset>` pointing at plugin files into the page and checks for `/sub/_img/pic.png?v=<sha256-10 of the plugin file>` in both attributes, which proves the hashing pass read the plugin's copy in `public/`.
- A local theme in a test needs a `views/` folder even when the test only cares about assets (`resolveTheme` throws otherwise).
- **Released.** Pushed after the user confirmed: `v4.13.0` tag → CI publish run succeeded (`+ @nera-static/core@4.13.0`, with provenance); the CI log is the proof, since the registry's `latest` still read 4.12.0 for a few minutes afterwards (CDN lag, not a failure). Website docs pushed with a plain `git push`. The devDependency `^4.12.0` → `^4.13.0` raise (slice 0 note) waits until 4.13.0 is on npm.

### Slice 2 — Plugin engine (no HTML yet)
Pure modules, unit-tested in isolation:
- [x] `src/config.js`: read `config/images.yaml` inside the hook (not at module scope), merge over defaults, validate types (warn + default on bad values).
- [x] `src/resolve-source.js`: URL → absolute file (D5 order: site assets, then theme `assetsRoot`). Strips `base_path`, query and hash; resolves page-relative URLs against `meta.href`. Rejects traversal outside the roots.
- [x] `src/transform.js`: `planVariants(sourceMeta, options)` → list of `{ width, height, format, quality, crop }` (pure, the main unit-test target: no upscaling, `w`/`2w` logic, ratio/fit/focus math). `encodeVariant(file, plan)` → sharp pipeline (`rotate`, resize, sRGB, format, quality, metadata stripped).
- [x] `src/cache.js`: key hashing (D3), manifest read/write (atomic write via temp+rename), `has`/`get`/`put`, `prune(usedKeys)`.
- [x] `src/queue.js`: bounded concurrency + in-flight dedupe (D13).
- [x] Tests: orientation-6 fixture comes out upright with swapped dimensions; output has no EXIF/GPS (`sharp(out).metadata()` → no `exif`); PNG alpha preserved in webp/avif; second run encodes nothing (spy on the encoder); prune removes exactly the unused files.

**Done 2026-10-09.** Engine committed on `main`: 118 tests (113 new across `config`, `resolve-source`, `transform`, `cache`, `queue`, `generate`), lint clean, green on Node 20 and 22. Nothing is wired into a hook yet; `index.js` is still empty. What was learned or decided where the decisions left a gap (none of it contradicts D1–D13):

- **devDependency raised to `@nera-static/core` `^4.13.0`** (slice 0 note), installed from the registry (4.13.0), lockfile regenerated with Node 22 / npm 10.9.4. The `npm install ../generator --no-save` workaround is no longer needed.
- **An extra module, `src/generate.js`** (`createGenerator({ cache, queue, encode })` → `generate(file, options)`, `usedKeys()`, `encoded`). It is the one place that reads the source, hashes it, plans, skips variants whose file exists and queues the rest. The "second run encodes nothing" test needs exactly this seam (the encoder is injected and spied on), and slices 3 and 5 both call it. `src/warn.js` holds the `⚠️ plugin-images: …` prefix.
- **During the plugin stage `app.theme` is core's `{ name, package, config }` object**, not the app.yaml spec string (core attaches it before plugins run). `sourceRoots({ app, cwd })` reads the spec back from `.name` and calls `resolveTheme` from `@nera-static/core/theme` for `assetsRoot`; it also accepts the raw string.
- **Two hash levels.** The manifest key (`imageKey`) is sha256 over source digest + *all* options (widths, formats, quality, geometry) + `CACHE_VERSION`, since all of them change the entry's `files[]`. The file-name `hash8` (`variantHash`) covers only format, quality and geometry (`fit`, `crop`, `aspect`), not the width (it is in the name). So all widths of one format share a hash, as in the goal example, and changing e.g. `quality.avif` re-encodes only the avif files (tested). `CACHE_VERSION` (now 1) feeds both: bump it when the encoder's output changes for the same inputs.
- **The file-name basename is slugified** with `slugify` from plugin-utils (`Straße am Meer.JPG` → `strasse-am-meer-…`, nothing usable → `image`), so emitted URLs never need escaping.
- **Geometry semantics `planVariants` settles for slice 4:** `ratio` is a number (width/height); slice 4 parses `16:9`. `w` + `h` take precedence over `ratio`. `h` without `w` does nothing in the plan (slice 4 decides whether to warn). `cover` crops the largest region of the aspect around `focus` (percent, clamped at the edges) as an explicit `extract` rectangle in *oriented* coordinates (`.rotate()` runs first; verified with the red/blue fixture); `attention`/`entropy` become `crop: { strategy }` and use sharp's `position`. `contain` pads to the aspect box (transparent, white under JPEG), `inside` scales into the box and reports the real output size. The no-upscale cap uses the crop region, not the source (a 16:9 crop of a portrait photo caps at its width).
- **Width capping, as written in D6/D7:** config widths above the cap are *dropped* (source width added only when none is left), while `w`/`2w` are *capped* (`min(x, cap)`). So a 1000 px source with default widths gets 480/800, but with `?w=800` gets 480/800/1000.
- **Fallback formats:** jpeg→jpeg, png→png, webp→webp, avif (sharp reports it as `heif`)→jpeg, tiff→jpeg. A modern format equal to the fallback (a WebP source with `formats: [avif, webp]`) is planned once, as the fallback; slice 3's markup must therefore treat the last format as the `<img>` and not expect a `<source>` per configured format in that case. JPEG output flattens alpha onto white. PNG output is lossless (`quality.png` is carried into the hash but unused by the encoder).
- **Plan entries are `{ width, height, format, quality, fit, crop, aspect }`**: `fit` is the encoder's mode (`fill` when there is no aspect, else `cover`/`contain`/`inside`), `aspect` is kept so two `contain`/`inside` plans with different aspects never share a file name.
- **Atomic writes everywhere:** variants are encoded to a temp name and renamed (a killed build cannot leave a truncated file the cache would accept), the manifest likewise. A manifest with another `version` or broken JSON (warning) starts empty; prune then removes the orphaned files. Prune deletes every file in `files/` not listed by a kept entry, including strays, and returns `{ entries, files }` for logging.
- **Config:** unknown top-level keys warn (typo help), a key present but empty (`widths:`) counts as absent, `formats: []` is valid (no `<source>`), `quality`/`og` merge per key, `output_path` is normalized to `/a/b` and rejects `..`. `loadConfig` honours `app.folders.config` like the rest of the pipeline.
- **Queue dedupe is build-lifetime**, not only in-flight: a key that already finished returns its settled promise, so a variant used on many pages is encoded once per build even when the pages are processed one after another. A failing task rejects its own promise; the queue keeps going.
- `files` now includes `src`.

### Slice 3 — Content pass + first end-to-end build
- [x] `src/rewrite-html.js`: cheerio pass over `content` (D5 skip rules, D6 markup, eager-first per page).
- [x] `index.js`: `async getMetaData({ app, pagesData })` (collect images, plan, encode via queue, rewrite content, record used keys), `async getAssets()` (prune, return `[{ from: <cache>/files, to: output_path }]`), the D12 runtime guard.
- [x] Integration test: build a throwaway site in a temp dir with core's `run()` (pattern from `nera-plugin-tags`' integration tests), assert `public/_img/*` exists, the HTML has `<picture>`, `width`/`height` are correct, the second build encodes 0 files, and `base_path` prefixes `srcset`.
- [x] Snapshot test of the emitted markup for one image (guards the D6 contract).

**Done 2026-10-09.** Content pass and hooks committed on `main`: 159 tests (41 new in `rewrite-html`, `guard`, `index` and `integration`), lint clean, green on Node 20.19, 20.20 and 22. A site with the plugin now gets `<picture>` markup and `public/_img/` end to end through core's real `run()`. Three points where D6/D12 left room were **decided with the user before implementing** and are written into D6/D12 above: the guard runs before encoding, "first image" means the first one rewritten, and the author's loading hints win. Everything else below fills gaps and does not contradict D1–D13:

- **Module layout.** `src/rewrite-html.js` knows nothing about files or sharp. `rewriteHtml(html, { handle, outputPath, sizes, eagerFirst })` offers each candidate `<img>`'s `src` to an async `handle(src)`, which returns the generated image or `null` (leave as is). `buildPicture`/`imgAttributes` are the pure markup builders. `index.js` supplies `handle` (resolve → guard → `generate`). `src/guard.js` holds the D12 check (`coreVersion`, `satisfies`, `assertCoreVersion`), with no `semver` dependency.
- **The D12 guard resolves `@nera-static/core/package.json` from the plugin's own location first, then from the site root** (`createRequire`). It throws on a known older version. An unresolvable core warns and passes, because some core is calling the plugin and refusing on a guess would block a working setup. Once it has failed, it re-throws for every later image of the build, so no concurrent image slips through to the encoder.
- **Markup details.** Attribute order on `<img>`: `src, srcset, sizes, width, height`, then the author's attributes in their original order (`alt`, `class`, `id`, `title`, `data-*`, …), then `loading`, `decoding`/`fetchpriority` (D13). An author's own `src`/`srcset`/`sizes`/`width`/`height` are replaced (D6). `<source>` carries `type, srcset, sizes`. With no modern format left (`formats: []`), the output is a bare `<img>` with `srcset` and **no `<picture>` wrapper** (the same shape D7 gives `formats=none`). A WebP source gets only an AVIF `<source>`, because its WebP set is the fallback (slice 2 note). Values are escaped by cheerio.
- **Untouched pages keep their exact string.** cheerio re-serializes the whole fragment, which can normalize unrelated markup. `rewriteHtml` therefore returns the original string when nothing changed, and `getMetaData` returns the original page object, so pages without images are byte-identical. A removed `data-nera-skip` counts as a change.
- **Warnings** name the page `href` and the URL as written: `image not found, left as is` for `missing`/`outside`, `could not process …, left as is (<sharp error>)` for an undecodable file. External, `data:`, SVG/GIF and empty `src` stay silent. Per-image errors are caught, so `getAssets` never throws because of one bad image (slice 1 note).
- **Concurrency.** Pages are processed one after another, and a page's images concurrently. The queue bounds the encoders, and only one page's source bytes are held at a time. Measure this in slice 7. If a site with many single-image pages encodes too serially, process a bounded number of pages at once.
- **State between the hooks** is one module-level slot that `getMetaData` sets and `getAssets` consumes. A second `getAssets` without a new `getMetaData` returns `[]`. `getAssets` prunes (if `prune`), saves the manifest and returns `[{ from: <cache>/files, to: output_path without the leading slash }]`. It returns `[]` (no core "asset not found" warning) when the build used no image. A site that never had an image gets **no `.nera-cache` folder at all**. A failing manifest write only warns.
- **One info line per build** when images were found: `🖼️  plugin-images: N image(s), M variant(s) encoded`. The integration test uses it, together with unchanged file mtimes in the cache, to prove that a warm build encodes 0 variants.
- **Integration test setup:** the temp site loads this repo's `index.js` through a local plugin (`plugins/images/index.js` re-exporting it by file URL) and passes absolute `folders` to `run()`, like core's own `plugin-assets.test.js`. The site's `package.json` needs `"type": "module"`, or Node warns about re-parsing the plugin file. A cold build with two images (12 variants incl. AVIF) takes well under a second here, so one site is built once and the tests run against it in order: output, eager/lazy, skip/warn, every URL exists, no EXIF, warm build, `base_path: /sub` → every `src`/`srcset` URL starts `/sub/_img/`, prune.
- **The snapshot test** is an inline snapshot over `rewriteHtml` with a fake `handle`, without sharp, so it guards the D6 markup without depending on encoder bytes (the file-name hash depends on the source bytes, which sharp generates at test time). It needs `// eslint-disable-next-line quotes`, because vitest writes inline snapshots in backticks.
- **Still out of this slice:** query parameters are not parsed yet. `?w=800` resolves to the file (the query is stripped) and is ignored, and slice 4 adds parsing. `title` stays on the `<img>` until slice 4's `<figure>`.

### Slice 4 — Query parameters, focal point, `<figure>`
- [x] Parse and strip parameters (D7), feed `planVariants`, derive the default `sizes` from `w`.
- [x] Focal-point crop (`focus=x,y` → sharp `extract` after resize-to-cover computed from the point; `attention`/`entropy` → `sharp.strategy`).
- [x] `<figure>`/`<figcaption>` from the title (D8), including the `<p>` replacement rule and the inline-text exception.
- [x] Tests per parameter, unknown/invalid parameter warnings, figure on/off, inline image keeps the title.

**Done 2026-10-09.** Query parameters and captions committed on `main`: 220 tests (61 new in `params`, `rewrite-html`, `index`, `transform` and `integration`), lint clean, green on Node 20.20 and 22. Nothing here contradicts D1–D13. Where D7/D8 left room, this is what was decided:

- **Parsing is a separate pure module, `src/params.js`** (`parseParams(search)` → `{ skip, options, sizes?, loading?, warnings }`, `sizesFor`, `stripParams`). `options` holds only the parameters that were given and valid, and is spread over the config's `planVariants` options. An image without parameters therefore keeps the exact same manifest key as in slice 3, and existing caches stay valid. Warnings come back as strings. `index.js` prints them as `<href>: <message>: <src as written>`, only for an image that will actually be processed (a missing file gets only the "not found" warning).
- **Value formats.** `w`/`h`: positive integers. `q`: integer 1–100. `ratio`: only `W:H` (decimals allowed, `2.35:1`). `focus`: `x,y` in percent 0–100 (decimals allowed), or `attention`/`entropy`. `formats`: a comma-separated list in preference order, or `none`. An unknown entry is dropped with a warning, and if nothing usable is left the config's formats apply. `sizes` is decoded like a browser decodes it (`+` = space, `%xx`). A repeated parameter: the last one wins. `skip` is a flag, whatever its value. An empty value (`?w=`) counts as invalid.
- **Parameters without an effect warn.** This covers `h` without `w`, `fit` without an aspect (`ratio` or `w`+`h`), and `focus` without a cover crop (no aspect, or `fit` other than `cover`). The plan ignores these, and the slice 2 note left open whether to warn. A warning tells the author why nothing changed.
- **Focal point needed no new code.** Slice 2's `planVariants` already computes the cover crop around `focus` as an `extract` rectangle *before* the resize (the region in source pixels, then scaled), which gives the same result as the item's "extract after resize-to-cover" and avoids an extra resample. `attention`/`entropy` go to sharp's `position: sharp.strategy[...]`. This slice parses the parameter and adds the missing encode test for a strategy.
- **Which URLs are read.** The query of an external, `data:` or empty URL is never read (`https://…/a.jpg?skip` is left as is, silently). For any local URL the query is read *before* the file check, so `?skip` works on a missing or unsupported file too, without a "not found" warning.
- **`?skip` strips the recognized parameters** from the `src` and leaves everything else exactly as written, including unknown parameters such as a cache-buster `?v=2` (no warning on a skipped image), the hash, and every other attribute. This follows from D7's "all recognized parameters are removed from the emitted URLs". A skipped image is not rewritten, so it does not take the eager-first slot. For an image that is left as is for other reasons (missing, undecodable), the `src` keeps its query untouched, like the rest of the `<img>`.
- **`?loading` overrides the author's `loading` attribute** (D7: "overrides D6") and then follows the slice 3 rule: the mode decides which hints are filled in (`eager` → `fetchpriority="high"`, `lazy` → `decoding="async"`). As with an author's `loading`, the first rewritten image takes the eager-first slot even when it says `?loading=lazy`. The slot does not move on to the next image.
- **`handle`'s answer in `rewriteHtml` is now explicit:** `null` (leave as is), `{ src }` (leave in place with this `src`, used for `?skip`), or `{ image, sizes?, loading? }`. A `{ src }` that changes nothing keeps the page's original string.
- **Figure context (D8), read literally.** A figure is emitted only when the image's **parent is a `<p>` without attributes** and the image is its only content, whitespace aside. Every other context keeps the `title` and gets no figure: inline with text, next to another image, inside a link (`[![alt](src "Cap")](url)` renders as `<p><a><img></a></p>`), raw HTML outside a paragraph, a `<p class>` from raw HTML (replacing it would silently drop the author's attributes). An empty or whitespace-only `title` produces no figure and stays on the `<img>`. Only images the plugin rewrites get a figure. A declined image (SVG, external, missing) is left completely as is, title included. A bare `<img>` (no modern format) is wrapped like a `<picture>`. The caption is set as text, so cheerio escapes it.
- **Markdown round trip verified** in the integration test: markdown-it keeps `?w=400&ratio=16:9&focus=50,0&formats=webp` intact (as `&amp;` in the HTML, which cheerio decodes), and the Markdown title arrives as `title`, so the figure is built from real Markdown, not only from hand-written HTML.

### Slice 5 — Frontmatter images + template
- [x] `frontmatter_keys` → `meta.images.<key>` (D9), `og` preset.
- [x] `views/picture.pug` mixin + `bin/publish-template.js` (`publishTemplates()` from plugin-utils) + `"bin": { "nera-images": … }` + `publish-template` script. Test that the mixin renders from a fixture `meta.images` entry (cwd-relative pug path, like the other template tests).
- [x] Tests: `meta.image` string untouched; missing/external frontmatter image → no `meta.images` entry + warning only for missing local files.

**Done 2026-10-09.** Frontmatter images and the mixin committed on `main`: 242 tests (22 new in `frontmatter`, `index`, `transform`, `template`, `publish-template` and `integration`), lint clean, green on Node 20.20 and 22. Nothing here contradicts D1–D13. Where D9 left room, this is what was decided:

- **One data shape for both passes.** `pictureData(image, { outputPath, sizes })` in `src/rewrite-html.js` computes `{ src, srcset, sizes, width, height, type, sources: [{ type, srcset }] }`. `buildPicture` now builds its markup from it, and the frontmatter pass stores it as `meta.images.<key>`, so the content markup and the mixin can never describe the same image differently. `sources` carry no `sizes` of their own (as D9 shows); the mixin repeats the entry's `sizes` on each `<source>`, like the content pass.
- **The pure part lives in `src/frontmatter.js`** (`frontmatterImages(meta, { keys, prepare })`). `index.js` shares one `prepare(src, href, label)` step (resolve → params → warnings → D12 guard) between the content pass and the frontmatter pass, so a frontmatter path is read exactly like a Markdown image URL: page-relative paths, `base_path` stripping, theme fallback.
- **Query parameters work on the frontmatter path** (`image: /images/hero.jpg?ratio=16:9&focus=30,60`), with the same warnings. D9 does not mention them; leaving them out would have made the same string mean different things in Markdown and in frontmatter. `?skip` means no entry. `?loading` warns ("has no effect on a frontmatter image"), because loading is the mixin's option. Since parameters are never stripped from `meta.<key>` (the string is untouched, D9), a template that prints `meta.image` itself still sees them.
- **The og preset** is a second `generate` call with `{ widths: [og.width], formats: [], ratio: og.width/og.height, fit: og.fit, fallback: 'jpeg' }`. `planVariants` gained one option for it, `fallback`, which forces the `<img>` format (D9 says "one JPEG", while the source-family rule of D6 would give a PNG source a PNG). From the frontmatter parameters only `focus` and `q` carry over. The page's own geometry (`w`, `ratio`) is not meant for a social card. The og image follows the no-upscale rule: a source smaller than 1200 px gives a smaller og image of the same aspect (300×200 → 300×158). `og` is `{ src, width, height }`, without a `type` (always JPEG).
- **Which values count.** Only non-empty strings are image paths. Anything else under a frontmatter key (number, list, object) is passed over silently. External URLs, `data:`, SVG/GIF and `?skip` give no entry and no warning. A missing local file warns `frontmatter <key> not found, left as is`. An undecodable file warns `could not process frontmatter <key> …`.
- **An author's own `meta.images`.** If it is a mapping, the plugin merges its keys into it (in `frontmatter_keys` order). If it is anything else (a gallery list, say), the plugin leaves it alone, prepares nothing for that page and warns. Replacing it would break the page's own templates.
- **Unchanged pages stay the same object.** A page with no frontmatter image keeps its `meta` object, and a page with neither kind of image is returned as is (the slice 3 rule). The build line's `N image(s)` now counts frontmatter images as well. They never take the content pass's eager-first slot, since the template decides where the hero goes and passes `loading: 'eager'` to the mixin.
- **The mixin** (`views/picture.pug`, two mixins: `picture` and a helper `picture-img`): `+picture(image, { alt, class, sizes, loading })`. `sizes` (an override for a column layout) is the one addition to D9's option list. Extra attributes go onto the `<img>` (`+picture(image, { alt: '' })(data-zoom)`). A missing entry renders nothing, so `+picture(meta.images && meta.images.image, …)` is safe on pages without the key. `loading` defaults to `lazy` + `decoding="async"`; `eager` adds `fetchpriority="high"`. A missing `alt` stays missing (D6). Pug always writes `class` first, so the mixin's attribute order differs from the content pass there. Markup is otherwise identical; the template test pins it.
- **Publishing:** `bin/publish-template.js` is the fleet's script (`publishTemplates`, `--force`), with `"bin": { "nera-images": … }` and `npm run publish-template`. It installs to `views/vendor/plugin-images/picture.pug` (or `theme/views/…` on a themed site, which plugin-utils resolves). A layout includes it as `include /vendor/plugin-images/picture`. `files` now has `bin` and `views`. `pug` is a new devDependency (template tests), as in `plugin-tags`.
- **`base_path`:** the mixin's `src`/`srcset` are prefixed by core's `rewriteHtmlUrls` (integration-tested with `base_path: /sub`). A `<meta content>` is **not** rewritten by core, so `meta.images.image.og.src` used in an `og:image` tag needs the origin and `base_path` added by the template, like any root-relative URL there. og:image must be an absolute URL anyway. **Slice 7:** say so in the README, with a snippet.

### Slice 6 — Placeholders
- [x] `placeholder: color | blur` (D10), stored in the manifest so cached builds don't recompute.
- [x] Applied in both the content pass and `meta.images`.
- [x] Tests: color is a valid `#rrggbb`, blur data URI under 1 KB, `none` emits no `style`.

**Done 2026-10-09.** Placeholders committed on `main`: 262 tests (20 new in `transform`, `generate`, `rewrite-html`, `template`, `index` and `integration`), lint clean, green on Node 20.20 and 22. One point D10 left open was **decided with the user before implementing** and is written into D10 above: images that are not fully opaque get no placeholder. Everything else fills gaps and does not contradict D1–D13:

- **Transparent images get no placeholder** (decided with the user). A background behind an image with alpha, or behind `fit=contain` padding (transparent in AVIF/WebP), would stay visible through the transparent parts after loading. "Transparent" is sharp's `stats().isOpaque === false` on the shaped sample, not the `hasAlpha` flag, so an opaque PNG with an alpha channel still gets one. The manifest records `transparent: true`, so the check is not repeated, whatever the mode.
- **Where the code lives.** `placeholderOf(input, variant, mode)` in `src/transform.js` computes it from the **largest planned variant's geometry**, so the colour and the blur show the crop the visitor sees (a `focus=50,0` crop of the red/blue fixture is red, `focus=50,100` blue). The rotate/crop/resize/sRGB part of `encodeVariant` moved into a shared `shape()` for this, and the encoder output is unchanged (`CACHE_VERSION` stays 1). One 64 px wide PNG sample is rendered. `stats()` on it gives `isOpaque` and `dominant` (`#rrggbb`, lower case), and the blur is that sample resized to 16 px wide (height from the variant's aspect) as WebP quality 50. The fixture photo's data URI is 159 characters. Slice 7 measures real photos against D10's 300–600 bytes.
- **The manifest key does not include the mode.** A placeholder adds data to an entry but changes none of its files, so switching `placeholder` on keeps every cached variant and only computes the placeholders (tested). `generate(file, options, { placeholder })` takes the mode as a third argument. An entry keeps **only the current mode's data**: switching to `color` drops a stored `blur`, and `none` drops both. Computation goes through the queue (key `placeholder:<mode>:<image key>`), so an image used several times in a build is computed once and the work counts against `concurrency`.
- **The og image gets no placeholder.** It is a file for crawlers, not markup.
- **Markup.** `pictureData` carries `color`/`blur` when present (never `transparent`), so `meta.images.<key>` and the content pass share them. On the content pass's `<img>`, `style` comes right after `height`. An author's own `style` is appended after the placeholder (`background-color:#…;<author's>`, one trailing `;` trimmed), so the author's declarations still win. Without a placeholder, the author's `style` keeps its place and its exact text. The mixin builds the same `style`. Blur is `background-image:url(data:…);background-size:cover`, and colour is `background-color:#rrggbb`, nothing more. With `none` the markup is byte-identical to slice 5.
- **The build line** gets `, P placeholder(s) computed` when `placeholder` is not `none`. The integration test uses it to prove that a warm build computes 0.
- **Slice 7:** the README needs the CSP note (D10), the transparency rule, and a hint that a placeholder is visible only while the image loads.

### Slice 7 — Field test + README
- [ ] Field test against `../nera-websites/michael-becker-berlin.de` (blog images under `theme/assets/images/blog/2026/`, the ZerpenSafari example) with `npm install ../nera-plugin-images --no-save`. Record: cold build time, warm build time, `public/` size before/after, Lighthouse/LCP spot check of one blog post, `nera check` (validate output rules) still clean.
- [ ] Also a `.neraignore` run (D11): confirm originals are absent from `public/` and no page references them.
- [ ] Fix what the field test finds and record the numbers here.
- [ ] README complete: what it does, before/after markup, config reference, query parameters, frontmatter + mixin, `.neraignore` privacy recipe, CI caching snippet (`actions/cache` for `.nera-cache`), CSP note for placeholders, requires core ≥ 4.13.0.

### Slice 8 — Release
- [ ] **Confirm with the user**, then create the GitHub repo `seebaermichi/nera-plugin-images` (`gh repo create`), push `main`, enable private vulnerability reporting, add the `protect-main` ruleset + secret-scanning push protection, add the Dependabot config (match the fleet, see the memory note "Dependabot posture").
- [ ] Version `1.0.0` + dated CHANGELOG. **Bootstrap publish by hand** (`npm publish`, the one documented exception for a brand-new package), then configure the Trusted Publisher on npmjs.com (`publish.yml`) so 1.0.1+ go through CI OIDC. Tag `v1.0.0` on the published commit and push it. That tag's CI publish run will fail on the already-existing version. That is expected and harmless; note it in the slice's done-note. Check how `core`/`nera`/`validate` were bootstrapped in July 2026 (`generator/ROADMAP-core.md`) and follow the same procedure if it differs.
- [ ] `generator/PLUGINS.md`: add alphabetically, bump the count (14 → 15).
- [ ] `nera-website/pages/{,de/,es/}plugins/index.md`: add to the `plugins:` frontmatter list with translated descriptions (no raw `: `). `nera build` + `nera validate`, push.
- [ ] `nera-cli/template/_gitignore`: add `.nera-cache` (patch release of `@nera-static/nera`).
- [ ] Workspace `CLAUDE.md`: move this from "Planned work" to a shipped note; update the folder list (now 15 plugins).

---

## Semver notes for later changes
Per CLAUDE.md. **Major:** renaming `meta.images` fields, the `figure.nera-image` BEM classes, query parameter names or config keys, or changing default output markup structure. **Minor:** a new parameter/config key/format with a backward-compatible default. Changing default `widths`/`quality` is a **minor** (output files change, contract doesn't), noted in the CHANGELOG.

## Not in scope (decided 2026-10-09)
- Generating images from **Pug layouts at render time** (`+picture('/hero.jpg')` with on-the-fly encoding). Pug renders synchronously after the plugin stage, so this would need a post-render hook in core. Frontmatter images (D9) cover the common hero/cover case.
- Art direction (different crops per breakpoint), remote/external images, animated GIF → video conversion.

## Acceptance criteria
1. A site with no `config/images.yaml` gets `<picture>` + AVIF/WebP + `srcset` + `width`/`height` + lazy loading for every local raster image in Markdown, with zero author changes.
2. No emitted file contains EXIF/GPS metadata, and phone photos come out upright.
3. A warm rebuild with unchanged images encodes nothing.
4. `base_path` and `asset_hashing` sites produce correct URLs for every variant.
5. Query parameters, `<figure>` captions, `meta.images` + mixin, and placeholders behave per D7–D10.
6. A themeless site without the plugin builds byte-identically on core 4.13.0 (hook is additive).
7. `nera check` on the field-test site reports no new findings.
