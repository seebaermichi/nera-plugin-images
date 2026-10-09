# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-10-09

### Fixed

-   README: a missing `alt` is reported by `nera check` (output rule
    `a11y-img-alt`), not by `nera validate`; the CI cache snippet uses
    `actions/cache@v6`; the `og:image` snippet says that `app.origin` comes
    from the `origin` key in `config/app.yaml`

## [1.0.0] - 2026-10-09

### Added

-   First release. Requires `@nera-static/core` 4.13.0 or later (the
    `getAssets` hook) and Node.js 20.18.1 or later
-   `getMetaData` rewrites every local raster image in the
    rendered pages to `<picture>` markup with AVIF/WebP `<source>`s, a
    `srcset`/`sizes` fallback `<img>` with intrinsic `width`/`height`, and
    lazy loading (the first image on a page eager, with
    `fetchpriority="high"`). `getAssets` (core >= 4.13.0) prunes the cache and
    hands the variants to core for `public/<output_path>`. The build fails
    with a clear message when core is too old to call `getAssets`. Core's
    version is read from the site first, so a symlinked plugin (`npm link`,
    an install by path) cannot hide the site's older core behind its own
    development copy
-   Encoding with sharp: EXIF orientation applied, all metadata (EXIF, GPS,
    ICC) stripped, colours converted to sRGB, widths never upscaled. Variants
    are cached in `.nera-cache/images/` (config `cache_dir`) with stable,
    content-hashed file names, so a warm build encodes nothing; variants no
    longer used are pruned (`prune: true`). Encodes run in parallel, bounded
    by `concurrency`
-   Per-image options as query parameters on the image URL
    (`![alt](/images/a.jpg?w=800&ratio=16:9)`): `w`, `h`, `ratio`, `fit`,
    `focus` (percent or `attention`/`entropy`), `q`, `formats`, `sizes`,
    `loading` and `skip`. Recognized parameters never reach the emitted URLs;
    unknown or invalid ones warn with the page and the URL and fall back to
    the defaults. `?w` also derives the default `sizes`
-   Captions: `![alt](src "Caption")` alone in its paragraph becomes
    `<figure class="nera-image">` with
    `<figcaption class="nera-image__caption">`, replacing the paragraph
    (config `figure: title`, the default; `figure: false` disables it)
-   Frontmatter images: for every key in `frontmatter_keys` (default
    `[image]`) holding a local image path, `meta.images.<key>` carries the
    precomputed `src`, `srcset`, `sizes`, `width`, `height`, `type` and the
    modern-format `sources`, plus `og` (one JPEG at the `og` preset,
    1200×630 cover by default; `og: false` disables it). The original
    `meta.<key>` string is never modified. Query parameters work on the
    frontmatter path as on a Markdown image
-   The `+picture(meta.images.image, { alt, class, sizes, loading })` Pug
    mixin (`views/picture.pug`), published to
    `views/vendor/plugin-images/` with `npm run publish-template` or the
    `nera-images` bin
-   Placeholders (config `placeholder: none | color | blur`, default
    `none`): `color` sets the image's dominant colour as
    `style="background-color:#rrggbb"`, `blur` a 16 px wide WebP as an
    inline `background-image`. Both apply to the content pass and to
    `meta.images.<key>` (`color`/`blur`, rendered by the mixin), are computed
    from the region the variants show, and are cached in the manifest. Images
    that are not fully opaque get none. Inline styles need `'unsafe-inline'`
    in a strict CSP's `style-src`
-   README: installation, before/after markup, configuration reference,
    query parameters, captions, frontmatter images and the mixin, `og:image`,
    placeholders and CSP, keeping originals off the server with
    `.neraignore`, and caching `.nera-cache` in CI
