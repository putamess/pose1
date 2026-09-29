// Browser regression test for REAL foreign rigs (?model=/female.glb).
//
// female.glb is a Mixamo export: Z-up armature, 0.0085 world scale (joint
// local units are centimetres) and large non-identity bind rotations. It used
// to sink a metre into the floor on every preset and reject almost every pose.
// This drives the actual UI (presets + sliders) and asserts the character
// stays on the ground and actually poses.
import fs from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || undefined,
  args: ['--no-sandbox', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.goto('http://localhost:5173/?model=/female.glb', { waitUntil: 'networkidle' });
await page.waitForTimeout(7000);

// pose-aware world bounds of every skinned mesh in the character
await page.evaluate(() => {
  // Only the character's own skinned meshes: the gizmo and grid helpers are
  // plain meshes whose extents dwarf the figure and would swamp the box.
  window.__BOUNDS__ = () => {
    const THREE = window.__POSE__.THREE;
    const root = window.__SCENE__.children.find((c) => c.userData && c.userData.charId);
    const b = new THREE.Box3();
    (root || window.__SCENE__).traverse((o) => {
      if (o.isSkinnedMesh) {
        o.computeBoundingBox();
        b.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld));
      }
    });
    return { minY: b.min.y, maxY: b.max.y };
  };
});

const state = await page.evaluate(() => {
  const chips = document.querySelectorAll('.chip').length;
  const presets = [...document.querySelectorAll('.preset')];
  let skinned = 0;
  window.__SCENE__.traverse((o) => { if (o.isSkinnedMesh) skinned++; });
  return {
    chips,
    presets: presets.length,
    presetsEnabled: presets.filter((b) => !b.disabled).length,
    skinned,
    hasHips: !!window.__SCENE__.getObjectByName('Hips'),
    grounded: window.__BOUNDS__(),
  };
});
console.log('state:', JSON.stringify(state));

const grab = async (name) => {
  const b64 = await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const { gl } = window.__POSE__;
    gl.render(window.__SCENE__, window.__POSE__.camera);
    return gl.domElement.toDataURL('image/png').split(',')[1];
  });
  fs.writeFileSync(name, Buffer.from(b64, 'base64'));
};
await grab('foreign_stand.png');

// ---- every preset must leave the character standing on the floor ----------
const presetNames = await page.evaluate(() =>
  [...document.querySelectorAll('.preset')].map((b) => b.textContent.trim()));
const perPreset = [];
for (const name of presetNames) {
  const r = await page.evaluate(async (n) => {
    const b = [...document.querySelectorAll('.preset')].find((x) => x.textContent.trim() === n);
    if (!b) return null;
    b.click();
    await new Promise((r) => setTimeout(r, 450));
    return window.__BOUNDS__();
  }, name);
  perPreset.push({ name, ...r });
}
console.log('presets:', JSON.stringify(perPreset));
await grab('foreign_preset_last.png');

// back to standing, then pose by slider — the mesh must actually deform
await page.evaluate(async () => {
  const b = [...document.querySelectorAll('.preset')].find((x) => x.textContent.trim().includes('서기'));
  b && b.click();
  await new Promise((r) => setTimeout(r, 500));
});

const before = await page.evaluate(() => {
  const THREE = window.__POSE__.THREE;
  const chip = [...document.querySelectorAll('.chip')].find((c) => c.textContent === 'UpperArmL');
  if (!chip) return null;
  chip.click();
  return null;
});
await page.waitForTimeout(400);
const handBefore = await page.evaluate(() => {
  const THREE = window.__POSE__.THREE;
  return window.__SCENE__.getObjectByName('HandL').getWorldPosition(new THREE.Vector3()).toArray();
});
// Z slider of the selected joint — raised through Playwright so React's
// controlled-input plumbing actually runs.
const sliders = page.locator('.slider-row input[type=range]');
await sliders.nth(2).fill('-45');
await page.waitForTimeout(600);
const deform = await page.evaluate((hb) => {
  const THREE = window.__POSE__.THREE;
  const after = window.__SCENE__.getObjectByName('HandL').getWorldPosition(new THREE.Vector3()).toArray();
  const moved = Math.hypot(...after.map((v, i) => v - hb[i]));
  return { ok: moved > 0.1, moved: +moved.toFixed(3), after: window.__BOUNDS__() };
}, handBefore);
console.log('deform:', JSON.stringify(deform));
await grab('foreign_posed.png');

const worstSink = Math.min(...perPreset.map((p) => p.minY), deform.after.minY);
const R = {
  rigLoaded: state.hasHips && state.skinned >= 1,
  presetsEnabled: state.presets > 0 && state.presetsEnabled === state.presets,
  groundedOnLoad: state.grounded.minY > -0.06 && state.grounded.minY < 0.25,
  staysAboveFloor: worstSink > -0.08,
  canPose: deform.ok,
  noSinkWhilePosing: deform.after.minY > -0.08,
};
console.log(JSON.stringify(R, null, 2));
console.log('worst minY across presets + posing:', worstSink.toFixed(3));
console.log('js errors:', errors.length ? errors.join(' | ') : 'NONE');
const ok = Object.values(R).every(Boolean) && errors.length === 0;
await browser.close();
process.exit(ok ? 0 : 1);
