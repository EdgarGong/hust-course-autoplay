const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Browser/iframe boundaries are simulated; each test runs the actual content script.
const script = fs.readFileSync(path.join(process.env.EXTENSION_DIR || path.join(__dirname, '..'), 'autoplay.js'), 'utf8');
function setup({ enabled = true, pending = true, muted = false, clickStarts = false, playResult } = {}) {
  let now = 10000, tick, clickCount = 0, playCount = 0;
  const listeners = {};
  const video = {
    muted, volume: 0.6, playbackRate: 1, defaultPlaybackRate: 1,
    paused: true, ended: false, readyState: 4, isConnected: true,
    addEventListener(name, fn) { listeners[name] = fn; },
    play() { playCount++; return playResult ? playResult(video, playCount) : Promise.resolve().then(() => { video.paused = false; }); },
  };
  const button = { disabled: false, getClientRects: () => [1], click() { clickCount++; if (clickStarts) video.paused = false; } };
  const frame = { isConnected: true, contentDocument: { querySelector: () => video, querySelectorAll: () => [button] } };
  const card = { URL: 'https://smartcourse.hust.edu.cn/cards?knowledgeid=new', querySelectorAll: selector => selector.includes('ans-insertvideo-online') ? [frame] : [] };
  const badgeListeners = {};
  const badge = { setAttribute() {}, addEventListener(name, fn) { badgeListeners[name] = fn; } };
  let state = { enabled, ...(pending ? { pending: { from: 'old', deadline: 45000 } } : {}) };
  const context = {
    URL, WeakSet, WeakMap, Promise, console, Date: { now: () => now },
    location: { href: 'https://smartcourse.hust.edu.cn/mooc-smartcourse/mycourse/studentstudy?courseId=test' },
    sessionStorage: { getItem: () => JSON.stringify(state), setItem(k, value) { state = JSON.parse(value); } },
    document: { createElement: () => badge, body: { append() {} }, querySelector: s => s === 'iframe#iframe' ? { contentDocument: card } : null },
    setInterval(fn) { tick = fn; },
  };
  vm.runInNewContext(script, context);
  return { video, badge, frame, listeners, state: () => state, clicks: () => clickCount, plays: () => playCount,
    tick(ms = 400) { now += ms; tick(); }, toggle() { badgeListeners.click(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('sets the current video to 2x when autoplay is enabled', () => {
  const h = setup({ pending: false });
  assert.equal(h.video.playbackRate, 2);
  assert.equal(h.video.defaultPlaybackRate, 2);
});

test('leaves playback speed alone while autoplay is disabled', () => {
  const h = setup({ enabled: false, pending: false });
  assert.equal(h.video.playbackRate, 1);
  assert.equal(h.video.defaultPlaybackRate, 1);
});

test('enabling autoplay applies 2x to an already observed video', () => {
  const h = setup({ enabled: false, pending: false });
  h.toggle();
  assert.equal(h.video.playbackRate, 2);
});

test('applies 2x to a video loaded later in the chapter', () => {
  const h = setup({ pending: false });
  const next = { ...h.video, playbackRate: 1, defaultPlaybackRate: 1, addEventListener() {} };
  h.frame.contentDocument.querySelector = () => next;
  h.tick();
  assert.equal(next.playbackRate, 2);
});

test('reapplies 2x after media initialization resets the speed', () => {
  const h = setup({ pending: false });
  h.video.playbackRate = 1;
  h.listeners.loadedmetadata?.();
  assert.equal(h.video.playbackRate, 2);
  h.video.playbackRate = 1;
  h.listeners.playing?.();
  assert.equal(h.video.playbackRate, 2);
});

test('stops applying automatic speed changes after autoplay is disabled', () => {
  const h = setup({ pending: false });
  h.toggle();
  h.video.playbackRate = 1.5;
  h.video.defaultPlaybackRate = 1.5;
  h.listeners.loadedmetadata?.();
  h.listeners.playing?.();
  h.tick();
  assert.equal(h.video.playbackRate, 1.5);
  assert.equal(h.video.defaultPlaybackRate, 1.5);
});

test('leaves player sound unchanged with autoplay enabled or disabled', () => {
  for (const enabled of [true, false]) {
    const h = setup({ enabled, pending: false });
    assert.equal(h.video.muted, false);
    assert.equal(h.video.volume, 0.6);
  }
  assert.equal(setup({ muted: true, pending: false }).video.muted, true);
});

test('keeps navigation pending when a play button click does not start playback', () => {
  const h = setup({ playResult: () => new Promise(() => {}) });
  assert.ok(h.state().pending, 'do not discard retry state after an ineffective click');
});

test('waits for media data even when the element reports it is no longer paused', async () => {
  const h = setup({ playResult(v) { v.paused = false; v.readyState = 0; return Promise.resolve(); } });
  await flush();
  h.tick();
  assert.ok(h.state().pending);
  h.video.readyState = 3;
  h.tick();
  assert.equal(h.state().pending, undefined);
});

test('does not issue a new play request every timer tick while loading', () => {
  const h = setup({ playResult: () => new Promise(() => {}) });
  h.tick(); h.tick(); h.tick();
  assert.equal(h.plays(), 1);
  assert.ok(h.state().pending);
});

test('starts next chapter through the media API and clears pending only after playback', async () => {
  const h = setup();
  assert.ok(h.state().pending);
  await flush();
  h.tick();
  assert.equal(h.video.paused, false);
  assert.equal(h.state().pending, undefined);
});

test('retries a temporary startup failure without toggling the player button again', async () => {
  const h = setup({ playResult(v, count) {
    if (count === 1) return Promise.reject(Object.assign(new Error('loading'), { name: 'AbortError' }));
    v.paused = false;
    return Promise.resolve();
  } });
  await flush();
  h.tick(1800);
  await flush();
  h.tick();
  assert.equal(h.video.paused, false);
  assert.equal(h.clicks(), 1);
  assert.equal(h.state().pending, undefined);
});

test('reports blocked audible autoplay without muting the video', async () => {
  const h = setup({ playResult: () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) });
  await flush();
  assert.match(h.badge.textContent, /浏览器.*自动播放/);
  h.tick(5000);
  assert.equal(h.plays(), 1);
  assert.equal(h.video.muted, false);
  h.video.paused = false; // A real user starts the player.
  h.tick();
  assert.equal(h.state().pending, undefined);
});

test('keeps the autoplay denial explanation after the navigation timeout', async () => {
  const h = setup({ playResult: () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) });
  await flush();
  h.tick(40000);
  assert.equal(h.state().pending, undefined);
  assert.match(h.badge.textContent, /浏览器.*自动播放/);
});

test('does not start paused videos when autoplay is disabled', async () => {
  const h = setup({ enabled: false });
  h.tick();
  await flush();
  assert.equal(h.plays(), 0);
  assert.equal(h.clicks(), 0);
});

test('enabling autoplay also starts the current video', async () => {
  const h = setup({ enabled: false, pending: false });
  h.toggle();
  await flush();
  h.tick();
  assert.equal(h.video.paused, false);
});

test('late rejection after disabling does not replace the disabled status', async () => {
  let reject;
  const h = setup({ playResult: () => new Promise((resolve, rejectFn) => { reject = rejectFn; }) });
  h.toggle();
  if (reject) reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
  await flush();
  assert.equal(h.badge.textContent, '开启连播');
});
