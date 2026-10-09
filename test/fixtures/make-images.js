import fs from 'fs'
import path from 'path'
import sharp from 'sharp'

// Fixture images are generated at test time so no binary blobs land in git.
// Each one stands for a case the plugin must handle (ROADMAP D5/D6):
//
//   photo.jpg   2000×1500 JPEG, EXIF orientation 6 + GPS: a phone photo that
//               must come out upright (1500×2000) with all metadata stripped
//   alpha.png   300×200 PNG with a transparent half: alpha must survive
//   logo.svg    vector: left untouched
//   anim.gif    2-frame animated GIF: left untouched

// Berlin, as EXIF rationals. Any value works; it only has to be there so a
// test can prove it is gone from the output.
const GPS = {
    GPSLatitudeRef: 'N',
    GPSLatitude: '52/1 31/1 0/1',
    GPSLongitudeRef: 'E',
    GPSLongitude: '13/1 24/1 0/1',
}

export const FIXTURES = {
    photo: { file: 'photo.jpg', width: 2000, height: 1500, orientation: 6 },
    alpha: { file: 'alpha.png', width: 300, height: 200 },
    svg: { file: 'logo.svg', width: 120, height: 60 },
    gif: { file: 'anim.gif', width: 40, height: 40, pages: 2 },
}

// TIFF tag 0x8825 is the pointer to the GPS IFD, in either byte order.
export function hasGpsIfd(exif) {
    return (
        exif.includes(Buffer.from([0x88, 0x25])) ||
        exif.includes(Buffer.from([0x25, 0x88]))
    )
}

function solid(width, height, background) {
    return sharp({ create: { width, height, channels: 3, background } })
}

async function makePhoto(file) {
    const { width, height, orientation } = FIXTURES.photo

    // Left half red, right half blue, so an orientation test can check where
    // a colour ends up after rotation, not just the swapped dimensions.
    const half = await solid(width / 2, height, '#0000ff').png().toBuffer()

    await solid(width, height, '#ff0000')
        .composite([{ input: half, left: width / 2, top: 0 }])
        .jpeg({ quality: 80 })
        .withExif({ IFD0: { Make: 'Nera Test Camera' }, IFD3: GPS })
        .withMetadata({ orientation })
        .toFile(file)
}

async function makeAlpha(file) {
    const { width, height } = FIXTURES.alpha
    const opaque = await sharp({
        create: {
            width: width / 2,
            height,
            channels: 4,
            background: { r: 0, g: 128, b: 0, alpha: 1 },
        },
    })
        .png()
        .toBuffer()

    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([{ input: opaque, left: 0, top: 0 }])
        .png()
        .toFile(file)
}

function makeSvg(file) {
    const { width, height } = FIXTURES.svg

    fs.writeFileSync(
        file,
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#336699"/></svg>\n`
    )
}

async function makeGif(file) {
    const { width, height } = FIXTURES.gif
    const frames = await Promise.all(
        ['#ff0000', '#00ff00'].map((color) =>
            solid(width, height, color).png().toBuffer()
        )
    )

    await sharp(frames, { join: { animated: true } })
        .gif({ delay: [200, 200], loop: 0 })
        .toFile(file)
}

/**
 * Write every fixture image into `dir` (created if missing).
 *
 * @param {string} dir absolute directory
 * @returns {Promise<Record<keyof FIXTURES, string>>} absolute path per fixture
 */
export async function makeImages(dir) {
    fs.mkdirSync(dir, { recursive: true })

    const paths = Object.fromEntries(
        Object.entries(FIXTURES).map(([key, { file }]) => [
            key,
            path.join(dir, file),
        ])
    )

    await Promise.all([
        makePhoto(paths.photo),
        makeAlpha(paths.alpha),
        makeSvg(paths.svg),
        makeGif(paths.gif),
    ])

    return paths
}
