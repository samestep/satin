#!/usr/bin/env node
// Render the Satin logo as a PNG.
//
//   node render.mjs <size> [supersample] > icon.png
//
// A satin ribbon lies along the line y = x with its lower-left half at z = -h and its upper-right half
// at z = +h; the bend between them is an arc-length-parametrized S that can overhang. An upright
// orthographic camera and a point or line light are placed by direction and elevation, and the fabric
// is shaded with the Ashikhmin-Shirley anisotropic BRDF, using one material for the centre of the
// ribbon and another for a band along each outer edge. Every pixel is ray-traced at <size> ×
// <supersample> resolution and box-filtered down in linear light, with rounded corners cut from the
// frame and transparency outside them. The PNG goes to standard output.
//
// PARAMS below are the settled design; the model code is the same as the interactive design tool's.
import { deflateSync } from 'node:zlib';

const PARAMS = {
  "bg": "#111111",
  "corner": 50,
  "width": 2.6,
  "lift": 1.7,
  "bendAngle": 161,
  "bendShape": 4.5,
  "bendAsym": 0.2,
  "camAz": -107,
  "camEl": 31.5,
  "camRoll": -42.5,
  "alignEdge": false,
  "showAxes": false,
  "zoom": 1.9,
  "panX": -0.164,
  "panY": 0.044,
  "baseColor": "#06070c",
  "specTint": 0.72,
  "specF0": 0.35,
  "glossAlong": 1.4,
  "glossAcross": 1.5,
  "threadAngle": 0,
  "sheen": 0.92,
  "sheenPow": 2.4,
  "ambient": 0,
  "edgeFrac": 6,
  "edgeSoft": 0.06,
  "baseColorE": "#202022",
  "specTintE": 0.73,
  "specF0E": 0.33,
  "glossAlongE": 0.75,
  "glossAcrossE": 1.85,
  "threadAngleE": 90,
  "sheenE": 0.13,
  "sheenPowE": 8,
  "ambientE": 0.95,
  "lightShape": "point",
  "lightAz": 176,
  "lightEl": 9.5,
  "lightDist": 2,
  "lightIntensity": 6,
  "lightColor": "#ffffff",
  "exposure": -0.6,
  "rolloff": true,
  "aa": "3",
  "stripA": "#2a2932",
  "stripB": "#eef2e8"
};

const [sizeArg, ssArg] = process.argv.slice(2);
if (!sizeArg) { console.error('usage: render.mjs <size> [supersample] > icon.png'); process.exit(2); }
const size = Math.max(1, Math.round(+sizeArg)), SS = Math.max(1, Math.round(+(ssArg ?? 3)));

const D2R = Math.PI / 180, R2 = Math.SQRT1_2;

// ---------- color helpers ----------
const clamp01 = c => c < 0 ? 0 : c > 1 ? 1 : c;
const lin2srgb = c => { c = clamp01(c); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
const srgb2lin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const hex2lin = h => [1, 3, 5].map(i => srgb2lin(parseInt(h.slice(i, i + 2), 16) / 255));
const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const byte = v => ('0' + Math.round(clamp01(v) * 255).toString(16)).slice(-2);
const lin2hex = c => '#' + byte(lin2srgb(c[0])) + byte(lin2srgb(c[1])) + byte(lin2srgb(c[2]));
const softclip = c => c <= 0.75 ? c : 0.75 + 0.25 * Math.tanh((c - 0.75) / 0.25);

// ---------- vectors ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------- scene: ribbon + camera ----------
function makeScene(P) {
  // camera on the sphere around the origin: direction angle in the xy plane, elevation above it
  const el = Math.max(5, Math.min(90, P.camEl)) * D2R, ph = P.camAz * D2R;
  const c = [Math.cos(el) * Math.cos(ph), Math.cos(el) * Math.sin(ph), Math.sin(el)];   // origin -> camera
  const f = [-c[0], -c[1], -c[2]];                                                     // view direction
  // upright camera: image up is world z projected onto the image plane (= the far direction on the ground)
  const u0 = [-Math.sin(el) * Math.cos(ph), -Math.sin(el) * Math.sin(ph), Math.cos(el)];
  const r0 = cross(f, u0);
  // roll: user roll, plus (optionally) whatever rotation puts the ribbon edge direction (1,1,0) at 45° in the image
  let rho = -P.camRoll * D2R;
  if (P.alignEdge) { const e = [R2, R2, 0]; rho += Math.atan2(dot(e, u0), dot(e, r0)) - 45 * D2R; }
  const cr = Math.cos(rho), sr = Math.sin(rho);
  const r = [r0[0] * cr + u0[0] * sr, r0[1] * cr + u0[1] * sr, r0[2] * cr + u0[2] * sr];
  const u = [-r0[0] * sr + u0[0] * cr, -r0[1] * sr + u0[1] * cr, -r0[2] * sr + u0[2] * cr];
  const S = P.zoom, pan = [P.panX, P.panY];
  // orthographic rays facing the origin; a: image-plane x, b: image-plane y (up), in world units
  const ray = (a, b, out) => {
    out.o[0] = a * r[0] + b * u[0] - f[0] * 30;
    out.o[1] = a * r[1] + b * u[1] - f[1] * 30;
    out.o[2] = a * r[2] + b * u[2] - f[2] * 30;
    out.d[0] = f[0]; out.d[1] = f[1]; out.d[2] = f[2];
  };
  // ---- bend profile in the (s, z) plane, parametrized by arc length ----
  // heading angle theta(t), t in [0,1]: 0 at both ends, peaking at the maximum bend angle
  const H = P.lift, thMax = P.bendAngle * D2R, qq = P.bendShape;
  const bb = 0.5 + 0.45 * P.bendAsym, biasK = 1 / bb - 2;
  const theta = t => thMax * Math.pow(Math.sin(Math.PI * (t / (biasK * (1 - t) + 1))), qq);
  const M = 240;
  let sinInt = 0; for (let i = 0; i < M; i++) sinInt += Math.sin(theta((i + 0.5) / M)) / M;
  const L = 2 * H / Math.max(1e-6, sinInt);      // arc length of the bend so that it rises from -H to +H
  const cs = new Float64Array(M + 1), cz = new Float64Array(M + 1);
  let ss = 0, zz = -H;
  for (let i = 0; i < M; i++) { const th = theta((i + 0.5) / M); cs[i] = ss; cz[i] = zz; ss += Math.cos(th) * L / M; zz += Math.sin(th) * L / M; }
  cs[M] = ss; cz[M] = H;
  const cth = new Float64Array(M + 1); for (let i = 0; i <= M; i++) cth[i] = theta(i / M);
  const sMid = cs[M >> 1]; let sMin = Infinity, sMax = -Infinity;
  for (let i = 0; i <= M; i++) { cs[i] -= sMid; if (cs[i] < sMin) sMin = cs[i]; if (cs[i] > sMax) sMax = cs[i]; }
  const sStart = cs[0], sEnd = cs[M];
  // all intersections of a ray with the extruded profile: flats (z=-H, s<=sStart), (z=+H, s>=sEnd) and the bend polyline.
  // Writes ray parameter and local heading into hl/ht, returns the count.
  const intersect = (o, d, hl, ht) => {
    let nh = 0;
    const s0 = (o[0] + o[1]) * R2, sd = (d[0] + d[1]) * R2, z0 = o[2], zd = d[2];
    if (zd >= -1e-9) return 0;
    const l0 = (-H - z0) / zd, lH = (H - z0) / zd;
    if (l0 > 0 && s0 + l0 * sd <= sStart + 1e-9) { hl[nh] = l0; ht[nh++] = 0; }
    if (lH > 0 && s0 + lH * sd >= sEnd - 1e-9) { hl[nh] = lH; ht[nh++] = 0; }
    const sa = s0 + lH * sd, sb = s0 + l0 * sd;
    if (Math.max(sa, sb) >= sMin && Math.min(sa, sb) <= sMax) {
      for (let i = 0; i < M && nh < 15; i++) {
        const ex = cs[i + 1] - cs[i], ez = cz[i + 1] - cz[i];
        const den = sd * ez - zd * ex; if (Math.abs(den) < 1e-12) continue;
        const ax = cs[i] - s0, az = cz[i] - z0;
        const mu = (ax * zd - az * sd) / den; if (mu < 0 || mu >= 1) continue;
        const l = (ax * ez - az * ex) / den; if (l <= 1e-9) continue;
        hl[nh] = l; ht[nh++] = theta((i + mu) / M);
      }
    }
    return nh;
  };
  return { ray, intersect, S, pan, r, u, f, curve: { cs, cz, cth, M, H, sStart, sEnd, sMin, sMax }, info: { L, run: sEnd - sStart, overhang: Math.max(0, sMax - sEnd, sStart - sMin) } };
}

// ---------- shading ----------
// everything about light and material that does not depend on the pixel
function lightMaterial(P) {
  const lc = hex2lin(P.lightColor);
  const expo = Math.pow(2, P.exposure), I = P.lightIntensity * expo;
  // one parameter set per material; suffix '' is the centre, 'E' the edge band
  const mat = x => { const base = hex2lin(P['baseColor' + x]); return { base, spec: base.map(b => 1 + (b - 1) * P['specTint' + x]), lnu: P['glossAlong' + x], lnv: P['glossAcross' + x], F0: P['specF0' + x], psi: P['threadAngle' + x] * D2R, sheenK: P['sheen' + x] * expo, sheenPow: P['sheenPow' + x], amb: P['ambient' + x] * expo }; };
  const bandW = P.edgeFrac / 100 * P.width, blendW = P.edgeSoft * bandW;
  // light: point or infinite line, normalized so the irradiance at the origin does not change with distance
  const laz = P.lightAz * D2R, lel = P.lightEl * D2R, LD = Math.pow(10, P.lightDist);
  const Q0 = [Math.cos(lel) * Math.cos(laz) * LD, Math.cos(lel) * Math.sin(laz) * LD, Math.sin(lel) * LD];
  const isLine = P.lightShape !== 'point';
  const le = P.lightShape === 'lineS' ? [R2, R2, 0] : [-R2, R2, 0];
  const q0e = dot(Q0, le), d0 = isLine ? Math.hypot(Q0[0] - q0e * le[0], Q0[1] - q0e * le[1], Q0[2] - q0e * le[2]) : LD;
  return { lc, I, Q0, isLine, le, LD, d0, W: P.width, bg: hex2lin(P.bg), m0: mat(''), m1: mat('E'), bandW, blendW };
}
// blend factor toward the edge material from the distance to the nearest ribbon edge
function edgeMix(ph, bandW, blendW) {
  if (blendW < 1e-9) return ph < bandW ? 1 : 0;
  const t = Math.min(1, Math.max(0, (ph - (bandW - blendW)) / (2 * blendW)));
  return 1 - t * t * (3 - 2 * t);
}
// ---------- renderer: one row of the image at a time ----------
function makeRenderer(P, r, padC) {
  const n = r + 2 * padC, lo = -padC / r, hi = 1 + padC / r, span = hi - lo;
  const SC = makeScene(P), S = SC.S;
  const { lc, I, Q0, isLine, le, LD, d0, W, m0, m1, bandW, blendW } = lightMaterial(P);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ray = { o: [0, 0, 0], d: [0, 0, 0] }, HL = new Float64Array(16), HT = new Float64Array(16);
  // shade one row j of the grid into the given buffers (shade and mask may be null)
  const renderRow = (j, shade, rgb, phi, mask) => {
    const ny = lo + (j + 0.5) / n * span, b = (0.5 - ny - P.panY) * S, jin = j >= padC && j < padC + r;
    for (let i = 0; i < n; i++) {
      const nx = lo + (i + 0.5) / n * span, a = (nx - 0.5 - P.panX) * S, idx = j * n + i;
      SC.ray(a, b, ray);
      const o = ray.o, d = ray.d;
      const nh = SC.intersect(o, d, HL, HT);
      // choose the nearest hit that lies within the ribbon; otherwise the hit closest to being inside
      let chosen = -1, firstL = Infinity, bestPhi = -Infinity, bestK = -1, phSel = -1;
      for (let k = 0; k < nh; k++) {
        const l = HL[k], u = ((o[1] + l * d[1]) - (o[0] + l * d[0])) * R2, ph = Math.min(u, W - u);
        if (ph > bestPhi) { bestPhi = ph; bestK = k; }
        if (ph >= 0 && l < firstL) { firstL = l; chosen = k; phSel = ph; }
      }
      const inside = chosen >= 0;
      if (!inside) { chosen = bestK; phSel = bestPhi; }
      phi[idx] = nh ? bestPhi : -1;
      if (mask) mask[idx] = (inside && jin && i >= padC && i < padC + r) ? 1 : 0;
      if (chosen < 0) {
        const cr = m0.base[0] * m0.amb, cg = m0.base[1] * m0.amb, cb = m0.base[2] * m0.amb;
        rgb[idx * 3] = cr; rgb[idx * 3 + 1] = cg; rgb[idx * 3 + 2] = cb; if (shade) shade[idx] = lin2srgb(0.2126 * cr + 0.7152 * cg + 0.0722 * cb);
        continue;
      }
      // material at this point: centre, edge, or a blend across the boundary
      const mm = edgeMix(phSel, bandW, blendW);
      const base = [lerp(m0.base[0], m1.base[0], mm), lerp(m0.base[1], m1.base[1], mm), lerp(m0.base[2], m1.base[2], mm)];
      const spec = [lerp(m0.spec[0], m1.spec[0], mm), lerp(m0.spec[1], m1.spec[1], mm), lerp(m0.spec[2], m1.spec[2], mm)];
      const nu = Math.pow(10, lerp(m0.lnu, m1.lnu, mm)), nv = Math.pow(10, lerp(m0.lnv, m1.lnv, mm));
      const normK = Math.sqrt((nu + 1) * (nv + 1)) / (8 * Math.PI), F0 = lerp(m0.F0, m1.F0, mm), kdc = 28 / (23 * Math.PI) * (1 - F0);
      const psi = lerp(m0.psi, m1.psi, mm), cpsi = Math.cos(psi), spsi = Math.sin(psi);
      const sheenK = lerp(m0.sheenK, m1.sheenK, mm), sheenPow = lerp(m0.sheenPow, m1.sheenPow, mm), amb = lerp(m0.amb, m1.amb, mm);
      let cr = base[0] * amb, cg = base[1] * amb, cb = base[2] * amb;
      const l = HL[chosen], th = HT[chosen], sth = Math.sin(th), cth = Math.cos(th);
      const Px = o[0] + l * d[0], Py = o[1] + l * d[1], Pz = o[2] + l * d[2];
      const Vx = -d[0], Vy = -d[1], Vz = -d[2];
      // normal of the profile, two-sided: face the camera
      let Nx = -sth * R2, Ny = -sth * R2, Nz = cth;
      let flip = 1; if (Nx * Vx + Ny * Vy + Nz * Vz < 0) { Nx = -Nx; Ny = -Ny; Nz = -Nz; flip = -1; }
      // thread direction in the tangent plane: along the ribbon (cth*e_s + sth*z) rotated toward across (e_u)
      const Tx = cpsi * cth * R2 - spsi * R2, Ty = cpsi * cth * R2 + spsi * R2, Tz = cpsi * sth;
      const NdotV = Math.max(1e-4, Nx * Vx + Ny * Vy + Nz * Vz);
      const sh = sheenK * Math.pow(Math.max(0, 1 - NdotV), sheenPow);
      cr += spec[0] * sh; cg += spec[1] * sh; cb += spec[2] * sh;
      // light directions: diffuse (Ld) and specular (Ls) and the normalized attenuation
      let Ldx, Ldy, Ldz, Lsx, Lsy, Lsz, att;
      const wx = Q0[0] - Px, wy = Q0[1] - Py, wz = Q0[2] - Pz;
      if (!isLine) {
        const d2 = wx * wx + wy * wy + wz * wz, il = 1 / Math.sqrt(d2);
        Ldx = Lsx = wx * il; Ldy = Lsy = wy * il; Ldz = Lsz = wz * il; att = LD * LD / d2;
      } else {
        // diffuse: an infinite line integrates to the foot-point direction with 1/d falloff
        const fw = wx * le[0] + wy * le[1] + wz * le[2];
        const fx = wx - fw * le[0], fy = wy - fw * le[1], fz = wz - fw * le[2];
        const dp = Math.max(1e-6, Math.hypot(fx, fy, fz));
        Ldx = fx / dp; Ldy = fy / dp; Ldz = fz / dp; att = d0 / dp;
        // specular: the point on the line closest to the mirror direction of the view ray
        const nv2 = 2 * (Nx * Vx + Ny * Vy + Nz * Vz);
        const Rx = nv2 * Nx - Vx, Ry = nv2 * Ny - Vy, Rz = nv2 * Nz - Vz;
        const bb = Rx * le[0] + Ry * le[1] + Rz * le[2], dd = Rx * wx + Ry * wy + Rz * wz, den = 1 - bb * bb;
        let lam = den > 1e-6 ? (dd - bb * fw) / den : 0; if (lam < 0) lam = 0;
        const t = lam * bb - fw;
        const sx = wx + t * le[0], sy = wy + t * le[1], sz = wz + t * le[2], il = 1 / Math.max(1e-6, Math.hypot(sx, sy, sz));
        Lsx = sx * il; Lsy = sy * il; Lsz = sz * il;
      }
      const NdotLd = Nx * Ldx + Ny * Ldy + Nz * Ldz, NdotLs = Nx * Lsx + Ny * Lsy + Nz * Lsz;
      const wgt = I * att;
      if (NdotLd > 0) {
        const kd = kdc * (1 - Math.pow(1 - NdotLd / 2, 5)) * (1 - Math.pow(1 - NdotV / 2, 5)) * NdotLd * wgt;
        cr += base[0] * kd * lc[0]; cg += base[1] * kd * lc[1]; cb += base[2] * kd * lc[2];
      }
      if (NdotLs > 0) {
        let Hx = Lsx + Vx, Hy = Lsy + Vy, Hz = Lsz + Vz; { const il = 1 / Math.sqrt(Hx * Hx + Hy * Hy + Hz * Hz); Hx *= il; Hy *= il; Hz *= il; }
        const NdotH = Nx * Hx + Ny * Hy + Nz * Hz, HdotV = Math.max(1e-4, Hx * Vx + Hy * Vy + Hz * Vz);
        const F = F0 + (1 - F0) * Math.pow(1 - HdotV, 5);
        const Bx = Ny * Tz - Nz * Ty, By = Nz * Tx - Nx * Tz, Bz = Nx * Ty - Ny * Tx;
        const HdotT = Hx * Tx + Hy * Ty + Hz * Tz, HdotB = Hx * Bx + Hy * By + Hz * Bz;
        const den = 1 - NdotH * NdotH;
        let sp = normK * F / (HdotV * Math.max(NdotLs, NdotV));
        if (den > 1e-7) sp *= Math.pow(Math.max(0, NdotH), (nu * HdotT * HdotT + nv * HdotB * HdotB) / den);
        if (sp > 50) sp = 50;
        sp *= NdotLs * wgt;
        cr += spec[0] * sp * lc[0]; cg += spec[1] * sp * lc[1]; cb += spec[2] * sp * lc[2];
      }
      if (P.rolloff) { cr = softclip(cr); cg = softclip(cg); cb = softclip(cb); }
      rgb[idx * 3] = cr; rgb[idx * 3 + 1] = cg; rgb[idx * 3 + 2] = cb;
      if (shade) shade[idx] = lin2srgb(0.2126 * cr + 0.7152 * cg + 0.0722 * cb);
    }
  };
  return { n, r, padC, lo, hi, span, renderRow, info: SC.info, S, basis: { r: SC.r, u: SC.u } };
}

// ---- render at supersampled resolution ----
const P = PARAMS, n = size * SS;
const R = makeRenderer(P, n, 0);
const rgb = new Float32Array(n * n * 3), phi = new Float32Array(n * n);
const t0 = Date.now();
for (let j = 0; j < n; j++) R.renderRow(j, null, rgb, phi, null);

// ---- composite: ribbon or background inside the rounded frame, transparent outside; average in linear light ----
const bg = hex2lin(P.bg);
const corner = P.corner / 100;
const px = new Uint8Array(size * size * 4);
for (let Y = 0; Y < size; Y++) for (let X = 0; X < size; X++) {
  let r = 0, g = 0, b = 0, cov = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const i = X * SS + sx, j = Y * SS + sy;
    const nx = (i + 0.5) / n, ny = (j + 0.5) / n;
    const qx = Math.max(Math.abs(nx - 0.5) - (0.5 - corner), 0), qy = Math.max(Math.abs(ny - 0.5) - (0.5 - corner), 0);
    if (Math.hypot(qx, qy) - corner > 0) continue;
    const idx = j * n + i;
    if (phi[idx] >= 0) { r += rgb[idx * 3]; g += rgb[idx * 3 + 1]; b += rgb[idx * 3 + 2]; }
    else { r += bg[0]; g += bg[1]; b += bg[2]; }
    cov++;
  }
  const o = (Y * size + X) * 4;
  if (cov) { px[o] = Math.round(lin2srgb(r / cov) * 255); px[o + 1] = Math.round(lin2srgb(g / cov) * 255); px[o + 2] = Math.round(lin2srgb(b / cov) * 255); }
  px[o + 3] = Math.round(cov / (SS * SS) * 255);
}

// ---- PNG ----
const crcTable = new Int32Array(256);
for (let k = 0; k < 256; k++) { let c = k; for (let i = 0; i < 8; i++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[k] = c; }
const crc32 = buf => { let c = -1; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; raw.set(px.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1); }
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
process.stdout.write(png);
console.error(`rendered ${size}×${size} (${SS}×${SS} samples per pixel) in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${(png.length / 1024).toFixed(0)} KB`);
