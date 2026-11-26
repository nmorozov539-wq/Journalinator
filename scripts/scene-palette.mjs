/**
 * Scene palette extraction — the Colorizinator principle, reduced to what Journalinator needs.
 *
 *   scene image → sampled pixels → perceptual clusters → semantic roles → theme
 *
 * This is deliberately not a port of Colorizinator's profiles/zones/studio. The scene profile
 * below is tuned for battlemaps and handouts rather than wallpapers:
 *
 *   - a scene is usually dominated by one neutral (terrain/paper) plus a few vivid accents
 *     (tokens, torchlight, UI markers), so roles are picked by cluster weight *and* chroma;
 *   - surfaces are derived from the dominant hue at a clamped, low chroma, never from raw
 *     image pixels (raw map colours make unreadable card text);
 *   - dark/light mode follows the weighted mean luminance of the image;
 *   - text, muted and line are contrast-corrected against the panel;
 *   - GM-only (teal) and hint (gold) stay semantically distinct instead of being recoloured
 *     by the scene, and the link colour comes from a second vivid cluster when one exists.
 *
 * All colour math is OKLab/OKLCH so hue and lightness behave perceptually. The analysis is a
 * pure function of pixels (`analyzePixels`) and is unit-tested; the DOM part only decodes the
 * image and handles the CORS/tainted-canvas case by returning null so the caller can fall back.
 */
import { normalizeTheme } from "./styles/themes.mjs";

export const SCENE_THEME_ID = "scene";

export const SCENE_PROFILE = Object.freeze({
  sampleSize: 64,          // 64×64 is plenty for palette extraction and costs one small draw
  clusters: 6,
  iterations: 8,
  lightThreshold: 0.64,    // mean OKLab L at or above this becomes a light theme
  minAccentWeight: 0.015,  // ignore one-pixel sparkles
  minAccentChroma: 0.03,
  darkBg: [0.10, 0.24],
  lightBg: [0.80, 0.93],
  textContrast: 7,
  mutedContrast: 4.5,
  accentContrast: 3,
  threadContrast: 2,
  maxCachedScenes: 8
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clamp01 = value => clamp(value, 0, 1);
const wrapHue = hue => ((hue % 360) + 360) % 360;
const hueDistance = (a, b) => {
  const d = Math.abs(wrapHue(a) - wrapHue(b));
  return Math.min(d, 360 - d);
};
const distance = (a, b) => Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);

// --- sRGB ↔ OKLab ---------------------------------------------------------------------------

function channelToLinear(value) {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToChannel(value) {
  const v = value <= 0.0031308 ? 12.92 * value : 1.055 * Math.max(value, 0) ** (1 / 2.4) - 0.055;
  return Math.round(clamp01(v) * 255);
}

export function rgbToOklab(r, g, b) {
  const lr = channelToLinear(r), lg = channelToLinear(g), lb = channelToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  };
}

export function oklabToRgb({ L, a, b }) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return {
    r: linearToChannel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToChannel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToChannel(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
  };
}

const toLch = ({ L, a, b }) => ({ L, C: Math.hypot(a, b), h: wrapHue(Math.atan2(b, a) * 180 / Math.PI) });
const fromLch = (L, C, h) => ({
  L,
  a: C * Math.cos(h * Math.PI / 180),
  b: C * Math.sin(h * Math.PI / 180)
});

export function labToHex(lab) {
  const { r, g, b } = oklabToRgb(lab);
  return `#${[r, g, b].map(n => clamp(n, 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function mixLab(a, b, t) {
  return { L: a.L + (b.L - a.L) * t, a: a.a + (b.a - a.a) * t, b: a.b + (b.b - a.b) * t };
}

function luminance(lab) {
  const { r, g, b } = oklabToRgb(lab);
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Walk a foreground's lightness away from the background until the target ratio is met. */
function ensureContrast(fg, bg, target, direction) {
  let color = { ...fg };
  for (let step = 0; step < 24 && contrastRatio(color, bg) < target; step++) {
    color = { ...color, L: clamp(color.L + direction * 0.02, 0.02, 0.98) };
  }
  return color;
}

function parseHex(value) {
  if (typeof value !== "string") return null;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map(c => c + c).join("") : match[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

// --- clustering -----------------------------------------------------------------------------

function clusterSamples(samples, k) {
  // Seed from the most populated coarse buckets (deterministic, robust against outliers).
  const buckets = new Map();
  for (const point of samples) {
    const lch = toLch(point);
    const key = `${Math.round(lch.L * 12)}|${Math.round(lch.C * 30)}|${lch.C < 0.012 ? 0 : Math.round(lch.h / 30) % 12}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { L: 0, a: 0, b: 0, n: 0 }; buckets.set(key, bucket); }
    bucket.L += point.L; bucket.a += point.a; bucket.b += point.b; bucket.n++;
  }

  const seeds = [];
  for (const bucket of [...buckets.values()].sort((x, y) => y.n - x.n)) {
    const center = { L: bucket.L / bucket.n, a: bucket.a / bucket.n, b: bucket.b / bucket.n };
    if (seeds.every(seed => distance(seed, center) > 0.05)) seeds.push(center);
    if (seeds.length === k) break;
  }
  while (seeds.length < k) {
    let farthest = null, farthestDistance = 0;
    for (const point of samples) {
      const nearest = Math.min(...seeds.map(seed => distance(seed, point)));
      if (nearest > farthestDistance) { farthestDistance = nearest; farthest = point; }
    }
    if (!farthest || farthestDistance < 0.01) break;
    seeds.push({ L: farthest.L, a: farthest.a, b: farthest.b });
  }

  let centers = seeds;
  for (let iteration = 0; iteration < SCENE_PROFILE.iterations; iteration++) {
    const sums = centers.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
    for (const point of samples) {
      let index = 0, best = Infinity;
      for (let i = 0; i < centers.length; i++) {
        const d = distance(point, centers[i]);
        if (d < best) { best = d; index = i; }
      }
      const sum = sums[index];
      sum.L += point.L; sum.a += point.a; sum.b += point.b; sum.n++;
    }
    centers = centers.map((center, i) => sums[i].n
      ? { L: sums[i].L / sums[i].n, a: sums[i].a / sums[i].n, b: sums[i].b / sums[i].n }
      : center);
  }

  const counts = centers.map(() => 0);
  for (const point of samples) {
    let index = 0, best = Infinity;
    for (let i = 0; i < centers.length; i++) {
      const d = distance(point, centers[i]);
      if (d < best) { best = d; index = i; }
    }
    counts[index]++;
  }

  return centers
    .map((center, i) => ({ ...center, weight: counts[i] / samples.length }))
    .filter(cluster => cluster.weight > 0)
    .map(cluster => ({ ...cluster, ...toLch(cluster) }));
}

// --- role picking ---------------------------------------------------------------------------

/**
 * Pure analysis: accepts RGBA bytes and returns semantic colours + the OKLab values they were
 * derived from. Returns null when there are not enough opaque pixels to judge.
 */
export function analyzePixels(pixels, width, height) {
  const samples = [];
  const total = Math.max(1, Math.min(pixels.length / 4, width * height));
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    samples.push(rgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2]));
  }
  if (samples.length < 4) return null;

  const clusters = clusterSamples(samples, SCENE_PROFILE.clusters);
  if (!clusters.length) return null;

  const meanL = clusters.reduce((sum, cluster) => sum + cluster.L * cluster.weight, 0);
  const dominant = [...clusters].sort((a, b) => b.weight - a.weight)[0];

  // Light mode needs both a bright average and a bright dominant area; a dark map with a
  // bright token or torch should still get the dark board it belongs to.
  const mode = dominant.L >= 0.60 && meanL >= SCENE_PROFILE.lightThreshold ? "light" : "dark";
  const dark = mode === "dark";

  const vivid = [...clusters]
    .filter(cluster => cluster.C > 0.02)
    .sort((a, b) => b.C * b.weight - a.C * a.weight);
  const hueSource = dominant.C > 0.012 ? dominant : (vivid[0] ?? dominant);
  const baseHue = hueSource.h;

  // Background: dominant hue, low chroma, lightness pulled into a readable UI range.
  const bgL = dark
    ? clamp(0.12 + dominant.L * 0.22, ...SCENE_PROFILE.darkBg)
    : clamp(0.91 - (1 - dominant.L) * 0.08, ...SCENE_PROFILE.lightBg);
  const bg = fromLch(bgL, Math.min(dark ? 0.035 : 0.02, dominant.C * 0.3 + 0.006), baseHue);

  // Panel is one elevation step above the board: lighter in both modes (paper on a desk).
  const panel = fromLch(
    clamp(bg.L + (dark ? 0.055 : 0.04), 0.05, 0.98),
    toLch(bg).C * 0.9,
    baseHue
  );

  let text = fromLch(dark ? 0.95 : 0.17, 0.008, baseHue);
  text = ensureContrast(text, panel, SCENE_PROFILE.textContrast, dark ? 1 : -1);

  let muted = mixLab(text, panel, 0.52);
  muted = ensureContrast(muted, panel, SCENE_PROFILE.mutedContrast, dark ? 1 : -1);

  const line = ensureContrast(mixLab(panel, text, 0.28), panel, 1.35, dark ? 1 : -1);

  // Accent: the most vivid, sufficiently common cluster that is not the background itself.
  const candidates = clusters
    .filter(cluster => cluster.C >= SCENE_PROFILE.minAccentChroma && cluster.weight >= SCENE_PROFILE.minAccentWeight)
    .filter(cluster => distance(cluster, dominant) > 0.08 || cluster.C > 0.08)
    .map(cluster => ({
      ...cluster,
      score: cluster.C * Math.sqrt(cluster.weight) * (1 + hueDistance(cluster.h, baseHue) / 360)
    }))
    .sort((a, b) => b.score - a.score);

  const accentPick = candidates[0] ?? null;
  const accentHue = accentPick?.h ?? (dominant.C > 0.02 ? wrapHue(baseHue + 24) : 265);
  const accentChroma = clamp((accentPick?.C ?? 0.1) * 1.35, 0.08, 0.16);
  const accentL = accentPick?.L ?? (dark ? 0.70 : 0.48);
  let accent = fromLch(
    dark ? clamp(accentL, 0.64, 0.80) : clamp(accentL, 0.38, 0.56),
    accentChroma,
    accentHue
  );
  accent = ensureContrast(accent, panel, SCENE_PROFILE.accentContrast, dark ? 1 : -1);

  // Thread: a second vivid hue when the scene has one, otherwise a complement of the accent.
  const second = candidates.find(cluster => hueDistance(cluster.h, accentHue) > 30) ?? null;
  const threadHue = second ? second.h : wrapHue(accentHue + 145);
  let thread = fromLch(
    dark ? clamp(second?.L ?? 0.68, 0.60, 0.80) : clamp(second?.L ?? 0.48, 0.40, 0.56),
    clamp(second?.C ?? toLch(accent).C * 0.9, 0.05, 0.12),
    threadHue
  );
  thread = ensureContrast(thread, bg, SCENE_PROFILE.threadContrast, dark ? 1 : -1);

  // Semantics stay recognisable: GM teal, hint gold, danger red.
  const gm = fromLch(dark ? 0.72 : 0.42, 0.075, 195);
  const hint = fromLch(dark ? 0.78 : 0.50, 0.10, 78);
  const danger = fromLch(dark ? 0.64 : 0.47, 0.15, 25);
  const dangerBg = mixLab(bg, danger, 0.16);
  const dangerText = ensureContrast(mixLab(text, danger, 0.2), dangerBg, 4.5, dark ? 1 : -1);

  const nearWhite = fromLch(0.99, 0.005, baseHue);
  const nearBlack = fromLch(0.15, 0.005, baseHue);
  const onAccent = contrastRatio(accent, nearWhite) >= contrastRatio(accent, nearBlack) ? nearWhite : nearBlack;

  const stamp = fromLch(0.87, 0.045, 75);
  const shadow = { L: 0.05, a: 0, b: 0 };

  const labs = { bg, panel, text, muted, line, accent, thread, gm, hint, danger, dangerBg, dangerText, onAccent, stamp, shadow };
  // Theme tokens name the accent role `acc`; keep `labs.accent` for the style derivation.
  const colors = Object.fromEntries(Object.entries(labs).map(([key, lab]) => [key === "accent" ? "acc" : key, labToHex(lab)]));

  return {
    mode,
    colors,
    labs,
    meta: {
      meanL,
      dominant: { L: dominant.L, C: dominant.C, h: dominant.h, weight: dominant.weight },
      accent: { L: toLch(accent).L, C: toLch(accent).C, h: accentHue },
      sampled: total
    }
  };
}

/** Maps a palette onto a complete Journalinator theme (validated by the theme layer). */
export function paletteToTheme(palette, { id = SCENE_THEME_ID } = {}) {
  if (!palette?.colors) return null;
  const { colors: c, labs: p, mode } = palette;
  const surface = (a, b, t) => labToHex(mixLab(a, b, t));

  return normalizeTheme({
    id,
    nameKey: "JN.Theme.Scene",
    colors: c,
    board: {
      color: "bg",
      pattern: "dots",
      patternColor: c.line,
      patternSize: 24,
      patternOpacity: mode === "dark" ? 0.75 : 0.5,
      image: null,
      vignette: mode === "dark" ? 0.2 : 0.06
    },
    styles: {
      sticky: {
        surface: surface(p.panel, p.accent, 0.07), surfaceAlpha: 1,
        edgeWidth: 0, edgeStyle: "none", radius: 3, shadow: "paper"
      },
      document: {
        surface: c.panel, edge: c.line, edgeWidth: 1, edgeStyle: "solid",
        radius: 6, shadow: "raised", rule: c.line, ruleWidth: 1
      },
      torn: {
        surface: surface(p.panel, p.bg, 0.4), surfaceAlpha: 1,
        edgeWidth: 0, edgeStyle: "none", radius: 0, shadow: "none"
      },
      wanted: {
        surface: c.panel, edge: "line", edgeWidth: 1, radius: 6, shadow: "raised",
        rule: "line", ruleWidth: 1
      },
      memo: { surface: c.panel, edge: "line", edgeWidth: 1, radius: 6, shadow: "raised" }
    }
  }, { id, name: "Scene" });
}

// --- scene I/O ------------------------------------------------------------------------------

/**
 * The scene the user is looking at. Foundry v14 stores the background on the initial Level
 * (`scene.initialLevel.background.src`); older builds used `scene.background` / `scene.img`.
 */
export function activeSceneSource() {
  const scene = globalThis.canvas?.scene ?? globalThis.game?.scenes?.active ?? null;
  if (!scene) return null;

  let level = null;
  try { level = scene.initialLevel ?? scene.firstLevel ?? null; } catch { /* no levels yet */ }

  const legacyBackground = scene.background;
  const src = level?.background?.src
    ?? (typeof legacyBackground === "string" ? legacyBackground : legacyBackground?.src)
    ?? scene.img
    ?? "";
  const color = scene.backgroundColor
    ?? (typeof legacyBackground === "object" ? legacyBackground?.color : null)
    ?? null;
  if (!src && !color) return null;
  return { id: scene.id ?? src ?? color, src, color };
}

/**
 * Decodes a scene asset into a small RGBA buffer. Returns null on load failure or when the
 * canvas is tainted (remote/S3 assets without CORS headers): the caller then falls back to a
 * normal theme rather than showing a half-broken one.
 */
export async function loadScenePixels(src, size = SCENE_PROFILE.sampleSize) {
  const ImageCtor = globalThis.Image;
  const doc = globalThis.document;
  if (!ImageCtor || !doc) return null;

  const url = globalThis.foundry?.utils?.getRoute?.(src) ?? src;
  const image = new ImageCtor();
  image.crossOrigin = "anonymous";
  image.decoding = "async";

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out loading ${src}`)), 8000);
    image.onload = () => { clearTimeout(timer); resolve(); };
    image.onerror = () => { clearTimeout(timer); reject(new Error(`could not load ${src}`)); };
    image.src = url;
  });

  const canvas = doc.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, size, size);
  try {
    return context.getImageData(0, 0, size, size).data;
  } catch (err) {
    console.warn("Journalinator: scene image is not readable (CORS); using the fallback theme.", err);
    return null;
  }
}

const cache = new Map();

export function sceneCacheKey(source) {
  return source ? `${source.id}|${source.src}|${source.color ?? ""}` : "";
}

export function clearSceneThemeCache() {
  cache.clear();
}

async function buildSceneTheme(source) {
  let palette = null;
  if (source.src) {
    const pixels = await loadScenePixels(source.src, SCENE_PROFILE.sampleSize);
    if (pixels) palette = analyzePixels(pixels, SCENE_PROFILE.sampleSize, SCENE_PROFILE.sampleSize);
  }
  if (!palette && source.color) {
    const rgb = parseHex(source.color);
    if (rgb) {
      // A solid background colour still deserves a theme; repeat it so clustering has samples.
      const pixels = new Uint8ClampedArray(16 * 4);
      for (let i = 0; i < 16; i++) {
        pixels[i * 4] = rgb.r;
        pixels[i * 4 + 1] = rgb.g;
        pixels[i * 4 + 2] = rgb.b;
        pixels[i * 4 + 3] = 255;
      }
      palette = analyzePixels(pixels, 4, 4);
    }
  }
  return palette ? paletteToTheme(palette) : null;
}

/**
 * Returns a ready-to-apply scene theme, or null. Cached by scene id + image path + background
 * colour, so a board full of document updates does not re-decode the image.
 */
export async function sceneTheme(source = activeSceneSource()) {
  if (!source || (!source.src && !source.color)) return null;
  const key = sceneCacheKey(source);
  if (!cache.has(key)) {
    const job = buildSceneTheme(source).catch(err => {
      console.warn("Journalinator: scene palette failed; using the fallback theme.", err);
      return null;
    });
    cache.set(key, job);
    if (cache.size > SCENE_PROFILE.maxCachedScenes) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}
