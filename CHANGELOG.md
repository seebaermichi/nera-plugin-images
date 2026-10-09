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
