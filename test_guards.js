/**
 * Self-check cho các guard trong background.js — chạy: node test_guards.js
 * Không cần trình duyệt: nạp background.js vào vm với chrome giả, rồi kiểm tra
 * đúng những hành vi đã từng bị lỗi. Mỗi test dùng context riêng để state module sạch.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const REG_URL = 'https://portal.ctdb.hcmus.edu.vn/dang-ky-hoc-phan/sinh-vien-clc';

function loadBackground(initialStorage, tabOverride) {
    const state = { ...initialStorage };
    const calls = { executeScript: 0, navigate: 0, reload: 0, created: 0 };
    const listeners = [];
    const tab = Object.assign({
        id: 7, active: true, windowId: 1, status: 'complete', url: REG_URL
    }, tabOverride);

    const chrome = {
        alarms: { onAlarm: { addListener() {} }, create() {}, clearAll() {} },
        runtime: {
            onMessage: { addListener() {} },
            getURL: (p) => 'chrome-extension://x/' + p,
            sendMessage: () => Promise.resolve()
        },
        windows: { update: () => Promise.resolve() },
        notifications: { create() {} },
        scripting: { executeScript: () => { calls.executeScript++; return Promise.resolve([]); } },
        storage: { local: {
            // Hỗ trợ cả 2 dạng: promise (background) và callback (listener onUpdated)
            get: (keys, cb) => {
                const list = Array.isArray(keys) ? keys : Object.keys(keys || {});
                const out = {};
                list.forEach(k => { out[k] = state[k]; });
                if (cb) { cb(out); return; }
                return Promise.resolve(out);
            },
            set: async (obj) => { Object.assign(state, obj); },
            remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete state[k]); }
        } },
        tabs: {
            query: async () => [tab],
            update: async (id, props) => { if (props && props.url) calls.navigate++; return tab; },
            reload: async () => { calls.reload++; },
            create: async () => { calls.created++; return tab; },
            onUpdated: { addListener: (fn) => listeners.push(fn) },
            sendMessage: () => Promise.resolve()
        }
    };

    const ctx = vm.createContext({ chrome, console, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(__dirname + '/background.js', 'utf8'), ctx);
    return { ctx, state, calls, listeners, tick: () => new Promise(r => setTimeout(r, 0)) };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('double-trigger: alarm + setTimeout cùng nổ -> chỉ bắn 1 lần', async () => {
    const b = loadBackground({ isRunning: false, targetTabId: 7, savedMaMG: '6288', savedPortalUrl: REG_URL });
    // Gọi song song đúng như prepareSniperTab (setTimeout) và alarm startSniper ở thời điểm T
    await Promise.all([b.ctx.triggerSniper(), b.ctx.triggerSniper()]);
    const fired = b.calls.executeScript + b.calls.reload + b.calls.navigate + b.calls.created;
    assert.strictEqual(fired, 1, `phải bắn đúng 1 lần, nhận ${fired} — ${JSON.stringify(b.calls)}`);
});

test('run đang chạy thật (mới) -> không bắn chồng', async () => {
    const b = loadBackground({ isRunning: true, runStartedAt: Date.now(), targetTabId: 7, savedMaMG: '6288', savedPortalUrl: REG_URL });
    await b.ctx.triggerSniper();
    assert.strictEqual(b.calls.executeScript, 0);
});

test('run treo quá STALE_RUN_MS -> chạy tiếp, không bị chặn vĩnh viễn', async () => {
    const b = loadBackground({ isRunning: true, runStartedAt: Date.now() - 11 * 60 * 1000, targetTabId: 7, savedMaMG: '6288', savedPortalUrl: REG_URL });
    await b.ctx.triggerSniper();
    assert.strictEqual(b.calls.executeScript, 1, 'phải tự phục hồi và chạy lại');
});

test('tab đã ở đúng trang đăng ký -> KHÔNG reload (giữ nguyên trang pre-warm)', async () => {
    const b = loadBackground({ isRunning: false, targetTabId: 7, savedMaMG: '6288', savedPortalUrl: REG_URL });
    await b.ctx.triggerSniper();
    assert.strictEqual(b.calls.reload, 0, 'reload ở T sẽ xoá trang đã pre-warm');
    assert.strictEqual(b.calls.executeScript, 1, 'phải inject thẳng');
});

test('savedPortalUrl không phải trang đăng ký -> không lặp điều hướng vô hạn', async () => {
    const target = 'https://portal.ctdb.hcmus.edu.vn/trang-chu';
    const b = loadBackground({ isRunning: true, targetTabId: 7, savedMaMG: '6288', savedPortalUrl: target },
        { url: target });
    b.listeners[0](7, { status: 'complete' }, { url: target });
    await b.tick();
    assert.strictEqual(b.calls.navigate, 0, 'URL đã đúng đích mà vẫn update -> lặp vô hạn');
});

test('tab ở trang portal khác -> vẫn điều hướng về trang đăng ký', async () => {
    const other = 'https://portal.ctdb.hcmus.edu.vn/trang-chu';
    const b = loadBackground({ isRunning: true, targetTabId: 7, savedMaMG: '6288', savedPortalUrl: REG_URL },
        { url: other });
    b.listeners[0](7, { status: 'complete' }, { url: other });
    await b.tick();
    assert.strictEqual(b.calls.navigate, 1);
});

test('tab khác không phải targetTabId -> không hijack', async () => {
    const b = loadBackground({ isRunning: true, targetTabId: 99, savedMaMG: '6288', savedPortalUrl: REG_URL });
    b.listeners[0](7, { status: 'complete' }, { url: REG_URL });
    await b.tick();
    assert.strictEqual(b.calls.executeScript, 0);
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log('  ✅ ' + t.name);
        } catch (e) {
            failed++;
            console.log('  ❌ ' + t.name + '\n     ' + e.message);
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} test passed`);
    process.exit(failed ? 1 : 0);
})();
