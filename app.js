const DATA = window.SKY_DATA;
const canvas = document.getElementById("sky");
const ctx = canvas.getContext("2d");
const drawer = document.getElementById("drawer");
const drawerContent = document.getElementById("drawerContent");
const filter = document.getElementById("markerFilter");
const catalogPreset = document.getElementById("catalogPreset");
const coordForm = document.getElementById("coordForm");
const coordRa = document.getElementById("coordRa");
const coordDec = document.getElementById("coordDec");
const subTitle = document.querySelector(".sub");
const skyReadout = document.getElementById("skyReadout");
const CELLS = window.HEALPIX_CELLS_NSIDE64 || [];
const LOCAL_CONTOURS = window.LOCAL_CONTOURS || {};
const SMOOTH = window.SMOOTH_TS_NSIDE64 || null;
const SMOOTH_RASTER = window.SMOOTH_RASTER_NSIDE64 || null;
const MILKY_WAY_POLYGONS = window.MILKY_WAY_POLYGONS || null;
const REFERENCE_SOURCES = window.REFERENCE_SOURCES || [];
const PARTIAL_DENSE = window.PARTIAL_DENSE || null;
const CATALOG_OVERLAYS = window.CATALOG_OVERLAYS || { metadata: { counts: {} }, sources: [] };

filter.value = "known";
if (catalogPreset) catalogPreset.value = "off";

if (REFERENCE_SOURCES.length) {
  const markerIds = new Set(DATA.markers.map((m) => m.id));
  for (const marker of REFERENCE_SOURCES) {
    if (!markerIds.has(marker.id)) {
      DATA.markers.push(marker);
      markerIds.add(marker.id);
    }
  }
}

if (PARTIAL_DENSE?.dense) {
  DATA.dense = DATA.dense || {};
  for (const [id, dense] of Object.entries(PARTIAL_DENSE.dense)) {
    if (!DATA.dense[id]) DATA.dense[id] = dense;
  }
}

if (PARTIAL_DENSE?.markers?.length) {
  const markerIds = new Set(DATA.markers.map((m) => m.id));
  for (const marker of PARTIAL_DENSE.markers) {
    if (!markerIds.has(marker.id)) {
      DATA.markers.push(marker);
      markerIds.add(marker.id);
    }
  }
}

let showLabels = true;
let smoothSky = true;
let showMilkyWay = true;
let showAlerts = true;
let useCells = CELLS.length === DATA.allsky.length;
let selected = DATA.markers.find((m) => m.id === "ngc1068") || DATA.markers[0];
const view = { zoom: 1, panX: 0, panY: 0, centerRa: 180 };
const drag = { active: false, moved: false, x: 0, y: 0, panX: 0, panY: 0 };
let smoothRasterCanvas = null;
let lastReadoutMs = 0;
let selectedCatalog = null;
const SKY_CELL_DISPLAY_MAX = Math.max(1, DATA.displayMaxTS || 8);
const SKY_SMOOTH_DISPLAY_MAX = Math.max(2.5, SKY_CELL_DISPLAY_MAX * 0.65);
const DETAIL_ZOOM = 5;
const MIN_PARTIAL_DENSE_ROWS_FOR_MAP = 80;
const HIGHLIGHTED_SOURCE_IDS = new Set(["ngc1068", "pks1424", "txs0506"]);

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function deg2rad(v) {
  return (v * Math.PI) / 180;
}

function rad2deg(v) {
  return (v * 180) / Math.PI;
}

function wrapRa(v) {
  return ((v % 360) + 360) % 360;
}

function wrapSigned(v) {
  let x = ((v + 180) % 360 + 360) % 360 - 180;
  return x === -180 ? 180 : x;
}

function parseCoordInput() {
  const rawRa = (coordRa?.value || "").trim();
  const rawDec = (coordDec?.value || "").trim();
  const pasted = rawRa.split(/[,\s]+/).filter(Boolean);
  const parts = pasted.length >= 2 ? pasted : [rawRa, rawDec];
  if (parts.length < 2) return null;
  const ra = Number(parts[0]);
  const dec = Number(parts[1]);
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) return null;
  return { ra: wrapRa(ra), dec };
}

function markCoordInputInvalid(invalid) {
  coordForm?.classList.toggle("invalid", invalid);
}

function sep(a, b) {
  const r1 = deg2rad(a.ra);
  const d1 = deg2rad(a.dec);
  const r2 = deg2rad(b.ra);
  const d2 = deg2rad(b.dec);
  const c = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(r1 - r2);
  return rad2deg(Math.acos(clamp(c, -1, 1)));
}

function mollweideTheta(latRad) {
  if (Math.abs(Math.abs(latRad) - Math.PI / 2) < 1e-8) {
    return Math.sign(latRad) * Math.PI / 2;
  }
  let theta = latRad;
  for (let i = 0; i < 12; i += 1) {
    const f = 2 * theta + Math.sin(2 * theta) - Math.PI * Math.sin(latRad);
    const fp = 2 + 2 * Math.cos(2 * theta);
    theta -= f / Math.max(fp, 1e-8);
  }
  return theta;
}

function projectionScale() {
  return baseProjectionScale() * view.zoom;
}

function markerZoomScale() {
  return clamp(1 + Math.log2(Math.max(view.zoom, 1)) * 0.10, 0.85, 1.45);
}

function alertZoomScale() {
  return clamp(1 + Math.log2(Math.max(view.zoom, 1)) * 0.10, 0.85, 3.0);
}

function catalogZoomScale(s) {
  return s.layer === "neutrino_alert" ? alertZoomScale() : markerZoomScale();
}

function baseProjectionScale() {
  const w = canvas.width;
  const h = canvas.height;
  return Math.min(w / (4 * Math.SQRT2 * 1.08), h / (2 * Math.SQRT2 * 1.18));
}

function frameCenter() {
  return { x: canvas.width / 2, y: canvas.height / 2 };
}

function traceFrameEllipse() {
  const s = baseProjectionScale();
  const c = frameCenter();
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, 2 * Math.SQRT2 * s, Math.SQRT2 * s, 0, 0, Math.PI * 2);
}

function withFrameClip(drawFn) {
  ctx.save();
  traceFrameEllipse();
  ctx.clip();
  drawFn();
  ctx.restore();
}

function skyToXY(ra, dec) {
  const lambda = deg2rad(wrapSigned(ra - view.centerRa));
  const theta = mollweideTheta(deg2rad(dec));
  const xNorm = -(2 * Math.SQRT2 / Math.PI) * lambda * Math.cos(theta);
  const yNorm = Math.SQRT2 * Math.sin(theta);
  const s = projectionScale();
  const c = frameCenter();
  return {
    x: c.x + view.panX + xNorm * s,
    y: c.y + view.panY - yNorm * s,
    ok: true,
  };
}

function skyToXYContinuous(ra, dec, anchorRa, shiftDeg = 0) {
  const unwrappedRa = anchorRa + wrapSigned(ra - anchorRa) + shiftDeg;
  const lambda = deg2rad(unwrappedRa - view.centerRa);
  const theta = mollweideTheta(deg2rad(dec));
  const xNorm = -(2 * Math.SQRT2 / Math.PI) * lambda * Math.cos(theta);
  const yNorm = Math.SQRT2 * Math.sin(theta);
  const s = projectionScale();
  const c = frameCenter();
  return {
    x: c.x + view.panX + xNorm * s,
    y: c.y + view.panY - yNorm * s,
  };
}

function galToEq(lDeg, bDeg) {
  const l = deg2rad(lDeg);
  const b = deg2rad(bDeg);
  const cb = Math.cos(b);
  const xg = cb * Math.cos(l);
  const yg = cb * Math.sin(l);
  const zg = Math.sin(b);
  const xe = -0.0548755604 * xg + 0.4941094279 * yg - 0.8676661490 * zg;
  const ye = -0.8734370902 * xg - 0.4448296300 * yg - 0.1980763734 * zg;
  const ze = -0.4838350155 * xg + 0.7469822445 * yg + 0.4559837762 * zg;
  return {
    ra: wrapRa(rad2deg(Math.atan2(ye, xe))),
    dec: rad2deg(Math.asin(clamp(ze, -1, 1))),
  };
}

function xyToSky(x, y) {
  const s = projectionScale();
  const c = frameCenter();
  const xNorm = (x - c.x - view.panX) / s;
  const yNorm = -(y - c.y - view.panY) / s;
  if (Math.abs(yNorm) > Math.SQRT2) return null;
  const theta = Math.asin(clamp(yNorm / Math.SQRT2, -1, 1));
  const cosTheta = Math.cos(theta);
  if (Math.abs(cosTheta) < 1e-8) return null;
  const lambda = -xNorm * Math.PI / (2 * Math.SQRT2 * cosTheta);
  if (Math.abs(lambda) > Math.PI + 1e-4) return null;
  const dec = rad2deg(Math.asin(clamp((2 * theta + Math.sin(2 * theta)) / Math.PI, -1, 1)));
  const ra = wrapRa(view.centerRa + rad2deg(lambda));
  return { ra, dec };
}

function constrainPan() {
  if (view.zoom <= 1) {
    view.panX = 0;
    view.panY = 0;
    return;
  }
  const s = baseProjectionScale();
  const maxX = 2 * Math.SQRT2 * s * (view.zoom - 1);
  const maxY = Math.SQRT2 * s * (view.zoom - 1);
  view.panX = clamp(view.panX, -maxX, maxX);
  view.panY = clamp(view.panY, -maxY, maxY);
}

function centerOnSky(ra, dec, minZoom = DETAIL_ZOOM) {
  view.zoom = Math.max(view.zoom, minZoom);
  view.panX = 0;
  view.panY = 0;
  const q = skyToXY(ra, dec);
  const c = frameCenter();
  view.panX = c.x - q.x;
  view.panY = c.y - q.y;
  constrainPan();
}

function color(ts, maxTS = SKY_CELL_DISPLAY_MAX) {
  const t = clamp(ts / maxTS, 0, 1);
  const stops = [
    [247, 249, 249],
    [224, 235, 244],
    [175, 205, 226],
    [105, 157, 199],
    [244, 185, 99],
    [220, 100, 72],
    [122, 32, 45],
  ];
  const x = t * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i];
  const b = stops[Math.min(i + 1, stops.length - 1)];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

function localScaleMax(rawMaxTS) {
  return Math.max(1, rawMaxTS);
}

function localScaleLabel(rawMaxTS) {
  return `local max ${localScaleMax(rawMaxTS).toFixed(1)}`;
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function localTSStats(points) {
  const values = points
    .map((p) => p.TS)
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  if (!values.length) {
    return { p75: 0, p90: 0, p95: 0, p98: 0, max: 1 };
  }
  return {
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.90),
    p95: percentile(values, 0.95),
    p98: percentile(values, 0.98),
    max: values[values.length - 1],
  };
}

function fallbackScaleMax(rawMaxTS, isDense, centerTS = rawMaxTS, stats = null) {
  if (isDense) return localScaleMax(rawMaxTS);
  const s = stats || { p75: rawMaxTS, p90: rawMaxTS, p95: rawMaxTS, max: rawMaxTS };
  const target = Math.max(s.p95, s.p90 * 1.18, s.p75 * 1.55, 1);
  const lower = Math.max(1, s.p75 * 1.1);
  return clamp(target, lower, Math.max(1, rawMaxTS));
}

function fallbackScaleLabel(rawMaxTS, isDense, centerTS = rawMaxTS, stats = null) {
  if (isDense) return localScaleLabel(rawMaxTS);
  const maxTS = fallbackScaleMax(rawMaxTS, isDense, centerTS, stats);
  const p95 = stats ? `, p95 ${stats.p95.toFixed(1)}` : "";
  return `adaptive max ${maxTS.toFixed(1)}, center ${centerTS.toFixed(1)}${p95}, peak ${rawMaxTS.toFixed(1)}`;
}

function skyColorMax() {
  return smoothSky ? SKY_SMOOTH_DISPLAY_MAX : SKY_CELL_DISPLAY_MAX;
}

function getSmoothRasterCanvas() {
  if (smoothRasterCanvas || !SMOOTH_RASTER) return smoothRasterCanvas;
  const width = SMOOTH_RASTER.width;
  const height = SMOOTH_RASTER.height;
  const bin = atob(SMOOTH_RASTER.data_u16_le_b64);
  const values = new Uint16Array(width * height);
  for (let i = 0, j = 0; i < values.length; i += 1, j += 2) {
    values[i] = bin.charCodeAt(j) | (bin.charCodeAt(j + 1) << 8);
  }
  const off = document.createElement("canvas");
  off.width = width;
  off.height = height;
  const og = off.getContext("2d");
  const image = og.createImageData(width, height);
  const scale = SMOOTH_RASTER.scale || 1000;
  const sentinel = SMOOTH_RASTER.sentinel ?? 65535;
  for (let i = 0; i < values.length; i += 1) {
    const out = i * 4;
    const v = values[i];
    if (v === sentinel) {
      image.data[out + 0] = 0;
      image.data[out + 1] = 0;
      image.data[out + 2] = 0;
      image.data[out + 3] = 0;
      continue;
    }
    const rgb = color(v / scale, SKY_SMOOTH_DISPLAY_MAX).match(/\d+/g).map(Number);
    image.data[out + 0] = rgb[0];
    image.data[out + 1] = rgb[1];
    image.data[out + 2] = rgb[2];
    image.data[out + 3] = 188;
  }
  og.putImageData(image, 0, 0);
  smoothRasterCanvas = off;
  return smoothRasterCanvas;
}

function displayTSForPixel(index, pixel) {
  if (smoothSky && SMOOTH?.TS?.length === DATA.allsky.length) {
    return SMOOTH.TS[index];
  }
  return pixel.TS;
}

function bestDisplayTS(m) {
  const denseBest = DATA.dense[m.id]?.top?.[0]?.TS;
  return denseBest ?? m.exactTS ?? m.TS ?? m.baseTS ?? 0;
}

function markerRole(m) {
  if (m.kind === "candidate") return "candidate";
  if (m.kind === "known" && HIGHLIGHTED_SOURCE_IDS.has(m.id)) return "highlighted";
  if (m.kind === "known" && m.sourceClass?.includes("galactic")) return "galactic";
  if (m.kind === "known") return "reference";
  return "other";
}

function filteredMarkers() {
  const f = filter.value;
  return DATA.markers.filter((m) => {
    if (f === "all") return true;
    if (f === "dense") return Boolean(DATA.dense[m.id] || LOCAL_CONTOURS[m.id]);
    return m.kind === f;
  });
}

function catalogPresetLayers() {
  const preset = catalogPreset?.value || "off";
  if (preset === "core") return { catalog: new Set(["core references"]) };
  if (preset === "snr") return { layer: new Set(["snr"]) };
  if (preset === "pulsar") return { layer: new Set(["pulsar"]) };
  if (preset === "tev") return { layer: new Set(["tev", "tev_snr", "tev_pwn"]) };
  if (preset === "galactic") return { layer: new Set(["snr", "pulsar", "tev_snr", "tev_pwn", "microquasar"]) };
  if (preset === "galaxy") return { layer: new Set(["galaxy"]) };
  if (preset === "agn") return { layer: new Set(["agn"]) };
  if (preset === "alerts") return { layer: new Set(["neutrino_alert"]) };
  if (preset === "fermi") return { layer: new Set(["fermi"]) };
  if (preset === "parent") return { role: new Set(["parent"]) };
  return new Set();
}

function filteredCatalogSources() {
  const preset = catalogPreset?.value || "off";
  if (preset === "off") return [];
  const spec = catalogPresetLayers();
  if (spec.catalog) return CATALOG_OVERLAYS.sources.filter((s) => spec.catalog.has(s.catalog));
  if (spec.layer) return CATALOG_OVERLAYS.sources.filter((s) => spec.layer.has(s.layer));
  if (spec.role) return CATALOG_OVERLAYS.sources.filter((s) => spec.role.has(s.catalogRole));
  return [];
}

function bestCatalogTS(s) {
  return s.match?.rankTs ?? s.match?.nearestTs ?? 0;
}

function neutrinoAlerts() {
  return CATALOG_OVERLAYS.sources.filter((s) => s.layer === "neutrino_alert");
}

function catalogStyle(s) {
  if (s.layer === "neutrino_alert") {
    const signalness = clamp(s.signalness ?? 0, 0, 1);
    const energy = Math.log10(Math.max(s.energyTeV || 1, 1));
    const r = clamp(1.5 + signalness * 2.2 + energy * 0.22, 1.7, 5.2);
    const goldLike = signalness >= 0.5;
    return {
      fill: goldLike ? `rgba(214,174,67,${0.15 + signalness * 0.20})` : `rgba(151,133,93,${0.07 + signalness * 0.12})`,
      stroke: goldLike ? `rgba(138,104,21,${0.50 + signalness * 0.22})` : `rgba(106,93,65,${0.30 + signalness * 0.18})`,
      r,
      shape: goldLike ? "diamond" : "cross",
    };
  }
  const ts = bestCatalogTS(s);
  const strength = clamp(s.visualWeight || 0, 0, 5);
  const r = clamp(1.6 + strength * 0.7 + Math.sqrt(Math.max(ts, 0)) * 0.22, 1.8, 6.0);
  const alpha = clamp(0.18 + ts / 45 + strength * 0.035, 0.18, 0.72);
  const palettes = {
    snr: [196, 92, 73],
    pulsar: [92, 92, 154],
    tev: [80, 66, 132],
    tev_snr: [165, 76, 86],
    tev_pwn: [96, 78, 156],
    microquasar: [184, 101, 55],
    galaxy: [63, 139, 115],
    agn: [42, 112, 181],
    fermi: [86, 96, 108],
  };
  const rgb = palettes[s.layer] || [82, 92, 122];
  const shape = s.layer === "snr" || s.layer === "tev_snr"
    ? "triangle"
    : s.layer === "microquasar"
      ? "diamond"
      : s.layer === "tev" || s.layer === "tev_pwn"
        ? "square"
        : "circle";
  return {
    fill: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`,
    stroke: `rgba(${Math.max(0, rgb[0] - 38)},${Math.max(0, rgb[1] - 38)},${Math.max(0, rgb[2] - 38)},${clamp(alpha + 0.16, 0.25, 0.88)})`,
    r,
    shape,
  };
}

function traceProjected(points) {
  let drawing = false;
  for (const p of points) {
    const q = skyToXY(p.ra, p.dec);
    if (!drawing) {
      ctx.moveTo(q.x, q.y);
      drawing = true;
    } else {
      ctx.lineTo(q.x, q.y);
    }
  }
}

function drawGrid() {
  ctx.save();
  ctx.strokeStyle = "rgba(74, 91, 105, 0.18)";
  ctx.lineWidth = devicePixelRatio;
  ctx.fillStyle = "rgba(48, 61, 72, 0.72)";
  ctx.font = `${11 * devicePixelRatio}px Segoe UI`;

  for (let ra = 0; ra < 360; ra += 30) {
    const pts = [];
    for (let dec = -89; dec <= 89; dec += 2) pts.push({ ra, dec });
    ctx.beginPath();
    traceProjected(pts);
    ctx.stroke();
    if (ra % 60 === 0) {
      const label = skyToXY(ra, -70);
      ctx.fillText(`${ra}°`, label.x + 4 * devicePixelRatio, label.y);
    }
  }

  for (let dec = -60; dec <= 60; dec += 30) {
    const pts = [];
    for (let ra = 0; ra <= 360; ra += 2) pts.push({ ra, dec });
    ctx.beginPath();
    traceProjected(pts);
    ctx.stroke();
    const label = skyToXY(view.centerRa, dec);
    ctx.fillText(`${dec}°`, label.x + 8 * devicePixelRatio, label.y - 4 * devicePixelRatio);
  }

  ctx.restore();
}

function drawFrame() {
  ctx.save();
  traceFrameEllipse();
  ctx.strokeStyle = "rgba(58, 70, 80, 0.58)";
  ctx.lineWidth = 1.7 * devicePixelRatio;
  ctx.stroke();
  ctx.restore();
}

function drawSkyPolyline(points, strokeStyle, lineWidth, dash = []) {
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let drawing = false;
  let last = null;
  for (const p of points) {
    const q = skyToXY(p.ra, p.dec);
    const jump = last && Math.hypot(q.x - last.x, q.y - last.y) > canvas.width * 0.35;
    if (!drawing || jump) {
      ctx.moveTo(q.x, q.y);
      drawing = true;
    } else {
      ctx.lineTo(q.x, q.y);
    }
    last = q;
  }
  ctx.stroke();
  ctx.restore();
}

function drawProjectedRingOutline(ring, strokeStyle, lineWidth, dash = []) {
  if (!ring || ring.length < 3) return;
  let segment = [];
  let last = null;
  const flush = () => {
    if (segment.length < 2) {
      segment = [];
      return;
    }
    ctx.beginPath();
    for (const [i, q] of segment.entries()) {
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    }
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    ctx.stroke();
    segment = [];
  };

  for (const pair of ring) {
    const q = skyToXY(pair[0], pair[1]);
    const jump = last && Math.hypot(q.x - last.x, q.y - last.y) > canvas.width * 0.35;
    if (jump) flush();
    segment.push(q);
    last = q;
  }
  flush();
}

function drawGalacticBandFill(widthDeg, fillStyle, stepDeg = 2) {
  ctx.save();
  ctx.fillStyle = fillStyle;
  for (let l = 0; l < 360; l += stepDeg) {
    const corners = [
      galToEq(l, -widthDeg),
      galToEq(l + stepDeg, -widthDeg),
      galToEq(l + stepDeg, widthDeg),
      galToEq(l, widthDeg),
    ].map((p) => skyToXY(p.ra, p.dec));
    let tooWide = false;
    for (let i = 0; i < corners.length; i += 1) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      if (Math.hypot(a.x - b.x, a.y - b.y) > canvas.width * 0.22) {
        tooWide = true;
        break;
      }
    }
    if (tooWide) continue;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i += 1) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawMilkyWayMorphologyShadow() {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const passes = [
    { width: 24.0, alpha: 0.026, color: [86, 101, 115] },
    { width: 14.0, alpha: 0.040, color: [73, 90, 106] },
    { width: 7.0, alpha: 0.062, color: [61, 78, 94] },
    { width: 1.4, alpha: 0.185, color: [43, 56, 69] },
  ];
  for (const pass of passes) {
    for (const [i, feature] of MILKY_WAY_POLYGONS.features.entries()) {
      const alpha = Math.max(pass.alpha * 0.55, pass.alpha * (1 - i * 0.10));
      const stroke = `rgba(${pass.color[0]}, ${pass.color[1]}, ${pass.color[2]}, ${alpha.toFixed(3)})`;
      for (const polygon of feature.geometry.coordinates) {
        for (const ring of polygon) {
          drawProjectedRingOutline(ring, stroke, pass.width * devicePixelRatio, []);
        }
      }
    }
  }
  ctx.restore();
}

function drawMilkyWayOverlay() {
  if (!showMilkyWay || !MILKY_WAY_POLYGONS?.features) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [i, feature] of MILKY_WAY_POLYGONS.features.entries()) {
    const alpha = Math.max(0.16, 0.34 - i * 0.030);
    const stroke = `rgba(44, 55, 67, ${alpha.toFixed(3)})`;
    for (const polygon of feature.geometry.coordinates) {
      for (const ring of polygon) {
        drawProjectedRingOutline(ring, stroke, 2.1 * devicePixelRatio, []);
      }
    }
  }
  ctx.restore();

  const plane = [];
  for (let l = 0; l <= 360; l += 1) plane.push(galToEq(l, 0));
  drawSkyPolyline(plane, "rgba(27, 37, 48, 0.82)", 1.75 * devicePixelRatio, [7 * devicePixelRatio, 4 * devicePixelRatio]);
}

function star(x, y, outer, inner, n) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i += 1) {
    const rr = i % 2 ? inner : outer;
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function diamond(x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.86, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r * 0.86, y);
  ctx.closePath();
}

function extensionLabel(ext) {
  if (!ext) return "";
  if (ext.type === "ellipse") {
    return `extended ellipse ${ext.radiusRaCosDecDeg.toFixed(1)} x ${ext.radiusDecDeg.toFixed(1)} deg`;
  }
  return `extended radius ${ext.radiusDeg.toFixed(2)} deg`;
}

function drawSourceExtension(m, isSelected = false) {
  const ext = m.extension;
  if (!ext) return;
  const cosDec = Math.max(0.08, Math.cos(deg2rad(m.dec)));
  const a = ext.type === "ellipse" ? ext.radiusRaCosDecDeg : ext.radiusDeg;
  const b = ext.type === "ellipse" ? ext.radiusDecDeg : ext.radiusDeg;
  const angle = deg2rad(ext.angleDeg || 0);
  const steps = 96;

  ctx.save();
  ctx.beginPath();
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const xr = a * Math.cos(t);
    const yr = b * Math.sin(t);
    const x = xr * Math.cos(angle) - yr * Math.sin(angle);
    const y = xr * Math.sin(angle) + yr * Math.cos(angle);
    const ra = wrapRa(m.ra + x / cosDec);
    const dec = clamp(m.dec + y, -89.5, 89.5);
    const q = skyToXYContinuous(ra, dec, m.ra);
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  }
  ctx.closePath();
  ctx.fillStyle = isSelected ? "rgba(31, 91, 157, 0.09)" : "rgba(89, 101, 114, 0.035)";
  ctx.strokeStyle = isSelected ? "rgba(31, 91, 157, 0.58)" : "rgba(89, 101, 114, 0.28)";
  ctx.lineWidth = (isSelected ? 1.5 : 0.9) * devicePixelRatio;
  ctx.setLineDash([5 * devicePixelRatio, 5 * devicePixelRatio]);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawMarker(m) {
  const p = skyToXY(m.ra, m.dec);
  const role = markerRole(m);
  const isSelected = Boolean(selected && selected.id === m.id);
  const baseR = role === "highlighted" ? 5.4 : role === "candidate" ? 2.5 : role === "galactic" ? 3.9 : 3.7;
  const r = baseR * markerZoomScale() * devicePixelRatio;
  if (p.x < -40 || p.x > canvas.width + 40 || p.y < -40 || p.y > canvas.height + 40) return;

  ctx.save();
  drawSourceExtension(m, isSelected);
  ctx.lineWidth = (role === "highlighted" ? 1.55 : 1.0) * devicePixelRatio;
  if (role === "highlighted") {
    ctx.fillStyle = isSelected ? "rgba(255,255,255,0.38)" : "rgba(255,255,255,0.24)";
    ctx.strokeStyle = isSelected ? "rgba(31,91,157,0.84)" : "rgba(31,91,157,0.62)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = isSelected ? "rgba(31,91,157,0.62)" : "rgba(31,91,157,0.42)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1.15 * devicePixelRatio, r * 0.20), 0, Math.PI * 2);
    ctx.fill();
  } else if (role === "reference" || role === "galactic") {
    ctx.fillStyle = role === "galactic" ? "rgba(92,84,168,0.52)" : "rgba(43,123,187,0.58)";
    ctx.strokeStyle = "rgba(255,255,255,0.62)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillStyle = "rgba(187,137,71,0.22)";
    ctx.strokeStyle = "rgba(255,255,255,0.54)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  const hasDenseMap = Boolean(DATA.dense[m.id] || LOCAL_CONTOURS[m.id]);
  if (hasDenseMap && (role !== "highlighted" || isSelected)) {
    ctx.setLineDash([]);
    ctx.strokeStyle = role === "candidate" ? "rgba(131,105,73,0.18)" : "rgba(31,91,157,0.38)";
    ctx.lineWidth = (isSelected ? 1.2 : 0.75) * devicePixelRatio;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 4.2 * devicePixelRatio, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (isSelected) {
    ctx.strokeStyle = "rgba(27,37,47,0.58)";
    ctx.lineWidth = 1.35 * devicePixelRatio;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 7.0 * devicePixelRatio, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (showLabels && (role === "highlighted" || isSelected)) {
    ctx.font = `${12 * devicePixelRatio}px Segoe UI`;
    ctx.fillStyle = role === "highlighted" ? "#1f5b9d" : "rgba(34,45,56,0.92)";
    ctx.fillText(m.name, p.x + 9 * devicePixelRatio, p.y - 8 * devicePixelRatio);
  }
  ctx.restore();
}

function drawCatalogSource(s) {
  const p = skyToXY(s.ra, s.dec);
  if (p.x < -30 || p.x > canvas.width + 30 || p.y < -30 || p.y > canvas.height + 30) return;
  const style = catalogStyle(s);
  const r = style.r * catalogZoomScale(s) * devicePixelRatio;
  const isSelected = selectedCatalog?.id === s.id;
  ctx.save();
  ctx.fillStyle = style.fill;
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = 0.9 * devicePixelRatio;
  ctx.beginPath();
  if (style.shape === "square") {
    ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
  } else if (style.shape === "cross") {
    ctx.moveTo(p.x - r, p.y - r);
    ctx.lineTo(p.x + r, p.y + r);
    ctx.moveTo(p.x + r, p.y - r);
    ctx.lineTo(p.x - r, p.y + r);
  } else if (style.shape === "triangle") {
    ctx.moveTo(p.x, p.y - r * 1.15);
    ctx.lineTo(p.x + r, p.y + r * 0.85);
    ctx.lineTo(p.x - r, p.y + r * 0.85);
    ctx.closePath();
  } else if (style.shape === "diamond") {
    ctx.moveTo(p.x, p.y - r * 1.2);
    ctx.lineTo(p.x + r, p.y);
    ctx.lineTo(p.x, p.y + r * 1.2);
    ctx.lineTo(p.x - r, p.y);
    ctx.closePath();
  } else {
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  }
  if (style.shape === "ring" || style.shape === "cross") {
    ctx.stroke();
  } else {
    ctx.fill();
    ctx.stroke();
  }
  if (isSelected) {
    ctx.strokeStyle = "rgba(30,39,48,0.62)";
    ctx.lineWidth = 1.25 * devicePixelRatio;
    ctx.setLineDash([3 * devicePixelRatio, 3 * devicePixelRatio]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 5.5 * devicePixelRatio, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCatalogOverlays() {
  const sources = filteredCatalogSources();
  if (!sources.length) return;
  for (const s of sources) drawCatalogSource(s);
}

function drawAlertOverlays() {
  if (!showAlerts) return;
  if ((catalogPreset?.value || "off") === "alerts") return;
  for (const s of neutrinoAlerts()) drawCatalogSource(s);
}

function markerDrawOrder(markers) {
  return markers.slice().sort((a, b) => {
    const weight = (m) => ({ candidate: 0, other: 1, reference: 2, galactic: 3, highlighted: 4 }[markerRole(m)] ?? 1);
    const aw = weight(a);
    const bw = weight(b);
    if (aw !== bw) return aw - bw;
    return bestDisplayTS(a) - bestDisplayTS(b);
  });
}

function draw() {
  if (subTitle) {
    const catalogText = (catalogPreset?.value || "off") === "off" ? "" : ` · ${filteredCatalogSources().length} catalog sources`;
    subTitle.textContent = `IceCube SkyLLH full-sky TS viewer${catalogText}`;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f4f5f1";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  withFrameClip(() => {
    const raster = smoothSky ? getSmoothRasterCanvas() : null;
    if (raster) {
      const s = projectionScale();
      const c = frameCenter();
      const w = 4 * Math.SQRT2 * s;
      const h = 2 * Math.SQRT2 * s;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        raster,
        c.x + view.panX - w / 2,
        c.y + view.panY - h / 2,
        w,
        h,
      );
      ctx.imageSmoothingEnabled = false;
    } else if (useCells && CELLS.length) {
      ctx.globalAlpha = 0.62;
      for (let i = 0; i < DATA.allsky.length; i += 1) {
        const p = DATA.allsky[i];
        const cell = CELLS[i];
        if (!cell) continue;
        ctx.beginPath();
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (let k = 0; k < cell.length; k += 2) {
          const q = skyToXYContinuous(cell[k], cell[k + 1], p.ra);
          minX = Math.min(minX, q.x);
          maxX = Math.max(maxX, q.x);
          minY = Math.min(minY, q.y);
          maxY = Math.max(maxY, q.y);
          if (k === 0) ctx.moveTo(q.x, q.y);
          else ctx.lineTo(q.x, q.y);
        }
        if (maxX < -8 || minX > canvas.width + 8 || maxY < -8 || minY > canvas.height + 8) continue;
        ctx.closePath();
        ctx.fillStyle = color(displayTSForPixel(i, p), skyColorMax());
        ctx.fill();
      }
    } else {
      const dot = clamp(2.6 * devicePixelRatio * Math.sqrt(view.zoom), 1.4 * devicePixelRatio, 6.0 * devicePixelRatio);
      for (const [i, p] of DATA.allsky.entries()) {
        const q = skyToXY(p.ra, p.dec);
        if (q.x < -dot || q.x > canvas.width + dot || q.y < -dot || q.y > canvas.height + dot) continue;
        const shownTS = displayTSForPixel(i, p);
        ctx.fillStyle = color(shownTS, skyColorMax());
        ctx.globalAlpha = shownTS > 0 ? 0.58 : 0.08;
        ctx.beginPath();
        ctx.arc(q.x, q.y, dot, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
    drawMilkyWayOverlay();
    drawGrid();
    drawAlertOverlays();
    drawCatalogOverlays();
    for (const m of markerDrawOrder(filteredMarkers())) drawMarker(m);
  });
  drawFrame();
}

function resize() {
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  draw();
}

function nearestPixel(ra, dec) {
  let best = null;
  let bestIndex = -1;
  let bestSep = 1e9;
  const target = { ra, dec };
  for (const [i, p] of DATA.allsky.entries()) {
    const s = sep(target, p);
    if (s < bestSep) {
      best = p;
      bestIndex = i;
      bestSep = s;
    }
  }
  return { ...best, index: bestIndex, sep: bestSep };
}

function updateSkyReadout(event) {
  if (!skyReadout || drag.active) return;
  const now = performance.now();
  if (now - lastReadoutMs < 70) return;
  lastReadoutMs = now;
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * devicePixelRatio;
  const y = (event.clientY - rect.top) * devicePixelRatio;
  const sky = xyToSky(x, y);
  if (!sky) {
    skyReadout.textContent = "";
    return;
  }
  const pix = nearestPixel(sky.ra, sky.dec);
  const shown = displayTSForPixel(pix.index, pix);
  skyReadout.textContent = `RA ${sky.ra.toFixed(3)}deg · Dec ${sky.dec.toFixed(3)}deg · TS ${shown.toFixed(2)}`;
}

function localPoints(m, radius) {
  const dense = DATA.dense[m.id];
  if (dense && (!dense.partial || (dense.rows || dense.points?.length || 0) >= MIN_PARTIAL_DENSE_ROWS_FOR_MAP)) {
    return {
      dense: true,
      points: dense.points.map((p) => ({
        x: p.x_deg,
        y: p.y_deg,
        TS: p.TS,
        ra: p.ra_deg,
        dec: p.dec_deg,
        ns: p.ns,
        gamma: p.gamma,
      })),
    };
  }
  return {
    dense: false,
    points: DATA.allsky
      .filter((p) => sep(m, p) <= radius * 1.2)
      .map((p) => ({
        x: wrapSigned(p.ra - m.ra) * Math.cos(deg2rad(m.dec)),
        y: p.dec - m.dec,
        TS: p.TS,
        ra: p.ra,
        dec: p.dec,
        ns: p.ns,
        gamma: p.gamma,
      })),
  };
}

function drawLocalStar(g, x, y, outer = 12, inner = 5.5) {
  g.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const rr = i % 2 ? inner : outer;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
}

function drawLocalAxes(g, c, margin, plot, radius) {
  const toXY = (x, y) => ({
    x: margin + ((radius - x) / (2 * radius)) * plot,
    y: margin + ((radius - y) / (2 * radius)) * plot,
  });
  g.strokeStyle = "rgba(74,91,105,0.20)";
  g.lineWidth = 1;
  g.fillStyle = "rgba(48,61,72,0.78)";
  g.font = "11px Segoe UI";
  const step = Math.max(0.5, Math.round((radius / 4) * 2) / 2);
  for (let k = -radius; k <= radius + 1e-6; k += step) {
    let a = toXY(k, -radius);
    let b = toXY(k, radius);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
    a = toXY(-radius, k);
    b = toXY(radius, k);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
    const xb = toXY(k, -radius);
    const yl = toXY(radius, k);
    g.fillText(k.toFixed(k % 1 ? 1 : 0), xb.x - 8, margin + plot + 16);
    g.fillText(k.toFixed(k % 1 ? 1 : 0), margin - 30, yl.y + 4);
  }
  g.strokeStyle = "rgba(48,61,72,0.34)";
  g.strokeRect(margin, margin, plot, plot);
}

function shouldShowLocalAlerts() {
  return showAlerts || (catalogPreset?.value || "off") === "alerts";
}

function localAlertsInBounds(m, bounds) {
  if (!shouldShowLocalAlerts()) return [];
  const cosDec = Math.max(0.05, Math.cos(deg2rad(m.dec)));
  return neutrinoAlerts()
    .map((alert) => ({
      ...alert,
      x: wrapSigned(alert.ra - m.ra) * cosDec,
      y: alert.dec - m.dec,
    }))
    .filter((alert) => (
      alert.x >= bounds.xMin
      && alert.x <= bounds.xMax
      && alert.y >= bounds.yMin
      && alert.y <= bounds.yMax
    ));
}

function drawLocalAlertMarker(g, x, y, alert) {
  const style = catalogStyle(alert);
  const r = clamp(style.r * 1.28, 2.4, 6.4);
  g.save();
  g.lineWidth = 1.35;
  g.strokeStyle = "rgba(255,255,250,0.72)";
  g.beginPath();
  if (style.shape === "diamond") {
    g.moveTo(x, y - r * 1.45);
    g.lineTo(x + r * 1.2, y);
    g.lineTo(x, y + r * 1.45);
    g.lineTo(x - r * 1.2, y);
    g.closePath();
    g.stroke();
  } else {
    g.moveTo(x - r * 1.25, y - r * 1.25);
    g.lineTo(x + r * 1.25, y + r * 1.25);
    g.moveTo(x + r * 1.25, y - r * 1.25);
    g.lineTo(x - r * 1.25, y + r * 1.25);
    g.stroke();
  }

  g.fillStyle = style.fill;
  g.strokeStyle = style.stroke;
  g.lineWidth = 1.1;
  g.beginPath();
  if (style.shape === "diamond") {
    g.moveTo(x, y - r * 1.2);
    g.lineTo(x + r, y);
    g.lineTo(x, y + r * 1.2);
    g.lineTo(x - r, y);
    g.closePath();
    g.fill();
    g.stroke();
  } else {
    g.moveTo(x - r, y - r);
    g.lineTo(x + r, y + r);
    g.moveTo(x + r, y - r);
    g.lineTo(x - r, y + r);
    g.stroke();
  }
  g.restore();
}

function drawLocalAlertOverlay(g, m, bounds, toXY) {
  const alerts = localAlertsInBounds(m, bounds);
  for (const alert of alerts) {
    const q = toXY(alert.x, alert.y);
    drawLocalAlertMarker(g, q.x, q.y, alert);
  }
  return alerts;
}

function drawLocalAlertCount(g, c, margin, plot, count) {
  if (!shouldShowLocalAlerts()) return;
  g.save();
  g.textAlign = "right";
  g.fillStyle = "rgba(48,61,72,0.74)";
  g.font = "12px Segoe UI";
  g.fillText(`IceCat alerts in view: ${count}`, margin + plot, 30);
  g.restore();
}

function setupLocalCoordinateReadout(c, m, bounds, pts) {
  const readout = document.createElement("div");
  readout.className = "coord-readout";
  readout.textContent = "";
  drawerContent.appendChild(readout);

  const nearestPoint = (x, y) => {
    if (!pts.length) return null;
    let best = null;
    let bestD2 = Infinity;
    for (const p of pts) {
      const d2 = (x - p.x) * (x - p.x) + (y - p.y) * (y - p.y);
      if (d2 < bestD2) {
        best = p;
        bestD2 = d2;
      }
    }
    return best ? { ...best, sep: Math.sqrt(bestD2) } : null;
  };

  c.addEventListener("mousemove", (event) => {
    const rect = c.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * c.width;
    const py = ((event.clientY - rect.top) / rect.height) * c.height;
    const { margin, plot, xMin, xMax, yMin, yMax } = bounds;
    if (px < margin || px > margin + plot || py < margin || py > margin + plot) {
      readout.textContent = "";
      return;
    }
    const x = xMax - ((px - margin) / plot) * (xMax - xMin);
    const y = yMax - ((py - margin) / plot) * (yMax - yMin);
    const dec = m.dec + y;
    const cosDec = Math.max(0.05, Math.cos(deg2rad(m.dec)));
    const ra = wrapRa(m.ra + x / cosDec);
    const near = nearestPoint(x, y);
    const nearText = near ? ` | TS ${near.TS.toFixed(2)} @ ${near.sep.toFixed(2)}deg` : "";
    readout.textContent = `x=${x.toFixed(3)}deg, y=${y.toFixed(3)}deg | RA=${ra.toFixed(4)}deg, Dec=${dec.toFixed(4)}deg${nearText}`;
  });
  c.addEventListener("mouseleave", () => {
    readout.textContent = "";
  });
}

function renderContourLocalCanvas(g, c, contour, margin, plot, m) {
  const xlim = contour.xlim;
  const ylim = contour.ylim;
  const radius = Math.max(Math.abs(xlim[0]), Math.abs(xlim[1]), Math.abs(ylim[0]), Math.abs(ylim[1]));
  const rawMaxTS = contour.levels[contour.levels.length - 1] || contour.best.TS;
  const maxTS = localScaleMax(rawMaxTS);
  const toXY = (x, y) => ({
    x: margin + ((xlim[1] - x) / (xlim[1] - xlim[0])) * plot,
    y: margin + ((ylim[1] - y) / (ylim[1] - ylim[0])) * plot,
  });

  for (const band of contour.fills) {
    g.fillStyle = color((band.lo + band.hi) / 2, maxTS);
    for (const path of band.paths) {
      if (path.length < 3) continue;
      g.beginPath();
      for (const [i, pair] of path.entries()) {
        const q = toXY(pair[0], pair[1]);
        if (i === 0) g.moveTo(q.x, q.y);
        else g.lineTo(q.x, q.y);
      }
      g.closePath();
      g.fill();
    }
  }

  drawLocalAxes(g, c, margin, plot, radius);

  g.strokeStyle = "rgba(32,45,58,0.56)";
  g.lineWidth = 1;
  for (const line of contour.lines) {
    for (const path of line.paths) {
      if (path.length < 2) continue;
      g.beginPath();
      for (const [i, pair] of path.entries()) {
        const q = toXY(pair[0], pair[1]);
        if (i === 0) g.moveTo(q.x, q.y);
        else g.lineTo(q.x, q.y);
      }
      g.stroke();
    }
  }

  const localAlerts = drawLocalAlertOverlay(g, m, {
    xMin: xlim[0],
    xMax: xlim[1],
    yMin: ylim[0],
    yMax: ylim[1],
  }, toXY);

  const source = toXY(contour.source.x, contour.source.y);
  g.fillStyle = "#ffffff";
  g.strokeStyle = "#1f5b9d";
  g.lineWidth = 2.2;
  g.beginPath();
  g.arc(source.x, source.y, 7.4, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = "#1f5b9d";
  g.beginPath();
  g.arc(source.x, source.y, 2.6, 0, Math.PI * 2);
  g.fill();

  const best = toXY(contour.best.x, contour.best.y);
  g.strokeStyle = "#8b1f35";
  g.lineWidth = 2.2;
  g.beginPath();
  g.moveTo(best.x - 12, best.y - 12);
  g.lineTo(best.x + 12, best.y + 12);
  g.moveTo(best.x + 12, best.y - 12);
  g.lineTo(best.x - 12, best.y + 12);
  g.stroke();

  g.fillStyle = "rgba(28,38,48,0.95)";
  g.font = "18px Segoe UI";
  g.fillText(`${contour.name} local TS`, margin, 30);
  drawLocalAlertCount(g, c, margin, plot, localAlerts.length);
  g.font = "13px Segoe UI";
  g.fillText(`SkyLLH contour, ${localScaleLabel(rawMaxTS)}`, margin, c.height - 22);
  g.textAlign = "center";
  g.fillText("dRA cos Dec (deg, +left)", margin + plot / 2, c.height - 8);
  g.textAlign = "start";
  g.save();
  g.translate(18, margin + 315);
  g.rotate(-Math.PI / 2);
  g.textAlign = "center";
  g.fillText("dDec (deg)", 0, 0);
  g.restore();
  g.textAlign = "start";

  const barX = c.width - 38;
  const barY = margin;
  const barH = plot;
  for (let i = 0; i < barH; i += 1) {
    const ts = maxTS * (1 - i / barH);
    g.fillStyle = color(ts, maxTS);
    g.fillRect(barX, barY + i, 16, 1);
  }
  g.strokeStyle = "rgba(48,61,72,0.42)";
  g.strokeRect(barX, barY, 16, barH);
  g.fillStyle = "rgba(48,61,72,0.90)";
  g.font = "12px Segoe UI";
  g.fillText(maxTS.toFixed(1), barX - 6, barY - 8);
  g.fillText("0", barX + 3, barY + barH + 16);

  g.fillStyle = "rgba(255,255,252,0.72)";
  g.fillRect(margin + 6, c.height - margin - 46, 330, 38);
  g.fillStyle = "#26323d";
  g.font = "12px Segoe UI";
  g.fillText(`best: RA ${contour.best.ra.toFixed(4)}deg, Dec ${contour.best.dec.toFixed(4)}deg, TS ${contour.best.TS.toFixed(2)}`, margin + 14, c.height - margin - 21);
}

function renderLocalCanvas(m) {
  const c = document.createElement("canvas");
  c.id = "localCanvas";
  c.width = 720;
  c.height = 720;
  drawerContent.appendChild(c);
  const g = c.getContext("2d");
  g.fillStyle = "#f7f8f4";
  g.fillRect(0, 0, c.width, c.height);

  const pack = localPoints(m, 10);
  const pts = pack.points;
  const ext = pts.length ? Math.max(...pts.map((p) => Math.max(Math.abs(p.x || 0), Math.abs(p.y || 0)))) : 10;
  const radius = pack.dense ? Math.max(1, ext * 1.08) : 10;
  const rawMaxTS = Math.max(1, ...pts.map((p) => p.TS));
  const margin = 54;
  const plot = c.width - margin * 2;
  const toXY = (x, y) => ({
    x: margin + ((radius - x) / (2 * radius)) * plot,
    y: margin + ((radius - y) / (2 * radius)) * plot,
  });

  const contour = LOCAL_CONTOURS[m.id];
  if (contour) {
    renderContourLocalCanvas(g, c, contour, margin, plot, m);
    setupLocalCoordinateReadout(c, m, {
      margin,
      plot,
      xMin: contour.xlim[0],
      xMax: contour.xlim[1],
      yMin: contour.ylim[0],
      yMax: contour.ylim[1],
    }, pts);
    return;
  }

  const centerPoint = pts.slice().sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))[0];
  const centerTS = centerPoint?.TS ?? rawMaxTS;
  const fallbackStats = pack.dense ? null : localTSStats(pts);
  const maxTS = fallbackScaleMax(rawMaxTS, pack.dense, centerTS, fallbackStats);

  if (pts.length) {
    const raster = document.createElement("canvas");
    const rasterSize = pack.dense ? 560 : 420;
    raster.width = rasterSize;
    raster.height = rasterSize;
    const rg = raster.getContext("2d");
    const image = rg.createImageData(rasterSize, rasterSize);
    const sigma = pack.dense ? 0.62 : 1.15;
    const support = sigma * 3.0;
    const maxSupport = pack.dense ? support : 2.5;
    const maxDataRadius = Math.max(...pts.map((p) => Math.hypot(p.x, p.y)));
    for (let py = 0; py < rasterSize; py += 1) {
      for (let px = 0; px < rasterSize; px += 1) {
        const x = radius - (px / (rasterSize - 1)) * 2 * radius;
        const y = radius - (py / (rasterSize - 1)) * 2 * radius;
        let num = 0;
        let den = 0;
        let nearest = Infinity;
        for (const p of pts) {
          const d2 = (x - p.x) * (x - p.x) + (y - p.y) * (y - p.y);
          if (d2 < nearest) nearest = d2;
          if (d2 > support * support) continue;
          const w = Math.exp(-0.5 * d2 / (sigma * sigma));
          num += w * p.TS;
          den += w;
        }
        const outsideSupport = Math.sqrt(nearest) > maxSupport || (pack.dense && Math.hypot(x, y) > maxDataRadius + 0.08);
        const idx = (py * rasterSize + px) * 4;
        if (outsideSupport || den <= 0) {
          image.data[idx + 0] = 247;
          image.data[idx + 1] = 248;
          image.data[idx + 2] = 244;
          image.data[idx + 3] = 255;
          continue;
        }
        const ts = num / den;
        const rgb = color(ts, maxTS).match(/\d+/g).map(Number);
        image.data[idx + 0] = rgb[0];
        image.data[idx + 1] = rgb[1];
        image.data[idx + 2] = rgb[2];
        image.data[idx + 3] = 255;
      }
    }
    rg.putImageData(image, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(raster, margin, margin, plot, plot);
    g.imageSmoothingEnabled = false;
    g.globalAlpha = 1;
  }

  g.strokeStyle = "rgba(74,91,105,0.18)";
  g.lineWidth = 1;
  const step = Math.max(0.5, Math.round((radius / 4) * 2) / 2);
  for (let k = -radius; k <= radius + 1e-6; k += step) {
    let a = toXY(k, -radius);
    let b = toXY(k, radius);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
    a = toXY(-radius, k);
    b = toXY(radius, k);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
  }

  g.strokeStyle = "rgba(48,61,72,0.32)";
  g.strokeRect(margin, margin, plot, plot);

  const localAlerts = drawLocalAlertOverlay(g, m, {
    xMin: -radius,
    xMax: radius,
    yMin: -radius,
    yMax: radius,
  }, toXY);

  const center = toXY(0, 0);
  g.fillStyle = "#ffffff";
  g.strokeStyle = "#1f5b9d";
  g.lineWidth = 2.2;
  g.beginPath();
  g.arc(center.x, center.y, 7.4, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = "#1f5b9d";
  g.beginPath();
  g.arc(center.x, center.y, 2.6, 0, Math.PI * 2);
  g.fill();

  const bestPoint = pts.slice().sort((a, b) => b.TS - a.TS)[0];
  if (bestPoint) {
    const q = toXY(bestPoint.x, bestPoint.y);
    g.strokeStyle = "#8b1f35";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(q.x - 11, q.y - 11);
    g.lineTo(q.x + 11, q.y + 11);
    g.moveTo(q.x + 11, q.y - 11);
    g.lineTo(q.x - 11, q.y + 11);
    g.stroke();
    g.fillStyle = "#8b1f35";
    g.font = "12px Segoe UI";
    g.fillText(`best ${bestPoint.TS.toFixed(1)}`, q.x + 9, q.y - 7);
  }

  g.fillStyle = "rgba(28,38,48,0.92)";
  g.font = "18px Segoe UI";
  g.fillText(`${m.name} local TS`, margin, 30);
  drawLocalAlertCount(g, c, margin, plot, localAlerts.length);
  g.font = "13px Segoe UI";
  g.fillText(`${pack.dense ? "SkyLLH dense smooth raster" : "nside64 smooth raster"}, ${fallbackScaleLabel(rawMaxTS, pack.dense, centerTS, fallbackStats)}`, margin, c.height - 22);
  g.textAlign = "center";
  g.fillText("dRA cos Dec (deg, +left)", margin + plot / 2, c.height - 8);
  g.textAlign = "start";
  g.save();
  g.translate(18, margin + 315);
  g.rotate(-Math.PI / 2);
  g.textAlign = "center";
  g.fillText("dDec (deg)", 0, 0);
  g.restore();
  g.textAlign = "start";

  const barX = c.width - 38;
  const barY = margin;
  const barH = plot;
  for (let i = 0; i < barH; i += 1) {
    const ts = maxTS * (1 - i / barH);
    g.fillStyle = color(ts, maxTS);
    g.fillRect(barX, barY + i, 16, 1);
  }
  g.strokeStyle = "rgba(48,61,72,0.42)";
  g.strokeRect(barX, barY, 16, barH);
  g.fillStyle = "rgba(48,61,72,0.88)";
  g.font = "12px Segoe UI";
  g.fillText(maxTS.toFixed(1), barX - 6, barY - 8);
  g.fillText("0", barX + 3, barY + barH + 16);
  setupLocalCoordinateReadout(c, m, {
    margin,
    plot,
    xMin: -radius,
    xMax: radius,
    yMin: -radius,
    yMax: radius,
  }, pts);
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function catalogNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function hasCatalogValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function formatScientific(value, digits = 2) {
  return Number.isFinite(value) ? value.toExponential(digits) : "-";
}

function formatAgeYears(years) {
  if (!Number.isFinite(years) || years <= 0) return "";
  if (years < 1e3) return `${catalogNumber(years, 0)} yr`;
  if (years < 1e6) return `${catalogNumber(years / 1e3, years < 1e5 ? 1 : 0)} kyr`;
  if (years < 1e9) return `${catalogNumber(years / 1e6, years < 1e8 ? 1 : 0)} Myr`;
  return `${catalogNumber(years / 1e9, 2)} Gyr`;
}

function pulsarAgeYears(source) {
  if (Number.isFinite(source.ageYears)) return source.ageYears;
  if (Number.isFinite(source.p0) && Number.isFinite(source.p1) && source.p1 > 0) {
    return source.p0 / (2 * source.p1) / (365.25 * 24 * 3600);
  }
  return null;
}

function snrTypeLabel(value) {
  const type = String(value || "").trim();
  if (!type) return "";
  const parts = [];
  if (type.includes("S")) parts.push("shell");
  if (type.includes("F")) parts.push("filled-center");
  if (type.includes("C")) parts.push("composite");
  const suffix = type.includes("?") ? ", uncertain" : "";
  return parts.length ? `${type} (${parts.join(" + ")}${suffix})` : type;
}

function infoRows(rows) {
  const html = rows
    .filter((row) => hasCatalogValue(row.value))
    .map((row) => `<div class="info-row"><span>${htmlEscape(row.label)}</span><b>${row.value}</b></div>`)
    .join("");
  return html;
}

function infoSection(title, rows) {
  const body = infoRows(rows);
  if (!body) return "";
  return `<section class="info-card"><h3>${htmlEscape(title)}</h3>${body}</section>`;
}

function infoDetails(title, body, open = false) {
  if (!body) return "";
  return `<details class="info-details"${open ? " open" : ""}><summary>${htmlEscape(title)}</summary>${body}</details>`;
}

function catalogDisplayName(source) {
  return source.name || source.sourceName || source.id;
}

function typeParameterRows(source) {
  const z = source.redshift ?? source.z;
  const tevAssoc = source.assocTev || source.tevcat || "";
  const alertBounds = source.raErrPlusDeg
    ? `RA +${catalogNumber(source.raErrPlusDeg, 2)}/-${catalogNumber(source.raErrMinusDeg, 2)}deg, Dec +${catalogNumber(source.decErrPlusDeg, 2)}/-${catalogNumber(source.decErrMinusDeg, 2)}deg`
    : "";
  const age = formatAgeYears(pulsarAgeYears(source) ?? source.ageYears);
  if (source.layer === "neutrino_alert") {
    return [
      { label: "Event MJD", value: Number.isFinite(source.mjd) ? catalogNumber(source.mjd, 3) : "" },
      { label: "Energy", value: Number.isFinite(source.energyTeV) ? `${catalogNumber(source.energyTeV, 0)} TeV` : "" },
      { label: "Signalness", value: Number.isFinite(source.signalness) ? catalogNumber(source.signalness, 2) : "" },
      { label: "90% uncertainty", value: alertBounds },
      { label: "Nearest source", value: source.nearestSource && !source.nearestSource.startsWith("--") ? htmlEscape(source.nearestSource) : "" },
    ];
  }
  if (source.layer === "pulsar") {
    return [
      { label: "Period", value: Number.isFinite(source.p0) ? `${catalogNumber(source.p0, 5)} s` : "" },
      { label: "Pdot", value: Number.isFinite(source.p1) ? formatScientific(source.p1) : "" },
      { label: "Age", value: age },
      { label: "Edot", value: Number.isFinite(source.edot) ? `${formatScientific(source.edot)} erg/s` : "" },
      { label: "Distance", value: Number.isFinite(source.distanceKpc) ? `${catalogNumber(source.distanceKpc, 2)} kpc` : "" },
      { label: "Edot/d2", value: Number.isFinite(source.edotOverD2) ? formatScientific(source.edotOverD2) : "" },
      { label: "Association", value: htmlEscape(source.association || "") },
    ];
  }
  if (source.layer === "snr" || source.layer === "tev_snr" || source.layer === "tev_pwn") {
    return [
      { label: "Source class", value: htmlEscape(snrTypeLabel(source.class)) },
      { label: "Angular size", value: Number.isFinite(source.sizeDeg) ? `${catalogNumber(source.sizeDeg, 3)} deg` : htmlEscape(source.extended || "") },
      { label: "Age", value: formatAgeYears(source.ageYears) },
      { label: "Distance", value: Number.isFinite(source.distanceKpc) ? `${catalogNumber(source.distanceKpc, 2)} kpc` : "" },
      { label: "1 GHz flux", value: Number.isFinite(source.radioFluxJy1GHz) ? `${catalogNumber(source.radioFluxJy1GHz, 2)} Jy` : "" },
      { label: "Radio index", value: Number.isFinite(source.spectralIndex) ? catalogNumber(source.spectralIndex, 2) : "" },
      { label: "TeV flux", value: Number.isFinite(source.fluxTeV) ? `${formatScientific(source.fluxTeV)} cm^-2 s^-1` : "" },
      { label: "TeV energy flux", value: Number.isFinite(source.energyFluxTeV) ? `${formatScientific(source.energyFluxTeV)} erg cm^-2 s^-1` : "" },
      { label: "Associated pulsar", value: htmlEscape(source.associatedPulsar || "") },
    ];
  }
  if (source.layer === "tev" || source.layer === "microquasar") {
    return [
      { label: "Source class", value: htmlEscape(source.class || source.sourceClass || "") },
      { label: "TeV flux", value: Number.isFinite(source.fluxTeV) ? `${formatScientific(source.fluxTeV)} cm^-2 s^-1` : "" },
      { label: "TeV energy flux", value: Number.isFinite(source.energyFluxTeV) ? `${formatScientific(source.energyFluxTeV)} erg cm^-2 s^-1` : "" },
      { label: "Extension", value: Number.isFinite(source.sizeDeg) ? `${catalogNumber(source.sizeDeg, 3)} deg` : htmlEscape(source.extended || "") },
      { label: "Significance", value: Number.isFinite(source.significance) ? catalogNumber(source.significance, 2) : "" },
      { label: "Association", value: htmlEscape(source.association || source.tevcat || source.seenBy || "") },
    ];
  }
  if (source.layer === "agn" || source.layer === "fermi") {
    return [
      { label: "Class", value: htmlEscape(source.class || source.sourceClass || "") },
      { label: "Redshift", value: Number.isFinite(z) ? catalogNumber(z, 4) : "" },
      { label: "Radio flux", value: Number.isFinite(source.radioFluxJy1GHz) ? `${catalogNumber(source.radioFluxJy1GHz, 2)} Jy` : "" },
      { label: "Gamma energy flux", value: Number.isFinite(source.energyFlux100) ? `${formatScientific(source.energyFlux100)} erg cm^-2 s^-1` : "" },
      { label: "Gamma flux >1 GeV", value: Number.isFinite(source.flux1000) ? `${formatScientific(source.flux1000)} ph cm^-2 s^-1` : "" },
      { label: "Variability", value: Number.isFinite(source.variability) ? catalogNumber(source.variability, 2) : "" },
      { label: "4FGL source", value: source.sourceName && source.catalog === "4FGL-DR4" ? htmlEscape(source.sourceName) : "" },
      { label: "TeV association", value: htmlEscape(tevAssoc) },
    ];
  }
  if (source.layer === "galaxy") {
    return [
      { label: "Class", value: htmlEscape(source.class || source.sourceClass || "") },
      { label: "Redshift", value: Number.isFinite(z) ? catalogNumber(z, 4) : "" },
      { label: "Distance", value: Number.isFinite(source.distanceMpc) ? `${catalogNumber(source.distanceMpc, 2)} Mpc` : "" },
      { label: "SFR", value: Number.isFinite(source.sfr) ? `${catalogNumber(source.sfr, 2)} Msun/yr` : "" },
      { label: "IR luminosity", value: Number.isFinite(source.irLuminosity) ? `${formatScientific(source.irLuminosity)} Lsun` : "" },
      { label: "Radio flux", value: Number.isFinite(source.radioFluxJy1GHz) ? `${catalogNumber(source.radioFluxJy1GHz, 2)} Jy` : "" },
      { label: "Gamma energy flux", value: Number.isFinite(source.energyFlux100) ? `${formatScientific(source.energyFlux100)} erg cm^-2 s^-1` : "" },
    ];
  }
  return [
    { label: "Class", value: htmlEscape(source.class || source.sourceClass || "") },
    { label: "Redshift", value: Number.isFinite(z) ? catalogNumber(z, 4) : "" },
    { label: "Distance", value: Number.isFinite(source.distanceKpc) ? `${catalogNumber(source.distanceKpc, 2)} kpc` : "" },
    { label: "Flux", value: Number.isFinite(source.fluxTeV) ? formatScientific(source.fluxTeV) : "" },
  ];
}

function sourceInfoSections(source, pix, shown) {
  const match = source.match || {};
  const candidate = match.candidateName
    ? `${htmlEscape(match.candidateName)}, ${catalogNumber(match.candidateSepDeg, 3)}deg, TS ${catalogNumber(match.candidateTs)}${match.candidateDense ? " (dense)" : ""}`
    : "";
  const bounds = source.raErrPlusDeg
    ? `RA +${catalogNumber(source.raErrPlusDeg, 2)}/-${catalogNumber(source.raErrMinusDeg, 2)}deg, Dec +${catalogNumber(source.decErrPlusDeg, 2)}/-${catalogNumber(source.decErrMinusDeg, 2)}deg`
    : "";
  const tevAssoc = source.assocTev || source.tevcat || "";
  const size = source.extended || source.sizeDeg || source.extensionDeg
    ? htmlEscape(source.extended || `${catalogNumber(source.sizeDeg || source.extensionDeg, 3)} deg`)
    : "";
  const z = source.redshift ?? source.z;
  const mag = source.vmag ?? source.magV ?? source.opticalMag ?? source.apparentMag;
  const summary = infoSection("Summary", [
    { label: "Catalog", value: htmlEscape(source.catalog || "") },
    { label: "Type", value: htmlEscape(source.class || source.sourceClass || source.layer || "") },
    { label: "Rank TS", value: catalogNumber(bestCatalogTS(source)) },
    { label: "Position", value: `RA ${source.ra.toFixed(4)}deg, Dec ${source.dec.toFixed(4)}deg` },
    { label: "Candidate", value: candidate },
  ]);
  const keyParams = infoSection("Source Parameters", typeParameterRows(source));
  const skyllh = infoSection("SkyLLH Match", [
    { label: "Nearest TS", value: `${pix.TS.toFixed(2)} (shown ${shown.toFixed(2)})` },
    { label: "ns / gamma", value: `${pix.ns.toFixed(2)} / ${pix.gamma.toFixed(2)}` },
    { label: "Pixel sep", value: `${pix.sep.toFixed(2)}deg` },
  ]);
  const more = [
    infoSection("Identity", [
      { label: "Catalog name", value: source.sourceName && source.sourceName !== source.name ? htmlEscape(source.sourceName) : "" },
      { label: "Layer", value: htmlEscape(source.layer || "") },
      { label: "Role", value: htmlEscape(source.catalogRole || "") },
    ]),
    infoSection("Position", [
      { label: "RA", value: `${source.ra.toFixed(4)}deg` },
      { label: "Dec", value: `${source.dec.toFixed(4)}deg` },
      { label: "Galactic l", value: Number.isFinite(source.glon) ? `${catalogNumber(source.glon, 3)}deg` : "" },
      { label: "Galactic b", value: Number.isFinite(source.glat) ? `${catalogNumber(source.glat, 3)}deg` : "" },
      { label: "Size / extension", value: size },
      { label: "90% bounds", value: bounds },
    ]),
    infoSection("Properties", [
      { label: "Redshift", value: Number.isFinite(z) ? catalogNumber(z, 4) : "" },
      { label: "Apparent mag", value: Number.isFinite(mag) ? catalogNumber(mag, 2) : "" },
      { label: "Distance", value: Number.isFinite(source.distanceKpc) ? `${catalogNumber(source.distanceKpc, 2)} kpc` : "" },
      { label: "Period", value: Number.isFinite(source.p0) ? `${catalogNumber(source.p0, 4)} s` : "" },
      { label: "Pdot", value: Number.isFinite(source.p1) ? formatScientific(source.p1) : "" },
      { label: "Age", value: formatAgeYears(pulsarAgeYears(source) ?? source.ageYears) },
      { label: "Edot", value: Number.isFinite(source.edot) ? `${formatScientific(source.edot)} erg/s` : "" },
      { label: "Edot/d2", value: Number.isFinite(source.edotOverD2) ? formatScientific(source.edotOverD2) : "" },
      { label: "Spectral index", value: Number.isFinite(source.spectralIndex) ? catalogNumber(source.spectralIndex, 2) : "" },
      { label: "Significance", value: Number.isFinite(source.significance) ? catalogNumber(source.significance, 2) : "" },
      { label: "Variability", value: Number.isFinite(source.variability) ? catalogNumber(source.variability, 2) : "" },
    ]),
    infoSection("Flux / Activity", [
      { label: "1 GHz flux", value: Number.isFinite(source.radioFluxJy1GHz) ? `${catalogNumber(source.radioFluxJy1GHz, 2)} Jy` : "" },
      { label: "Fermi flux >1 GeV", value: Number.isFinite(source.flux1000) ? `${formatScientific(source.flux1000)} ph cm^-2 s^-1` : "" },
      { label: "Fermi energy flux", value: Number.isFinite(source.energyFlux100) ? `${formatScientific(source.energyFlux100)} erg cm^-2 s^-1` : "" },
      { label: "TeV flux", value: Number.isFinite(source.fluxTeV) ? `${formatScientific(source.fluxTeV)} cm^-2 s^-1` : "" },
      { label: "TeV energy flux", value: Number.isFinite(source.energyFluxTeV) ? `${formatScientific(source.energyFluxTeV)} erg cm^-2 s^-1` : "" },
    ]),
    infoSection("IceCube Alert", [
      { label: "MJD", value: Number.isFinite(source.mjd) ? catalogNumber(source.mjd, 3) : "" },
      { label: "Energy", value: Number.isFinite(source.energyTeV) ? `${catalogNumber(source.energyTeV, 0)} TeV` : "" },
      { label: "Signalness", value: Number.isFinite(source.signalness) ? catalogNumber(source.signalness, 2) : "" },
      { label: "Nearest source", value: source.nearestSource && !source.nearestSource.startsWith("--") ? htmlEscape(source.nearestSource) : "" },
      { label: "IceTop veto", value: source.crVeto ? "likely cosmic-ray shower background" : "" },
    ]),
    infoSection("Associations", [
      { label: "Association", value: htmlEscape(source.association || "") },
      { label: "TeV association", value: htmlEscape(tevAssoc) },
      { label: "Other names", value: htmlEscape(source.otherNames || "") },
      { label: "Note", value: htmlEscape(source.note || "") },
      { label: "Source", value: htmlEscape(source.provenance || "") },
    ]),
  ];
  return [summary, keyParams, skyllh, infoDetails("More catalog fields", more.join(""))].join("");
}

function sourceCompactSections(source, pix, shown) {
  const details = sourceInfoSections(source, pix, shown);
  const start = details.indexOf("<details");
  const more = start >= 0 ? details.slice(start) : "";
  const skyllh = infoSection("SkyLLH Match", [
    { label: "Rank TS", value: catalogNumber(bestCatalogTS(source)) },
    { label: "Nearest TS", value: `${pix.TS.toFixed(2)} (shown ${shown.toFixed(2)})` },
    { label: "Pixel sep", value: `${pix.sep.toFixed(2)}deg` },
  ]);
  return [
    skyllh,
    infoSection("Source Parameters", typeParameterRows(source)),
    more,
  ].join("");
}

function normalizedName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function catalogNameCandidates(source) {
  const names = [];
  const add = (value) => {
    const cleanValue = String(value || "").trim();
    if (!cleanValue || cleanValue === "--" || cleanValue.startsWith("--")) return;
    names.push(cleanValue);
  };
  add(source.name);
  add(source.sourceName);
  add(source.association);
  add(source.assocTev);
  add(source.tevcat);
  String(source.otherNames || "")
    .split(/[;,]/)
    .forEach(add);
  return [...new Set(names.map(normalizedName).filter((name) => name.length >= 3))];
}

function sameSourceByName(a, b) {
  const aNames = new Set(catalogNameCandidates(a));
  if (!aNames.size) return false;
  return catalogNameCandidates(b).some((name) => aNames.has(name));
}

function counterpartCatalogSources(target) {
  return CATALOG_OVERLAYS.sources
    .map((source) => {
      const distance = sep(target, source);
      return { source, distance };
    })
    .filter((item) => sameSourceByName(target, item.source))
    .sort((a, b) => {
      const roleWeight = (source) => ({ parent: 0, association: 1, event: 2 }[source.catalogRole] ?? 3);
      const rw = roleWeight(a.source) - roleWeight(b.source);
      if (rw !== 0) return rw;
      const ats = bestCatalogTS(a.source);
      const bts = bestCatalogTS(b.source);
      if (ats !== bts) return bts - ats;
      return a.distance - b.distance;
    });
}

function catalogContextScore(item) {
  const source = item.source;
  const ts = bestCatalogTS(source);
  const roleBoost = ({ parent: 2.6, association: 1.0, event: 1.8 }[source.catalogRole] ?? 0);
  const layerBoost = ({
    agn: 1.2,
    galaxy: 1.2,
    microquasar: 1.4,
    snr: 0.8,
    tev: 1.1,
    tev_snr: 1.1,
    tev_pwn: 1.0,
    neutrino_alert: 1.5,
  }[source.layer] ?? 0);
  const candidateBoost = source.match?.candidateName ? 2.0 : 0;
  const visualBoost = clamp(source.visualWeight || 0, 0, 4) * 0.45;
  const distanceBoost = clamp(2.0 - item.distance, 0, 2.0) * 0.9;
  return ts * 0.18 + roleBoost + layerBoost + candidateBoost + visualBoost + distanceBoost;
}

function isMeaningfulNearby(item) {
  const source = item.source;
  const ts = bestCatalogTS(source);
  if (item.distance <= 0.35) return true;
  if (source.catalog === "core references") return true;
  if (source.match?.candidateName) return true;
  if (source.layer === "neutrino_alert" && (source.signalness || 0) >= 0.5) return true;
  if (source.catalogRole === "parent" && source.layer !== "pulsar" && ts >= 1.5) return true;
  if ((source.visualWeight || 0) >= 1.6 && ts >= 2.0) return true;
  return ts >= 6.0;
}

function nearbyCatalogList(target, radiusDeg = 2.0, limit = 6) {
  return CATALOG_OVERLAYS.sources
    .map((source) => ({ source, distance: sep(target, source) }))
    .filter((item) => item.distance <= radiusDeg)
    .filter(isMeaningfulNearby)
    .sort((a, b) => {
      const score = catalogContextScore(b) - catalogContextScore(a);
      if (Math.abs(score) > 1e-6) return score;
      return a.distance - b.distance;
    })
    .slice(0, limit);
}

function compactSourceList(title, items) {
  if (!items.length) return "";
  const rows = items.map(({ source, distance }) => `
    <button class="nearby-row" type="button" data-source-id="${htmlEscape(source.id)}">
      <span class="nearby-name">${htmlEscape(catalogDisplayName(source))}</span>
      <b>${catalogNumber(distance, 2)}deg · TS ${catalogNumber(bestCatalogTS(source), 1)}</b>
      <em>${htmlEscape(source.catalog || "")}${source.class ? ` · ${htmlEscape(source.class)}` : ""}</em>
    </button>`).join("");
  return `<section class="info-card nearby-card"><h3>${htmlEscape(title)}</h3>${rows}</section>`;
}

function compactMatchedCatalog(source, distance) {
  if (!source) return "";
  return `<section class="info-card nearby-card matched-card">
    <h3>Catalog Match</h3>
    <button class="nearby-row matched-row" type="button" data-source-id="${htmlEscape(source.id)}">
      <span class="nearby-name">${htmlEscape(catalogDisplayName(source))}</span>
      <b>${catalogNumber(distance, 3)}deg · TS ${catalogNumber(bestCatalogTS(source), 1)}</b>
      <em>${htmlEscape(source.catalog || "")}${source.class ? ` · ${htmlEscape(source.class)}` : ""}</em>
    </button>
  </section>`;
}

function compactCounterpartList(items, currentId = "") {
  const filtered = items.filter((item) => item.source.id !== currentId);
  if (!filtered.length) return "";
  const rows = filtered.map(({ source, distance }) => `
    <button class="nearby-row counterpart-row" type="button" data-source-id="${htmlEscape(source.id)}">
      <span class="nearby-name">${htmlEscape(catalogDisplayName(source))}</span>
      <b>${catalogNumber(distance, 3)}deg · TS ${catalogNumber(bestCatalogTS(source), 1)}</b>
      <em>${htmlEscape(source.catalog || "")}${source.class ? ` · ${htmlEscape(source.class)}` : ""}</em>
    </button>`).join("");
  return `<section class="info-card nearby-card counterpart-card"><h3>Catalog Counterparts</h3>${rows}</section>`;
}

function bindNearbyRows() {
  drawerContent.querySelectorAll(".nearby-row").forEach((row) => {
    row.addEventListener("click", () => {
      const source = CATALOG_OVERLAYS.sources.find((item) => item.id === row.dataset.sourceId);
      if (source) openCatalogDrawer(source);
    });
  });
}

function markerResultSection(m, pix, dense, best, denseRows, sparsePartial, preferredTS, preferredNs, preferredGamma) {
  const denseBest = best
    ? `TS ${best.TS.toFixed(2)}, RA ${best.ra_deg.toFixed(3)}deg, Dec ${best.dec_deg.toFixed(3)}deg`
    : "";
  const denseProgress = dense?.partial
    ? `${denseRows} / 113${sparsePartial ? ", sparse" : ""}`
    : "";
  const summary = infoSection("SkyLLH Result", [
    { label: "Best shown TS", value: `${preferredTS.toFixed(2)}, ns ${preferredNs.toFixed(2)}, gamma ${preferredGamma.toFixed(2)}` },
    { label: "Source position", value: `RA ${m.ra.toFixed(4)}deg, Dec ${m.dec.toFixed(4)}deg` },
    { label: "Nearest pixel", value: `TS ${pix.TS.toFixed(2)}, sep ${pix.sep.toFixed(2)}deg` },
    { label: "Dense best", value: denseBest },
  ]);
  const more = infoSection("More SkyLLH", [
    { label: "Pixel ns / gamma", value: `${pix.ns.toFixed(2)} / ${pix.gamma.toFixed(2)}` },
    { label: "Exact source TS", value: Number.isFinite(m.exactTS) ? m.exactTS.toFixed(2) : "" },
    { label: "Shape", value: m.extension ? htmlEscape(`${extensionLabel(m.extension)}${m.extension.note ? ` (${m.extension.note})` : ""}`) : "" },
    { label: "Dense rows", value: denseProgress },
  ]);
  return `${summary}${infoDetails("More SkyLLH fields", more)}`;
}

function openDrawer(m) {
  selected = m;
  selectedCatalog = null;
  centerOnSky(m.ra, m.dec);
  drawer.classList.add("open");
  drawer.classList.remove("closed");
  drawer.classList.remove("minimized");
  draw();

  const pix = nearestPixel(m.ra, m.dec);
  const dense = DATA.dense[m.id];
  const best = dense?.top?.[0];
  const denseRows = dense?.rows || dense?.points?.length || 0;
  const sparsePartial = Boolean(dense?.partial && denseRows < MIN_PARTIAL_DENSE_ROWS_FOR_MAP);
  const denseTag = dense
    ? (dense.partial ? (sparsePartial ? "partial dense sparse" : "partial dense cache") : "official dense cache")
    : "nside64 only";
  const preferredTS = best?.TS ?? m.exactTS ?? m.TS ?? m.baseTS ?? pix.TS;
  const preferredNs = best?.ns ?? pix.ns;
  const preferredGamma = best?.gamma ?? pix.gamma;
  const counterparts = counterpartCatalogSources(m);
  const primaryItem = counterparts.find((item) => item.source.catalog !== "core references") || counterparts[0] || null;
  const primaryCatalog = primaryItem?.source || null;
  const counterpartIds = new Set(counterparts.map((item) => item.source.id));
  const nearby = nearbyCatalogList(m, 2.0, 6)
    .filter((item) => !counterpartIds.has(item.source.id));
  const catalogContext = primaryCatalog
    ? compactMatchedCatalog(primaryCatalog, primaryItem.distance)
    : "";
  const counterpartContext = infoDetails("Catalog Counterparts", compactCounterpartList(counterparts, primaryCatalog?.id || ""));
  const nearbyContext = infoDetails("Nearby References", compactSourceList("Nearby References", nearby));
  const resultContext = markerResultSection(m, pix, dense, best, denseRows, sparsePartial, preferredTS, preferredNs, preferredGamma);

  drawerContent.innerHTML = `
    <h2>${m.name}</h2>
    <div>
      <span class="tag">${m.kind}</span>
      ${m.sourceClass ? `<span class="tag">${m.sourceClass}</span>` : ""}
      <span class="tag">${denseTag}</span>
    </div>
    <div class="source-info">${resultContext}</div>
    <div class="source-info">${catalogContext}</div>
    ${counterpartContext}
    ${nearbyContext}
    <div class="note"></div>`;
  bindNearbyRows();
  renderLocalCanvas(m);
}

function openCatalogDrawer(source) {
  selected = null;
  selectedCatalog = source;
  centerOnSky(source.ra, source.dec);
  drawer.classList.add("open");
  drawer.classList.remove("closed");
  drawer.classList.remove("minimized");
  draw();

  const pix = nearestPixel(source.ra, source.dec);
  const shown = displayTSForPixel(pix.index, pix);
  const name = htmlEscape(source.name || source.sourceName || source.id);
  const counterparts = counterpartCatalogSources(source);
  const counterpartIds = new Set(counterparts.map((item) => item.source.id));
  const nearby = nearbyCatalogList(source, 2.0, 6)
    .filter((item) => !counterpartIds.has(item.source.id) && item.source.id !== source.id);
  const counterpartContext = infoDetails("Catalog Counterparts", compactCounterpartList(counterparts, source.id));
  const nearbyContext = infoDetails("Nearby References", compactSourceList("Nearby References", nearby));
  const marker = {
    id: `catalog_${source.id}`,
    name: source.name || source.sourceName || source.id,
    kind: "catalog",
    ra: source.ra,
    dec: source.dec,
  };

  drawerContent.innerHTML = `
    <h2>${name}</h2>
    <div>
      <span class="tag">${htmlEscape(source.catalog || "catalog")}</span>
      <span class="tag">${htmlEscape(source.catalogRole || "catalog")}</span>
      <span class="tag">${htmlEscape(source.layer || "source")}</span>
      ${source.class ? `<span class="tag">${htmlEscape(source.class)}</span>` : ""}
    </div>
    <div class="source-info">${sourceCompactSections(source, pix, shown)}</div>
    ${counterpartContext}
    ${nearbyContext}
    <div class="note"></div>`;
  renderLocalCanvas(marker);
}

function populateBright() {
  const box = document.getElementById("brightList");
  const note = document.querySelector(".brightest .panel-note");
  box.innerHTML = "";
  if ((catalogPreset?.value || "off") !== "off") {
    const sources = filteredCatalogSources()
      .slice()
      .sort((a, b) => {
        const ats = bestCatalogTS(a);
        const bts = bestCatalogTS(b);
        if (ats !== bts) return bts - ats;
        return (b.visualWeight || 0) - (a.visualWeight || 0);
      });
    if (note) note.textContent = catalogPreset.options[catalogPreset.selectedIndex].text;
    if (!sources.length) {
      box.innerHTML = `<div class="empty-list">No catalog sources in this view</div>`;
      return;
    }
    for (const [i, s] of sources.slice(0, 80).entries()) {
      const row = document.createElement("div");
      row.className = "bright-row";
      const match = s.match || {};
      const assoc = match.candidateName ? `${match.candidateName}, ${catalogNumber(match.candidateSepDeg, 2)}deg` : `nearest pixel ${catalogNumber(match.nearestSepDeg, 2)}deg`;
      row.innerHTML = `<div>#${i + 1}</div><div>${htmlEscape(s.name || s.sourceName || s.id)}<div class="meta">${htmlEscape(s.catalog)} / ${htmlEscape(s.layer)} · ${assoc}</div></div><div>TS ${bestCatalogTS(s).toFixed(1)}</div>`;
      row.onclick = () => openCatalogDrawer(s);
      box.appendChild(row);
    }
    return;
  }
  if (note) note.textContent = filter.options[filter.selectedIndex].text;
  const ranked = filteredMarkers()
    .sort((a, b) => bestDisplayTS(b) - bestDisplayTS(a));
  if (!ranked.length) {
    box.innerHTML = `<div class="empty-list">No markers in this view</div>`;
    return;
  }
  for (const [i, m] of ranked.entries()) {
    const row = document.createElement("div");
    row.className = "bright-row";
    const role = markerRole(m);
    const type = DATA.dense[m.id]?.partial ? "partial dense" : (DATA.dense[m.id] || LOCAL_CONTOURS[m.id] ? `${role} dense` : role);
    row.innerHTML = `<div>#${i + 1}</div><div>${m.name}<div class="meta">${type} 路 RA ${m.ra.toFixed(1)} Dec ${m.dec.toFixed(1)}</div></div><div>TS ${bestDisplayTS(m).toFixed(1)}</div>`;
    row.onclick = () => openDrawer(m);
    box.appendChild(row);
  }
}

function clickCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * devicePixelRatio;
  const y = (e.clientY - rect.top) * devicePixelRatio;
  const sky = xyToSky(x, y);
  if (!sky) return;
  let best = null;
  let bestSep = 4 / Math.sqrt(view.zoom);
  for (const m of filteredMarkers()) {
    const s = sep(sky, m);
    if (s < bestSep) {
      best = m;
      bestSep = s;
    }
  }
  if (best) openDrawer(best);
  else {
    let catalogBest = null;
    let catalogBestSep = 2.2 / Math.sqrt(view.zoom);
    const clickableCatalog = [
      ...filteredCatalogSources(),
      ...(((catalogPreset?.value || "off") === "alerts" || !showAlerts) ? [] : neutrinoAlerts()),
    ];
    for (const source of clickableCatalog) {
      const s = sep(sky, source);
      if (s < catalogBestSep) {
        catalogBest = source;
        catalogBestSep = s;
      }
    }
    if (catalogBest) openCatalogDrawer(catalogBest);
    else openDrawer({ id: `click_${Date.now()}`, name: "Clicked direction", kind: "clicked", ra: sky.ra, dec: sky.dec });
  }
}

function zoomBy(factor, clientX = innerWidth / 2, clientY = innerHeight / 2) {
  const before = xyToSky(clientX * devicePixelRatio, clientY * devicePixelRatio);
  view.zoom = clamp(view.zoom * factor, 1, 18);
  if (before) {
    const after = skyToXY(before.ra, before.dec);
    view.panX += clientX * devicePixelRatio - after.x;
    view.panY += clientY * devicePixelRatio - after.y;
  }
  constrainPan();
  draw();
}

canvas.addEventListener("pointerdown", (e) => {
  drag.active = true;
  drag.moved = false;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.panX = view.panX;
  drag.panY = view.panY;
  canvas.classList.add("dragging");
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag.active) return;
  const dx = (e.clientX - drag.x) * devicePixelRatio;
  const dy = (e.clientY - drag.y) * devicePixelRatio;
  if (Math.hypot(dx, dy) > 3 * devicePixelRatio) drag.moved = true;
  view.panX = drag.panX + dx;
  view.panY = drag.panY + dy;
  constrainPan();
  draw();
});

canvas.addEventListener("pointerup", (e) => {
  canvas.classList.remove("dragging");
  if (!drag.active) return;
  drag.active = false;
  if (!drag.moved) clickCanvas(e);
});

canvas.addEventListener("mousemove", updateSkyReadout);
canvas.addEventListener("mouseleave", () => {
  if (skyReadout) skyReadout.textContent = "";
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
}, { passive: false });

document.getElementById("closeDrawer").onclick = () => {
  drawer.classList.add("closed");
  drawer.classList.remove("minimized");
};
document.getElementById("minDrawer").onclick = () => drawer.classList.toggle("minimized");
document.getElementById("drawerTab").onclick = () => {
  drawer.classList.remove("closed");
  drawer.classList.remove("minimized");
  if (!drawerContent.innerHTML && selectedCatalog) openCatalogDrawer(selectedCatalog);
  else if (!drawerContent.innerHTML && selected) openDrawer(selected);
};
document.getElementById("collapseList").onclick = () => {
  document.querySelector(".brightest").classList.toggle("collapsed");
};
document.getElementById("reset").onclick = () => {
  view.zoom = 1;
  view.panX = 0;
  view.panY = 0;
  selected = DATA.markers.find((m) => m.id === "ngc1068") || DATA.markers[0];
  selectedCatalog = null;
  filter.value = "known";
  if (catalogPreset) catalogPreset.value = "off";
  drawer.classList.add("closed");
  drawer.classList.remove("minimized");
  populateBright();
  draw();
};
document.getElementById("zoomIn").onclick = () => zoomBy(1.25);
document.getElementById("zoomOut").onclick = () => zoomBy(1 / 1.25);
document.getElementById("toggleCells").onclick = () => {
  useCells = !useCells;
  document.getElementById("toggleCells").textContent = useCells ? "Cells on" : "Cells off";
  draw();
};
document.getElementById("toggleSmooth").onclick = () => {
  smoothSky = !smoothSky;
  document.getElementById("toggleSmooth").textContent = smoothSky ? "Smooth on" : "Smooth off";
  draw();
};
document.getElementById("toggleMilkyWay").onclick = () => {
  showMilkyWay = !showMilkyWay;
  document.getElementById("toggleMilkyWay").textContent = showMilkyWay ? "Milky Way on" : "Milky Way off";
  draw();
};
document.getElementById("toggleAlerts").onclick = () => {
  showAlerts = !showAlerts;
  document.getElementById("toggleAlerts").textContent = showAlerts ? "Alerts on" : "Alerts off";
  draw();
};
document.getElementById("toggleLabels").onclick = () => {
  showLabels = !showLabels;
  draw();
};
if (coordForm) {
  coordForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const coord = parseCoordInput();
    if (!coord) {
      markCoordInputInvalid(true);
      return;
    }
    markCoordInputInvalid(false);
    if (coordRa) coordRa.value = coord.ra.toFixed(4);
    if (coordDec) coordDec.value = coord.dec.toFixed(4);
    openDrawer({
      id: `input_${Date.now()}`,
      name: "Input direction",
      kind: "clicked",
      ra: coord.ra,
      dec: coord.dec,
    });
  });
  coordForm.addEventListener("input", () => markCoordInputInvalid(false));
}
filter.onchange = () => {
  populateBright();
  draw();
};
if (catalogPreset) {
  catalogPreset.onchange = () => {
    selectedCatalog = null;
    populateBright();
    draw();
  };
}
addEventListener("resize", resize);

populateBright();
resize();

