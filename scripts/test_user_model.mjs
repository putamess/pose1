// Verifies a rig-less uploaded GLB (?model= URL) now gets AUTO-RIGGED with
// the default mannequin skeleton: chips present, presets enabled, no notice,
// view modes + PNG still work.
import fs from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.goto('http://localhost:5173/?model=/mannequin_user.glb', { waitUntil: 'networkidle' });
await page.waitForTimeout(6500);

const state = await page.evaluate(() => {
  const notice = [...document.querySelectorAll('.notice')].map((n) => n.textContent.slice(0, 60));
  const chips = document.querySelectorAll('.chip').length;
  const presets = [...document.querySelectorAll('.preset')];
  const scene = window.__SCENE__;
  let skinned = 0, meshCount = 0;
  if (scene) {
    scene.traverse((o) => {
      if (o.isMesh && !o.userData.isLineArt) meshCount++;
      if (o.isSkinnedMesh) skinned++;
    });
  }
  return {
    notice,
    chips,
    presets: presets.length,
    presetsEnabled: presets.filter((b) => !b.disabled).length,
    meshCount,
    skinned,
    hasHips: !!(scene && scene.getObjectByName('Hips')),
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
await grab('usermodel_normal.png');

// view modes
for (const [label, file] of [['선화', 'usermodel_line.png'], ['실루엣', 'usermodel_sil.png'], ['노멀', 'usermodel_back_normal.png']]) {
  await page.evaluate((l) => {
    const b = [...document.querySelectorAll('.seg button')].find((x) => x.textContent === l);
    b && b.click();
  }, label);
  await page.waitForTimeout(900);
  await grab(file);
}

// pose test: select ForearmL chip, bend it via slider, hand must move
const deform = await page.evaluate(async () => {
  const THREE = window.__POSE__.THREE;
  const chip = [...document.querySelectorAll('.chip')].find((c) => c.textContent === 'ForearmL');
  if (!chip) return { ok: false, why: 'no chip' };
  chip.click();
  await new Promise((r) => setTimeout(r, 300));
  const hand = window.__SCENE__.getObjectByName('HandL');
  if (!hand) return { ok: false, why: 'no HandL' };
  const before = hand.getWorldPosition(new THREE.Vector3()).toArray();
  const row = document.querySelectorAll('.slider-row input[type=range]')[1]; // Y = elbow bend
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(row, '-60');
  row.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const after = hand.getWorldPosition(new THREE.Vector3()).toArray();
  const moved = Math.hypot(...after.map((v, i) => v - before[i]));
  return { ok: moved > 0.05, moved: +moved.toFixed(3) };
});
console.log('deform:', JSON.stringify(deform));

const R = {
  autoRigged: state.skinned >= 1 && state.hasHips,
  chipsPresent: state.chips >= 17,
  presetsEnabled: state.presets > 0 && state.presetsEnabled === state.presets,
  noNotice: state.notice.length === 0,
  deformOk: deform.ok,
};
console.log(JSON.stringify(R, null, 2));
console.log('js errors:', errors.length ? errors.join(' | ') : 'NONE');
const ok = Object.values(R).every(Boolean) && errors.length === 0;
await browser.close();
process.exit(ok ? 0 : 1);
