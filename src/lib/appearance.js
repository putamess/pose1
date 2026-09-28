// Rendering styles for the three export/view modes:
//   normal     — PBR materials from the glTF, ground + shadows
//   line       — shader line-art: flat paper-white lambert + inverted-hull
//                outline (BackSide, geometry baked with a normal offset) +
//                crease edges from EdgesGeometry
//   silhouette  — scene.overrideMaterial (solid black) on a white background
//
// The outline hull is an inverted-hull clone whose geometry is EXPANDED ALONG
// ITS NORMALS ONCE (baked) and whose material is a plain BackSide
// MeshBasicMaterial — built-in materials skin automatically, so the same
// recipe works for static meshes and SkinnedMeshes alike.

import * as THREE from 'three';

export const VIEW_MODES = [
  { id: 'normal', label: '노멀' },
  { id: 'line', label: '선화' },
  { id: 'silhouette', label: '실루엣' },
];

const OUTLINE_THICKNESS = 0.009;

export function makeAppearanceAssets() {
  const outlineMat = new THREE.MeshBasicMaterial({
    color: '#141414',
    side: THREE.BackSide,
    toneMapped: false,
    depthWrite: true,
  });

  const edgeMat = new THREE.LineBasicMaterial({ color: '#1c1c1c', toneMapped: false });

  const paperMat = new THREE.MeshLambertMaterial({ color: '#fdfbf6', toneMapped: false });

  const silhouetteMat = new THREE.MeshBasicMaterial({ color: '#101010', toneMapped: false });

  return { outlineMat, edgeMat, paperMat, silhouetteMat, outlineThickness: OUTLINE_THICKNESS };
}

// Clone the geometry and push every vertex along its normal (bind space for
// skinned meshes — the offset travels with the skinning).
function bakeHullGeometry(src, t) {
  const geo = src.clone();
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + nor.getX(i) * t,
      pos.getY(i) + nor.getY(i) * t,
      pos.getZ(i) + nor.getZ(i) * t,
    );
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
  return geo;
}

export function applyAppearance(root, mode, assets) {
  root.traverse((o) => {
    if (o.userData.isLineArt) return; // don't recurse into our own helpers
    if (!o.isMesh) return;
    if (!o.userData.origMaterial) o.userData.origMaterial = o.material;

    if (!o.userData.hull) {
      const geo = bakeHullGeometry(o.geometry, assets.outlineThickness || OUTLINE_THICKNESS);
      let hull;
      if (o.isSkinnedMesh) {
        hull = new THREE.SkinnedMesh(geo, assets.outlineMat);
        hull.bind(o.skeleton, o.bindMatrix);
        hull.frustumCulled = false; // baked bounds + skinning: don't cull
      } else {
        hull = new THREE.Mesh(geo, assets.outlineMat);
      }
      hull.userData.isLineArt = true;
      hull.raycast = () => {};
      hull.castShadow = false;
      hull.receiveShadow = false;
      hull.visible = false;
      o.add(hull);
      o.userData.hull = hull;

      // Crease edges can't follow skinning — static meshes only.
      if (!o.isSkinnedMesh) {
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(o.geometry, 30),
          assets.edgeMat,
        );
        edges.userData.isLineArt = true;
        edges.raycast = () => {};
        edges.visible = false;
        o.add(edges);
        o.userData.edges = edges;
      }
    }

    const lineMode = mode === 'line';
    o.userData.hull.visible = lineMode;
    if (o.userData.edges) o.userData.edges.visible = lineMode;
    o.material = lineMode ? assets.paperMat : o.userData.origMaterial;
  });
}
