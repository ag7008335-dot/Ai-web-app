// ═══════════════════════════════════════════
// Server Health Check
// ═══════════════════════════════════════════

import { API_BASE, HEALTH_CHECK_INTERVAL } from './config.js';
import { state } from './state.js';
import { addLog } from './logger.js';

let healthInterval = null;

/**
 * Check if server is reachable and has MP files
 */
export async function checkServerHealth() {
    const dot = document.getElementById('statusDot');
    const txt = document.getElementById('statusText');

    // 1. ایجاد کنترلر برای مدیریت تایم‌اوت
    const controller = new AbortController();
    
    // 2. تنظیم تایمر: اگر بعد از 5 ثانیه جوابی نیامد، درخواست لغو شود
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
        // 3. ارسال درخواست با سیگنال کنترلر
        const resp = await fetch(`${API_BASE}/api/health`, {
            signal: controller.signal
        });
        
        // 4. اگر پاسخ آمد، تایمر را پاک کن تا بیهوده اجرا نشود
        clearTimeout(timeoutId);

        if (resp.ok) {
            const data = await resp.json();
            
            // بروزرسانی UI
            if (dot) {
                dot.classList.add('online');
                dot.classList.remove('offline');
            }
            if (txt) txt.textContent = 'Server online';

            // بررسی فایل‌های مدیاپایپ
            if (data.mediapipe_files) {
                state.serverMPReady = true;
                // فقط اگر وضعیت قبلی سرور متفاوت بود لاگ بزن (برای جلوگیری از اسپم شدن کنسول)
                // addLog('✅ Server online — MediaPipe files available', 'success');
            } else {
                addLog('⚠️ Server online — MediaPipe files NOT found', 'warning');
                showSetupNotice();
            }
            return true;
        }
    } catch (err) {
        // اگر خطایی رخ داد (چه قطعی نت، چه تایم‌اوت)
        if (err.name === 'AbortError') {
            // خطای تایم‌اوت: یعنی سرور کند است یا پاسخ نمی‌دهد
             addLog('⚠️ Server request timed out', 'warning');
        } else {
            // سایر خطاها
             // addLog(`⚠️ Server check failed: ${err.message}`, 'error'); 
        }
    }

    // اگر به اینجا رسیدیم یعنی یا خطا داشتیم یا ریسپانس ok نبود
    if (dot) {
        dot.classList.add('offline');
        dot.classList.remove('online');
    }
    if (txt) txt.textContent = 'Server offline';
    
    // اینجا return false برمی‌گردانیم اما چون در catch مدیریت شده، برنامه کرش نمی‌کند
    return false;
}

/**
 * Show the setup notice panel with download commands
 */
function showSetupNotice() {
    const notice = document.getElementById('setupNotice');
    const codeEl = document.getElementById('setupCommands');
    if (!notice) return;

    // اگر قبلا نمایش داده شده، دوباره رندر نکن
    if (notice.style.display === 'block') return;

    notice.style.display = 'block';
    if (codeEl) {
        codeEl.textContent =
`# Download MediaPipe files to static/mediapipe/
mkdir -p static/mediapipe
cd static/mediapipe

# Vision bundle
curl -L -o vision_bundle.mjs "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs"

# WASM files
curl -L -o vision_wasm_internal.wasm "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.wasm"
curl -L -o vision_wasm_internal.js "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js"

# Model
curl -L -o pose_landmarker_lite.task "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"`;
    }
}

/**
 * Start periodic health checks
 */
export function startHealthChecks() {
    // یک بار بلافاصله چک کن
    checkServerHealth();
    // سپس طبق بازه زمانی تکرار کن
    healthInterval = setInterval(checkServerHealth, HEALTH_CHECK_INTERVAL);
}

/**
 * Stop periodic health checks
 */
export function stopHealthChecks() {
    if (healthInterval) {
        clearInterval(healthInterval);
        healthInterval = null;
    }
}
