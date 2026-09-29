/**
 * HCMUS Course Sniper VIP v2.1
 * @author vuhieu
 */
document.addEventListener('DOMContentLoaded', async () => {
    const DEFAULT_REG_URL = "https://portal.ctdb.hcmus.edu.vn/dang-ky-hoc-phan/sinh-vien-clc";

    // Tab 1: Sniper Elements
    const tabBtnSniper = document.getElementById('tabBtnSniper');
    const tabBtnPicker = document.getElementById('tabBtnPicker');
    const sniperTabContent = document.getElementById('sniperTabContent');
    const pickerTabContent = document.getElementById('pickerTabContent');

    const portalUrlInput = document.getElementById('portalUrl');
    const maMGInput = document.getElementById('maMGList');
    const regModeSelect = document.getElementById('regMode');
    const intervalInput = document.getElementById('interval');
    const maxRetriesInput = document.getElementById('maxRetries');
    const retryWhenFullCheck = document.getElementById('retryWhenFull');
    const soundAlertCheck = document.getElementById('soundAlert');
    const startTimeInput = document.getElementById('startTime');
    const statusDiv = document.getElementById('status');
    const logBox = document.getElementById('logBox');
    const runNowBtn = document.getElementById('runNowBtn');
    const scheduleBtn = document.getElementById('scheduleBtn');
    const stopBtn = document.getElementById('stopBtn');

    // Tab 2: Course Picker Elements
    const studentIdInput = document.getElementById('studentIdInput');
    const loadCoursesBtn = document.getElementById('loadCoursesBtn');
    const courseSearchInput = document.getElementById('courseSearchInput');
    const hideFullClassesCheck = document.getElementById('hideFullClassesCheck');
    const courseCountLabel = document.getElementById('courseCountLabel');
    const courseListContainer = document.getElementById('courseListContainer');
    const selectedCountBadge = document.getElementById('selectedCountBadge');
    const selectedMaMGPreview = document.getElementById('selectedMaMGPreview');
    const applyToSniperBtn = document.getElementById('applyToSniperBtn');
    const clearSelectionBtn = document.getElementById('clearSelectionBtn');

    // Escape HTML helper
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    // --- Tab Switching ---
    function switchTab(tabName) {
        if (tabName === 'sniper') {
            tabBtnSniper.classList.add('active');
            tabBtnPicker.classList.remove('active');
            sniperTabContent.style.display = 'block';
            pickerTabContent.style.display = 'none';
            chrome.storage.local.set({ lastActivePopupTab: 'sniper' });
        } else {
            tabBtnPicker.classList.add('active');
            tabBtnSniper.classList.remove('active');
            pickerTabContent.style.display = 'block';
            sniperTabContent.style.display = 'none';
            chrome.storage.local.set({ lastActivePopupTab: 'picker' });
        }
    }

    tabBtnSniper.addEventListener('click', () => switchTab('sniper'));
    tabBtnPicker.addEventListener('click', () => switchTab('picker'));

    // Tự động phát hiện URL nếu người dùng đang đứng ở tab Portal
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab && activeTab.url && activeTab.url.includes("portal.ctdb.hcmus.edu.vn/dang-ky-hoc-phan")) {
            portalUrlInput.value = activeTab.url;
        }
    } catch (e) {}

    // 1. Tải cấu hình từ Storage
    const stored = await chrome.storage.local.get([
        'savedPortalUrl',
        'savedMaMG', 
        'savedTime', 
        'savedInterval', 
        'savedMaxRetries', 
        'savedMode',
        'savedRetryWhenFull',
        'savedSoundAlert',
        'isRunning', 
        'statusText',
        'logs',
        'savedStudentId',
        'cachedCourses',
        'lastActivePopupTab'
    ]);

    if (stored.savedPortalUrl && !portalUrlInput.value) portalUrlInput.value = stored.savedPortalUrl;
    if (stored.savedMaMG) maMGInput.value = stored.savedMaMG;
    if (stored.savedTime) startTimeInput.value = stored.savedTime;
    if (stored.savedInterval) intervalInput.value = stored.savedInterval;
    if (stored.savedMaxRetries) maxRetriesInput.value = stored.savedMaxRetries;
    if (stored.savedMode) regModeSelect.value = stored.savedMode;
    if (typeof stored.savedRetryWhenFull === 'boolean') retryWhenFullCheck.checked = stored.savedRetryWhenFull;
    if (typeof stored.savedSoundAlert === 'boolean') soundAlertCheck.checked = stored.savedSoundAlert;
    if (stored.savedStudentId) studentIdInput.value = stored.savedStudentId;
    if (stored.lastActivePopupTab === 'picker') switchTab('picker');

    function renderStatus(isRunning, statusText) {
        if (isRunning) {
            statusDiv.innerHTML = `<span style="color:#28a745; font-weight:bold;">🔥 Đang hoạt động...</span><br><small>${statusText || ''}</small>`;
        } else if (statusText) {
            statusDiv.innerHTML = statusText;
        } else {
            statusDiv.innerHTML = "Sẵn sàng...";
        }
    }

    function renderLogs(logs) {
        if (logs && Array.isArray(logs) && logs.length > 0) {
            logBox.style.display = 'block';
            logBox.textContent = logs.slice(-12).join('\n');
            logBox.scrollTop = logBox.scrollHeight;
        } else {
            logBox.style.display = 'none';
        }
    }

    renderStatus(stored.isRunning, stored.statusText);
    renderLogs(stored.logs);

    // Lắng nghe thay đổi trạng thái từ Storage để cập nhật UI
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
            chrome.storage.local.get(['isRunning', 'statusText', 'logs'], (latest) => {
                renderStatus(latest.isRunning, latest.statusText);
                renderLogs(latest.logs);
            });
        }
    });

    // Helper: Tìm hoặc mở tab Portal (dành cho các nút cần focus tab như Chạy Ngay)
    async function getOrOpenPortalTab(targetUrl) {
        const urlToUse = targetUrl || DEFAULT_REG_URL;
        const tabs = await chrome.tabs.query({ url: "*://portal.ctdb.hcmus.edu.vn/*" });
        if (tabs.length > 0) {
            const tab = tabs.find(t => t.active) || tabs[0];
            await chrome.tabs.update(tab.id, { active: true });
            if (tab.windowId) {
                await chrome.windows.update(tab.windowId, { focused: true });
            }
            return tab;
        }
        return await chrome.tabs.create({ url: urlToUse, active: true });
    }

    // Helper: Tìm tab Portal trong im lặng (KHÔNG kích hoạt tab hay focus window để tránh làm đóng Popup extension)
    async function findPortalTabSilently(targetUrl) {
        const tabs = await chrome.tabs.query({ url: "*://portal.ctdb.hcmus.edu.vn/*" });
        if (tabs.length > 0) {
            return tabs.find(t => t.active) || tabs[0];
        }
        return await chrome.tabs.create({ url: targetUrl || DEFAULT_REG_URL, active: false });
    }

    // Helper: Kiểm tra tab có ở trang login không
    async function checkIsLoginPage(tab) {
        if (!tab || !tab.id) return false;
        const lowerUrl = (tab.url || "").toLowerCase();
        if (lowerUrl.includes("dang-ky-hoc-phan")) return false;

        if (lowerUrl.includes("/login") || lowerUrl.includes("/dang-nhap") || lowerUrl.includes("/dangnhap") || lowerUrl.includes("/account/login")) {
            return true;
        }

        try {
            const [injection] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    const path = window.location.pathname.toLowerCase();
                    if (path.includes("/login") || path.includes("/dang-nhap") || path.includes("/dangnhap") || path.includes("/account/login")) return true;
                    return Array.from(document.querySelectorAll('input[type="password"]')).some(el => el.offsetWidth > 0 && el.offsetHeight > 0);
                }
            });
            return injection?.result === true;
        } catch (e) {
            return false;
        }
    }

    // Kiểm tra nhanh màn hình đăng nhập khi mở popup (ưu tiên tab đang active)
    const portalTabs = await chrome.tabs.query({ url: "*://portal.ctdb.hcmus.edu.vn/*" });
    if (portalTabs.length > 0) {
        const activePortalTab = portalTabs.find(t => t.active) || portalTabs[0];
        const isLogin = await checkIsLoginPage(activePortalTab);
        if (isLogin) {
            statusDiv.innerHTML = `<span style="color:#e0a800; font-weight:bold;">⚠️ Portal chưa đăng nhập! Hãy đăng nhập trước giờ G.</span>`;
        }
    }

    // 2. Nút "CHẠY NGAY" (Tab Sniper)
    runNowBtn.addEventListener('click', async () => {
        const rawList = maMGInput.value.trim();
        const targetUrl = portalUrlInput.value.trim() || DEFAULT_REG_URL;
        const interval = Math.max(200, parseInt(intervalInput.value, 10) || 600);
        const maxRetries = Math.max(1, parseInt(maxRetriesInput.value, 10) || 100);
        const mode = regModeSelect.value;
        const retryWhenFull = retryWhenFullCheck.checked;
        const soundAlert = soundAlertCheck.checked;

        if (!rawList) {
            alert("Vui lòng nhập danh sách mã môn học (MaMG)!\nHoặc qua tab 'Tra cứu & Chọn môn' để chọn nhanh.");
            return;
        }

        if (!targetUrl.toLowerCase().includes("dang-ky-hoc-phan")) {
            alert("Đường dẫn phải là trang đăng ký học phần (chứa 'dang-ky-hoc-phan').\nVí dụ: https://portal.ctdb.hcmus.edu.vn/dang-ky-hoc-phan/sinh-vien-clc");
            return;
        }

        const tab = await getOrOpenPortalTab(targetUrl);
        if (!tab || !tab.id) {
            alert("Không thể tìm hoặc mở trang Portal!");
            return;
        }

        const isLogin = await checkIsLoginPage(tab);
        if (isLogin) {
            alert("⚠️ Cảnh báo: Trang Portal đang ở màn hình ĐĂNG NHẬP.\nVui lòng đăng nhập trước khi kích hoạt Sniper!");
            statusDiv.innerHTML = `<span style="color:red; font-weight:bold;">⚠️ Chưa đăng nhập vào Portal!</span>`;
            return;
        }

        // Hủy mọi báo thức cũ và xóa savedTime cũ
        await chrome.alarms.clearAll();
        await chrome.storage.local.remove(['savedTime']);

        const msg = `<span style="color:#28a745; font-weight:bold;">⚡ Đang kích hoạt Sniper ngay...</span>`;

        await chrome.storage.local.set({
            savedPortalUrl: targetUrl,
            savedMaMG: rawList,
            savedInterval: interval,
            savedMaxRetries: maxRetries,
            savedMode: mode,
            savedRetryWhenFull: retryWhenFull,
            savedSoundAlert: soundAlert,
            targetTabId: tab.id,
            runStartedAt: Date.now(),
            isRunning: true,
            statusText: msg,
            logs: [`[${new Date().toLocaleTimeString()}] Bắt đầu chạy ngay...`]
        });

        statusDiv.innerHTML = msg;
        const lowerUrl = (tab.url || "").toLowerCase();
        if (!lowerUrl.includes("dang-ky-hoc-phan")) {
            chrome.tabs.update(tab.id, { url: targetUrl });
        } else {
            // Tab đã ở sẵn trang đăng ký: Bắn thẳng ngay, KHÔNG reload tab làm gián đoạn
            chrome.runtime.sendMessage({ action: "INJECT_SNIPER_NOW", tabId: tab.id, url: lowerUrl }).catch(() => {});
        }
    });

    // 3. Nút "ĐẶT LỊCH" (Tab Sniper)
    scheduleBtn.addEventListener('click', async () => {
        const rawList = maMGInput.value.trim();
        const targetUrl = portalUrlInput.value.trim() || DEFAULT_REG_URL;
        const startTimeValue = startTimeInput.value;
        const interval = Math.max(200, parseInt(intervalInput.value, 10) || 600);
        const maxRetries = Math.max(1, parseInt(maxRetriesInput.value, 10) || 100);
        const mode = regModeSelect.value;
        const retryWhenFull = retryWhenFullCheck.checked;
        const soundAlert = soundAlertCheck.checked;

        if (!rawList) {
            alert("Vui lòng nhập danh sách mã môn học (MaMG)!\nHoặc qua tab 'Tra cứu & Chọn môn' để chọn nhanh.");
            return;
        }

        if (!targetUrl.toLowerCase().includes("dang-ky-hoc-phan")) {
            alert("Đường dẫn phải là trang đăng ký học phần (chứa 'dang-ky-hoc-phan').\nVí dụ: https://portal.ctdb.hcmus.edu.vn/dang-ky-hoc-phan/sinh-vien-clc");
            return;
        }

        if (!startTimeValue) {
            alert("Vui lòng chọn thời điểm kích hoạt!");
            return;
        }

        const targetDate = new Date(startTimeValue);
        const now = new Date();
        const tab = await getOrOpenPortalTab(targetUrl);

        if (!tab || !tab.id) {
            alert("Không thể tìm hoặc mở trang Portal!");
            return;
        }

        const isLogin = await checkIsLoginPage(tab);
        if (isLogin) {
            alert("⚠️ Lưu ý: Portal chưa đăng nhập. Hãy nhớ đăng nhập tài khoản trước giờ hẹn!");
        }

        await chrome.alarms.clearAll();

        const diffMs = targetDate.getTime() - now.getTime();

        if (diffMs <= 0) {
            // Đã quá giờ -> Kích hoạt ngay
            await chrome.storage.local.remove(['savedTime']);
            const msg = `<span style="color:#28a745; font-weight:bold;">🔥 Đã quá giờ hẹn! Chạy Sniper ngay...</span>`;
            await chrome.storage.local.set({
                savedPortalUrl: targetUrl,
                savedMaMG: rawList,
                savedInterval: interval,
                savedMaxRetries: maxRetries,
                savedMode: mode,
                savedRetryWhenFull: retryWhenFull,
                savedSoundAlert: soundAlert,
                targetTabId: tab.id,
                runStartedAt: Date.now(),
                isRunning: true,
                statusText: msg,
                logs: [`[${new Date().toLocaleTimeString()}] Đã quá giờ hẹn, chạy ngay...`]
            });
            statusDiv.innerHTML = msg;
            const lowerUrl = (tab.url || "").toLowerCase();
            if (!lowerUrl.includes("dang-ky-hoc-phan")) {
                chrome.tabs.update(tab.id, { url: targetUrl });
            } else {
                // Tab đã ở sẵn trang đăng ký: Bắn thẳng ngay, KHÔNG reload tab làm gián đoạn
                chrome.runtime.sendMessage({ action: "INJECT_SNIPER_NOW", tabId: tab.id, url: lowerUrl }).catch(() => {});
            }
        } else {
            // Chưa đến giờ -> Lên lịch báo thức
            const timeStr = targetDate.toLocaleString('vi-VN');
            const msg = `⏰ Đã hẹn: <span class="highlight">${timeStr}</span>.<br>Chế độ: <b>${mode === 'concurrent' ? 'Song song' : 'Dự phòng'}</b> | Delay: <b>${interval}ms</b>`;

            await chrome.storage.local.set({
                savedPortalUrl: targetUrl,
                savedMaMG: rawList,
                savedTime: startTimeValue,
                savedInterval: interval,
                savedMaxRetries: maxRetries,
                savedMode: mode,
                savedRetryWhenFull: retryWhenFull,
                savedSoundAlert: soundAlert,
                targetTabId: tab.id,
                isRunning: false,
                statusText: msg,
                logs: [`[${new Date().toLocaleTimeString()}] Đã đặt lịch lúc ${timeStr}`]
            });

            if (diffMs > 30000) {
                chrome.alarms.create("prepareSniper", { delayInMinutes: (diffMs - 15000) / 60000 });
            }
            chrome.alarms.create("startSniper", { delayInMinutes: Math.max(diffMs, 30000) / 60000 });

            statusDiv.innerHTML = msg;
        }
    });

    // 4. Nút "DỪNG / HỦY"
    stopBtn.addEventListener('click', async () => {
        await chrome.alarms.clearAll();
        await chrome.storage.local.remove(['savedTime']);

        const stopMsg = `<span style="color:#dc3545; font-weight:bold;">⏹️ Đã dừng / hủy Sniper!</span>`;

        await chrome.storage.local.set({
            isRunning: false,
            statusText: stopMsg
        });

        const { targetTabId } = await chrome.storage.local.get(['targetTabId']);
        if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, { action: "STOP_SNIPER" }).catch(() => {});
        }
        chrome.runtime.sendMessage({ action: "STOP_SNIPER" }).catch(() => {});

        statusDiv.innerHTML = stopMsg;
    });

    // ==========================================
    // 5. TAB 2: COURSE PICKER / TRA CỨU MÔN HỌC
    // ==========================================
    let rawCoursesList = [];
    const selectedClasses = new Map(); // key: MaMG, value: { maMG, nhomTH, kyHieu, tenMH, maLopHP }

    // Cập nhật giao diện thống kê lớp đã chọn
    function updateSelectedUI() {
        selectedCountBadge.textContent = selectedClasses.size;
        if (selectedClasses.size === 0) {
            selectedMaMGPreview.textContent = "";
            return;
        }
        const previewItems = Array.from(selectedClasses.values()).map(v => `${v.maMG}`);
        selectedMaMGPreview.textContent = previewItems.join(', ');
    }

    // Hiển thị danh sách môn học
    function renderCourses() {
        if (!rawCoursesList || rawCoursesList.length === 0) {
            courseCountLabel.textContent = "Chưa có dữ liệu";
            courseListContainer.innerHTML = `
                <div style="text-align: center; color: #94a3b8; padding: 30px 10px; font-size: 11px;">
                    👉 Nhập MSSV rồi bấm <b>"📥 Tải danh sách"</b> để lấy danh sách môn học trực tiếp từ Portal.
                </div>`;
            return;
        }

        const query = (courseSearchInput.value || "").trim().toLowerCase();
        const hideFull = hideFullClassesCheck.checked;

        // Lọc môn học
        const filtered = rawCoursesList.filter(item => {
            if (hideFull && item.SoSVTT) {
                const parts = item.SoSVTT.split('/');
                const cur = parseInt(parts[0], 10) || 0;
                const max = parseInt(parts[1], 10) || 0;
                if (max > 0 && cur >= max) return false;
            }

            if (!query) return true;

            const tenMH = (item.TenMH || "").toLowerCase();
            const kyHieu = (item.KyHieu || "").toLowerCase();
            const maLop = (item.MaLopHP || item.MaLopSH || "").toLowerCase();
            const maMG = String(item.MaMG || "");
            const lichLT = (item.LichHocLT || "").toLowerCase();
            const lichTH = (item.LichHocTH || "").toLowerCase();

            return tenMH.includes(query) || 
                   kyHieu.includes(query) || 
                   maLop.includes(query) || 
                   maMG.includes(query) ||
                   lichLT.includes(query) ||
                   lichTH.includes(query);
        });

        courseCountLabel.textContent = `Hiển thị ${filtered.length}/${rawCoursesList.length} lớp`;

        if (filtered.length === 0) {
            courseListContainer.innerHTML = `
                <div style="text-align: center; color: #64748b; padding: 30px 10px; font-size: 11px;">
                    🔍 Không tìm thấy lớp nào khớp với từ khóa "<b>${esc(query)}</b>"
                </div>`;
            return;
        }

        // Nhóm các lớp theo môn học (KyHieu + TenMH)
        const groups = {};
        filtered.forEach(item => {
            const groupKey = `${item.KyHieu || 'OTHER'}__${item.TenMH || 'Môn học'}`;
            if (!groups[groupKey]) {
                groups[groupKey] = {
                    kyHieu: item.KyHieu || '',
                    tenMH: item.TenMH || '',
                    soTinChi: item.SoTinChi || 0,
                    hocBangTA: !!item.HocBangTA,
                    items: []
                };
            }
            groups[groupKey].items.push(item);
        });

        let html = '';
        for (const key in groups) {
            const grp = groups[key];
            html += `
                <div class="course-group">
                    <div class="course-group-header">
                        <span class="badge-code">${esc(grp.kyHieu)}</span>
                        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(grp.tenMH)}</span>
                        ${grp.hocBangTA ? '<span class="badge-en">Eng</span>' : ''}
                        <span class="badge-tc">${grp.soTinChi} TC</span>
                    </div>
                    <div class="course-class-list">`;

            grp.items.forEach(item => {
                const isSelected = selectedClasses.has(item.MaMG);
                
                // Trạng thái sĩ số (đầy / còn)
                let slotHtml = '';
                if (item.SoSVTT) {
                    const parts = item.SoSVTT.split('/');
                    const cur = parseInt(parts[0], 10) || 0;
                    const max = parseInt(parts[1], 10) || 0;
                    const isFull = max > 0 && cur >= max;
                    slotHtml = `<span class="slot-tag ${isFull ? 'slot-full' : 'slot-avail'}">${isFull ? 'Hết ' : ''}${esc(item.SoSVTT)}</span>`;
                }

                const ltSchedule = item.LichHocLT ? `LT: ${item.LichHocLT.trim()}` : '';
                const thSchedule = item.LichHocTH ? `TH: ${item.LichHocTH.trim()}` : '';
                const nhomTHText = item.MaNhomTH && item.MaNhomTH > 0 ? `(Nhóm TH: ${item.MaNhomTH})` : '';

                html += `
                    <label class="class-item ${isSelected ? 'selected' : ''}" data-mamg="${item.MaMG}">
                        <input type="checkbox" class="class-checkbox" data-mamg="${item.MaMG}" ${isSelected ? 'checked' : ''}>
                        <div class="class-details">
                            <div class="class-row-1">
                                <span class="badge-mamg">#${item.MaMG}</span>
                                <span class="class-hp-name">Lớp: ${esc(item.MaLopHP || item.MaLopSH || 'CLC')}</span>
                                ${slotHtml}
                            </div>
                            <div class="class-row-2">
                                ${ltSchedule ? `<span>${esc(ltSchedule)}</span>` : ''}
                                ${thSchedule ? `<span>${esc(thSchedule)} ${nhomTHText}</span>` : (nhomTHText ? `<span>${nhomTHText}</span>` : '')}
                            </div>
                        </div>
                    </label>`;
            });

            html += `
                    </div>
                </div>`;
        }

        courseListContainer.innerHTML = html;

        // Bắt sự kiện click chọn lớp
        courseListContainer.querySelectorAll('.class-item').forEach(labelEl => {
            const checkbox = labelEl.querySelector('.class-checkbox');
            const maMGNum = parseInt(checkbox.dataset.mamg, 10);
            const itemData = rawCoursesList.find(c => c.MaMG === maMGNum);

            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    labelEl.classList.add('selected');
                    if (itemData) {
                        selectedClasses.set(itemData.MaMG, {
                            maMG: itemData.MaMG,
                            kyHieu: itemData.KyHieu || '',
                            tenMH: itemData.TenMH || '',
                            maLopHP: itemData.MaLopHP || ''
                        });
                    }
                } else {
                    labelEl.classList.remove('selected');
                    selectedClasses.delete(maMGNum);
                }
                updateSelectedUI();
            });
        });
    }

    // Helper: Thực thi fetch API loadDangKyHocPhan trực tiếp trong tab Portal (sử dụng session & cookies thật)
    async function fetchCoursesFromPortal(tabId, url, mssv) {
        const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (endpoint, studentCode) => {
                try {
                    const formData = new FormData();
                    formData.append("action", "loadDangKyHocPhan");
                    formData.append("data", studentCode);

                    const response = await fetch(endpoint, {
                        method: "POST",
                        headers: {
                            "x-requested-with": "XMLHttpRequest",
                            "x-official-request": "TRUE",
                            "Accept": "*/*"
                        },
                        credentials: "include",
                        body: formData
                    });

                    if (!response.ok) {
                        return { success: false, error: `Máy chủ trả về HTTP ${response.status}` };
                    }

                    const rawText = await response.text();
                    try {
                        const json = JSON.parse(rawText);
                        return { success: true, data: json };
                    } catch (e) {
                        return { 
                            success: false, 
                            error: "Server trả về giao diện HTML thay vì dữ liệu JSON (Cổng chưa mở hoặc phiên đăng nhập chưa hợp lệ)." 
                        };
                    }
                } catch (err) {
                    return { success: false, error: err?.message || String(err) };
                }
            },
            args: [url, mssv]
        });
        return res?.result;
    }

    // Nút "Tải danh sách môn"
    loadCoursesBtn.addEventListener('click', async () => {
        const studentId = studentIdInput.value.trim();
        const targetUrl = portalUrlInput.value.trim() || DEFAULT_REG_URL;

        if (!studentId) {
            alert("Vui lòng nhập Mã số sinh viên (MSSV)!");
            return;
        }

        await chrome.storage.local.set({ savedStudentId: studentId });

        loadCoursesBtn.disabled = true;
        loadCoursesBtn.innerHTML = `<span>⏳ Đang tải...</span>`;
        courseListContainer.innerHTML = `
            <div style="text-align: center; padding: 35px 10px; color: #0066cc;">
                <div style="font-size: 13px; font-weight: bold; margin-bottom: 4px;">⏳ Đang kết nối Portal...</div>
                <small style="color: #64748b;">Đang lấy dữ liệu môn học cho MSSV: <b>${esc(studentId)}</b></small>
            </div>`;

        try {
            const tab = await findPortalTabSilently(targetUrl);
            if (!tab || !tab.id) {
                alert("Không tìm thấy tab Portal! Hãy mở hoặc tải lại trang Portal trước.");
                return;
            }

            const res = await fetchCoursesFromPortal(tab.id, targetUrl, studentId);
            if (res && res.success && res.data) {
                const d = res.data;
                const listChua = d?.Results?.ListChuaDangKy || [];
                const listDa = d?.Results?.ListDaDangKy || [];
                const allCourses = [...listChua, ...listDa];

                if (allCourses.length > 0) {
                    rawCoursesList = allCourses;
                    await chrome.storage.local.set({ cachedCourses: rawCoursesList });
                    renderCourses();
                } else {
                    courseListContainer.innerHTML = `
                        <div style="text-align: center; padding: 30px 10px; color: #eab308; font-size: 11px;">
                            ⚠️ Không tìm thấy môn học nào cho MSSV <b>${esc(studentId)}</b>.<br>
                            <small style="color: #64748b;">${esc(d?.Message || 'Có thể cổng chưa mở đợt đăng ký hoặc sai MSSV.')}</small>
                        </div>`;
                    courseCountLabel.textContent = "0 lớp";
                }
            } else {
                const errMsg = res?.error || "Lỗi không xác định khi tải dữ liệu";
                courseListContainer.innerHTML = `
                    <div style="text-align: center; padding: 30px 10px; color: #dc3545; font-size: 11px;">
                        ❌ Lỗi tải danh sách môn: <b>${esc(errMsg)}</b><br>
                        <small style="color: #64748b;">Hãy chắc chắn rằng bạn đã đăng nhập tài khoản trên tab Portal.</small>
                    </div>`;
            }
        } catch (err) {
            courseListContainer.innerHTML = `
                <div style="text-align: center; padding: 30px 10px; color: #dc3545; font-size: 11px;">
                    ❌ Lỗi: ${esc(err?.message || String(err))}
                </div>`;
        } finally {
            loadCoursesBtn.disabled = false;
            loadCoursesBtn.innerHTML = `<span>📥 Tải danh sách</span>`;
        }
    });

    // Lắng nghe ô tìm kiếm và checkbox ẩn lớp đầy
    courseSearchInput.addEventListener('input', () => renderCourses());
    hideFullClassesCheck.addEventListener('change', () => renderCourses());

    // Nút "Nạp vào danh sách Sniper"
    applyToSniperBtn.addEventListener('click', () => {
        if (selectedClasses.size === 0) {
            alert("Bạn chưa chọn lớp học nào!\nHãy tick chọn các lớp bạn muốn đăng ký trước khi nạp vào Sniper.");
            return;
        }

        const mamgListFormatted = Array.from(selectedClasses.values()).map(v => `${v.maMG}`).join(', ');

        maMGInput.value = mamgListFormatted;
        chrome.storage.local.set({ savedMaMG: mamgListFormatted });

        // Tự động chuyển về Tab 1: Sniper
        switchTab('sniper');

        // Báo trạng thái thành công
        statusDiv.innerHTML = `<span style="color:#28a745; font-weight:bold;">✅ Đã nạp thành công ${selectedClasses.size} mã môn vào Sniper!</span>`;

        // Highlight nhẹ vào ô danh sách mã môn
        maMGInput.focus();
        maMGInput.style.borderColor = "#28a745";
        setTimeout(() => {
            maMGInput.style.borderColor = "#ced4da";
        }, 1500);
    });

    // Nút "Bỏ chọn tất cả"
    clearSelectionBtn.addEventListener('click', () => {
        selectedClasses.clear();
        renderCourses();
        updateSelectedUI();
    });

    // Khôi phục danh sách môn học từ bộ nhớ đệm (nếu có)
    if (stored.cachedCourses && Array.isArray(stored.cachedCourses) && stored.cachedCourses.length > 0) {
        rawCoursesList = stored.cachedCourses;
        renderCourses();
    }
});