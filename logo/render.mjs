#!/usr/bin/env node
// The Satin logo.
//
//   node render.mjs > satin.svg              the logo: an SVG of lines, elliptical arcs and linear gradients
//   node render.mjs png <size> [ss] > x.png  a ray-traced rendering of the same model, for checking the SVG against
//                                            (without the white ring, which is a wrapper applied to the SVG only)
//
// A satin ribbon lies along the line y = x with its lower-left half at z = -h and its upper-right half at z = +h,
// joined by a bend whose heading follows a sine law and can overhang into a true S. An upright orthographic camera
// looks at the middle of the bend under a directional light, and the fabric is shaded with the Ashikhmin-Shirley
// anisotropic BRDF, in a centre material, an edge band, and a sharp strip of the midpoint material between them.
// Because the ribbon is an extrusion, the camera orthographic and the light directional, the picture is a set of
// strips filled with linear gradients, which is what renderSVG below writes: the SVG is the logo, and the PNGs are
// rasterizations of it. The ray tracer is kept only to check that claim.
//
// PARAMS is the settled design. The model code between the markers is shared verbatim with logo/lab.html, the
// interactive tool used to design it.
import { deflateSync } from 'node:zlib';

const PARAMS = {
  "bg": "#111111",
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
  "stripSteps": 1,
  "stripFrac": 0.25,
  "baseColorE": "#202022",
  "specTintE": 0.73,
  "specF0E": 0.33,
  "glossAlongE": 0.75,
  "glossAcrossE": 1.85,
  "threadAngleE": 90,
  "sheenE": 0.13,
  "sheenPowE": 8,
  "ambientE": 0.95,
  "lightShape": "dir",
  "lightAz": 176,
  "lightEl": 9.5,
  "lightDist": 2,
  "lightIntensity": 6,
  "lightColor": "#ffffff",
  "exposure": -0.6,
  "rolloff": true,
  "aa": "3",
  "stripA": "#2a2932",
  "stripB": "#eef2e8",
  "ringGap": 16,
  "ringColor": "#ffffff"
};

// ======== Satin model. This block is shared verbatim by logo/lab.html and logo/render.mjs. ========
const D2R = Math.PI / 180, R2 = Math.SQRT1_2;

// ---------- color helpers ----------
const clamp01 = c => c < 0 ? 0 : c > 1 ? 1 : c;
const lin2srgb = c => { c = clamp01(c); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
const srgb2lin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const hex2lin = h => [1, 3, 5].map(i => srgb2lin(parseInt(h.slice(i, i + 2), 16) / 255));
const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lin2hex = c => '#' + c.map(v => Math.round(lin2srgb(v) * 255).toString(16).padStart(2, '0')).join('');
const softclip = c => c <= 0.75 ? c : 0.75 + 0.25 * Math.tanh((c - 0.75) / 0.25);

// ---------- vectors ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

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

// ---------- light and materials ----------
function lightMaterial(P) {
  const lc = hex2lin(P.lightColor), expo = Math.pow(2, P.exposure), I = P.lightIntensity * expo;
  const mat = x => { const base = hex2lin(P['baseColor' + x]); return { base, spec: base.map(b => 1 + (b - 1) * P['specTint' + x]), lnu: P['glossAlong' + x], lnv: P['glossAcross' + x], F0: P['specF0' + x], psi: P['threadAngle' + x] * D2R, sheenK: P['sheen' + x] * expo, sheenPow: P['sheenPow' + x], amb: P['ambient' + x] * expo }; };
  const W = P.width, bandW = P.edgeFrac / 100 * W, stripW = P.stripFrac / 100 * W, steps = Math.max(0, Math.round(P.stripSteps));
  const laz = P.lightAz * D2R, lel = P.lightEl * D2R, LD = Math.pow(10, P.lightDist);
  const dir = [Math.cos(lel) * Math.cos(laz), Math.cos(lel) * Math.sin(laz), Math.sin(lel)];
  const Q0 = dir.map(v => v * LD), isDir = P.lightShape === 'dir', isLine = P.lightShape === 'lineS' || P.lightShape === 'lineU';
  const le = P.lightShape === 'lineS' ? [R2, R2, 0] : [-R2, R2, 0];
  const q0e = dot(Q0, le), d0 = isLine ? Math.hypot(Q0[0] - q0e * le[0], Q0[1] - q0e * le[1], Q0[2] - q0e * le[2]) : LD;
  return { lc, I, Q0, dir, isDir, isLine, le, LD, d0, W, bg: hex2lin(P.bg), m0: mat(''), m1: mat('E'), bandW, stripW, steps };
}
// material blend at a distance `dist` from the nearer ribbon edge: the edge material in the band, then `steps`
// strips of intermediate materials (parameters blended, then shaded), then the centre material
function zoneMix(dist, LM) {
  if (dist < LM.bandW) return 1;
  for (let k = 0; k < LM.steps; k++) if (dist < LM.bandW + LM.stripW * (k + 1)) return 1 - (k + 0.5) / LM.steps;
  return 0;
}
// linear rgb of the ribbon at world point P with profile heading th, seen along V, with material blend mm
function shadePoint(LM, P, Px, Py, Pz, th, Vx, Vy, Vz, mm) {
  const { lc, I, Q0, isLine, isDir, le, LD, d0, m0, m1 } = LM;
  const lerp = (a, b, t) => a + (b - a) * t;
  const base = [lerp(m0.base[0], m1.base[0], mm), lerp(m0.base[1], m1.base[1], mm), lerp(m0.base[2], m1.base[2], mm)];
  const spec = [lerp(m0.spec[0], m1.spec[0], mm), lerp(m0.spec[1], m1.spec[1], mm), lerp(m0.spec[2], m1.spec[2], mm)];
  const nu = Math.pow(10, lerp(m0.lnu, m1.lnu, mm)), nv = Math.pow(10, lerp(m0.lnv, m1.lnv, mm));
  const normK = Math.sqrt((nu + 1) * (nv + 1)) / (8 * Math.PI), F0 = lerp(m0.F0, m1.F0, mm), kdc = 28 / (23 * Math.PI) * (1 - F0);
  const psi = lerp(m0.psi, m1.psi, mm), cpsi = Math.cos(psi), spsi = Math.sin(psi);
  const sheenK = lerp(m0.sheenK, m1.sheenK, mm), sheenPow = lerp(m0.sheenPow, m1.sheenPow, mm), amb = lerp(m0.amb, m1.amb, mm);
  let cr = base[0] * amb, cg = base[1] * amb, cb = base[2] * amb;
  const sth = Math.sin(th), cth = Math.cos(th);
  let Nx = -sth * R2, Ny = -sth * R2, Nz = cth;                        // two-sided: face the camera
  if (Nx * Vx + Ny * Vy + Nz * Vz < 0) { Nx = -Nx; Ny = -Ny; Nz = -Nz; }
  const Tx = cpsi * cth * R2 - spsi * R2, Ty = cpsi * cth * R2 + spsi * R2, Tz = cpsi * sth;   // thread direction
  const NdotV = Math.max(1e-4, Nx * Vx + Ny * Vy + Nz * Vz);
  const sh = sheenK * Math.pow(Math.max(0, 1 - NdotV), sheenPow);
  cr += spec[0] * sh; cg += spec[1] * sh; cb += spec[2] * sh;
  let Ldx, Ldy, Ldz, Lsx, Lsy, Lsz, att;
  if (isDir) { Ldx = Lsx = LM.dir[0]; Ldy = Lsy = LM.dir[1]; Ldz = Lsz = LM.dir[2]; att = 1; }
  else {
    const wx = Q0[0] - Px, wy = Q0[1] - Py, wz = Q0[2] - Pz;
    if (!isLine) { const d2 = wx * wx + wy * wy + wz * wz, il = 1 / Math.sqrt(d2); Ldx = Lsx = wx * il; Ldy = Lsy = wy * il; Ldz = Lsz = wz * il; att = LD * LD / d2; }
    else {
      const fw = wx * le[0] + wy * le[1] + wz * le[2], fx = wx - fw * le[0], fy = wy - fw * le[1], fz = wz - fw * le[2], dp = Math.max(1e-6, Math.hypot(fx, fy, fz));
      Ldx = fx / dp; Ldy = fy / dp; Ldz = fz / dp; att = d0 / dp;
      const nv2 = 2 * (Nx * Vx + Ny * Vy + Nz * Vz), Rx = nv2 * Nx - Vx, Ry = nv2 * Ny - Vy, Rz = nv2 * Nz - Vz;
      const bb = Rx * le[0] + Ry * le[1] + Rz * le[2], dd = Rx * wx + Ry * wy + Rz * wz, den = 1 - bb * bb;
      let lam = den > 1e-6 ? (dd - bb * fw) / den : 0; if (lam < 0) lam = 0;
      const t = lam * bb - fw, sx = wx + t * le[0], sy = wy + t * le[1], sz = wz + t * le[2], il = 1 / Math.max(1e-6, Math.hypot(sx, sy, sz));
      Lsx = sx * il; Lsy = sy * il; Lsz = sz * il;
    }
  }
  const NdotLd = Nx * Ldx + Ny * Ldy + Nz * Ldz, NdotLs = Nx * Lsx + Ny * Lsy + Nz * Lsz, wgt = I * att;
  if (NdotLd > 0) {
    const kd = kdc * (1 - Math.pow(1 - NdotLd / 2, 5)) * (1 - Math.pow(1 - NdotV / 2, 5)) * NdotLd * wgt;
    cr += base[0] * kd * lc[0]; cg += base[1] * kd * lc[1]; cb += base[2] * kd * lc[2];
  }
  if (NdotLs > 0) {
    let Hx = Lsx + Vx, Hy = Lsy + Vy, Hz = Lsz + Vz; { const il = 1 / Math.sqrt(Hx * Hx + Hy * Hy + Hz * Hz); Hx *= il; Hy *= il; Hz *= il; }
    const NdotH = Nx * Hx + Ny * Hy + Nz * Hz, HdotV = Math.max(1e-4, Hx * Vx + Hy * Vy + Hz * Vz);
    const F = F0 + (1 - F0) * Math.pow(1 - HdotV, 5);
    const Bx = Ny * Tz - Nz * Ty, By = Nz * Tx - Nx * Tz, Bz = Nx * Ty - Ny * Tx;
    const HdotT = Hx * Tx + Hy * Ty + Hz * Tz, HdotB = Hx * Bx + Hy * By + Hz * Bz, den = 1 - NdotH * NdotH;
    let sp = normK * F / (HdotV * Math.max(NdotLs, NdotV));
    if (den > 1e-7) sp *= Math.pow(Math.max(0, NdotH), (nu * HdotT * HdotT + nv * HdotB * HdotB) / den);
    if (sp > 50) sp = 50;
    sp *= NdotLs * wgt;
    cr += spec[0] * sp * lc[0]; cg += spec[1] * sp * lc[1]; cb += spec[2] * sp * lc[2];
  }
  if (P.rolloff) { cr = softclip(cr); cg = softclip(cg); cb = softclip(cb); }
  return [cr, cg, cb];
}

// ---------- CPU ray tracer (the design tool's fallback, and the renderer's check mode) ----------
function makeRenderer(P, r, padC) {
  const n = r + 2 * padC, lo = -padC / r, hi = 1 + padC / r, span = hi - lo;
  const SC = makeScene(P), S = SC.S, LM = lightMaterial(P), { W, m0 } = LM;
  const ray = { o: [0, 0, 0], d: [0, 0, 0] }, HL = new Float64Array(16), HT = new Float64Array(16);
  const renderRow = (j, shade, rgb, phi, mask) => {
    const ny = lo + (j + 0.5) / n * span, b = (0.5 - ny - P.panY) * S, jin = j >= padC && j < padC + r;
    for (let i = 0; i < n; i++) {
      const nx = lo + (i + 0.5) / n * span, a = (nx - 0.5 - P.panX) * S, idx = j * n + i;
      SC.ray(a, b, ray);
      const o = ray.o, d = ray.d, nh = SC.intersect(o, d, HL, HT);
      let chosen = -1, firstL = Infinity, bestPhi = -Infinity, bestK = -1, phSel = -1;   // nearest hit inside the ribbon
      for (let k = 0; k < nh; k++) {
        const l = HL[k], uu = ((o[1] + l * d[1]) - (o[0] + l * d[0])) * R2, ph = Math.min(uu, W - uu);
        if (ph > bestPhi) { bestPhi = ph; bestK = k; }
        if (ph >= 0 && l < firstL) { firstL = l; chosen = k; phSel = ph; }
      }
      const inside = chosen >= 0;
      if (!inside) { chosen = bestK; phSel = bestPhi; }
      phi[idx] = nh ? bestPhi : -1;
      if (mask) mask[idx] = (inside && jin && i >= padC && i < padC + r) ? 1 : 0;
      let cr, cg, cb;
      if (chosen < 0) { cr = m0.base[0] * m0.amb; cg = m0.base[1] * m0.amb; cb = m0.base[2] * m0.amb; }
      else { const l = HL[chosen]; [cr, cg, cb] = shadePoint(LM, P, o[0] + l * d[0], o[1] + l * d[1], o[2] + l * d[2], HT[chosen], -d[0], -d[1], -d[2], zoneMix(phSel, LM)); }
      rgb[idx * 3] = cr; rgb[idx * 3 + 1] = cg; rgb[idx * 3 + 2] = cb;
      if (shade) shade[idx] = lin2srgb(0.2126 * cr + 0.7152 * cg + 0.0722 * cb);
    }
  };
  return { n, r, padC, lo, hi, span, renderRow, info: SC.info, S, basis: { r: SC.r, u: SC.u } };
}
function renderField(P, r) {
  const padC = 1, R = makeRenderer(P, r, padC), n = R.n;
  const shade = new Float32Array(n * n), rgb = new Float32Array(n * n * 3), phi = new Float32Array(n * n), mask = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) R.renderRow(j, shade, rgb, phi, mask);
  return Object.assign({ shade, rgb, phi, mask }, R);
}

// ---------- SVG: the picture itself ----------
// The ribbon is an extrusion seen by an orthographic camera under a directional light, so a surface point's colour
// depends only on where it lies along the profile, and every profile point sweeps a straight line across the image,
// all parallel. Colour is therefore constant along those lines and a linear gradient across them. The profile is
// split where its image reverses direction (the folds of the S); each monotone piece becomes a strip filled with one
// gradient, painted far to near, and the material zones are the same strips offset along the sweep. The flat halves
// are uniform fills. What is sampled: the outline, a 240-segment polyline simplified to a tenth of a pixel, and the
// gradient stops, placed by the shading model and thinned to `tol` levels of 255.
function renderSVG(P, VB = 1024, tol = 0.5) {
  const SC = makeScene(P), LM = lightMaterial(P), S = SC.S, pan = SC.pan, C = SC.curve;
  if (!LM.isDir) throw new Error('The SVG needs a directional light: with a point or line light the flat parts of the ribbon are not uniform.');
  const W = LM.W, H = C.H, M = C.M, es = [R2, R2, 0], eu = [-R2, R2, 0], V = [-SC.f[0], -SC.f[1], -SC.f[2]];
  const frame = Pw => [dot(Pw, SC.r) / S + 0.5 + pan[0], 0.5 - dot(Pw, SC.u) / S - pan[1]];   // 0..1, y down
  const uf = [dot(eu, SC.r) / S, -dot(eu, SC.u) / S], ul = Math.hypot(uf[0], uf[1]);          // sweep per unit u
  if (ul < 1e-4) throw new Error('SVG: the camera looks along the ribbon\'s width, so the ribbon has no area');
  const uu = [uf[0] / ul, uf[1] / ul], nh = [-uf[1] / ul, uf[0] / ul];                        // sweep and gradient axes
  const fEu = dot(SC.f, eu);
  const f2 = v => (Math.round(v * 100) / 100).toString();
  const hex = c => '#' + c.map(v => Math.round(lin2srgb(v) * 255).toString(16).padStart(2, '0')).join('');
  // profile vertices: lower flat, bend, upper flat, each with its image point and the quantities the layering needs
  const verts = [];
  const push = (sv, zv, th) => {
    const Pw = [sv * R2, sv * R2, zv], p = frame(Pw);
    verts.push({ Pw, th, p, t: p[0] * nh[0] + p[1] * nh[1], eff: dot(SC.f, Pw) - (p[0] * uu[0] + p[1] * uu[1]) * fEu / ul });
  };
  const FLAT = [40, 16, 8, 4, 2, 1, 0.5, 0.25];
  for (const dd of FLAT) push(C.cs[0] - dd, -H, 0);
  for (let i = 0; i <= M; i++) push(C.cs[i], C.cz[i], C.cth[i]);
  for (const dd of FLAT.slice().reverse()) push(C.cs[M] + dd, H, 0);
  // split where the image direction along the gradient axis reverses
  const pieces = [];
  let start = 0, dir = 0;
  for (let i = 1; i < verts.length; i++) {
    const dt = verts[i].t - verts[i - 1].t, sg = dt > 1e-12 ? 1 : dt < -1e-12 ? -1 : 0;
    if (!sg) continue;
    if (!dir) dir = sg; else if (sg !== dir) { pieces.push({ i0: start, i1: i - 1 }); start = i - 1; dir = sg; }
  }
  pieces.push({ i0: start, i1: verts.length - 1 });
  const tCorners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(c => c[0] * nh[0] + c[1] * nh[1]);
  const tLo = Math.min(...tCorners) - 0.05, tHi = Math.max(...tCorners) + 0.05;   // t-range that can appear in the frame
  for (const pc of pieces) {
    const ts = verts.slice(pc.i0, pc.i1 + 1).map(v => v.t); pc.tMin = Math.min(...ts); pc.tMax = Math.max(...ts);
    pc.gMin = Math.max(pc.tMin, tLo); pc.gMax = Math.min(pc.tMax, tHi);          // the gradient covers only this
  }
  // effective depth of a piece at a given t (linear along each profile segment)
  const effAt = (pc, t) => {
    for (let i = pc.i0; i < pc.i1; i++) {
      const a = verts[i], b = verts[i + 1], lo = Math.min(a.t, b.t), hi = Math.max(a.t, b.t);
      if (t >= lo - 1e-12 && t <= hi + 1e-12) { const w = hi > lo ? (t - a.t) / (b.t - a.t) : 0; return a.eff + (b.eff - a.eff) * w; }
    }
    return null;
  };
  const nearer = (A, B) => {   // true if A is nearer than B where they overlap in t; null if no overlap
    const lo = Math.max(A.tMin, B.tMin), hi = Math.min(A.tMax, B.tMax); if (hi - lo < 1e-9) return null;
    const t = (lo + hi) / 2, ea = effAt(A, t), eb = effAt(B, t); return ea === null || eb === null ? null : ea < eb;
  };
  // painter's order: farther pieces first (topological sort over the pairwise depth relations)
  const n = pieces.length, after = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const r = nearer(pieces[i], pieces[j]); if (r === true) after[i].add(j); else if (r === false) after[j].add(i); }   // after[i]: pieces that must be painted before i
  const order = [], done = new Set();
  while (order.length < n) { const k = pieces.findIndex((_, i) => !done.has(i) && [...after[i]].every(j => done.has(j))); if (k < 0) throw new Error('SVG: inconsistent depth order'); order.push(k); done.add(k); }
  // extend a piece a few vertices under a nearer neighbour so antialiased seams show the ribbon, not the background
  const ranges = pieces.map((pc, i) => {
    let i0 = pc.i0, i1 = pc.i1;
    if (i > 0 && nearer(pieces[i - 1], pc) === true) i0 = Math.max(0, i0 - 3);
    if (i < n - 1 && nearer(pieces[i + 1], pc) === true) i1 = Math.min(verts.length - 1, i1 + 3);
    return [i0, i1];
  });
  // polyline simplification, in output pixels
  const rdp = (pts, tol) => {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop(); if (b - a < 2) continue;
      const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay, L2 = dx * dx + dy * dy;
      let best = -1, bi = -1;
      for (let i = a + 1; i < b; i++) {
        const px = pts[i][0] - ax, py = pts[i][1] - ay;
        const c = L2 ? (px * dx + py * dy) / L2 : 0, ex = px - dx * c, ey = py - dy * c, dd = ex * ex + ey * ey;
        if (dd > best) { best = dd; bi = i; }
      }
      if (best > tol * tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  // gradient stops: colour sampled at every profile vertex, then thinned where the run is linear anyway
  const stopsFor = (pc, mm, uOff, tol = 0.5) => {   // tol: max channel error (0..255) allowed by stop thinning
    const raw = [];
    for (let i = pc.i0; i <= pc.i1; i++) {
      const v = verts[i], Pw = [v.Pw[0] + uOff * eu[0], v.Pw[1] + uOff * eu[1], v.Pw[2] + uOff * eu[2]];
      const c = shadePoint(LM, P, Pw[0], Pw[1], Pw[2], v.th, V[0], V[1], V[2], mm).map(x => lin2srgb(x) * 255);
      raw.push({ o: (v.t - pc.gMin) / (pc.gMax - pc.gMin), c });
    }
    raw.sort((a, b) => a.o - b.o);
    // keep one sample beyond each end of the visible range, clamped to it: gradients pad, so the rest is unnecessary
    const lo = raw.findLastIndex(r => r.o <= 0), hi = raw.findIndex(r => r.o >= 1);
    const cut = raw.slice(lo < 0 ? 0 : lo, hi < 0 ? raw.length : hi + 1);
    raw.length = 0; raw.push(...cut.map(r => ({ o: Math.min(1, Math.max(0, r.o)), c: r.c })));
    const keep = new Uint8Array(raw.length); keep[0] = keep[raw.length - 1] = 1;
    const stack = [[0, raw.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop(); if (b - a < 2) continue;
      let best = -1, bi = -1;
      for (let i = a + 1; i < b; i++) {
        const w = raw[b].o > raw[a].o ? (raw[i].o - raw[a].o) / (raw[b].o - raw[a].o) : 0;
        const dev = Math.max(...raw[i].c.map((ci, k) => Math.abs(ci - (raw[a].c[k] + (raw[b].c[k] - raw[a].c[k]) * w))));
        if (dev > best) { best = dev; bi = i; }
      }
      if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    return raw.filter((_, i) => keep[i]).map(st => `<stop offset="${(Math.round(st.o * 1e5) / 1e5)}" stop-color="${hex(st.c.map(x => srgb2lin(Math.max(0, Math.min(255, x)) / 255)))}"/>`).join('');
  };
  // material zones, outermost first so each later one lies inside the one before it (no seams against the background):
  // the centre over the whole width, then the strips of intermediate material, then the edge band
  const zones = [{ w: W, mm: 0 }];
  for (let k = LM.steps - 1; k >= 0; k--) zones.push({ w: LM.bandW + LM.stripW * (k + 1), mm: 1 - (k + 0.5) / LM.steps });
  if (LM.bandW > 0) zones.push({ w: LM.bandW, mm: 1 });
  const farToo = W >= 2 * (LM.bandW + LM.stripW * LM.steps);   // the far edge too, unless the ribbon is so narrow the zones would overlap
  if (typeof process !== "undefined" && process.env.SVG_DEBUG) console.error({ ul, sweepPx: uf.map(v => v * VB), pieces: pieces.map((pc, i) => ({ i, i0: pc.i0, i1: pc.i1, tMin: +pc.tMin.toFixed(3), tMax: +pc.tMax.toFixed(3), range: ranges[i] })), order });
  const defs = [], body = [];
  const poly = (pts, off) => pts.map(p => `${f2((p[0] + off[0]) * VB)} ${f2((p[1] + off[1]) * VB)}`);
  const tr = d => `translate(${f2(d * uf[0] * VB)} ${f2(d * uf[1] * VB)})`;
  defs.push(`<clipPath id="frame"><circle cx="${VB / 2}" cy="${VB / 2}" r="${VB / 2}"/></clipPath>`);
  body.push(`<rect width="${VB}" height="${VB}" fill="${P.bg}"/>`);
  let gid = 0;
  order.forEach(k => {
    const pc = pieces[k]; if (pc.tMax - pc.tMin < 1e-6 || pc.gMax - pc.gMin < 1e-6) return;
    const [i0, i1] = ranges[k];
    const edge = rdp(verts.slice(i0, i1 + 1).map(v => v.p), 0.1 / VB);
    const flat = verts.slice(pc.i0, pc.i1 + 1).every(v => v.th === 0);   // a flat half: one colour, no gradient
    const g1 = [pc.gMin * nh[0] * VB, pc.gMin * nh[1] * VB], g2 = [pc.gMax * nh[0] * VB, pc.gMax * nh[1] * VB];
    const gradAttrs = `gradientUnits="userSpaceOnUse" x1="${f2(g1[0])}" y1="${f2(g1[1])}" x2="${f2(g2[0])}" y2="${f2(g2[1])}"`;
    const zone = w => `M${poly(edge, [0, 0]).join('L')}L${poly(edge.slice().reverse(), [w * uf[0], w * uf[1]]).join('L')}Z`;
    zones.forEach((z, zi) => {
      let fill;
      if (flat) { const v = verts[pc.i0]; fill = hex(shadePoint(LM, P, v.Pw[0], v.Pw[1], v.Pw[2], 0, V[0], V[1], V[2], z.mm)); }
      else { defs.push(`<linearGradient id="g${gid}" ${gradAttrs}>${stopsFor(pc, z.mm, z.w / 2, tol)}</linearGradient>`); fill = `url(#g${gid++})`; }
      body.push(`<path d="${zone(z.w)}" fill="${fill}"/>`);
      if (zi > 0 && farToo) body.push(`<path d="${zone(z.w)}" transform="${tr(W - z.w)}" fill="${fill}"/>`);
    });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" width="${VB}" height="${VB}">\n<defs>\n${defs.join('\n')}\n</defs>\n<g clip-path="url(#frame)">\n${body.join('\n')}\n</g>\n</svg>\n`;
}

// ======== end of the shared model ========

// ---- command line ----
// a white disc of the full radius behind the logo, which is scaled down to leave a ring of `gap` px around it
const withRing = (svg, gap, color, VB = 1024) => {
  if (!(gap > 0)) return svg;
  const open = svg.indexOf('>') + 1, close = svg.lastIndexOf('</svg>'), k = (VB - 2 * gap) / VB;
  return `${svg.slice(0, open)}\n<circle cx="${VB / 2}" cy="${VB / 2}" r="${VB / 2}" fill="${color}"/>\n<g transform="translate(${gap} ${gap}) scale(${k})">${svg.slice(open, close)}</g>\n</svg>\n`;
};
const args = process.argv.slice(2), P = PARAMS;
if (args[0] !== 'png') { process.stdout.write(withRing(renderSVG(P), P.ringGap, P.ringColor)); process.exit(0); }
const size = Math.max(1, Math.round(+args[1] || 1024)), SS = Math.max(1, Math.round(+(args[2] ?? 3)));
const n = size * SS, R = makeRenderer(P, n, 0);
const rgb = new Float32Array(n * n * 3), phi = new Float32Array(n * n);
const t0 = Date.now();
for (let j = 0; j < n; j++) R.renderRow(j, null, rgb, phi, null);

// ---- composite: ribbon or background inside the rounded frame, transparent outside; average in linear light ----
const bg = hex2lin(P.bg);
const px = new Uint8Array(size * size * 4);
for (let Y = 0; Y < size; Y++) for (let X = 0; X < size; X++) {
  let r = 0, g = 0, b = 0, cov = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const i = X * SS + sx, j = Y * SS + sy;
    const nx = (i + 0.5) / n, ny = (j + 0.5) / n;
    if (Math.hypot(nx - 0.5, ny - 0.5) > 0.5) continue;                       // the circular frame
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
