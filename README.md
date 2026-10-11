# @nera-static/plugin-images

[![Test](https://github.com/seebaermichi/nera-plugin-images/actions/workflows/test.yml/badge.svg)](https://github.com/seebaermichi/nera-plugin-images/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@nera-static/plugin-images)](https://www.npmjs.com/package/@nera-static/plugin-images)

A plugin for the [Nera](https://github.com/seebaermichi/nera) static site generator that turns every local image in your Markdown into responsive, modern-format markup at build time: `<picture>` with AVIF/WebP, `srcset`/`sizes`, `width`/`height`, lazy loading, and camera metadata (EXIF/GPS) stripped.

📖 **Documentation:** [nera.js.org](https://nera.js.org)

> Requires `@nera-static/core` **4.13.0 or later** (see [Compatibility](#compatibility)).

## ✨ Features

- Every local raster image in Markdown becomes `<picture>` + AVIF/WebP + `srcset` + `width`/`height` + lazy loading, with no change to your content
- Variants are generated once, at build time, with [sharp](https://sharp.pixelplumbing.com), and cached between builds; a warm build encodes nothing
- EXIF orientation is applied, then **all metadata is stripped** (no camera data, no GPS on your server)
- The first image on each page loads eagerly with `fetchpriority="high"` (the usual LCP image), every other one lazily
- Per-image control with query parameters on the URL: `![alt](/images/a.jpg?w=800&ratio=16:9&focus=30,60)`
- `![alt](src "Caption")` becomes a `<figure>` with a `<figcaption>`
- Frontmatter images (`image: /images/hero.jpg`) get precomputed variants for your templates, including an `og:image` crop, plus a Pug mixin to render them
- Optional colour or blur placeholders
- Works with `base_path` and `asset_hashing`

## 🚀 Installation

```bash
npm install @nera-static/plugin-images
```

Nera detects the plugin and processes images during `nera build`. There is nothing else to set up: `config/images.yaml` is optional.

Add the cache folder to your `.gitignore`:

```gitignore
.nera-cache
```

## Before and after

```md
![Startseite der ZerpenSafari](/images/blog/2026/zerpensafari-iphone.jpg)
```

Without the plugin, this is a bare `<img src="/images/blog/2026/zerpensafari-iphone.jpg" alt="…">`. Phones download the full original. With the plugin:

```html
<picture>
    <source type="image/avif" srcset="/_img/zerpensafari-iphone-fca66340-480.avif 480w, /_img/zerpensafari-iphone-fca66340-800.avif 800w" sizes="100vw">
    <source type="image/webp" srcset="/_img/zerpensafari-iphone-881dc739-480.webp 480w, /_img/zerpensafari-iphone-881dc739-800.webp 800w" sizes="100vw">
    <img src="/_img/zerpensafari-iphone-06076855-800.jpg"
         srcset="/_img/zerpensafari-iphone-06076855-480.jpg 480w, /_img/zerpensafari-iphone-06076855-800.jpg 800w"
         sizes="100vw" width="800" height="1739"
         alt="Startseite der ZerpenSafari"
         loading="eager" fetchpriority="high">
</picture>
```

The `<img>` fallback keeps the source's own format (JPEG stays JPEG, PNG stays PNG; AVIF and TIFF fall back to JPEG) and always points at a processed variant, never the original. Widths are never upscaled. `width`/`height` are the largest variant's size, so the browser reserves the right space before the image loads (no layout shift). Every attribute you set on the original `<img>` (`alt`, `class`, `id`, `data-*`, …) is kept. A missing `alt` stays missing: [`nera check`](https://nera.js.org) reports it (rule `a11y-img-alt`), the plugin does not invent one.

On the field-test site (a German/English blog), the 32 content images went from 4.2 MB of originals to 0.45 MB of AVIF a phone downloads, and the Lighthouse mobile LCP of a blog post dropped from 3.5–3.8 s to 2.6 s; with its teaser image rendered through the mixin as well (see below), to 1.8–1.9 s.

### What is left untouched

- SVG and GIF (animation), external `http(s)://` and `//` URLs, `data:` URIs
- An `<img>` already inside a `<picture>`, or with its own `srcset`
- An image with `?skip`, or a raw HTML `<img data-nera-skip>` (the attribute is removed from the output)
- A file that cannot be found: the build warns with the page and the URL and leaves the `<img>` as it is

Raw HTML `<img>` in Markdown is handled like a Markdown image. Images in your **Pug templates** are not processed; use frontmatter images and the mixin for those (see below).

## ⚙️ Configuration

`config/images.yaml` is optional, and so is every key in it. These are the defaults:

```yaml
# Which modern formats get a <source>, in order of preference.
formats: [avif, webp]
# Candidate widths for srcset (px). Never upscaled.
widths: [480, 800, 1200, 1600]
# Default sizes attribute.
sizes: 100vw
# Encoder quality per format (1–100). PNG output is lossless.
quality:
    avif: 50
    webp: 75
    jpeg: 78
    png: 80
# First image on each page: loading="eager" + fetchpriority="high".
eager_first: true
# "title" turns ![alt](src "Caption") into <figure>; false disables it.
figure: title
# Frontmatter keys holding an image path → meta.images.<key>. [] disables it.
frontmatter_keys: [image]
# og:image preset for frontmatter images; false disables it.
og:
    width: 1200
    height: 630
    fit: cover
# Placeholder while an image loads: none | color | blur
placeholder: none
# Public URL path for the generated files.
output_path: /_img
# Cache folder (relative to the site root), and pruning of unused variants.
cache_dir: .nera-cache/images
prune: true
# Parallel encodes; default: CPU count - 1.
# concurrency: 4
```

An invalid value warns and falls back to its default; an unknown key warns too (typo help). Neither fails the build.

## Query parameters

Add them to the image URL in Markdown (or in a frontmatter path). They never reach the emitted URLs.

| Param | Meaning | Example |
|---|---|---|
| `w` | Maximum display width in px. `srcset` gets the configured widths below it plus `w` and `2w` (retina), capped at the source. The default `sizes` becomes `(min-width: {w}px) {w}px, 100vw` | `?w=800` |
| `h` | Target height; together with `w` it crops by `fit` | `?w=800&h=450` |
| `ratio` | Crop to an aspect ratio, `W:H` | `?ratio=16:9` |
| `fit` | `cover` (default when cropping), `contain` (pad) or `inside` (scale into the box) | `?fit=contain` |
| `focus` | Focal point of a `cover` crop in percent, `x,y` (default `50,50`), or `attention` / `entropy` to let sharp find it | `?focus=30,60` |
| `q` | Quality for all formats, 1–100 | `?q=60` |
| `formats` | Modern formats for this image, comma-separated, or `none` for a plain `<img>` with `srcset` | `?formats=webp` |
| `sizes` | `sizes` for this image (URL-encoded) | `?sizes=50vw` |
| `loading` | `eager` or `lazy`, overriding the first-image rule | `?loading=eager` |
| `skip` | Leave this image completely untouched | `?skip` |

An unknown parameter, an invalid value (`?w=abc`) or a parameter without effect (`h` without `w`, `focus` without a crop) warns with the page and the URL and is ignored.

## Captions

```md
![A pier at dusk](/images/pier.jpg "Usedom, October 2026")
```

An image with a title that is alone in its paragraph becomes:

```html
<figure class="nera-image"><picture>…</picture><figcaption class="nera-image__caption">Usedom, October 2026</figcaption></figure>
```

The `<figure>` replaces the paragraph (a `<figure>` inside `<p>` is invalid HTML), and the `title` attribute is dropped. An image inline with text, inside a link or next to another image keeps its `title` and gets no figure. `figure: false` turns this off. The classes `nera-image` and `nera-image__caption` are part of the public contract: style them freely.

## Frontmatter images and the `+picture` mixin

```yaml
---
title: My post
image: /images/blog/hero.jpg
---
```

For every key in `frontmatter_keys` (default `[image]`), the plugin generates variants and adds precomputed data next to the original:

```js
meta.images.image = {
    src, srcset, sizes, width, height, type,    // the fallback <img>
    sources: [{ type: 'image/avif', srcset }, { type: 'image/webp', srcset }],
    og: { src, width, height },                 // 1200×630 JPEG (the og preset)
    color, blur                                 // only with a placeholder
}
```

**`meta.image` itself stays the string you wrote**, so existing templates and plugins keep working. Query parameters work here too (`image: /images/hero.jpg?ratio=16:9&focus=30,60`).

Publish the mixin into your views once:

```bash
npx nera-images
```

It lands in `views/vendor/plugin-images/picture.pug` (`theme/views/…` on a themed site). Then, in a layout:

```pug
include /vendor/plugin-images/picture

+picture(meta.images && meta.images.image, { alt: meta.image_alt, loading: 'eager' })
```

**A hero above the content.** `eager_first` gives the first *Markdown* image `fetchpriority="high"`. If your layout renders a teaser or hero image above the content, that one is the page's LCP image: render it with `loading: 'eager'` as above and set `eager_first: false`, so the two do not compete.

Options: `alt`, `class`, `sizes` (for a column layout, e.g. `'(min-width: 60em) 50vw, 100vw'`) and `loading` (`lazy` by default; `eager` adds `fetchpriority="high"` for a hero). Extra attributes go onto the `<img>`: `+picture(image, { alt: '' })(data-zoom)`. A missing entry renders nothing.

### `og:image`

Core's `base_path` rewriting does not touch `<meta content>`, and `og:image` must be an absolute URL anyway, so add your origin (and `base_path`, if you use one) in the template. `app.origin` is the `origin` key of your `config/app.yaml` (for example `origin: https://example.com`); core does not set it for you:

```pug
if meta.images && meta.images.image && meta.images.image.og
    - const og = meta.images.image.og
    meta(property="og:image" content=`${app.origin}${app.basePath || ''}${og.src}`)
    meta(property="og:image:width" content=og.width)
    meta(property="og:image:height" content=og.height)
```

## Placeholders

`placeholder: color` sets the image's dominant colour as `style="background-color:#rrggbb"` on the `<img>`; `placeholder: blur` sets a tiny inline WebP as its `background-image` (about 100–300 bytes of HTML per image on real photos). The placeholder is visible only while the image loads. Both apply to Markdown images and to `meta.images` (the mixin renders them).

- An image that is not fully opaque (transparency, or `fit=contain` padding) gets **no** placeholder, because the background would stay visible through it after loading.
- **Content Security Policy:** placeholders are inline `style` attributes. A CSP whose `style-src` lacks `'unsafe-inline'` blocks them. That is why the default is `none`.

## Keeping your originals off the server

The plugin reads images from your assets folder **regardless of `.neraignore`**. So if you list your photo folder in `.neraignore`, only the processed, metadata-stripped variants are published, and the originals, with their EXIF and GPS data, never leave your repository:

```gitignore
# .neraignore (paths relative to the assets folder)
images/photos
```

Before you do this, check what else uses that folder. `.neraignore` matches **exact paths and folder prefixes only, no glob patterns**, and everything in a listed folder that the plugin does not process stops being published:

- SVG and GIF images, and files you link for download
- images your **templates** use directly, such as a teaser `img(src=meta.image)` or an `og:image` built from `meta.image`. Render those from `meta.images` instead (the mixin, the `og` snippet above).

A folder that holds only Markdown photos is the safe case. On the field-test site, listing all of `images` broke 8 URLs: template teasers and `og:image` tags from `meta.image`, plus two SVG diagrams. To find such URLs, build once and look for `src`, `srcset` and `content` values that point into the ignored folder.

## Cache and CI

Variants live in `.nera-cache/images/` (`cache_dir`): `files/` holds the images, `manifest.json` what they were made from. A variant is encoded only when its file is missing, and file names carry a hash of the source and the settings, so URLs are stable across builds and safe to cache forever. Variants no build uses any more are pruned (`prune: true`).

A cold build of a site with ~100 images takes a minute or more, because AVIF encoding is slow; a warm build adds well under a second. Keep the cache between CI runs:

```yaml
# GitHub Actions, before `npm run build`
- uses: actions/cache@v6
  with:
      path: .nera-cache
      key: nera-images-${{ hashFiles('assets/**', 'theme/assets/**', 'config/images.yaml') }}
      restore-keys: nera-images-
```

```yaml
# GitLab CI, in the build job
cache:
    - key: nera-images
      paths:
          - .nera-cache/
```

`nera dev` does not watch the cache folder, so it never causes a rebuild loop.

## Compatibility

- **`@nera-static/core` 4.13.0 or later** (the `getAssets` hook, which copies the variants into `public/`). On an older core the build stops with a message naming the required version, rather than publishing pages that link to missing files. A site without any processable image still builds.
- Node.js 20.18.1 or later.
- sharp ships prebuilt binaries for macOS, Linux and Windows on x64 and arm64.

## 🧪 Development

```bash
npx vitest run
npm run lint
```

The fixture images are generated by sharp at test time (`test/fixtures/make-images.js`), so no binaries are committed.

## 📦 License

MIT
