// E2E: multi-character flow —
//   add rigged Soldier as a character, Shift+drag to place it, IK on it,
//   switch active character, prop staging (incl. 0.01–500× scale range),
//   line mode, delete prop + character, zero JS errors.
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

const R = {};
const fail = (k, v) => { R[k] = v === undefined ? false : v; };

const screenOf = (name) => page.evaluate((n) => {
  const scene = window.__SCENE__;
  const gl = window.__POSE__.gl;
  const camera = window.__POSE__.camera;
  const THREE = window.__POSE__.THREE;
  const obj = scene.getObjectByName(n);
  if (!obj) return null;
  const wp = obj.getWorldPosition(new THREE.Vector3());
  const v = wp.clone().project(camera);
  const rect = gl.domElement.getBoundingClientRect();
  return { x: rect.x + ((v.x + 1) / 2) * rect.width, y: rect.y + ((1 - v.y) / 2) * rect.height };
}, name);

const charRoots = () => page.evaluate(() => {
  const THREE = window.__POSE__.THREE;
  const out = [];
  window.__SCENE__.children.forEach((c) => {
    if (c.userData && c.userData.charId) {
      const box = new THREE.Box3().setFromObject(c);
      out.push({
        id: c.userData.charId,
        x: +c.position.x.toFixed(3),
        y: +c.position.y.toFixed(3),
        z: +c.position.z.toFixed(3),
        minY: +box.min.y.toFixed(3),
        h: +(box.max.y - box.min.y).toFixed(3),
      });
    }
  });
  return out;
});

// screen position of a joint INSIDE the uploaded character (not the default)
const soldierScreenOf = (name) => page.evaluate((n) => {
  const THREE = window.__POSE__.THREE;
  const gl = window.__POSE__.gl;
  const camera = window.__POSE__.camera;
  let root = null;
  window.__SCENE__.children.forEach((c) => {
    if (c.userData && c.userData.charId && c.userData.charId !== 'char_default') root = c;
  });
  const obj = root && root.getObjectByName(n);
  if (!obj) return null;
  const wp = obj.getWorldPosition(new THREE.Vector3());
  const v = wp.clone().project(camera);
  const rect = gl.domElement.getBoundingClientRect();
  return { x: rect.x + ((v.x + 1) / 2) * rect.width, y: rect.y + ((1 - v.y) / 2) * rect.height };
}, name);

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(4500);

// ---- 1. add rigged Soldier as a SECOND character ----
await page.setInputFiles('[data-testid=char-file-input]', 'public/soldier_user.glb');
await page.waitForTimeout(5000);
R.charList2 = await page.evaluate(
  () => document.querySelectorAll('[data-testid=char-list] li').length === 2,
);
R.activeIsSoldier = await page.evaluate(() => {
  const on = document.querySelector('[data-testid=char-list] li.on');
  return !!on && on.textContent.includes('soldier_user.glb');
});
R.rigReady = await page.evaluate(
  () => document.querySelectorAll('.chip').length > 0 && !document.querySelector('.notice'),
);
{
  const roots = await charRoots();
  R.soldierAdded = roots.some((r) => r.id !== 'char_default' && r.h > 0.5);
  const s = roots.find((r) => r.id !== 'char_default');
  // foot bone on floor, body not buried (scoped to the soldier root)
  R.soldierGrounded = await page.evaluate(() => {
    const THREE = window.__POSE__.THREE;
    let root = null;
    window.__SCENE__.children.forEach((c) => {
      if (c.userData && c.userData.charId && c.userData.charId !== 'char_default') root = c;
    });
    if (!root) return false;
    const foot = root.getObjectByName('FootL');
    if (!foot) return false;
    const fy = foot.getWorldPosition(new THREE.Vector3()).y;
    return fy > -0.06 && fy < 0.4;
  });
}

// ---- 2. Shift+drag moves the soldier on the ground ----
const hand = await soldierScreenOf('HandL');
if (hand) {
  const before = await charRoots();
  await page.keyboard.down('Shift');
  await page.mouse.move(hand.x, hand.y);
  await page.mouse.down();
  await page.mouse.move(hand.x + 260, hand.y + 40, { steps: 14 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(400);
  const after = await charRoots();
  const b = before.find((r) => r.id !== 'char_default');
  const a = after.find((r) => r.id !== 'char_default');
  R.charMoved = b && a && Math.hypot(a.x - b.x, a.z - b.z) > 0.4 && Math.abs(a.y - b.y) < 0.01;
} else fail('charMoved');

// ---- 3. IK drag the soldier's hand (no shift) ----
const hand2 = await soldierScreenOf('HandL');
if (hand2 && hand2.x > 0 && hand2.x < 1440) {
  const before = await page.evaluate(() => {
    const THREE = window.__POSE__.THREE;
    let root = null;
    window.__SCENE__.children.forEach((c) => {
      if (c.userData && c.userData.charId && c.userData.charId !== 'char_default') root = c;
    });
    const o = root && root.getObjectByName('HandL');
    return o ? o.getWorldPosition(new THREE.Vector3()).toArray() : null;
  });
  await page.mouse.move(hand2.x, hand2.y);
  await page.mouse.down();
  await page.mouse.move(hand2.x - 40, hand2.y - 140, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    const THREE = window.__POSE__.THREE;
    let root = null;
    window.__SCENE__.children.forEach((c) => {
      if (c.userData && c.userData.charId && c.userData.charId !== 'char_default') root = c;
    });
    const o = root && root.getObjectByName('HandL');
    return o ? o.getWorldPosition(new THREE.Vector3()).toArray() : null;
  });
  R.ikOnUploaded = !!before && !!after
    && Math.hypot(...after.map((v, i) => v - before[i])) > 0.1;
} else fail('ikOnUploaded');

// ---- 4. activate the default character via the list (pose button) ----
await page.evaluate(() => {
  const li = [...document.querySelectorAll('[data-testid=char-list] li')]
    .find((x) => x.textContent.includes('기본 마니퀸'));
  const b = li && [...li.querySelectorAll('button')].find((x) => x.textContent === '포즈');
  b && b.click();
});
await page.waitForTimeout(300);
R.activeSwitched = await page.evaluate(() => {
  const on = document.querySelector('[data-testid=char-list] li.on');
  return !!on && on.textContent.includes('기본 마니퀸');
});

// ---- 5. add a prop (static mannequin_user.glb) ----
await page.setInputFiles('[data-testid=prop-file-input]', 'public/mannequin_user.glb');
await page.waitForTimeout(3500);
R.propPlaced = await page.evaluate(() => {
  let n = 0;
  window.__SCENE__.traverse((o) => { if (o.userData && o.userData.propId) n++; });
  return n === 1;
});
R.propAutoSelected = await page.evaluate(() => !!document.querySelector('.prop-list li.on'));
R.propGrounded = await page.evaluate(() => {
  const THREE = window.__POSE__.THREE;
  let root = null;
  window.__SCENE__.traverse((o) => { if (o.userData && o.userData.propId && !root) root = o; });
  if (!root) return false;
  const box = new THREE.Box3().setFromObject(root);
  return Math.abs(box.min.y) < 0.06;
});
R.gizmoTranslate = await page.evaluate(() => {
  let mode = null;
  window.__SCENE__.traverse((o) => { if (o.type === 'TransformControls' || (o.constructor && o.constructor.name === 'TransformControls')) mode = o.mode; });
  return mode === 'translate';
});

// ---- 6. sliders move/scale the prop (exp scale up to 500×) ----
const setRange = async (idx, val) => {
  await page.evaluate(([i, v]) => {
    const inputs = [...document.querySelectorAll('.prop-sliders input[type=range]')];
    const el = inputs[i];
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [idx, val]);
  await page.waitForTimeout(250);
};
const propPos = () => page.evaluate(() => {
  let s = null;
  window.__SCENE__.traverse((o) => { if (o.userData && o.userData.propId && !s) s = o; });
  return s ? { x: s.position.x, z: s.position.z, scale: s.scale.x } : null;
});
const p0 = await propPos();
await setRange(0, 1.5); // X
const p1 = await propPos();
R.sliderMovesProp = p0 && p1 && Math.abs(p1.x - p0.x) > 0.3;
await setRange(2, 700); // scale slider → ≈19× (log scale, was capped at 4)
const p2 = await propPos();
R.sliderScalesProp = p2 && Math.abs(p2.scale - p1.scale) > 0.2;
R.scaleExceedsOldCap = p2 && p2.scale > 4;
await setRange(2, 1000); // top of the slider → 500×
const p3 = await propPos();
R.scale500 = p3 && p3.scale > 300; // slider top = 500× the prepared size
await setRange(2, 800); // pull back so screenshots stay sane (≈63×)
await page.waitForTimeout(300);

// ---- 7. line mode capture (soldier + prop + default) ----
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.seg button')].find((x) => x.textContent === '선화');
  b && b.click();
});
await page.waitForTimeout(1200);
{
  const b64 = await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const { gl } = window.__POSE__;
    gl.render(window.__SCENE__, window.__POSE__.camera);
    return gl.domElement.toDataURL('image/png').split(',')[1];
  });
  fs.writeFileSync('import_multichar_line.png', Buffer.from(b64, 'base64'));
}
R.lineOnBoth = true;
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.seg button')].find((x) => x.textContent === '노멀');
  b && b.click();
});

// ---- 8. delete prop, then delete the soldier character ----
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.prop-list li .del')][0];
  b && b.click();
});
await page.waitForTimeout(400);
R.propDeleted = await page.evaluate(() => {
  let n = 0;
  window.__SCENE__.traverse((o) => { if (o.userData && o.userData.propId) n++; });
  return n === 0;
});
await page.evaluate(() => {
  const lis = [...document.querySelectorAll('[data-testid=char-list] li')];
  const soldier = lis.find((li) => li.textContent.includes('soldier_user'));
  const del = soldier && soldier.querySelector('.del');
  del && del.click();
});
await page.waitForTimeout(500);
R.charDeleted = await page.evaluate(() => {
  const n = document.querySelectorAll('[data-testid=char-list] li').length;
  let roots = 0;
  window.__SCENE__.children.forEach((c) => { if (c.userData && c.userData.charId) roots++; });
  const on = document.querySelector('[data-testid=char-list] li.on');
  return n === 1 && roots === 1 && !!on && on.textContent.includes('기본 마니퀸');
});

console.log(JSON.stringify(R, null, 2));
console.log('js errors:', errors.length ? errors.join(' | ') : 'NONE');
const ok = Object.values(R).every(Boolean) && errors.length === 0;
await browser.close();
process.exit(ok ? 0 : 1);
