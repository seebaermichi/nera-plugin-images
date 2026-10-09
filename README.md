# @nera-static/plugin-images

A plugin for the [Nera](https://github.com/seebaermichi/nera) static site generator that turns every local image in your Markdown into responsive, modern-format markup at build time: `<picture>` with AVIF/WebP, `srcset`/`sizes`, `width`/`height`, lazy loading, and camera metadata (EXIF/GPS) stripped.

📖 **Documentation:** [nera.js.org](https://nera.js.org)

> **Work in progress.** This package is not published yet. It already rewrites Markdown images to `<picture>` markup at build time, with query parameters, captions, and frontmatter images for templates (`meta.images` + the `+picture` mixin); placeholders are still to come. It requires `@nera-static/core` 4.13.0 or later. The design and progress are tracked in [`ROADMAP.md`](./ROADMAP.md).

## 📦 License

MIT
