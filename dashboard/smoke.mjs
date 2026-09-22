// Built dashboard integration smoke test using the native sing-box API.
// Usage: BROWSER_BIN=/path/to/chromium node dashboard/smoke.mjs
import assert from 'node:assert/strict';
import { createSingboxMock } from './mock-singbox.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtAssets = await readdir(join(root, 'htdocs/luci-static/sing-box/dashboard/assets'));
assert.ok(
  !builtAssets.some((name) => /earth|geoip\.worker|Noto|clash/i.test(name)),
  'removed assets are still bundled',
);
assert.equal(builtAssets.filter((name) => /\.(ttf|woff2?)$/.test(name)).length, 1);
assert.ok(builtAssets.some((name) => /^Twemoji.*\.woff2$/.test(name)));
const publicFiles = await readdir(join(root, 'htdocs/luci-static/sing-box/dashboard'));
assert.ok(!publicFiles.some((name) => /^(pwa-|apple-touch-icon)|manifest|sw\.js/.test(name)), 'PWA assets remain');
const css = await readFile(
  join(
    root,
    'htdocs/luci-static/sing-box/dashboard/assets',
    builtAssets.find((name) => name.endsWith('.css')),
  ),
  'utf8',
);
const themes = [...css.matchAll(/\[data-theme=["']?([\w-]+)["']?\]/g)].map((match) => match[1]);
assert.deepEqual([...new Set(themes)].sort(), ['dark', 'light']);
assert.ok(
  !/vc-calendar|\.dock(?:[{:.,\s])|\.sidebar-route-menu/.test(css),
  'unused calendar or removed navigation CSS remains',
);
const profile = await mkdtemp(join(tmpdir(), 'sing-box-dashboard-smoke-'));
const calls = [];
const errors = [];
const sockets = new Set();
const native = createSingboxMock(calls, errors, sockets);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/daemon.StartedService/')) {
      await native.http(req, res);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      errors.push('unexpected Clash API request: ' + url.pathname);
      throw new Error('Only native sing-box API is mocked');
    }
    const filename = resolve(root, 'htdocs', '.' + decodeURIComponent(url.pathname));
    assert.ok(filename.startsWith(join(root, 'htdocs') + '/'));
    const data = await readFile(filename);
    res.setHeader(
      'Content-Type',
      { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[
        extname(filename)
      ] || 'application/octet-stream',
    );
    res.end(data);
  } catch (error) {
    res.writeHead(404);
    res.end(String(error));
  }
});
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/daemon.StartedService/')) {
    native.upgrade(req, socket, head);
    return;
  }
  errors.push('unexpected WebSocket endpoint: ' + req.url);
  socket.destroy();
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const url = origin + '/luci-static/sing-box/dashboard/index.html';
const browser = spawn(
  process.env.BROWSER_BIN ||
    (process.platform === 'darwin'
      ? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
      : '/usr/bin/chromium'),
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
);
let stderr = '';
browser.stderr.on('data', (data) => {
  stderr += data;
});
let nextId = 0;
const pending = new Map();
let buffer = '';
browser.on('error', (error) => {
  for (const task of pending.values()) task.reject(error);
});
browser.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString();
  while (buffer.includes('\0')) {
    const end = buffer.indexOf('\0');
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) task?.reject(new Error(JSON.stringify(message.error)));
      else task?.resolve(message.result);
    } else if (message.method === 'Fetch.requestPaused') {
      // Never probe a real service on the default port or fetch external resources.
      const allowed = message.params.request.url.startsWith(origin + '/');
      cdp(
        allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        {
          requestId: message.params.requestId,
          ...(allowed ? {} : { errorReason: 'BlockedByClient' }),
        },
        message.sessionId,
      ).catch((error) => errors.push(String(error)));
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
  }
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}\n${stderr.slice(-2000)}`));
    }, 20000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
try {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (method, params = {}) => cdp(method, params, sessionId);
  await cmd('Runtime.enable');
  await cmd('Page.enable');
  await cmd('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression) => {
    const result = await cmd('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Timed out: ${label}\n${await evaluate('document.body.innerText')}`);
  };
  await cmd('Page.navigate', { url });
  await until(
    'location.hash.includes("setup") && !!document.querySelector("input[name=username]")',
    'first-run connection form',
  );
  assert.equal(await evaluate('document.querySelector("input[name=username]").value'), '127.0.0.1');
  for (const [saved, expected] of [
    ['zh-TW', 'zh-CN'],
    ['ru-RU', 'en-US'],
  ]) {
    await evaluate(`localStorage.setItem('config/language', '${saved}')`);
    await cmd('Page.navigate', { url });
    await until('!!document.querySelector("input[name=username]")', 'language migration setup');
    await until(`localStorage.getItem('config/language') === '${expected}'`, `migrate ${saved}`);
    assert.deepEqual(await evaluate('[...document.querySelector("select[aria-label]").options].map(o => o.value)'), [
      'zh-CN',
      'en-US',
    ]);
  }
  assert.ok(
    !(await evaluate('[...document.querySelectorAll("option")].some(el => el.value === "clash")')),
    'Clash backend selector remains',
  );
  await evaluate(`for (const [selector, value] of [['input[placeholder="9090"]', '${port}'], ['input[type=password]', 'smoke-secret']]) {
    const input = document.querySelector(selector); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
  }`);
  await until('!!document.querySelector("button.btn-primary:not(:disabled)")', 'native setup reachability');
  await evaluate('document.querySelector("button.btn-primary").click()');
  await until('!!document.querySelector("nav")', 'native setup submission');
  assert.equal(await evaluate('JSON.parse(localStorage.getItem("setup/api-list"))[0].type'), 'singbox');
  const backend = {
    uuid: 'smoke',
    type: 'singbox',
    host: '127.0.0.1',
    port: String(port),
    protocol: 'http',
    secondaryPath: '',
    password: 'smoke-secret',
    label: 'Smoke API',
  };
  const legacy = { ...backend, uuid: 'legacy', type: 'clash' };
  await evaluate(
    `localStorage.setItem('setup/api-list', ${JSON.stringify(JSON.stringify([legacy, backend]))}); localStorage.setItem('setup/active-uuid', 'legacy');`,
  );
  await cmd('Page.navigate', { url });
  await until(
    'location.hash.includes("setup") && !!document.querySelector("input[name=username]")',
    'unsupported saved backend returns to setup',
  );
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("setup/api-list")).map(b => b.uuid)'), ['smoke']);
  await evaluate(
    `localStorage.setItem('config/default-theme', 'light-monet'); localStorage.setItem('config/dark-theme', 'business'); localStorage.setItem('config/emoji', 'NotoEmoji');`,
  );
  await evaluate(
    `localStorage.setItem('setup/api-list', ${JSON.stringify(JSON.stringify([backend]))}); localStorage.setItem('setup/active-uuid', 'smoke'); localStorage.setItem('config/language', 'zh-CN');`,
  );
  await evaluate(`localStorage.setItem('config/overview-card-order', JSON.stringify([
    {card: 'EarthGlobeCard', visible: true}, {card: 'NetworkCard', visible: false}, {card: 'ChartsCard', visible: true}
  ]))`);
  await cmd('Page.navigate', { url });
  await until(
    '!!document.querySelector("nav") && document.body.innerText.includes("sing-box 1.13.0")',
    'overview data',
  );
  assert.deepEqual(await evaluate('[...document.querySelectorAll("nav a")].map(a => a.textContent.trim())'), [
    '概览',
    '代理',
    '连接',
    '日志',
  ]);
  await evaluate(
    `{ const select = document.querySelector('nav select'); select.value = 'en-US'; select.dispatchEvent(new Event('change', {bubbles:true})); }`,
  );
  await until('document.querySelector("nav a").textContent.trim() === "Overview"', 'English language switch');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("nav a")].map(a => a.textContent.trim())'), [
    'Overview',
    'Proxies',
    'Connections',
    'Logs',
  ]);
  await evaluate(
    `{ const select = document.querySelector('nav select'); select.value = 'zh-CN'; select.dispatchEvent(new Event('change', {bubbles:true})); }`,
  );
  await until('document.querySelector("nav a").textContent.trim() === "概览"', 'Chinese language switch');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("nav")).display'), 'flex');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("nav a.btn")).display'), 'flex');
  assert.equal(await evaluate('localStorage.getItem("config/default-theme")'), 'light');
  assert.equal(await evaluate('localStorage.getItem("config/dark-theme")'), 'dark');
  assert.ok(await evaluate('!!document.querySelector(".font-SystemUI-Twemoji")'));
  const cards = await evaluate('JSON.parse(localStorage.getItem("config/overview-card-order"))');
  assert.ok(!cards.some(({ card }) => card === 'EarthGlobeCard'), 'legacy globe preference was retained');
  assert.deepEqual(cards.slice(0, 2), [
    { card: 'NetworkCard', visible: false },
    { card: 'ChartsCard', visible: true },
  ]);
  await evaluate('document.querySelector("main button.btn-circle").click()');
  await until('document.body.innerText.includes("卡片设置")', 'overview card settings');
  assert.equal(
    await evaluate('getComputedStyle(document.querySelector("#dialog-title").closest(".modal")).position'),
    'fixed',
  );
  assert.equal(
    await evaluate('getComputedStyle(document.querySelector("#dialog-title").closest(".modal-box")).display'),
    'flex',
  );
  assert.ok(!(await evaluate('document.body.innerText.includes("全球连接")')), 'globe setting remains visible');
  await evaluate('document.querySelector("#dialog-title button").click()');
  await evaluate('document.querySelector("nav a[href*=proxies]").click()');
  await until('!!document.querySelector("[data-group-name=PROXY]")', 'proxy group');
  await evaluate(`document.querySelector('[data-group-name=PROXY] .collapse-title').click()`);
  await until('document.body.innerText.includes("node-b")', 'proxy data');
  // Click the smallest node card label, allowing Vue click bubbling to reach its card handler.
  await evaluate(
    `([...document.querySelectorAll('main *')].find(el => el.textContent.trim() === 'node-b' && el.children.length === 0)).click()`,
  );
  await until('document.body.innerText.includes("node-b")', 'proxy selection');
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(native.selected, 'node-b');
  // Upstream can close existing connections after switching nodes; simulate a new connection.
  native.reopenConnection();
  await evaluate('document.querySelector("nav a[href*=connections]").click()');
  await until('document.body.innerText.includes("smoke.example")', 'connection stream');
  await evaluate('document.querySelector("nav a[href*=logs]").click()');
  await until('document.body.innerText.includes("dashboard-smoke-log")', 'log stream');
  for (const removed of ['rules', 'tools', 'settings']) {
    await evaluate(`location.hash = '/${removed}'`);
    await until('location.hash === "#/overview"', `removed ${removed} route`);
  }
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const page of ['overview', 'proxies', 'connections', 'logs']) {
    await evaluate(`document.querySelector('nav a[href*=${page}]').click()`);
    await until(`location.hash === '#/${page}'`, `mobile ${page}`);
    const layout = await evaluate(
      `({ width: innerWidth, scroll: document.documentElement.scrollWidth, nav: document.querySelector('nav').getBoundingClientRect().bottom, main: document.querySelector('main').getBoundingClientRect().top })`,
    );
    assert.ok(layout.scroll <= layout.width + 1, `mobile overflow: ${JSON.stringify(layout)}`);
    assert.ok(layout.main >= layout.nav - 1, 'navigation overlaps content');
  }
  assert.equal(await evaluate('navigator.serviceWorker.getRegistrations().then(x => x.length)'), 0);
  assert.ok(!calls.some(({ path }) => /upgrade|restart/.test(path)), 'unexpected core/UI maintenance call');
  for (const method of [
    'GetVersion',
    'GetStartedAt',
    'GetClashModeStatus',
    'SelectOutbound',
    'SubscribeStatus',
    'SubscribeGroups',
    'SubscribeOutbounds',
    'SubscribeConnections',
    'SubscribeLog',
  ]) {
    assert.ok(
      calls.some(({ path }) => path === '/daemon.StartedService/' + method),
      `native RPC not exercised: ${method}`,
    );
  }
  assert.ok(!calls.some(({ path }) => path.startsWith('/api/')), 'native test used Clash endpoints');
  assert.deepEqual(errors, [], 'browser or mock protocol errors');
  console.log(
    `PASS [sing-box native gRPC-Web + grpc-websockets]: native-only setup, saved backend/theme/language migration, Chinese/English switch, trimmed CSS/assets, overview, node switch, connections/log streams, removed routes, mobile layout, no service worker or upgrade calls.`,
  );
} finally {
  await cdp('Browser.close').catch(() => browser.kill());
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
