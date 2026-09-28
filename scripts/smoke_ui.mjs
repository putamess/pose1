import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('CONSOLE: ' + m.text());
});

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000); // glTF load + first frames
await page.screenshot({ path: 'smoke_normal.png' });

const clickPreset = (name) =>
  page.$$eval(
    '.preset',
    (els, n) => {
      const b = els.find((e) => e.querySelector('b').textContent === n);
      if (b) b.click();
    },
    name,
  );

for (const [name, file] of [
  ['앉기', 'smoke_sit.png'],
  ['인사', 'smoke_wave.png'],
  ['걸음', 'smoke_walk.png'],
  ['기지개', 'smoke_stretch.png'],
]) {
  await clickPreset(name);
  await page.waitForTimeout(700);
  await page.screenshot({ path: file });
}

// view modes
await page.$$eval('.seg button', (els) => els.find((e) => e.textContent === '선화').click());
await page.waitForTimeout(700);
await page.screenshot({ path: 'smoke_line.png' });

await page.$$eval('.seg button', (els) => els.find((e) => e.textContent === '실루엣').click());
await page.waitForTimeout(700);
await page.screenshot({ path: 'smoke_silhouette.png' });

await page.$$eval('.seg button', (els) => els.find((e) => e.textContent === '노멀').click());
await clickPreset('서기');
await page.waitForTimeout(700);

// joint selection: click on the torso in the canvas
const box = await page.locator('.canvas-wrap').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 40);
await page.waitForTimeout(500);
const selected = await page
  .textContent('.selected-joint')
  .catch(() => null);
await page.screenshot({ path: 'smoke_selected.png' });

// joint chip select (deterministic)
await page.$$eval('.chip', (els) => {
  const c = els.find((e) => e.textContent === 'ForearmL');
  if (c) c.click();
});
await page.waitForTimeout(400);
const selected2 = await page.textContent('.selected-joint').catch(() => null);

// move a slider (elbow flexion)
const sliderInfo = await page.evaluate(() => {
  const row = document.querySelectorAll('.slider-row input[type=range]')[1];
  if (!row) return null;
  const before = row.value;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(row, String(Number(row.min) + 5));
  row.dispatchEvent(new Event('input', { bubbles: true }));
  row.dispatchEvent(new Event('change', { bubbles: true }));
  return { before, after: row.value, min: row.min, max: row.max };
});
await page.waitForTimeout(500);
await page.screenshot({ path: 'smoke_slider.png' });

// save a pose to localStorage
await page.evaluate(() => {
  const inp = document.querySelector('[data-testid=pose-name-input]');
  inp.value = '테스트 자세';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.$$eval('.save-row .primary', (els) => els[0].click());
await page.waitForTimeout(300);
const savedCount = await page.$$eval('.saved-list li', (els) => els.length);

// PNG export (headless download)
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
  page.$$eval('.panel button', (els) => {
    const b = els.find((e) => e.textContent.includes('PNG 저장 (현재'));
    if (b) b.click();
  }),
]);

console.log('— results —');
console.log('selected after canvas click :', selected);
console.log('selected after chip click   :', selected2);
console.log('slider move                 :', JSON.stringify(sliderInfo));
console.log('saved poses in list         :', savedCount);
console.log('png download                :', download ? download.suggestedFilename() : 'NONE');
console.log('js errors                   :', errors.length ? '\n' + errors.join('\n') : 'NONE');

await browser.close();
process.exit(errors.length ? 1 : 0);
