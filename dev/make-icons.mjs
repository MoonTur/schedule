// 앱 아이콘 만들기: node dev/make-icons.mjs
// SVG를 화면 없는 크롬으로 그려 docs/icons/*.png 로 저장합니다. (추가 설치 없음)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const OUT = new URL('../docs/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const glyph = `
  <g fill="none" stroke="#FFFFFF" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
    <rect x="96" y="140" width="320" height="280" rx="44"/>
    <path d="M96 220h320"/>
    <path d="M184 100v76M328 100v76"/>
  </g>
  <path d="M190 312l46 46 94-98" fill="none" stroke="#F97316" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>`;

const ICONS = [
  // 일반 아이콘: 둥근 사각형 (모서리 밖은 투명)
  { file: 'icon-512.png', size: 512, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#18181B"/>${glyph}</svg>` },
  { file: 'icon-192.png', size: 192, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#18181B"/>${glyph}</svg>` },
  // maskable: 안드로이드가 원·둥근 사각형 등으로 잘라 쓰므로 바탕을 꽉 채우고 그림은 가운데 안전 영역(80%) 안에
  { file: 'icon-maskable-512.png', size: 512, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#18181B"/><g transform="translate(256 260) scale(0.74) translate(-256 -260)">${glyph}</g></svg>` },
];

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9700 + Math.floor(Math.random() * 200);
const PROFILE = join(os.tmpdir(), 'ws-icons-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
for (let i = 0; i < 100 && !ws; i++) {
  try {
    const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((ok) => { ws.onopen = ok; }); }
  } catch { /* 아직 안 뜸 */ }
  if (!ws) await sleep(100);
}
ws.onmessage = (m) => { const msg = JSON.parse(m.data); const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });

await send('Page.enable');
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
for (const icon of ICONS) {
  await send('Emulation.setDeviceMetricsOverride', { width: icon.size, height: icon.size, deviceScaleFactor: 1, mobile: false });
  const html = `<!doctype html><html><body style="margin:0;background:transparent"><img width="${icon.size}" height="${icon.size}" style="display:block" src="data:image/svg+xml;base64,${Buffer.from(icon.svg).toString('base64')}"></body></html>`;
  await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
  await sleep(500);
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: icon.size, height: icon.size, scale: 1 } });
  writeFileSync(new URL(icon.file, OUT), Buffer.from(shot.data, 'base64'));
  console.log('만듦: docs/icons/' + icon.file);
}
ws.close(); chrome.kill(); await sleep(300);
try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 무시 */ }
