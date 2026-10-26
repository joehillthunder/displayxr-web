// glb-preview — any glTF/GLB in ONE persistent inline-3D window, framed inside the comfort
// budget, with a live depth control. Built for generated assets (image → 3D: SF3D / SPAR3D via
// displayxr-stability) and asset-library kits (a manifest of GLBs), but it takes any GLB.
//
// Why addSplat and not addModel: the page needs a LIVE depth control, and `handle.setStereo` is on
// the splat handle. One PlayCanvas addSplat tile with its splat hidden, the glTF under
// `handle.engine.root` and `setRig('display')` renders pixel-identically to an addModel tile
// (docs/playcanvas-adapter.md, the setRig gates), and a model swap is a content swap inside the
// same canvas: never a remount (woven-canvas-rules §2, §3).

import { createInline3D } from '@displayxr/inline3d';
import { addSplat } from '@displayxr/inline3d/splat';

// Comfort budget as fractions of PANEL width: 0.14 % in front of the glass, 0.42 % behind. The
// same numbers as displayxr-stability's depthfit.comfort_budget() and the DCC integrations; not
// yet a display-info field, so kept in one place here.
const BUDGET_FRONT = 0.0014;
const BUDGET_BEHIND = 0.0042;
const VH = 0.24; // virtualDisplayHeight: metres of world the tile's height spans (addModel's default)
const IDLE_SPIN = 8; // °/s once idle, as addModel

const DEFAULT_GLB = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@c6a6bd13ab2b3c685c7903d03561b8a9392f38b8/Models/DamagedHelmet/glTF-Binary/DamagedHelmet.glb';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const canvas = $('tile');
const cover = $('cover');
const depth = $('depth');
const above = $('above');

// ── Depth control state ─────────────────────────────────────────────────────────────────────
// `comfort` is the ipdFactor that puts THIS asset exactly on the budget (capped at 1 = true
// geometry: never more stereo than the real thing). The slider is a percentage of it.
let comfort = 1;
{
  const d = Number(params.get('depth'));
  if (Number.isFinite(d) && params.has('depth')) {
    if (d > 100) above.checked = true;
    depth.max = above.checked ? 200 : 100;
    depth.value = String(Math.max(0, Math.min(Number(depth.max), d)));
  }
}

// ── One session, one canvas, one handle for the life of the page (rules 1–3) ─────────────────
const wall = await createInline3D({ lazy: false });
const h = addSplat(wall, canvas, placeholderSplat(), {
  engine: 'playcanvas',
  antialias: true, // addModel's MSAA, so meshes render as they would there
  virtualDisplayHeight: VH,
  idleSpin: 0,
});
await h.ready;
h.mesh.entity.enabled = false; // the placeholder is never shown
const pc = await import('playcanvas');
const { app, root } = h.engine;

/** The model on screen: { entity, asset, blobUrl, entry }. */
let current = null;
let seq = 0;

/** A one-splat, fully transparent binary PLY: addSplat needs a source; the page shows meshes. */
function placeholderSplat() {
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\n' +
    props.map((p) => `property float ${p}\n`).join('') + 'end_header\n';
  const head = new TextEncoder().encode(header);
  const body = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, -20, -12, -12, -12, 1, 0, 0, 0]);
  const out = new Uint8Array(head.length + body.byteLength);
  out.set(head, 0);
  out.set(new Uint8Array(body.buffer), head.length);
  return out.buffer;
}

// ── Loading ─────────────────────────────────────────────────────────────────────────────────
/**
 * entry: { name, url?, file?, size_m? (number or [x, y, z] m), licence?, kit? }. Files are read with cache:'no-store' and
 * handed to the engine as an object URL, so this page never keeps a copy of a library asset.
 */
async function show(entry) {
  const token = ++seq;
  status(`Loading ${entry.name}…`);
  let blobUrl = null;
  let asset = null;
  try {
    const isGltf = /\.gltf(\?|#|$)/i.test(entry.file?.name || entry.url || '');
    let url;
    let filename;
    if (entry.file) {
      if (isGltf) throw new Error('a local .gltf needs its .bin and textures beside it — open a .glb, or serve the folder and use its URL');
      blobUrl = URL.createObjectURL(entry.file);
      url = blobUrl;
      filename = entry.file.name;
    } else if (isGltf) {
      url = entry.url; // external .bin / textures resolve against the URL
      filename = entry.url.split(/[?#]/)[0].split('/').pop();
    } else {
      const r = await fetch(entry.url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      blobUrl = URL.createObjectURL(await r.blob());
      url = blobUrl;
      filename = (entry.url.split(/[?#]/)[0].split('/').pop() || 'asset').replace(/(\.glb)?$/i, '.glb');
    }
    asset = new pc.Asset(entry.name, 'container', { url, filename });
    app.assets.add(asset);
    await new Promise((resolve, reject) => {
      asset.ready(resolve);
      asset.once('error', (e) => reject(new Error(String(e))));
      app.assets.load(asset);
    });
    if (token !== seq) return dispose({ asset, blobUrl }); // a newer pick won

    const entity = asset.resource.instantiateRenderEntity();
    if (current) dispose(current); // content swap on the same canvas: no remount
    root.addChild(entity);
    current = { entity, asset, blobUrl, entry };
    await h.setRig('display', { virtualDisplayHeight: VH, idleSpin: IDLE_SPIN });
    if (token !== seq) return;

    comfort = await comfortFactor();
    applyDepth();
    describe(entry);
    status('');
  } catch (err) {
    if (asset && current?.asset !== asset) dispose({ asset, blobUrl });
    if (token === seq) status(`Could not load ${entry.name}: ${err.message}`, true);
    console.error('[glb-preview]', err);
  }
}

function dispose({ entity, asset, blobUrl }) {
  entity?.destroy();
  if (asset) {
    asset.unload();
    app.assets.remove(asset);
  }
  if (blobUrl) URL.revokeObjectURL(blobUrl);
}

// ── Comfort ─────────────────────────────────────────────────────────────────────────────────
/**
 * The ipdFactor that puts this asset's parallax on the budget, capped at 1.
 *
 * Display rig: the tile's height spans VH virtual metres, so a virtual depth z is
 * z × (tile height in metres / VH) physically. A point that far in front of (behind) the glass
 * has on-screen disparity e·z/(D − z) (e·z/(D + z)) at ipdFactor 1, D the nominal viewing distance;
 * disparity scales linearly with ipdFactor. The turntable swings depth into width, so the subject's
 * depth is taken as its horizontal diagonal (the swept circle), not its face-on depth.
 */
async function comfortFactor() {
  const m = await h.displayMetrics();
  const b = h.viewer.getSubjectBounds();
  const k = (m.canvasSizeM[1] || m.displaySizeM[1]) / VH;
  const half = 0.5 * Math.hypot(b.extent.x, b.extent.z);
  const zf = Math.max(0, (b.center.z + half) * k);
  const zb = Math.max(0, -(b.center.z - half) * k);
  const D = m.nominalViewerM;
  const e = m.eyeSeparationM;
  const W = m.displaySizeM[0];
  const pf = zf > 0 ? (e * zf) / Math.max(D - zf, 1e-3) / W : 0;
  const pb = zb > 0 ? (e * zb) / (D + zb) / W : 0;
  return Math.min(1, pf > 0 ? BUDGET_FRONT / pf : Infinity, pb > 0 ? BUDGET_BEHIND / pb : Infinity);
}

/** Live parallax of the drawn pose at the current factor, as % of panel width. */
async function parallaxNow() {
  const m = await h.displayMetrics();
  const b = h.viewer.getSubjectBounds();
  const k = (m.canvasSizeM[1] || m.displaySizeM[1]) / VH;
  const f = factor();
  const zf = Math.max(0, b.front * k);
  const zb = Math.max(0, -b.back * k);
  const D = m.nominalViewerM;
  const e = m.eyeSeparationM * f;
  const W = m.displaySizeM[0];
  return {
    front: zf > 0 ? (e * zf) / Math.max(D - zf, 1e-3) / W : 0,
    behind: zb > 0 ? (e * zb) / (D + zb) / W : 0,
    source: m.source?.size || 'default',
  };
}

const factor = () => comfort * (Number(depth.value) / 100);

function applyDepth() {
  // ipdFactor and parallaxFactor TOGETHER, so stereo and head-motion parallax agree
  // (authoring-inline-3d.md, "Lowering a display rig's ipdFactor").
  const f = factor();
  h.setStereo({ ipdFactor: f, parallaxFactor: f });
  $('depthVal').textContent = `${depth.value} %`;
}

depth.addEventListener('input', applyDepth);
above.addEventListener('change', () => {
  depth.max = above.checked ? 200 : 100;
  if (!above.checked && Number(depth.value) > 100) depth.value = '100';
  applyDepth();
});
$('reset').addEventListener('click', () => h.resetPose());

setInterval(async () => {
  if (!current) return;
  const p = await parallaxNow();
  const over = p.front > BUDGET_FRONT * 1.02 || p.behind > BUDGET_BEHIND * 1.02;
  $('depthNote').innerHTML =
    `100 % = the comfort budget for this asset${comfort >= 1 ? ' (true geometry fits: no reduction needed)' : ''}. ` +
    `Now: <span class="${over ? 'over' : ''}">${(p.front * 100).toFixed(3)} % in front, ` +
    `${(p.behind * 100).toFixed(3)} % behind</span> of panel width` +
    ` (budget ${(BUDGET_FRONT * 100).toFixed(2)} / ${(BUDGET_BEHIND * 100).toFixed(2)} %` +
    `${p.source === 'display' ? '' : ', panel size assumed'}).`;
}, 250);

// ── What is on screen ───────────────────────────────────────────────────────────────────────
async function describe(entry) {
  $('name').textContent = entry.name;
  $('src').textContent = entry.kit ? entry.kit : '';
  const ext = h.rig?.frame?.extent;
  const fmt = (n) => (n >= 10 ? n.toFixed(1) : n.toFixed(2));
  if (entry.size_m !== undefined) {
    $('size').textContent = `real size ${sizeText(entry.size_m, fmt)} m`;
  } else if (ext) {
    // glTF units are metres by spec; this is the file's own bounding box.
    $('size').textContent = `${ext.map(fmt).join(' × ')} m (file bounds)`;
  } else {
    $('size').textContent = '';
  }
  // Shown at any real size: the window always frames the asset to fit, so say so.
  if ($('size').textContent) $('size').textContent += ' · shown scaled to fit';

  const lic = $('lic');
  lic.textContent = entry.licence || params.get('licence') || '';
  const side = await sidecar(entry);
  if (side && current?.entry === entry) {
    const span = document.createElement('span');
    span.className = 'ai';
    span.textContent = `AI-generated · ${side.model_name || side.model} · ${String(side.license || '').split(':')[0]}`;
    if (lic.textContent) lic.append(' · ');
    lic.append(span);
  }
}

/** displayxr-stability writes `<stem>.stability.json` beside its outputs. */
async function sidecar(entry) {
  if (!entry.url || !/\.glb(\?|#|$)/i.test(entry.url)) return null;
  try {
    const r = await fetch(entry.url.replace(/\.glb(?=(\?|#|$))/i, '.stability.json'), { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ai_generated ? j : null;
  } catch {
    return null;
  }
}

function status(text, isError = false) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('err', isError);
  if (cover && !cover.hidden && text) cover.textContent = text;
}

// ── Sources: a manifest list, one URL, a picked or dropped file ─────────────────────────────
async function loadList(listUrl) {
  const r = await fetch(listUrl, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${listUrl}: ${r.status}`);
  const j = await r.json();
  const base = new URL(listUrl, location.href);
  return (Array.isArray(j) ? j : j.assets || []).map((a) => ({
    name: a.name || a.url,
    url: new URL(a.url, base).href,
    size_m: parseSize(a.size_m),
    kit: a.kit,
    licence: a.licence || a.license,
  }));
}

/** size_m: one number (largest extent) or [x, y, z], in metres; anything else is ignored. */
function parseSize(v) {
  if (Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(Number(n)))) return v.map(Number);
  if (v === null || v === '' || Array.isArray(v)) return undefined;
  return Number.isFinite(Number(v)) ? Number(v) : undefined;
}
const sizeText = (v, fmt) => (Array.isArray(v) ? v.map(fmt).join(' × ') : fmt(v));

function renderList(entries) {
  const nav = $('list');
  nav.replaceChildren();
  for (const e of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e.name;
    if (e.size_m !== undefined || e.kit) {
      const s = document.createElement('small');
      s.textContent = [e.kit, e.size_m !== undefined ? `${sizeText(e.size_m, (n) => String(+n.toFixed(1)))} m` : ''].filter(Boolean).join(' · ');
      b.append(s);
    }
    b.addEventListener('click', () => pick(b, e));
    nav.append(b);
  }
  return nav.querySelector('button');
}

function pick(button, entry) {
  for (const b of $('list').querySelectorAll('button')) b.setAttribute('aria-current', String(b === button));
  show(entry);
}

$('file').addEventListener('change', (ev) => {
  const f = ev.target.files?.[0];
  if (f) pick(null, { name: f.name.replace(/\.(glb|gltf)$/i, ''), file: f });
});
$('load').addEventListener('click', () => {
  const u = $('url').value.trim();
  if (u) pick(null, { name: u.split(/[?#]/)[0].split('/').pop().replace(/\.(glb|gltf)$/i, ''), url: new URL(u, location.href).href });
});
const stage = $('stage');
stage.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  stage.classList.add('drop');
});
stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
stage.addEventListener('drop', (ev) => {
  ev.preventDefault();
  stage.classList.remove('drop');
  const f = ev.dataTransfer?.files?.[0];
  if (f) pick(null, { name: f.name.replace(/\.(glb|gltf)$/i, ''), file: f });
});

// ── Boot: first content + first woven frame, then cut the cover (rule 5) ────────────────────
let first;
try {
  if (params.get('list')) {
    const entries = await loadList(params.get('list'));
    const btn = renderList(entries);
    if (btn) {
      btn.setAttribute('aria-current', 'true');
      first = show(entries[0]);
    }
  }
} catch (err) {
  status(`Could not read the list: ${err.message}`, true);
}
if (!first) {
  const u = params.get('glb') || DEFAULT_GLB;
  first = show({ name: u.split(/[?#]/)[0].split('/').pop().replace(/\.(glb|gltf)$/i, ''), url: new URL(u, location.href).href });
}
await Promise.all([first, h.firstWoven]);
cover.hidden = true; // cut, never fade
