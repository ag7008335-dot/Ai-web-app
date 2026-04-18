// ═══════════════════════════════════════════
// Logging System
// ═══════════════════════════════════════════

import { MAX_LOG_ENTRIES } from './config.js';

/**
 * Add a log entry to the log console
 * @param {string} msg - Message to log
 * @param {'info'|'success'|'warning'|'error'} type - Log level
 */
export function addLog(msg, type = 'info') {
    const el = document.getElementById('logConsole');
    if (!el) return;

    const now = new Date().toLocaleTimeString('en-US', { hour12: false });
    const d = document.createElement('div');
    d.className = 'log-entry';
    d.innerHTML = `<span class="log-time">[${now}]</span> <span class="log-${type}">${msg}</span>`;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;

    // Keep log size bounded
    while (el.children.length > MAX_LOG_ENTRIES) {
        el.removeChild(el.firstChild);
    }
}

/**
 * Clear the log console
 */
export function clearLog() {
    const el = document.getElementById('logConsole');
    if (!el) return;
    el.innerHTML = '';
    addLog('Log cleared.', 'info');
}

/**
 * Show debug info panel
 */
export function showDebug(text) {
    const el = document.getElementById('debugInfo');
    if (el) {
        el.style.display = 'block';
        el.textContent = text;
    }
}

/**
 * Hide debug info panel
 */
export function hideDebug() {
    const el = document.getElementById('debugInfo');
    if (el) {
        el.style.display = 'none';
    }
}
