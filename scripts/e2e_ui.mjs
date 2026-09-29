import { chromium } from 'playwright';

// End-to-end interaction test: FK gizmo, IK drag, view modes, screenshots.
const browser = await chromium.launch({
  // CHROMIUM_BIN: optional path to a system/extracted Chromium when the
  // Playwright browser download is unavailable (restricted networks).
  executablePath: process.env.CHROMIUM_BIN || undefined,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('CONSOLE: ' + m.text());
});

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

const results = {};

// ---- 1. FK gizmo: select ForearmL via chip, expect TransformControls gizmo
await page.$$eval('.chip', (els) => {
  const c = els.find((e) => e.textContent === 'ForearmL');
  c && c.click();
});
await page.waitForTimeout(600);
results.gizmoVisible = await page.evaluate(() => {
  const scene = window.__SCENE__;
  let found = false;
  scene.traverse((o) => {
    // three-stdlib TransformControls: look for its gizmo helpers
    if (o.type === 'TransformControlsGizmo' || (o.name && o.name.includes('TransformControls'))) found = true;
  });
  return found;
});
await page.screenshot({ path: 'e2e_gizmo.png' });

// rotate via gizmo drag: find screen position of the selected joint
const jointScreen = await page.evaluate(() => {
  const scene = window.__SCENE__;
  const gl = window.__POSE__.gl;
  const camera = window.__POSE__.camera;
  const obj = scene.getObjectByName('ForearmL');
  const wp = obj.getWorldPosition(new (obj.position.constructor)());
  const v = wp.clone().project(camera);
  const rect = gl.domElement.getBoundingClientRect();
  return {
    x: rect.x + ((v.x + 1) / 2) * rect.width,
    y: rect.y + ((1 - v.y) / 2) * rect.height,
  };
});
// drag the red gizmo ring (offset from joint center to catch an axis handle)
const beforeRot = await page.evaluate(() => {
  const gl = window.__POSE__.gl;
  const scene = window.__SCENE__;
  const obj = scene.getObjectByName('ForearmL');
  const q = obj.quaternion.toArray();
  gl.render(scene, window.__POSE__.camera);
  return q;
});
await page.mouse.move(jointScreen.x + 46, jointScreen.y);
await page.mouse.down();
await page.mouse.move(jointScreen.x + 46, jointScreen.y + 60, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(400);
const afterRot = await page.evaluate(() => {
  const gl = window.__POSE__.gl;
  const scene = window.__SCENE__;
  const obj = scene.getObjectByName('ForearmL');
  const q = obj.quaternion.toArray();
  gl.render(scene, window.__POSE__.camera);
  return q;
});
results.gizmoRotated = beforeRot.some((v, i) => Math.abs(v - afterRot[i]) > 1e-4);
await page.screenshot({ path: 'e2e_gizmo_after.png' });

// ---- 2. IK drag: find LEFT hand screen position, drag it toward the head
const handScreen = await page.evaluate(() => {
  const scene = window.__SCENE__;
  const gl = window.__POSE__.gl;
  const camera = window.__POSE__.camera;
  const obj = scene.getObjectByName('HandL');
  const wp = obj.getWorldPosition(new (obj.position.constructor)());
  const v = wp.clone().project(camera);
  const rect = gl.domElement.getBoundingClientRect();
  return {
    x: rect.x + ((v.x + 1) / 2) * rect.width,
    y: rect.y + ((1 - v.y) / 2) * rect.height,
  };
});
const wristBefore = await page.evaluate(() => {
  const scene = window.__SCENE__;
  const obj = scene.getObjectByName('HandL');
  return obj.getWorldPosition(new (obj.position.constructor)()).toArray();
});
await page.mouse.move(handScreen.x, handScreen.y);
await page.mouse.down();
// drag toward the head (screen up-left-ish: head is near canvas center-top)
const headScreen = await page.evaluate(() => {
  const scene = window.__SCENE__;
  const gl = window.__POSE__.gl;
  const camera = window.__POSE__.camera;
  const obj = scene.getObjectByName('Head');
  const wp = obj.getWorldPosition(new (obj.position.constructor)());
  wp.y += 0.1;
  const v = wp.clone().project(camera);
  const rect = gl.domElement.getBoundingClientRect();
  return {
    x: rect.x + ((v.x + 1) / 2) * rect.width,
    y: rect.y + ((1 - v.y) / 2) * rect.height,
  };
});
await page.mouse.move(headScreen.x - 30, headScreen.y, { steps: 16 });
await page.screenshot({ path: 'e2e_ik_drag.png' });
await page.mouse.up();
await page.waitForTimeout(400);
const wristAfter = await page.evaluate(() => {
  const scene = window.__SCENE__;
  const obj = scene.getObjectByName('HandL');
  return obj.getWorldPosition(new (obj.position.constructor)()).toArray();
});
const dist = Math.hypot(
  wristAfter[0] - wristBefore[0],
  wristAfter[1] - wristBefore[1],
  wristAfter[2] - wristBefore[2],
);
results.ikDragMovedHand = dist > 0.1;
results.ikDragDistance = Number(dist.toFixed(3));
await page.screenshot({ path: 'e2e_ik_after.png' });

// ---- 3. view modes & presets screenshots
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.seg button')].find((x) => x.textContent === '선화');
  b && b.click();
});
await page.waitForTimeout(700);
await page.screenshot({ path: 'e2e_line.png' });

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.seg button')].find((x) => x.textContent === '실루엣');
  b && b.click();
});
await page.waitForTimeout(700);
await page.screenshot({ path: 'e2e_silhouette.png' });

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.seg button')].find((x) => x.textContent === '노멀');
  b && b.click();
  const p = [...document.querySelectorAll('.preset')].find((x) => x.querySelector('b').textContent === '앉기');
  p && p.click();
});
await page.waitForTimeout(700);
await page.screenshot({ path: 'e2e_sit.png' });

console.log(JSON.stringify(results, null, 2));
console.log('js errors:', errors.length ? errors.join('\n') : 'NONE');
await browser.close();
process.exit(errors.length ? 1 : 0);
