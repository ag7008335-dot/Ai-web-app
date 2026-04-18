// ═══════════════════════════════════════════
// Toast Notification System
// ═══════════════════════════════════════════

/**
 * Show a toast notification
 * @param {string} msg - Message text
 * @param {'info'|'success'|'error'} type - Toast type
 */
export function showToast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}
