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
