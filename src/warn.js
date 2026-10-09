// One prefix for every message the plugin prints, matching the fleet's
// `⚠️ plugin-<name>: …` style, so a site owner can tell where a warning came
// from in a build log full of other plugins.
export function warn(message) {
    console.warn(`⚠️ plugin-images: ${message}`)
}
