# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

-   Repository scaffold: package metadata, fleet lint/test/publish setup, and
    a test-time fixture generator (`test/fixtures/make-images.js`). No plugin
    behaviour yet; see `ROADMAP.md` for the plan
-   Image engine (not wired into any hook yet): config loading with
    per-key validation (`src/config.js`), URL → source file resolution over
    the site and theme assets (`src/resolve-source.js`), variant planning and
    the sharp encode pipeline (`src/transform.js`), the variant cache with
    manifest and pruning (`src/cache.js`), a bounded, de-duplicating encode
    queue (`src/queue.js`) and the generator that ties them together
    (`src/generate.js`)
-   The plugin itself: `getMetaData` rewrites every local raster image in the
    rendered pages to `<picture>` markup with AVIF/WebP `<source>`s, a
    `srcset`/`sizes` fallback `<img>` with intrinsic `width`/`height`, and
    lazy loading (the first image on a page eager, with
    `fetchpriority="high"`). `getAssets` (core >= 4.13.0) prunes the cache and
    hands the variants to core for `public/<output_path>`. The build fails
    with a clear message when core is too old to call `getAssets`
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
