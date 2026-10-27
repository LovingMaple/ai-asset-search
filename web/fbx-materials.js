// catalog 의 머티리얼 슬롯(유니티 .mat 에서 뽑은 텍스처/색)을 FBX 메시에 입힌다.
// 썸네일 렌더러(tools/render.html)와 웹 3D 뷰어가 같이 쓴다.
import * as THREE from 'three';

const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

// FBX 안에 박힌 외부 텍스처 경로는 없는 파일이므로 빈 이미지로 돌린다
export function makeManager() {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => (url.startsWith('data:') || url.startsWith('blob:') || /\.fbx$/i.test(url)) ? url : BLANK);
  return manager;
}

const texLoader = new THREE.TextureLoader();
const texCache = new Map();

function loadTex(path) {
  if (!texCache.has(path)) {
    texCache.set(path, texLoader.loadAsync('/' + path).then(t => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return t;
    }).catch(() => null));
  }
  return texCache.get(path);
}

async function makeMaterial(orig, slot, hasVColor) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide });
  const tex = slot && slot.tex ? await loadTex(slot.tex) : null;
  if (tex) {
    m.map = tex;
  } else if (slot && slot.color) {
    m.color.setRGB(...slot.color, THREE.SRGBColorSpace);
  } else if (orig && orig.color) {
    m.color.copy(orig.color);
  }
  if (!tex && hasVColor) m.vertexColors = true;
  if (orig && orig.transparent && orig.opacity < 1) { m.transparent = true; m.opacity = orig.opacity; }
  m.name = orig ? orig.name : '';
  return m;
}

// 머티리얼을 교체하고 메시 통계를 돌려준다
export async function applyMaterials(obj, entry) {
  const stats = { meshes: 0, triangles: 0, skinned: false, bones: 0, animations: (obj.animations || []).length, materialNames: [] };
  const jobs = [];
  let slotIdx = 0;
  const seen = new Map();
  obj.traverse(o => {
    if (o.isBone) stats.bones++;
    if (!o.isMesh) return;
    stats.meshes++;
    if (o.isSkinnedMesh) stats.skinned = true;
    const g = o.geometry;
    stats.triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const hasV = !!g.attributes.color;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map(mt => {
      const key = mt ? mt.name || mt.uuid : 'none';
      if (!seen.has(key)) {
        const slot = (mt && entry.materials.byName[mt.name]) || entry.materials.ordered[slotIdx] || entry.materials.ordered[0] || null;
        slotIdx++;
        if (mt && mt.name) stats.materialNames.push(mt.name);
        seen.set(key, makeMaterial(mt, slot, hasV));
      }
      return seen.get(key);
    });
    jobs.push(Promise.all(out).then(ms => { o.material = Array.isArray(o.material) ? ms : ms[0]; o.frustumCulled = false; }));
  });
  await Promise.all(jobs);
  stats.triangles = Math.round(stats.triangles);
  return stats;
}
