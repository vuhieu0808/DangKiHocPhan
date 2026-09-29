/**
 * HCMUS Course Sniper VIP v2.0
 * @author vuhieu
 */
const DEFAULT_REG_URL = "https://portal.ctdb.hcmus.edu.vn/dang-ky-hoc-phan/sinh-vien-clc";

// Chặn trùng lặp kích hoạt: dùng mốc thời gian thay vì cờ boolean.
// Cửa sổ 5s là đủ để dedup giữa alarm và setTimeout mà không chặn thao tác đặt lại lịch của user.
const SNIPING_WINDOW_MS = 5000;
let snipingAt = 0;

// Một lần chạy coi như treo nếu lâu hơn mức này (fallback mode 5 môn ~5 phút).
// Không có mốc này thì 1 lần chạy chết sẽ chặn vĩnh viễn mọi lần đặt lịch sau.
const STALE_RUN_MS = 10 * 60 * 1000;

// 1. Lắng nghe báo thức Alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === "startSniper") {
        await triggerSniper();
    } else if (alarm.name === "prepareSniper") {
        // Đánh thức sớm ~15s trước giờ G: Mở sẵn tab, tải trang để sẵn sàng bộ nhớ đệm
        await prepareSniperTab();
    }
});

// Lắng nghe yêu cầu gửi Desktop Notification & tín hiệu dừng
chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === "NOTIFY_USER") {
        try {
            chrome.notifications.create({
                type: "basic",
                iconUrl: chrome.runtime.getURL("icon.png"),
                title: msg.title || "HCMUS Course Sniper VIP",
                message: msg.message || "",
                priority: 2
            });
        } catch (e) {
            console.error("[Sniper] Lỗi khi gửi thông báo:", e);
        }
    } else if (msg && msg.action === "STOP_SNIPER") {
        snipingAt = 0;
    } else if (msg && msg.action === "INJECT_SNIPER_NOW" && msg.tabId) {
        injectSniper(msg.tabId, msg.url || "");
    }
});

// Helper: Tìm tab portal ưu tiên tab đang active hoặc tab mục tiêu
async function findPortalTab(preferredTabId) {
    const tabs = await chrome.tabs.query({ url: "*://portal.ctdb.hcmus.edu.vn/*" });
    if (tabs.length === 0) return null;
    return tabs.find(t => t.active) || (preferredTabId ? tabs.find(t => t.id === preferredTabId) : null) || tabs[0];
}

// Chuẩn bị trước tab Portal (Pre-warm) trước giờ G ~15 giây
async function prepareSniperTab() {
    try {
        const { savedPortalUrl, savedTime, targetTabId } = await chrome.storage.local.get(['savedPortalUrl', 'savedTime', 'targetTabId']);
        const targetUrl = savedPortalUrl || DEFAULT_REG_URL;

        let targetTab = await findPortalTab(targetTabId);
        let tabCreated = false;
        if (targetTab) {
            await chrome.tabs.update(targetTab.id, { active: true });
        } else {
            targetTab = await chrome.tabs.create({ url: targetUrl, active: true });
            tabCreated = true;
        }

        await chrome.storage.local.set({ targetTabId: targetTab.id });

        // Đảm bảo tab đã ở trang đăng ký (bỏ qua nếu tab mới tạo vì đã mở sẵn targetUrl)
        if (!tabCreated) {
            const lowerUrl = (targetTab.url || "").toLowerCase();
            if (!lowerUrl.includes("dang-ky-hoc-phan")) {
                await chrome.tabs.update(targetTab.id, { url: targetUrl });
            }
        }

        // SW vừa thức giấc nên còn sống ~30s. Sử dụng setTimeout cho ≤ 20s cuối để bắn chính xác ms
        if (savedTime) {
            const targetMs = new Date(savedTime).getTime();
            const nowMs = Date.now();
            const delayMs = targetMs - nowMs;
            if (delayMs > 0 && delayMs <= 20000) {
                setTimeout(() => {
                    triggerSniper();
                }, delayMs);
            }
        }
    } catch (e) {
        console.error("[Sniper] Lỗi chuẩn bị tab:", e);
    }
}

// 2. Kích hoạt Sniper (Bắn ngay)
async function triggerSniper() {
    // Chặn double-trigger: alarm startSniper và setTimeout của prepareSniperTab cùng nổ ở T.
    // Phải chốt mốc ĐỒNG BỘ trước mọi await — nếu chốt sau await thì cả hai lời gọi song song
    // đều lọt qua guard (bug cũ) và reload tab 2 lần, giết sniper đang chạy.
    if (Date.now() - snipingAt < SNIPING_WINDOW_MS) return;
    snipingAt = Date.now();

    try {
        const { isRunning, runStartedAt, targetTabId, savedPortalUrl } = await chrome.storage.local.get(['isRunning', 'runStartedAt', 'targetTabId', 'savedPortalUrl']);

        // isRunning còn true = lần chạy trước chưa kết thúc. Chỉ tôn trọng nếu còn mới;
        // nếu đã treo quá lâu thì chạy tiếp, tránh bị chặn vĩnh viễn.
        if (isRunning && Date.now() - (runStartedAt || 0) < STALE_RUN_MS) {
            snipingAt = 0;
            return;
        }

        // Xóa hoàn toàn savedTime để ngăn chặn Bug vòng lặp kích hoạt vĩnh viễn
        await chrome.storage.local.remove(['savedTime']);

        const targetUrl = savedPortalUrl || DEFAULT_REG_URL;
        let targetTab = await findPortalTab(targetTabId);
        let tabCreated = false;

        if (targetTab) {
            await chrome.tabs.update(targetTab.id, { active: true });
            if (targetTab.windowId) {
                await chrome.windows.update(targetTab.windowId, { focused: true });
            }
        } else {
            targetTab = await chrome.tabs.create({ url: targetUrl, active: true });
            tabCreated = true;
        }

        await chrome.storage.local.set({
            isRunning: true,
            runStartedAt: Date.now(),
            targetTabId: targetTab.id,
            statusText: "🔥 Đã đến giờ! Đang kích hoạt Sniper..."
        });

        // Nếu tab mới tạo thì onUpdated sẽ tự động inject khi hoàn tất tải trang
        if (!tabCreated) {
            const lowerUrl = (targetTab.url || "").toLowerCase();
            if (lowerUrl.includes("dang-ky-hoc-phan")) {
                // Tab đã ở sẵn trang đăng ký: KHÔNG reload. Reload sẽ xoá trang đã pre-warm ở T-15s
                // và đẩy request đầu tiên trễ thêm vài giây — vô hiệu hoá toàn bộ cơ chế hẹn giờ.
                if (targetTab.status === "complete") {
                    await injectSniper(targetTab.id, lowerUrl);
                }
            } else {
                chrome.tabs.update(targetTab.id, { url: targetUrl });
            }
        }
    } catch (err) {
        console.error("[Sniper] Lỗi triggerSniper:", err);
        snipingAt = 0;
    }
}

// Đọc cấu hình đã lưu và inject sniperCoreLogic vào tab đích (nếu đủ điều kiện).
// Tách riêng để triggerSniper bắn thẳng được vào tab đã pre-warm, không cần reload.
async function injectSniper(tabId, currentUrl) {
    const res = await chrome.storage.local.get([
        'isRunning',
        'targetTabId',
        'savedPortalUrl',
        'savedMaMG',
        'savedInterval',
        'savedMaxRetries',
        'savedMode',
        'savedRetryWhenFull',
        'savedSoundAlert'
    ]);

    // CHỈ XỬ LÝ NẾU tabId CHÍNH LÀ targetTabId (tránh hijack các tab portal khác của người dùng)
    if (!res.isRunning || res.targetTabId !== tabId || !res.savedMaMG) return false;
    if (!currentUrl.includes("dang-ky-hoc-phan")) return false;

    // Parser danh sách mã môn: linh hoạt nhận phẩy, chấm phẩy, khoảng trắng hoặc xuống dòng
    const list = (res.savedMaMG || "")
        .split(/[\s,;\n\t]+/)
        .map(s => s.trim())
        .filter(Boolean);

    if (list.length === 0) return false;

    const interval = Math.max(200, parseInt(res.savedInterval, 10) || 600);
    const maxRetries = Math.max(1, parseInt(res.savedMaxRetries, 10) || 100);
    const mode = res.savedMode || 'concurrent';
    const retryWhenFull = res.savedRetryWhenFull !== false;
    const soundAlert = res.savedSoundAlert !== false;

    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: sniperCoreLogic,
            args: [list, interval, maxRetries, {
                mode: mode,
                retryWhenFull: retryWhenFull,
                soundAlert: soundAlert,
                portalUrl: res.savedPortalUrl || DEFAULT_REG_URL
            }]
        });
        return true;
    } catch (err) {
        console.error("[Sniper] Lỗi khi executeScript:", err);
        snipingAt = 0;
        // Inject thất bại (tab đã điều hướng / bị đóng) -> nhả trạng thái chạy ngay,
        // không đợi hết hạn STALE_RUN_MS.
        try {
            await chrome.storage.local.set({ isRunning: false });
        } catch (e) {}
        return false;
    }
}

// 3. Tự động kiểm tra khi Tab reload hoặc tải xong
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const currentUrl = (tab?.url || changeInfo?.url || "").toLowerCase();

    if (changeInfo.status !== 'complete' || !currentUrl.includes("portal.ctdb.hcmus.edu.vn")) return;

    try {
        const res = await chrome.storage.local.get(['savedTime', 'isRunning', 'targetTabId', 'savedPortalUrl']);

        // Dọn dẹp savedTime nếu đã quá giờ
        if (res.savedTime) {
            const targetDate = new Date(res.savedTime);
            if (Date.now() >= targetDate.getTime()) {
                await chrome.storage.local.remove(['savedTime']);
            }
        }

        if (!res.isRunning || res.targetTabId !== tabId) return;

        // Nếu tab chưa ở trang đăng ký học phần -> chuyển về đúng trang.
        // Chỉ điều hướng khi URL thật sự KHÁC đích, nếu không sẽ lặp reload vô hạn
        // khi savedPortalUrl không phải trang đăng ký học phần.
        if (!currentUrl.includes("dang-ky-hoc-phan")) {
            const targetUrl = res.savedPortalUrl || DEFAULT_REG_URL;
            if (currentUrl !== targetUrl.toLowerCase()) {
                chrome.tabs.update(tabId, { url: targetUrl });
            }
            return;
        }

        await injectSniper(tabId, currentUrl);
    } catch (err) {
        console.error("[Sniper] Lỗi trong onUpdated:", err);
    }
});

// 4. Hàm lõi (Sniper Core Logic) - Chạy trực tiếp trong ngữ cảnh trang Portal
async function sniperCoreLogic(priorityList, baseInterval, maxRetries, options) {
    if (window.__SNIPER_ACTIVE__) {
        console.log("[Sniper] Sniper đã đang hoạt động trên tab này.");
        return;
    }
    window.__SNIPER_ACTIVE__ = true;

    const mode = options?.mode || 'concurrent';
    const retryWhenFull = options?.retryWhenFull !== false;
    const soundAlert = options?.soundAlert !== false;
    const apiUrl = options?.portalUrl || window.location.href.split('?')[0];

    // Hàm escape HTML chống XSS (đủ cả 5 ký tự, thiếu ' sẽ biến dấu nháy thành chuỗi "undefined")
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    console.log("%c🚀 SNIPER MODE: KHỞI ĐỘNG v2.0 (by vuhieu)", "background: #007bff; color: white; padding: 6px; font-weight: bold; border-radius: 4px;");
    console.log(`[Sniper] Chế độ: ${mode} | Canh slot khi hết chỗ: ${retryWhenFull} | Delay: ${baseInterval}ms | Thử tối đa: ${maxRetries} lần`);
    console.log(`[Sniper] Danh sách môn:`, priorityList);

    // Phát âm thanh cảnh báo bằng Web Audio API (có resume giải quyết Autoplay Policy)
    // Dùng lại 1 AudioContext duy nhất: tạo mới mỗi lần sẽ chạm giới hạn ~6 context của Chrome
    // và từ tiếng chuông thứ ~7 trở đi sẽ im lặng.
    let audioCtx = null;
    async function playBeep(type) {
        if (!soundAlert) return;
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            const ctx = audioCtx;
            await ctx.resume().catch(() => {});

            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);

            if (type === 'success') {
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
                osc.frequency.setValueAtTime(880, ctx.currentTime + 0.15); // A5
                gain.gain.setValueAtTime(0.3, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.45);
                osc.start();
                osc.stop(ctx.currentTime + 0.45);
            } else if (type === 'error') {
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(260, ctx.currentTime);
                gain.gain.setValueAtTime(0.4, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
                osc.start();
                osc.stop(ctx.currentTime + 0.6);
            }
        } catch (e) {}
    }

    window.__SNIPER_ACTIVE_CONTROLLERS__ = new Set();
    const allActiveControllers = window.__SNIPER_ACTIVE_CONTROLLERS__;

    // Lắng nghe tín hiệu dừng từ Popup / Background
    if (!window.__SNIPER_STOP_LISTENER__) {
        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            if (msg && msg.action === "STOP_SNIPER") {
                console.log("%c🛑 Nhận tín hiệu DỪNG Sniper từ người dùng!", "background: red; color: white; padding: 4px;");
                window.__SNIPER_ACTIVE__ = false;
                if (window.__SNIPER_ACTIVE_CONTROLLERS__) {
                    window.__SNIPER_ACTIVE_CONTROLLERS__.forEach(ctrl => {
                        try { ctrl.abort(); } catch (e) {}
                    });
                    window.__SNIPER_ACTIVE_CONTROLLERS__.clear();
                }
                sendResponse({ status: "stopped" });
            }
        });
        window.__SNIPER_STOP_LISTENER__ = true;
    }

    const updateStatus = async (htmlMsg) => {
        try {
            await chrome.storage.local.set({ statusText: htmlMsg });
        } catch (e) {}
    };

    // Serialize tuần tự các thao tác ghi log vào storage để tránh Race Condition (Lost Update)
    let logQueue = Promise.resolve();
    const addLog = (logMsg) => {
        const time = new Date().toLocaleTimeString();
        const fullMsg = `[${time}] ${logMsg}`;
        console.log(`[Sniper] ${fullMsg}`);
        logQueue = logQueue.then(async () => {
            try {
                const cur = await chrome.storage.local.get(['logs']);
                const logs = cur.logs || [];
                logs.push(fullMsg);
                if (logs.length > 25) logs.shift();
                await chrome.storage.local.set({ logs });
            } catch (e) {}
        });
        return logQueue;
    };

    const notifyUser = (title, message) => {
        try {
            chrome.runtime.sendMessage({
                action: "NOTIFY_USER",
                title: title,
                message: message
            }).catch(() => {});
        } catch (e) {}
    };

    try {
        // Kiểm tra trang đăng nhập
        const path = window.location.pathname.toLowerCase();
        const isLoginPath = path.includes("/login") || path.includes("/dang-nhap") || path.includes("/dangnhap") || path.includes("/account/login");
        const visiblePwd = Array.from(document.querySelectorAll('input[type="password"]')).some(el => el.offsetWidth > 0 && el.offsetHeight > 0);

        if (isLoginPath || visiblePwd) {
            console.warn("[Sniper] Đang ở trang đăng nhập. Dừng Sniper.");
            await updateStatus(`<span style="color:red; font-weight:bold;">🚨 CHƯA ĐĂNG NHẬP! Vui lòng đăng nhập trước.</span>`);
            await addLog("Lỗi: Portal chưa đăng nhập.");
            window.__SNIPER_ACTIVE__ = false;
            playBeep('error');
            notifyUser("🚨 CHƯA ĐĂNG NHẬP PORTAL!", "Vui lòng đăng nhập tài khoản trước khi chạy Sniper!");
            return;
        }

        // Chuẩn hóa danh sách môn học: Chỉ lấy MaMG thuần, loại bỏ ký tự nhóm TH (:nhomTH) nếu có
        const cleanedPriorityList = priorityList
            .map(rawItem => String(rawItem).split(/[:\/]/)[0].trim())
            .filter(Boolean);
        const uniqueList = [...new Set(cleanedPriorityList)];

        let globalInFlight = 0;
        const MAX_GLOBAL_IN_FLIGHT = 5;       // Giữ <= 5 để không chạm ngưỡng 6 socket tối đa của Chrome với mỗi domain
        const MAX_IN_FLIGHT_PER_SUBJECT = 2;  // Mỗi môn tối đa 1 kết nối gốc + 1 kết nối gối đầu
        const HEDGE_DELAY_MS = 15000;         // Sau 15s nếu request cũ vẫn đang pending xếp hàng trên server -> bắn gối đầu thêm 1 request
        const REQUEST_TIMEOUT_MS = 240000;    // 4 phút trần an toàn (portal vào giờ cao điểm có thể pending 2-3 phút)

        const activeSubjects = new Set();
        const startTime = Date.now();
        let lastHeartbeatLogTime = startTime;

        // Heartbeat ticker cập nhật statusText thời gian thực mỗi 1 giây (để người dùng thấy giây nhảy liên tục, không bị cảm giác đứng hình)
        const tickerInterval = setInterval(async () => {
            if (!window.__SNIPER_ACTIVE__) {
                clearInterval(tickerInterval);
                return;
            }
            const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
            const activeSockets = globalInFlight;
            
            if (activeSubjects.size > 0) {
                const listStr = Array.from(activeSubjects).join(', ');
                await updateStatus(`⏳ <b>[${elapsedSec}s]</b> Đang chờ Portal (<b>${listStr}</b>) 🟢 <b>[${activeSockets} kết nối]</b>`);
            } else {
                await updateStatus(`⏳ <b>[${elapsedSec}s]</b> Đang điều phối kết nối... 🟢 <b>[${activeSockets} kết nối]</b>`);
            }

            // Định kỳ mỗi 20 giây ghi log nhắc người dùng kiên nhẫn nếu vẫn đang trong hàng đợi của Portal
            if (Date.now() - lastHeartbeatLogTime >= 20000 && activeSockets > 0) {
                lastHeartbeatLogTime = Date.now();
                await addLog(`⏳ Vẫn đang giữ kết nối xếp hàng trên máy chủ Portal (${elapsedSec}s trôi qua, ${activeSockets} kết nối đang chờ phản hồi)...`);
            }
        }, 1000);

        // Hàm xử lý đăng ký 1 mã môn với cơ chế Bắn Gối Đầu (Hedged Requests)
        async function registerSubject(maMG, index, total) {
            let success = false;
            let retryCount = 0;
            let brokeEarly = false;
            let sessionExpired = false;

            activeSubjects.add(maMG);
            await addLog(`[${index + 1}/${total}] Bắt đầu canh/đăng ký mã môn: ${maMG}`);

            const inFlightRequests = new Map(); // reqId -> { abortCtrl, startTime }
            const activePromises = new Map();   // reqId -> Promise
            let reqIdSeq = 0;

            const abortAllSubjectRequests = () => {
                for (const [id, req] of inFlightRequests.entries()) {
                    try { req.abortCtrl.abort(); } catch (e) {}
                }
                inFlightRequests.clear();
                activePromises.clear();
            };

            // Hàm phát sinh và gửi 1 request lên Portal
            function launchRequest() {
                if (!window.__SNIPER_ACTIVE__) return null;
                if (globalInFlight >= MAX_GLOBAL_IN_FLIGHT) return null;
                if (inFlightRequests.size >= MAX_IN_FLIGHT_PER_SUBJECT) return null;
                if (retryCount >= maxRetries) return null;

                retryCount++;
                const currentReqId = ++reqIdSeq;
                const abortCtrl = new AbortController();
                const reqStartTime = Date.now();

                inFlightRequests.set(currentReqId, { abortCtrl, reqStartTime });
                allActiveControllers.add(abortCtrl);
                globalInFlight++;

                const promise = (async () => {
                    const timeoutId = setTimeout(() => {
                        abortCtrl.abort();
                    }, REQUEST_TIMEOUT_MS);

                    try {
                        const formData = new FormData();
                        formData.append("action", "addMonDangKy");
                        formData.append("data", maMG);
                        // CHỈ gửi MaMG thuần, KHÔNG gửi nhomTH hay nhomThucHanh!

                        const response = await fetch(apiUrl, {
                            method: "POST",
                            headers: {
                                "x-requested-with": "XMLHttpRequest",
                                "x-official-request": "TRUE",
                                "Accept": "application/json, text/javascript, */*; q=0.01"
                            },
                            credentials: "include",
                            body: formData,
                            signal: abortCtrl.signal
                        });

                        clearTimeout(timeoutId);
                        const duration = Math.round((Date.now() - reqStartTime) / 1000);

                        // 1. Kiểm tra Redirect đăng nhập
                        const lowerResUrl = (response.url || "").toLowerCase();
                        if (response.redirected && (lowerResUrl.includes("/login") || lowerResUrl.includes("/dang-nhap") || lowerResUrl.includes("/dangnhap") || lowerResUrl.includes("/account/login"))) {
                            return { reqId: currentReqId, sessionExpired: true, duration };
                        }

                        // 2. Kiểm tra Rate Limit (429 / 503)
                        if (response.status === 429 || response.status === 503) {
                            return { reqId: currentReqId, rateLimit: true, status: response.status, duration };
                        }

                        if (!response.ok) {
                            return { reqId: currentReqId, httpError: true, status: response.status, duration };
                        }

                        const rawText = await response.text();
                        try {
                            const json = JSON.parse(rawText);
                            return { reqId: currentReqId, json, duration };
                        } catch (jsonErr) {
                            const lowerText = rawText.toLowerCase();
                            const isLoginRedirect = response.redirected && (
                                lowerResUrl.includes("/login") || 
                                lowerResUrl.includes("/dang-nhap") || 
                                lowerResUrl.includes("/dangnhap") || 
                                lowerResUrl.includes("/account/login")
                            );
                            const hasPasswordInput = lowerText.includes('type="password"') || lowerText.includes("type='password'");
                            const hasUserSession = lowerText.includes('/logout') || lowerText.includes('dang-xuat') || lowerText.includes('đăng xuất') || lowerText.includes('chào,') || lowerText.includes('mssv:');

                            if (isLoginRedirect || (hasPasswordInput && !hasUserSession)) {
                                return { reqId: currentReqId, sessionExpired: true, duration };
                            }
                            return { reqId: currentReqId, htmlNotice: true, duration };
                        }
                    } catch (err) {
                        clearTimeout(timeoutId);
                        if (err.name === 'AbortError') {
                            return { reqId: currentReqId, aborted: true };
                        }
                        return { reqId: currentReqId, networkError: true, error: err?.message || String(err) };
                    } finally {
                        globalInFlight = Math.max(0, globalInFlight - 1);
                        inFlightRequests.delete(currentReqId);
                        allActiveControllers.delete(abortCtrl);
                        activePromises.delete(currentReqId);
                    }
                })();

                activePromises.set(currentReqId, promise);
                return promise;
            }

            // Bắn request đầu tiên
            launchRequest();

            // Vòng lặp điều phối Hedged Requests ("Bắn gối đầu")
            while (!success && !brokeEarly && !sessionExpired && window.__SNIPER_ACTIVE__) {
                // Nếu không còn request nào đang in-flight (do lỗi mạng hoặc timeout):
                if (inFlightRequests.size === 0) {
                    if (retryCount >= maxRetries) break;
                    launchRequest();
                    if (inFlightRequests.size === 0) {
                        await new Promise(r => setTimeout(r, 500));
                        continue;
                    }
                }

                // Tạo timer bắn gối đầu sau HEDGE_DELAY_MS (15s)
                let hedgeTimerId;
                const hedgeTimerPromise = new Promise(resolve => {
                    hedgeTimerId = setTimeout(() => resolve({ isHedgeTimer: true }), HEDGE_DELAY_MS);
                });

                // Đua giữa TẤT CẢ các request đang xếp hàng VÀ timer gối đầu
                const raceResult = await Promise.race([
                    ...activePromises.values(),
                    hedgeTimerPromise
                ]);

                clearTimeout(hedgeTimerId);

                if (!window.__SNIPER_ACTIVE__) break;

                // Kịch bản A: Timer 15s nổ mà request cũ vẫn đang pending -> BẮN GỐI ĐẦU!
                if (raceResult && raceResult.isHedgeTimer) {
                    if (inFlightRequests.size < MAX_IN_FLIGHT_PER_SUBJECT && globalInFlight < MAX_GLOBAL_IN_FLIGHT && retryCount < maxRetries) {
                        const spawned = launchRequest();
                        if (spawned) {
                            await addLog(`🚀 [Bắn gối đầu] Môn ${maMG} vẫn đang pending xếp hàng trên Portal (đã giữ kết nối ${HEDGE_DELAY_MS / 1000}s). Đã bắn thêm 1 request song song để tăng cơ hội!`);
                        }
                    }
                    continue;
                }

                // Kịch bản B: 1 request đã có phản hồi từ Portal
                const res = raceResult;
                if (!res) continue;

                if (res.aborted) {
                    continue;
                }

                // 1. Kiểm tra hết phiên đăng nhập
                if (res.sessionExpired) {
                    abortAllSubjectRequests();
                    sessionExpired = true;
                    await updateStatus(`<span style="color:red; font-weight:bold;">🚨 HẾT PHIÊN ĐĂNG NHẬP!</span>`);
                    await addLog("Phiên đăng nhập đã hết hạn (phát hiện màn hình đăng nhập)!");
                    window.__SNIPER_ACTIVE__ = false;
                    await chrome.storage.local.set({ isRunning: false });
                    await chrome.storage.local.remove(['savedTime']);
                    playBeep('error');
                    notifyUser("🚨 HẾT PHIÊN ĐĂNG NHẬP!", "Vui lòng đăng nhập lại vào Portal ngay!");
                    break;
                }

                // 2. Kiểm tra THÀNH CÔNG (Status === "OK")
                if (res.json && res.json.Status === "OK") {
                    abortAllSubjectRequests();
                    success = true;
                    await addLog(`🎉 THÀNH CÔNG: Đã đăng ký mã môn ${maMG} (thời gian chờ: ${res.duration}s)!`);
                    await updateStatus(`<span style="color:#28a745; font-weight:bold;">✅ Thành công: ${esc(maMG)} (${res.duration}s)</span>`);
                    playBeep('success');
                    notifyUser("🎉 ĐĂNG KÝ THÀNH CÔNG!", `Đã đăng ký thành công mã môn: ${maMG} (${res.duration}s)`);
                    break;
                }

                // 3. Kiểm tra Rate Limit (429 / 503)
                if (res.rateLimit) {
                    const backoff = 2500 + Math.floor(Math.random() * 800);
                    await addLog(`⚠️ Server trả HTTP ${res.status}. Nghỉ ${backoff}ms trước khi gửi thêm...`);
                    await new Promise(r => setTimeout(r, backoff));
                    continue;
                }

                // 4. Kiểm tra phản hồi HTML (Cổng chưa mở)
                if (res.htmlNotice) {
                    if (retryCount === 1 || retryCount % 5 === 0) {
                        await addLog(`⏳ Cổng chưa mở (phản hồi web). Đang giữ kết nối và chờ mở cổng (lần ${retryCount}/${maxRetries})...`);
                    }
                    await new Promise(r => setTimeout(r, baseInterval));
                    continue;
                }

                // 5. Kiểm tra phản hồi JSON nghiệp vụ
                if (res.json) {
                    const errorMsg = res.json.Message || "Lỗi không xác định";

                    // Trường hợp đã đăng ký (do 1 request gối đầu đến trước đã được ghi nhận hoặc môn đã có sẵn)
                    if (errorMsg.includes("đã đăng ký") || errorMsg.includes("đã tồn tại")) {
                        abortAllSubjectRequests();
                        success = true;
                        await addLog(`✅ Môn ${maMG} đã được ghi nhận đăng ký thành công!`);
                        await updateStatus(`<span style="color:#28a745; font-weight:bold;">✅ Đã đăng ký: ${esc(maMG)}</span>`);
                        playBeep('success');
                        notifyUser("🎉 ĐĂNG KÝ THÀNH CÔNG!", `Môn ${maMG} đã được ghi nhận trên Portal.`);
                        break;
                    }

                    if (errorMsg.includes("Hết chỗ")) {
                        if (retryWhenFull) {
                            if (retryCount % 5 === 0) {
                                await addLog(`[Canh slot] ${maMG} hết chỗ. Tiếp tục canh slot (lần ${retryCount})...`);
                            }
                            await new Promise(r => setTimeout(r, baseInterval));
                        } else {
                            abortAllSubjectRequests();
                            await addLog(`⏩ ${maMG} hết chỗ. Bỏ qua do tắt Canh slot.`);
                            brokeEarly = true;
                            break;
                        }
                    } else if (errorMsg.includes("Trùng lịch") || errorMsg.includes("không tồn tại")) {
                        abortAllSubjectRequests();
                        await addLog(`⏩ Bỏ qua ${maMG}: "${errorMsg}"`);
                        brokeEarly = true;
                        break;
                    } else {
                        await addLog(`[Portal] ${maMG}: ${errorMsg}`);
                        await new Promise(r => setTimeout(r, baseInterval));
                    }
                } else if (res.httpError) {
                    await addLog(`Mã ${maMG} lỗi HTTP ${res.status}`);
                    await new Promise(r => setTimeout(r, 1000));
                } else if (res.networkError) {
                    await addLog(`⚠️ Lỗi mạng kết nối mã ${maMG} (${res.error})`);
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            abortAllSubjectRequests();
            activeSubjects.delete(maMG);

            if (!success) {
                if (retryCount >= maxRetries) {
                    await addLog(`❌ Hết ${maxRetries} lần thử cho mã ${maMG}.`);
                } else if (brokeEarly) {
                    await addLog(`⏩ Đã dừng thử mã ${maMG} do lỗi nghiệp vụ.`);
                }
            }

            return { success, maMG, sessionExpired, aborted: !window.__SNIPER_ACTIVE__ };
        }

        // THỰC THI THEO CHẾ ĐỘ
        let hasSuccess = false;
        let successCount = 0;
        // true khi bị dừng giữa chừng: người dùng bấm DỪNG (aborted) hoặc hết phiên (sessionExpired)
        let interrupted = false;

        if (mode === 'fallback') {
            // Chế độ dự phòng: Chạy tuần tự, hễ 1 môn thành công là DỪNG môn sau
            for (let i = 0; i < uniqueList.length; i++) {
                if (!window.__SNIPER_ACTIVE__) {
                    interrupted = true;
                    break;
                }
                const res = await registerSubject(uniqueList[i], i, uniqueList.length);
                if (res.aborted || res.sessionExpired) {
                    interrupted = true;
                    break;
                }
                if (res.success) {
                    hasSuccess = true;
                    successCount++;
                    await addLog(`🎯 Dừng danh sách ưu tiên do môn ${res.maMG} đã đăng ký thành công!`);
                    break;
                }
            }
        } else {
            // Chế độ song song: Kích hoạt tất cả các môn cùng lúc (điều phối tối đa 5 kết nối toàn cục)
            await updateStatus(`⚡ Đang kích hoạt song song ${uniqueList.length} môn...`);
            const tasks = uniqueList.map((maMG, idx) => registerSubject(maMG, idx, uniqueList.length));
            const results = await Promise.allSettled(tasks);
            const successful = results.filter(r => r.status === 'fulfilled' && r.value?.success);
            hasSuccess = successful.length > 0;
            successCount = successful.length;
            interrupted = results.some(r => r.status === 'fulfilled' && r.value && (r.value.aborted || r.value.sessionExpired));
        }

        // Kết thúc sớm (bấm DỪNG / hết phiên): giữ nguyên statusText đã báo trước đó
        if (interrupted) {
            await addLog("🏁 Tiến trình Sniper kết thúc sớm (dừng theo yêu cầu hoặc hết phiên đăng nhập).");
            return;
        }

        const finalStatus = hasSuccess
            ? `🏁 <span style="color:#28a745; font-weight:bold;">Xong: Đã đăng ký thành công ${successCount}/${uniqueList.length} môn!</span>`
            : `🏁 <span style="color:#dc3545; font-weight:bold;">Xong: KHÔNG đăng ký được môn nào. Hãy kiểm tra lại log!</span>`;

        await chrome.storage.local.set({ statusText: finalStatus });

        await addLog("🏁 Toàn bộ tiến trình Sniper đã hoàn thành.");
        notifyUser("🏁 HOÀN THÀNH SNIPER", hasSuccess ? `Đã đăng ký thành công ${successCount} môn!` : "Không đăng ký được môn nào.");
    } catch (e) {
        await addLog(`💥 Lỗi không mong đợi: ${e && e.message ? e.message : e}`);
        await updateStatus(`<span style="color:red;font-weight:bold;">💥 Lỗi: ${esc(e?.message ?? String(e))}</span>`);
    } finally {
        clearInterval(tickerInterval);
        if (window.__SNIPER_ACTIVE_CONTROLLERS__) {
            window.__SNIPER_ACTIVE_CONTROLLERS__.forEach(ctrl => {
                try { ctrl.abort(); } catch (e) {}
            });
            window.__SNIPER_ACTIVE_CONTROLLERS__.clear();
        }
        window.__SNIPER_ACTIVE__ = false;
        try {
            await chrome.storage.local.set({ isRunning: false });
            await chrome.storage.local.remove(['savedTime']);
        } catch (e) {}
    }
}