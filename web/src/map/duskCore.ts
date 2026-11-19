/**
 * The "dusk" look (the default), the pixel work, applied to finished art tiles so nothing is
 * re-rendered. Runs in web workers (duskWorker.ts).
 *
 *  1. Grade: every exact palette colour maps to its dusk colour (duskPalette.ts); blended,
 *     zoomed-out colours go through a smooth grade built from the same anchors.
 *  2. Texture (zoom ≥ TEXTURE_MIN_ZOOM): tileable, world-anchored patterns per surface.
 *     They only lighten or darken the graded colour, so shadows and face tones survive.
 *  3. Building details (zoom ≥ 19) and street life (native zoom only): duskDetails.ts.
 */
import { addLife, detailBuildings, type Scale, type TileCtx } from './duskDetails'
import { clamp, FOAM, getTables, MASK, SLOT_MASK, slotOf, SPECIAL, SPECIAL_COLOUR, Surface, texture } from './duskPalette'

export const TEXTURE_MIN_ZOOM = 17 // below this a tile pixel covers ≥ 8 art px: texture would be noise
const DETAIL_STEP = 2 // building details on tiles with ≤ 2 art px per pixel (zoom ≥ 19)

/**
 * Grade (and, close up, texture and detail) one RGBA tile in place.
 * (x0, y0) = world art px of its top-left pixel; step = art px per tile pixel.
 * `scale` (the art projection) enables street life on native-zoom tiles.
 */
export function applyDusk(px: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, step: number, textured: boolean, scale?: Scale): void {
  const { keys, entry, colour, surface, shadowed, lut } = getTables()
  const cls = new Uint8Array(w * h)
  const shade = new Uint8Array(w * h)
  const detailed = step <= DETAIL_STEP
  for (let j = 0, p = 0; j < h; j++) {
    const Y = (y0 + j * step) & MASK
    for (let i = 0; i < w; i++, p += 4) {
      if (px[p + 3] === 0) continue
      const r = px[p]
      const g = px[p + 1]
      const b = px[p + 2]
      const k = (r << 16) | (g << 8) | b
      let slot = slotOf(k)
      while (keys[slot] !== -1 && keys[slot] !== k) slot = (slot + 1) & SLOT_MASK
      if (keys[slot] === -1) {
        const o = (((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2)) * 3
        px[p] = lut[o]
        px[p + 1] = lut[o + 1]
        px[p + 2] = lut[o + 2]
        continue
      }
      const e = entry[slot]
      const s = surface[e]
      const q = j * w + i
      cls[q] = s
      shade[q] = shadowed[e]
      let R = colour[e * 3]
      let G = colour[e * 3 + 1]
      let B = colour[e * 3 + 2]
      // Close up, windows get per-window treatment instead of the texture (duskDetails).
      const t = textured && !(detailed && s === Surface.Window) ? texture(s) : null
      if (t) {
        const code = t[(Y << 10) | ((x0 + i * step) & MASK)]
        if (code === SPECIAL) {
          const sc = SPECIAL_COLOUR[s]!
          const dim = shadowed[e] ? 0.7 : 1 // glints and lit windows are dimmer in shadow
          R = sc[0] * dim
          G = sc[1] * dim
          B = sc[2] * dim
        } else if (code !== 128) {
          R = clamp((R * code) >> 7)
          G = clamp((G * code) >> 7)
          B = clamp((B * code) >> 7)
        }
      }
      px[p] = R
      px[p + 1] = G
      px[p + 2] = B
    }
  }
  if (!detailed || !textured) return
  foam(px, w, h, cls)
  const ctx: TileCtx = { px, w, h, x0, y0, step, cls, shade }
  detailBuildings(ctx)
  if (step === 1 && scale) addLife(ctx, scale)
}

/** A 1 px light edge where water meets land (left/top neighbours only, so it reads as one line). */
function foam(px: Uint8ClampedArray, w: number, h: number, cls: Uint8Array) {
  const land = (s: number) => s !== Surface.Water && s !== Surface.Other
  for (let j = 1; j < h; j++)
    for (let i = 1; i < w; i++) {
      const q = j * w + i
      if (cls[q] !== Surface.Water || !(land(cls[q - 1]) || land(cls[q - w]))) continue
      const p = q * 4
      px[p] = (px[p] + FOAM[0]) >> 1
      px[p + 1] = (px[p + 1] + FOAM[1]) >> 1
      px[p + 2] = (px[p + 2] + FOAM[2]) >> 1
    }
}
