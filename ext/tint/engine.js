/* Satin color engine.
 *
 * Every color pdf.js paints is assigned to a canvas 2D context's fillStyle or
 * strokeStyle, so shadowing those two accessors is enough to (a) learn the
 * document's exact palette and (b) remap it live, with no PDF parsing and no
 * patching of pdf.js internals.
 *
 * The page background falls out of the same mechanism: pdf.js fills the canvas
 * with white before drawing, and that assignment is intercepted like any other.
 * The PDF default color (black, often never set explicitly in the file) is
 * handled by priming each context before a render pass.
 *
 * Raster images are deliberately out of scope: they reach the canvas through
 * drawImage/putImageData, which bypass these accessors, and are left untouched.
 */
(function (global) {
  "use strict";

  // ---------- color parsing ----------

  function parseColor(value) {
    if (typeof value !== "string") return null; // gradient / pattern object
    const s = value.trim().toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) {
      const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
      return { r, g, b, a: 1 };
    }
    m = /^#([0-9a-f]{6})$/.exec(s);
    if (m) {
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const chan = (p) =>
        p.endsWith("%")
          ? Math.round((parseFloat(p) / 100) * 255)
          : Math.round(parseFloat(p));
      const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
      const c = { r: chan(parts[0]), g: chan(parts[1]), b: chan(parts[2]), a };
      return Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b)
        ? c
        : null;
    }
    return null;
  }

  const hex2 = (v) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");

  function toKey(c) {
    return "#" + hex2(c.r) + hex2(c.g) + hex2(c.b);
  }

  function toCss(c) {
    return c.a >= 1
      ? toKey(c)
      : `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${c.a})`;
  }

  // ---------- Oklab ----------

  const srgbToLinear = (c) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const linearToSrgb = (c) =>
    c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
  const cbrt = (v) => (v >= 0 ? Math.cbrt(v) : -Math.cbrt(-v));

  function rgbToOklab(r, g, b) {
    r = srgbToLinear(r);
    g = srgbToLinear(g);
    b = srgbToLinear(b);
    const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  function oklabToRgb(L, a, bb) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * bb, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * bb, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * bb, 3);
    return [
      linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  }

  const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

  /* Oklch — Oklab in polar form. Lightness/chroma/hue are what a person
     actually wants to drag, and hue stays put while the other two move. */
  function toOklch(c) {
    const [L, a, b] = rgbToOklab(c.r / 255, c.g / 255, c.b / 255);
    const C = Math.hypot(a, b);
    return {
      L,
      C,
      /* Hue is meaningless at zero chroma; pin it so greys round-trip. */
      h: C < 1e-6 ? 0 : (((Math.atan2(b, a) * 180) / Math.PI) + 360) % 360,
    };
  }

  /* Back to sRGB, pulling chroma in only as far as needed to land in gamut. */
  function fromOklch({ L, C, h }, alpha = 1) {
    const rad = (h * Math.PI) / 180;
    const at = Math.cos(rad) * C;
    const bt = Math.sin(rad) * C;
    let rgb = oklabToRgb(L, at, bt);
    if (!inGamut(rgb)) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (inGamut(oklabToRgb(L, at * mid, bt * mid))) lo = mid;
        else hi = mid;
      }
      rgb = oklabToRgb(L, at * lo, bt * lo);
    }
    return {
      r: Math.max(0, Math.min(255, rgb[0] * 255)),
      g: Math.max(0, Math.min(255, rgb[1] * 255)),
      b: Math.max(0, Math.min(255, rgb[2] * 255)),
      a: alpha,
    };
  }

  /* Remap perceptual lightness by the straight line through (0, black) and
     (1, white), keeping hue and chroma. `black` is where the document's black
     lands and `white` is where its white lands, so the identity is (0, 1) and a
     full inversion is (1, 0). Anything in between is available: (0.9, 0.12)
     reads as dark mode without the glare of pure white on pure black, and
     (0.05, 0.9) softens a light document. Chroma is pulled in only as far as
     needed to stay inside sRGB. */
  function affineLightness(c, { black = 0, white = 1 } = {}) {
    const { L, C, h } = toOklch(c);
    return fromOklch({ L: black + L * (white - black), C, h }, c.a);
  }

  // ---------- engine ----------

  const engine = {
    /** Where the document's black and white land on the lightness axis. */
    affine: { black: 0, white: 1 },
    /** key '#rrggbb' -> '#rrggbb': per-color overrides, win over the affine map. */
    overrides: new Map(),
    /** key '#rrggbb' -> { key, count }. */
    palette: new Map(),
    /** Bump to invalidate the memo when the affine map or overrides change. */
    revision: 0,

    _memo: new Map(),

    /** Affine-only result for a key, ignoring overrides. */
    baseline(key) {
      const c = parseColor(key);
      if (!c) return key;
      const { black, white } = this.affine;
      if (black === 0 && white === 1) return key;
      return toKey(affineLightness(c, this.affine));
    },

    /** Final mapped color for a key: override if present, else baseline. */
    resolve(key) {
      const override = this.overrides.get(key);
      return override !== undefined ? override : this.baseline(key);
    },

    transform(value) {
      const c = parseColor(value);
      if (!c) return value; // gradients, patterns, unparseable: pass through
      const key = toKey(c);
      const seen = this.palette.get(key);
      if (seen) seen.count++;
      else this.palette.set(key, { key, count: 1 });

      const memoKey = key + "|" + this.revision;
      let mapped = this._memo.get(memoKey);
      if (mapped === undefined) {
        mapped = this.resolve(key);
        this._memo.set(memoKey, mapped);
      }
      if (mapped === key) return value; // keep original notation & alpha
      const m = parseColor(mapped);
      return m ? toCss({ r: m.r, g: m.g, b: m.b, a: c.a }) : value;
    },

    touch() {
      this.revision++;
      if (this._memo.size > 4096) this._memo.clear();
    },

    resetPalette() {
      this.palette.clear();
    },

    /** Record a color found by scanning the document rather than by painting. */
    observe(key, count = 1) {
      const seen = this.palette.get(key);
      if (seen) seen.count += count;
      else this.palette.set(key, { key, count });
    },

    /* Ordered for reading, not for insertion or frequency: greys first, darkest
       to lightest, then the chromatic colors by hue. Sorting by use count looks
       arbitrary on screen, and any order keyed on when a color was first seen
       shuffles as more pages render. */
    sortedPalette() {
      const NEUTRAL = 0.02;
      return [...this.palette.values()]
        .map((entry) => {
          const c = parseColor(entry.key);
          return c ? { ...entry, ...toOklch(c) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => {
          const aN = a.C < NEUTRAL;
          const bN = b.C < NEUTRAL;
          if (aN !== bN) return aN ? -1 : 1;
          if (aN) return a.L - b.L;
          return a.h - b.h || a.L - b.L;
        });
    },

    /** The color a fresh context should start at: PDF's implicit default is
        black, and many producers never emit a color operator at all. */
    defaultColor() {
      return this.transform("#000000");
    },

    /** Prime a context so an unset default color is mapped too. */
    prime(ctx) {
      ctx.fillStyle = "#000000";
      ctx.strokeStyle = "#000000";
    },

    install(win) {
      const w = win || global;
      /* Both context types matter: the pdf.js viewer paints pages into an
         OffscreenCanvas, whose 2D context does NOT share a prototype with a
         regular canvas's, while direct page.render() callers pass the latter. */
      const protos = [w.CanvasRenderingContext2D, w.OffscreenCanvasRenderingContext2D]
        .filter(Boolean)
        .map((ctor) => ctor.prototype);
      let patched = 0;
      for (const proto of protos) {
        if (!proto || proto.__satinInstalled) continue;
        for (const prop of ["fillStyle", "strokeStyle"]) {
          const desc = Object.getOwnPropertyDescriptor(proto, prop);
          if (!desc || !desc.set) continue;
          Object.defineProperty(proto, prop, {
            configurable: true,
            enumerable: desc.enumerable,
            get() {
              return desc.get.call(this);
            },
            set(value) {
              desc.set.call(this, engine.transform(value));
            },
          });
        }
        Object.defineProperty(proto, "__satinInstalled", {
          value: true,
          enumerable: false,
        });
        patched++;
      }
      return patched > 0;
    },
  };

  engine.parseColor = parseColor;
  engine.toKey = toKey;
  engine.affineLightness = affineLightness;
  engine.hexToOklch = (hex) => {
    const c = parseColor(hex);
    return c ? toOklch(c) : null;
  };
  engine.oklchToHex = (lch) => toKey(fromOklch(lch));

  global.Satin = engine;

  // Patch on load, not on first use: this script runs before pdf.js, and any
  // color assigned before the accessors are in place would escape untinted.
  engine.install(global);
})(typeof window !== "undefined" ? window : globalThis);
