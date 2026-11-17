// Floor and drawer sizes. Pure functions: no DOM, so the unit tests import them.
//
// The scene is 480 x 272 scene pixels and scales in whole device pixels (scene/scene.js): on a Retina screen
// (devicePixelRatio 2) the steps are 0.5, 1, 1.5, 2 ... in CSS. While a panel is open the floor sits in the free area left
// of the drawer. A drawer that is a little narrower can buy the floor a whole scale step (at 1280 x 762: a drawer of 536 px
// instead of 589 px puts the floor at 1.5, 720 px wide, instead of 1.0). fitDrawer() finds that width.

export const SCENE_W = 480;
export const SCENE_H = 272;
export const DRAWER_MIN = 480;       // a normal drawer never gets narrower than this
export const DRAWER_WIDE_MIN = 660;  // the wide drawer (Models) keeps room for six score columns
export const FLOOR_GUTTER = 24;      // free space around a floor that the drawer narrowed for (12 px on each side)

/** Device pixels per CSS pixel, as whole numbers 1 to 4 (the scene uses the same rule). */
export function wholeDpr(ratio) {
  const n = Math.floor(Number(ratio) || 1);
  return Math.max(1, Math.min(4, n));
}

/** The largest whole-device-pixel scale of the scene in a box of w x h CSS px. Never below one device pixel per scene pixel. */
export function floorScale(w, h, dpr = 1) {
  const d = wholeDpr(dpr);
  const s = Math.floor(Math.min(w / SCENE_W, h / SCENE_H) * d) / d;
  return Number.isFinite(s) && s > 1 / d ? s : 1 / d;
}

/**
 * The drawer width that gives the floor the largest scale, or the normal width when narrowing buys nothing.
 *   width   the free width of the window (CSS px)
 *   height  the height of the stage (between the top bar and the ticker)
 *   base    the normal width of the drawer (from style.css)
 *   wide    the drawer holds a wide table (it keeps DRAWER_WIDE_MIN)
 * Returns { drawer, scale, narrowed }. The drawer is never narrower than its minimum, and never wider than base.
 * When base is already below the minimum (a small window), the drawer keeps base.
 */
export function fitDrawer({ width, height, base, wide = false, dpr = 1 }) {
  const W = Math.max(0, Number(width) || 0), H = Math.max(0, Number(height) || 0), B = Math.max(0, Number(base) || 0);
  const now = floorScale(W - B, H, dpr);
  const min = Math.min(B, wide ? DRAWER_WIDE_MIN : DRAWER_MIN);
  const best = floorScale(W - min - FLOOR_GUTTER, H, dpr);
  if (!(best > now) || SCENE_W * best > W - min - FLOOR_GUTTER) return { drawer: B, scale: now, narrowed: false };
  const drawer = Math.max(min, Math.min(B, Math.floor(W - SCENE_W * best - FLOOR_GUTTER)));
  return { drawer, scale: best, narrowed: drawer < B };
}
