// 3D card previews supplied by dots (scope preview:write). The model is outside data:
// only the Gallery's own .sbox package is accepted, decoded and rebuilt here from a
// whitelist, so nothing the Gallery would not draw (scripts, shaders, external URLs,
// extras) reaches visitors. The poster is either the upload's own cover (the one
// chosen at submission or by cover:write) or a separate preview-<stamp>.webp sent
// through the same endpoint.
//
// Storage keeps every version: preview-<stamp>.sbox (or .webp poster) and a matching
// manifest preview-<stamp>.json next to the active media/<id>/preview.json that
// work-previews.mjs reads. History lives in cover_history (actions preview-*), so
// admins roll back the same way as covers. A preview.json not written here (baked
// by the operators' pipeline) is never replaced.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { transaction } from './db.mjs';
import { HttpError, fail } from './http.mjs';
import { COVER_LIMITS, sniffImage } from './work-covers.mjs';
import { mirrorPublicMedia } from './cos-dual-write.mjs';

export const PREVIEW_LIMITS = {
  bytes: 2 * 1024 * 1024, // compressed upload
  inflated: 24 * 1024 * 1024, // after gunzip
  header: 1024 * 1024,
  geometries: 4096, meshes: 8192, materials: 1024, textures: 64, images: 32, imageBytes: 1024 * 1024,
  instances: 1_000_000, groups: 4096,
};
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const ARRAY_TYPES = { Float32Array: 4, Float64Array: 8, Uint8Array: 1, Uint8ClampedArray: 1, Uint16Array: 2, Uint32Array: 4, Int8Array: 1, Int16Array: 2, Int32Array: 4 };
const MATERIAL_TYPES = new Set(['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshBasicMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial',
  'MeshToonMaterial', 'MeshMatcapMaterial', 'MeshNormalMaterial']);
// Plain values three's MaterialLoader understands; anything else (userData, shaders,
// defines, uniforms, onBeforeCompile, extensions) is dropped.
const MATERIAL_NUMBERS = ['roughness', 'metalness', 'sheen', 'sheenRoughness', 'emissiveIntensity', 'shininess', 'opacity', 'side', 'alphaTest',
  'reflectivity', 'refractionRatio', 'envMapIntensity', 'clearcoat', 'clearcoatRoughness', 'transmission', 'ior', 'thickness', 'attenuationDistance',
  'specularIntensity', 'iridescence', 'anisotropy', 'aoMapIntensity', 'lightMapIntensity', 'bumpScale', 'displacementScale', 'displacementBias',
  'blending', 'depthFunc', 'polygonOffsetFactor', 'polygonOffsetUnits', 'shadowSide', 'combine', 'rotation'];
const MATERIAL_BOOLEANS = ['transparent', 'vertexColors', 'flatShading', 'depthTest', 'depthWrite', 'colorWrite', 'wireframe', 'toneMapped', 'fog',
  'dithering', 'premultipliedAlpha', 'alphaToCoverage', 'polygonOffset', 'visible', 'forceSinglePass'];
const MATERIAL_COLORS = ['color', 'emissive', 'specular', 'sheenColor', 'attenuationColor', 'specularColor'];
const MATERIAL_MAPS = ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'aoMap', 'bumpMap', 'lightMap', 'specularMap', 'matcap'];
const TEXTURE_NUMBERS = ['mapping', 'channel', 'rotation', 'format', 'internalFormat', 'type', 'minFilter', 'magFilter', 'anisotropy'];
const TEXTURE_BOOLEANS = ['flipY', 'generateMipmaps', 'premultiplyAlpha'];
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const UUID = /^[A-Za-z0-9-]{1,64}$/;

const bad = (message) => fail(422, `预览模型无效：${message}`, 'invalid_model');

// A separate poster upload is always WebP, matching the existing preview.webp file.
export function checkPreviewPoster(buffer) {
  if (!buffer.length) fail(400, '预览海报内容为空', 'invalid_image');
  if (buffer.length > PREVIEW_LIMITS.bytes) fail(413, '预览海报不能超过 2 MB', 'too_large');
  const image = sniffImage(buffer);
  if (!image || image.mime !== 'image/webp') fail(415, '预览海报只接受 WebP（按文件内容判断）', 'unsupported_type');
  const { minSide, maxSide, maxPixels } = COVER_LIMITS;
  if (image.width < minSide || image.height < minSide || image.width > maxSide || image.height > maxSide || image.width * image.height > maxPixels) {
    fail(422, `预览海报尺寸须在 ${minSide}–${maxSide} 像素之间`, 'bad_dimensions');
  }
  return image;
}
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const int = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
function numbers(value, length, label) {
  if (!Array.isArray(value) || value.length !== length || !value.every(finite)) bad(`${label} 必须是 ${length} 个有限数字`);
  return value.map(Number);
}

// Decodes, checks and re-encodes a .sbox package. Returns the sanitized gzip bytes.
export function sanitizeSbox(upload) {
  if (!Buffer.isBuffer(upload) || upload.length < 18) bad('内容为空');
  if (upload.length > PREVIEW_LIMITS.bytes) fail(413, '预览模型不能超过 2 MB', 'too_large');
  if (upload[0] !== 0x1f || upload[1] !== 0x8b || upload[2] !== 0x08) fail(415, '只接受 gzip 压缩的 .sbox 预览包', 'unsupported_type');
  let raw;
  try { raw = gunzipSync(upload, { maxOutputLength: PREVIEW_LIMITS.inflated }); }
  catch (error) { if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /larger than/.test(error?.message)) fail(413, '预览模型解压后太大', 'too_large'); bad('gzip 解压失败'); }
  if (raw.length < 6) bad('包太短');
  const headerSize = raw.readUInt32LE(0);
  if (!headerSize || headerSize > PREVIEW_LIMITS.header || 4 + headerSize > raw.length) bad('头部长度不对');
  let data;
  try { data = JSON.parse(raw.subarray(4, 4 + headerSize).toString('utf8')); } catch { bad('头部不是 JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) bad('头部不是对象');
  if (data.version !== 1 && data.version !== 2) bad('只支持 version 1 或 2');
  const bodyStart = data.version >= 2 ? Math.ceil((4 + headerSize) / 8) * 8 : 4 + headerSize;
  if (bodyStart > raw.length) bad('数据区缺失');
  const body = raw.subarray(bodyStart);

  const array = (spec, label, { expect } = {}) => {
    if (!spec || typeof spec !== 'object') bad(`${label} 缺失`);
    const size = ARRAY_TYPES[spec.type];
    if (!size) bad(`${label} 类型不在白名单`);
    if (!int(spec.offset, 0, body.length) || !int(spec.length, 0, body.length)) bad(`${label} 偏移或长度无效`);
    if (spec.offset + spec.length * size > body.length) bad(`${label} 超出数据区`);
    if (expect !== undefined && spec.length !== expect) bad(`${label} 长度不对`);
    return { type: spec.type, offset: spec.offset, length: spec.length };
  };
  const attribute = (spec, label) => {
    const out = array(spec, label);
    if (!int(spec.itemSize, 1, 16)) bad(`${label} itemSize 无效`);
    out.itemSize = spec.itemSize;
    if (spec.normalized !== undefined) out.normalized = Boolean(spec.normalized);
    if (spec.instanced) { out.instanced = true; if (spec.meshPerAttribute !== undefined) { if (!int(spec.meshPerAttribute, 1, 1e6)) bad(`${label} meshPerAttribute 无效`); out.meshPerAttribute = spec.meshPerAttribute; } }
    if (spec.quantized !== undefined) out.quantized = { min: numbers(spec.quantized?.min, 3, `${label}.quantized.min`), span: numbers(spec.quantized?.span, 3, `${label}.quantized.span`) };
    return out;
  };

  const list = (value, max, label) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max) bad(`${label} 必须是不超过 ${max} 项的数组`);
    return value;
  };
  const geometries = list(data.geometries, PREVIEW_LIMITS.geometries, 'geometries').map((spec, i) => {
    const label = `geometries[${i}]`;
    if (!spec?.attributes || typeof spec.attributes !== 'object' || Array.isArray(spec.attributes)) bad(`${label}.attributes 缺失`);
    const names = Object.keys(spec.attributes);
    if (!names.length || names.length > 16 || !names.every((name) => NAME.test(name))) bad(`${label} 属性名无效`);
    const out = { attributes: Object.fromEntries(names.map((name) => [name, attribute(spec.attributes[name], `${label}.${name}`)])) };
    if (spec.index !== undefined && spec.index !== null) {
      out.index = attribute(spec.index, `${label}.index`);
      if (!['Uint8Array', 'Uint16Array', 'Uint32Array'].includes(out.index.type) || out.index.itemSize !== 1) bad(`${label}.index 必须是单分量无符号整数数组`);
    }
    out.groups = list(spec.groups, PREVIEW_LIMITS.groups, `${label}.groups`).map((group) => {
      if (!int(group?.start, 0, 2 ** 31) || !int(group?.count, 0, 2 ** 31) || !(group.materialIndex === undefined || int(group.materialIndex, 0, 1024))) bad(`${label}.groups 无效`);
      return { start: group.start, count: group.count, ...(group.materialIndex !== undefined ? { materialIndex: group.materialIndex } : {}) };
    });
    if (spec.drawRange !== undefined) {
      if (!Array.isArray(spec.drawRange) || !int(spec.drawRange[0], 0, 2 ** 31) || !(spec.drawRange[1] === undefined || spec.drawRange[1] === null || int(spec.drawRange[1], 0, 2 ** 31))) bad(`${label}.drawRange 无效`);
      out.drawRange = spec.drawRange[1] == null ? [spec.drawRange[0]] : [spec.drawRange[0], spec.drawRange[1]];
    }
    if (spec.sphere !== undefined) out.sphere = { center: numbers(spec.sphere?.center, 3, `${label}.sphere.center`), radius: numbers([spec.sphere?.radius], 1, `${label}.sphere.radius`)[0] };
    return out;
  });

  const images = list(data.images, PREVIEW_LIMITS.images, 'images').map((spec, i) => {
    const label = `images[${i}]`;
    if (!UUID.test(spec?.uuid ?? '')) bad(`${label}.uuid 无效`);
    // Only embedded PNG / JPEG / WebP. No external or blob URLs, no raw pixel arrays.
    const match = typeof spec.url === 'string' ? /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(spec.url) : null;
    if (!match) bad(`${label} 只能是内嵌的 data:image/png|jpeg|webp`);
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > PREVIEW_LIMITS.imageBytes) bad(`${label} 太大`);
    const sniffed = sniffImage(bytes);
    if (!sniffed || sniffed.mime !== `image/${match[1]}`) bad(`${label} 内容与类型不符`);
    if (sniffed.width > 4096 || sniffed.height > 4096) bad(`${label} 尺寸过大`);
    return { uuid: spec.uuid, url: `data:${sniffed.mime};base64,${bytes.toString('base64')}` };
  });
  const imageIds = new Set(images.map((image) => image.uuid));

  const textures = list(data.textures, PREVIEW_LIMITS.textures, 'textures').map((spec, i) => {
    const label = `textures[${i}]`;
    if (!UUID.test(spec?.uuid ?? '') || !imageIds.has(spec.image)) bad(`${label} 引用的图片不存在`);
    const out = { uuid: spec.uuid, image: spec.image };
    for (const key of TEXTURE_NUMBERS) if (spec[key] !== undefined) { if (!finite(spec[key])) bad(`${label}.${key} 无效`); out[key] = spec[key]; }
    for (const key of TEXTURE_BOOLEANS) if (spec[key] !== undefined) out[key] = Boolean(spec[key]);
    for (const key of ['repeat', 'offset', 'center']) if (spec[key] !== undefined) out[key] = numbers(spec[key], 2, `${label}.${key}`);
    if (spec.wrap !== undefined) out.wrap = numbers(spec.wrap, 2, `${label}.wrap`);
    if (spec.colorSpace !== undefined) { if (!['', 'srgb', 'srgb-linear'].includes(spec.colorSpace)) bad(`${label}.colorSpace 无效`); out.colorSpace = spec.colorSpace; }
    return out;
  });
  const textureIds = new Set(textures.map((texture) => texture.uuid));

  const materials = list(data.materials, PREVIEW_LIMITS.materials, 'materials').map((spec, i) => {
    const label = `materials[${i}]`;
    if (!MATERIAL_TYPES.has(spec?.type)) bad(`${label}.type 不在白名单（${[...MATERIAL_TYPES].join('、')}）`);
    const out = { type: spec.type };
    if (spec.uuid !== undefined) { if (!UUID.test(spec.uuid)) bad(`${label}.uuid 无效`); out.uuid = spec.uuid; }
    for (const key of MATERIAL_NUMBERS) if (spec[key] !== undefined) { if (!finite(spec[key])) bad(`${label}.${key} 无效`); out[key] = spec[key]; }
    for (const key of MATERIAL_BOOLEANS) if (spec[key] !== undefined) out[key] = Boolean(spec[key]);
    for (const key of MATERIAL_COLORS) if (spec[key] !== undefined) { if (!int(spec[key], 0, 0xffffff)) bad(`${label}.${key} 无效`); out[key] = spec[key]; }
    for (const key of MATERIAL_MAPS) if (spec[key] !== undefined) { if (!textureIds.has(spec[key])) bad(`${label}.${key} 引用的贴图不存在`); out[key] = spec[key]; }
    for (const key of ['normalScale', 'clearcoatNormalScale']) if (spec[key] !== undefined) out[key] = numbers(spec[key], 2, `${label}.${key}`);
    if (spec.normalMapType !== undefined) { if (!int(spec.normalMapType, 0, 1)) bad(`${label}.normalMapType 无效`); out.normalMapType = spec.normalMapType; }
    return out;
  });
  const meshes = list(data.meshes, PREVIEW_LIMITS.meshes, 'meshes').map((spec, i) => {
    const label = `meshes[${i}]`;
    if (!int(spec?.geometry, 0, geometries.length - 1)) bad(`${label}.geometry 越界`);
    const materialOk = (id) => int(id, 0, materials.length - 1);
    if (!(Array.isArray(spec.material) ? spec.material.length && spec.material.length <= 64 && spec.material.every(materialOk) : materialOk(spec.material))) bad(`${label}.material 越界`);
    // Gallery maps global material IDs to this mesh's local slots. Three ignores
    // geometry groups for a scalar material; shared geometry keeps its groups.
    if (Array.isArray(spec.material)) {
      for (const group of geometries[spec.geometry].groups) {
        if (group.materialIndex !== undefined && group.materialIndex >= spec.material.length) bad(`${label}.groups.materialIndex 越界`);
      }
    }
    const out = { geometry: spec.geometry, material: Array.isArray(spec.material) ? [...spec.material] : spec.material, matrix: numbers(spec.matrix, 16, `${label}.matrix`) };
    if (spec.count !== undefined && spec.count !== null && spec.count !== 0) {
      if (!int(spec.count, 1, PREVIEW_LIMITS.instances)) bad(`${label}.count 无效`);
      out.count = spec.count;
      if (spec.instances !== undefined) { out.instances = array(spec.instances, `${label}.instances`, { expect: spec.count * 16 }); if (out.instances.type !== 'Float32Array') bad(`${label}.instances 必须是 Float32Array`); }
      if (spec.colors !== undefined) { out.colors = array(spec.colors, `${label}.colors`, { expect: spec.count * 3 }); if (out.colors.type !== 'Float32Array') bad(`${label}.colors 必须是 Float32Array`); }
    }
    if (spec.renderOrder !== undefined) { if (!int(spec.renderOrder, -1000, 1000)) bad(`${label}.renderOrder 无效`); out.renderOrder = spec.renderOrder; }
    return out;
  });
  if (!meshes.length) bad('没有任何网格');
  if (!data.bounds) bad('缺少 bounds');
  const bounds = { min: numbers(data.bounds.min, 3, 'bounds.min'), max: numbers(data.bounds.max, 3, 'bounds.max') };
  if (bounds.min.some((value, i) => value > bounds.max[i])) bad('bounds 最小值大于最大值');

  // Rebuild with only whitelisted fields; extras, userData and unknown keys are gone.
  const clean = { version: 2, normalized: Boolean(data.normalized), clip: Boolean(data.clip), bounds, geometries, materials, meshes,
    ...(images.length ? { images } : {}), ...(textures.length ? { textures } : {}) };
  // The data area is rebuilt too: only the byte ranges a spec points at are copied,
  // each 8-aligned, so trailing or unreferenced bytes are dropped.
  const chunks = [], placed = new Map();
  let bodySize = 0;
  const place = (spec) => {
    const bytes = spec.length * ARRAY_TYPES[spec.type];
    const key = `${spec.offset}:${bytes}`;
    if (!placed.has(key)) {
      const at = Math.ceil(bodySize / 8) * 8;
      chunks.push([at, body.subarray(spec.offset, spec.offset + bytes)]);
      placed.set(key, at);
      bodySize = at + bytes;
    }
    spec.offset = placed.get(key);
  };
  for (const geometry of geometries) { Object.values(geometry.attributes).forEach(place); if (geometry.index) place(geometry.index); }
  for (const mesh of meshes) { if (mesh.instances) place(mesh.instances); if (mesh.colors) place(mesh.colors); }
  const compact = Buffer.alloc(bodySize);
  for (const [at, bytes] of chunks) bytes.copy(compact, at);
  const header = Buffer.from(JSON.stringify(clean), 'utf8');
  if (header.length > PREVIEW_LIMITS.header) bad('头部太大');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(header.length, 0);
  const start = Math.ceil((4 + header.length) / 8) * 8;
  const packed = Buffer.concat([prefix, header, Buffer.alloc(start - 4 - header.length), compact]);
  const output = gzipSync(packed, { level: 9 });
  if (output.length > PREVIEW_LIMITS.bytes) fail(413, '预览模型清理后仍超过 2 MB', 'too_large');
  return { buffer: output, stats: { geometries: geometries.length, meshes: meshes.length, materials: materials.length, textures: textures.length, images: images.length,
    inflated: packed.length, droppedBytes: body.length - bodySize, dropped: Object.keys(data).filter((key) => !['version', 'normalized', 'clip', 'bounds', 'geometries', 'materials', 'meshes', 'images', 'textures'].includes(key)) } };
}

// Static WebGPU signals in the stored work files (entry page and scripts, bounded).
const WEBGPU = [
  ['navigator.gpu', /navigator\s*\.\s*gpu\b/],
  ['WebGPURenderer', /\bWebGPURenderer\b/],
  ['three/webgpu', /three\/webgpu|three\.webgpu(?:\.nodes)?(?:\.min)?\.js/],
  ["getContext('webgpu')", /getContext\(\s*['"]webgpu['"]/],
  ['requestAdapter', /\.requestAdapter\s*\(/],
];
const webgpuCache = new Map();
export function webgpuSignals(work) {
  const key = `${work.id}:${work.digest ?? ''}`;
  if (webgpuCache.has(key)) return webgpuCache.get(key);
  const found = new Set();
  let budget = 8 * 1024 * 1024;
  let files = [];
  try { files = readdirSync(work.dir, { recursive: true }).map(String).filter((name) => /\.(?:html?|m?js)$/i.test(name)).sort(); } catch { /* none */ }
  if (work.entry) files = [work.entry, ...files.filter((name) => name !== work.entry)];
  for (const name of files.slice(0, 400)) {
    if (budget <= 0 || found.size === WEBGPU.length) break;
    try {
      const file = resolve(work.dir, name);
      if (relative(resolve(work.dir), file).startsWith('..')) continue;
      const size = statSync(file).size;
      const text = readFileSync(file).subarray(0, Math.min(size, budget, 2 * 1024 * 1024)).toString('utf8');
      budget -= text.length;
      for (const [label, pattern] of WEBGPU) if (pattern.test(text)) found.add(label);
    } catch { /* unreadable file */ }
  }
  const result = WEBGPU.map(([label]) => label).filter((label) => found.has(label));
  webgpuCache.set(key, result);
  if (webgpuCache.size > 4096) webgpuCache.delete(webgpuCache.keys().next().value);
  return result;
}

const STAMPED = /^preview-[a-z0-9]{8,24}\.json$/;
const STAMPED_MODEL = /^preview-[a-z0-9]{8,24}\.sbox$/;
const STAMPED_POSTER = /^preview-[a-z0-9]{8,24}\.webp$/;
// Submission covers are cover.<ext>; cover:write and admin rollback use cover-<stamp>.<ext>.
const COVER = /^cover(?:-[a-z0-9]{8,24})?\.(?:png|jpg|webp)$/;
export const PREVIEW_MODEL_FILE = /^preview(?:-[a-z0-9]{8,24})?\.sbox$/;
export const PREVIEW_POSTER_FILE = /^preview(?:-[a-z0-9]{8,24})?\.webp$/;

export function createPreviewStore({ db, library }) {
  const q = {
    history: db.prepare(`INSERT INTO cover_history (at, work_id, task_id, action, previous, next, snapshot, actor_id, actor_name, detail)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`),
    list: db.prepare("SELECT * FROM cover_history WHERE work_id = ? AND action LIKE 'preview-%' ORDER BY id DESC LIMIT 100"),
    entry: db.prepare("SELECT * FROM cover_history WHERE id = ? AND work_id = ? AND action LIKE 'preview-%'"),
    audit: db.prepare('INSERT INTO audit (at, actor_id, actor_name, action, task_id, work_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    // Any write to the works row moves the catalog revision, so cached bootstrap/catalog rebuild.
    touch: db.prepare('UPDATE works SET updated_at = updated_at WHERE id = ?'),
  };
  const dirOf = (work) => join(library.mediaDir, work.id);
  const active = (work) => join(dirOf(work), 'preview.json');

  // What preview.json holds now: null, a manifest written here (with its version file), or a foreign one.
  function current(work) {
    let text;
    try { text = readFileSync(active(work), 'utf8'); } catch { return { kind: 'none', version: null }; }
    try {
      const manifest = JSON.parse(text);
      if (manifest?.source === 'dots' && STAMPED.test(manifest.version ?? '')) return { kind: 'dots', version: manifest.version, manifest };
    } catch { /* foreign or broken */ }
    return { kind: 'foreign', version: null };
  }

  function activate(work, version) {
    const target = active(work);
    if (version === null) { rmSync(target, { force: true }); return; }
    const pending = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(pending, readFileSync(join(dirOf(work), version)));
    renameSync(pending, target);
  }

  function record(work, action, from, to, actor, detail) {
    return transaction(db, () => {
      const at = Date.now();
      const id = Number(q.history.run(at, work.id, work.taskId, action, from, to, actor.id, actor.name, JSON.stringify(detail)).lastInsertRowid);
      q.audit.run(at, actor.id, actor.name, action, work.taskId, work.id, JSON.stringify({ historyId: id, previous: from, next: to, ...detail }));
      q.touch.run(work.id);
      return id;
    });
  }

  // Prefer a poster previously uploaded for a dots preview, then the work's own cover.
  function posterFor(work, now) {
    const custom = now.kind === 'dots' ? now.manifest.poster : '';
    if (STAMPED_POSTER.test(custom ?? '') && existsSync(join(dirOf(work), custom))) return custom;
    const cover = work.cover ?? '';
    if (COVER.test(cover) && existsSync(join(dirOf(work), cover))) return cover;
    return null;
  }

  // Writes a new manifest beside the versioned media, switches preview.json, then records it.
  function publish(work, now, files, manifest, actor, detail) {
    const names = [...files.map(([name]) => name), manifest.version];
    mkdirSync(dirOf(work), { recursive: true });
    for (const [name, buffer] of files) writeFileSync(join(dirOf(work), name), buffer);
    writeFileSync(join(dirOf(work), manifest.version), `${JSON.stringify(manifest)}\n`);
    // Re-check right before switching: synchronous from here on, so nothing interleaves.
    const again = current(work);
    if (again.kind !== now.kind || again.version !== now.version) {
      for (const name of names) rmSync(join(dirOf(work), name), { force: true });
      throw new HttpError(409, '预览刚刚被修改，请重新上传', 'conflict');
    }
    activate(work, manifest.version);
    let historyId;
    try {
      historyId = record(work, 'preview-replace', now.version, manifest.version, actor, detail);
    } catch (error) {
      activate(work, now.version);
      throw error;
    }
    // Versioned .sbox / .webp only. preview.json is the local activation copy and is not a public object.
    for (const [name, buffer] of files) mirrorPublicMedia({ workId: work.id, name, body: buffer });
    return historyId;
  }

  return {
    current,
    // model: sanitized .sbox bytes. The poster is a dots poster or the work's own cover.
    replace(work, model, actor, detail = {}) {
      if (!work || work.curated) fail(404, '作品不存在', 'not_found');
      const now = current(work);
      if (now.kind === 'foreign') fail(409, '这件作品已有人工制作的预览，不能覆盖', 'preview_exists');
      const poster = posterFor(work, now);
      if (!poster) fail(409, '作品还没有可用的封面：请先通过 cover:write 上传封面，再上传 .sbox 模型，之后可选上传 preview.webp 海报', 'poster_required');
      const entry = resolve(work.dir, work.entry ?? '');
      if (!work.entry || !entry.startsWith(`${resolve(work.dir)}${sep}`)) fail(409, '作品入口文件缺失', 'entry_missing');
      let sourceDigest;
      try { sourceDigest = sha256(readFileSync(entry)); } catch { fail(409, '作品入口文件缺失', 'entry_missing'); }
      const stamp = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
      const modelName = `preview-${stamp}.sbox`, manifestName = `preview-${stamp}.json`;
      const manifest = { schemaVersion: 1, source: 'dots', version: manifestName, sourceDigest, mode: 'model',
        model: modelName, modelSha: sha256(model), poster, posterSha: sha256(readFileSync(join(dirOf(work), poster))) };
      const historyId = publish(work, now, [[modelName, model]], manifest, actor, { ...detail, bytes: model.length, poster });
      return { historyId, previewModel: `media/${work.id}/${modelName}`, previewPoster: `media/${work.id}/${poster}`, previous: now.version };
    },
    // A separate preview.webp poster, without changing the work's cover.
    replacePoster(work, poster, image, actor, detail = {}) {
      if (!work || work.curated) fail(404, '作品不存在', 'not_found');
      const now = current(work);
      if (now.kind === 'foreign') fail(409, '这件作品已有人工制作的预览，不能覆盖', 'preview_exists');
      if (now.kind !== 'dots') fail(409, '请先上传 .sbox 模型，再上传 preview.webp 海报', 'preview_required');
      const model = now.manifest.model ?? '';
      let modelBytes;
      try { modelBytes = readFileSync(join(dirOf(work), model)); } catch { modelBytes = null; }
      if (!STAMPED_MODEL.test(model) || !modelBytes || sha256(modelBytes) !== now.manifest.modelSha) {
        fail(409, '当前预览模型文件缺失或已改变，请重新上传模型', 'missing_file');
      }
      const stamp = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
      const posterName = `preview-${stamp}.webp`, manifestName = `preview-${stamp}.json`;
      const manifest = { ...now.manifest, version: manifestName, poster: posterName, posterSha: sha256(poster) };
      const historyId = publish(work, now, [[posterName, poster]], manifest, actor,
        { ...detail, bytes: poster.length, poster: posterName, width: image.width, height: image.height });
      return { historyId, previewModel: `media/${work.id}/${model}`, previewPoster: `media/${work.id}/${posterName}`, previous: now.version };
    },
    history(work) {
      return q.list.all(work.id).map((row) => ({ id: row.id, at: new Date(row.at).toISOString(), action: row.action, previous: row.previous,
        next: row.next, actor: row.actor_name, detail: JSON.parse(row.detail) }));
    },
    // Back to the manifest before history entry `id` (default: undo the latest change).
    rollback(work, id, actor) {
      if (!work || work.curated) fail(404, '作品不存在', 'not_found');
      const entry = id == null ? q.list.all(work.id)[0] : q.entry.get(Number(id), work.id);
      if (!entry) fail(404, '没有可回滚的预览记录', 'not_found');
      const now = current(work);
      if (now.kind === 'foreign') fail(409, '当前预览不是 dots 上传的，不能回滚覆盖', 'preview_exists');
      const target = entry.previous;
      if (target && (!STAMPED.test(target) || !existsSync(join(dirOf(work), target)))) fail(409, '旧预览文件已不存在', 'missing_file');
      activate(work, target);
      const historyId = record(work, 'preview-rollback', now.version, target, actor, { source: 'rollback', to: entry.id });
      return { historyId, preview: target };
    },
  };
}
