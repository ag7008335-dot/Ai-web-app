// ═══════════════════════════════════════════
// Camera Management — Dynamic Resolution
// ═══════════════════════════════════════════

import { CAMERA_CONSTRAINTS } from './config.js';
import { state } from './state.js';
import { addLog } from './logger.js';
import { showToast } from './toast.js';

// ──────────────────────────────────────────────
// Camera device discovery
// ──────────────────────────────────────────────

async function getVideoDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return [];
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput');
}

/**
 * Populate the camera dropdown with friendly names only (no IDs).
 * Called on init and again after permission is granted so labels are available.
 */
export async function initCameraSelection() {
    const select = document.getElementById('cameraSelect');
    if (!select) return;

    try {
        const devices = await getVideoDevices();
        state.availableCameras = devices;

        // Remember current handler state so we don't double-bind
        const alreadyBound = select.dataset.bound === '1';

        select.innerHTML = '';

        if (devices.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No camera found';
            select.appendChild(opt);
            select.disabled = true;
            return;
        }

        select.disabled = false;

        devices.forEach((device, idx) => {
            const rawLabel = device.label || '';
            // Strip deviceId hash or technical suffix to keep it readable
            const friendlyName = rawLabel
                ? rawLabel.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim()
                : `Camera ${idx + 1}`;

            const opt = document.createElement('option');
            opt.value = device.deviceId;
            opt.textContent = friendlyName;
            opt.title = rawLabel || friendlyName;
            select.appendChild(opt);
        });

        if (!state.selectedDeviceId && devices[0]) {
            state.selectedDeviceId = devices[0].deviceId;
        }

        if (state.selectedDeviceId) {
            select.value = state.selectedDeviceId;
        }

        // Bind change handler only once
        if (!alreadyBound) {
            select.dataset.bound = '1';
            select.addEventListener('change', async (e) => {
                const newId = e.target.value || null;
                state.selectedDeviceId = newId;
                addLog(`🎥 Camera switched`, 'info');

                if (state.isWebcamOn && newId) {
                    try {
                        stopCamera();
                        await startCamera(newId);
                        showToast('Switched camera', 'info');
                    } catch (err) {
                        addLog(`❌ Failed to switch camera: ${err.message}`, 'error');
                        showToast('Failed to switch camera', 'error');
                    }
                }
            });
        }
    } catch (err) {
        addLog(`❌ Failed to list cameras: ${err.message}`, 'error');
    }
}

/**
 * Start webcam with max available resolution (or a selected device)
 */
export async function startCamera(preferredDeviceId = null) {
    try {
        addLog('📷 Requesting camera (dynamic resolution)...', 'info');

        // Clone constraints so we don't mutate the shared config
        const constraints = {
            video: {
                ...CAMERA_CONSTRAINTS.video,
                width: { ...CAMERA_CONSTRAINTS.video.width },
                height: { ...CAMERA_CONSTRAINTS.video.height },
                frameRate: { ...CAMERA_CONSTRAINTS.video.frameRate },
            },
            audio: false,
        };

        const deviceId = preferredDeviceId || state.selectedDeviceId || null;
        if (deviceId) {
            // When a specific device is chosen, use deviceId and drop facingMode
            delete constraints.video.facingMode;
            constraints.video.deviceId = { exact: deviceId };
        }

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        state.webcamStream = stream;
        state.isWebcamOn = true;

        const video = document.getElementById('webcamVideo');
        if (video) {
            video.srcObject = stream;

            // Wait for video metadata to get real resolution
            await new Promise((resolve, reject) => {
                video.onloadedmetadata = () => {
                    video.play().then(resolve).catch(reject);
                };
                setTimeout(() => reject(new Error('Video metadata timeout')), 5000);
            });

            // Get actual resolution from track settings
            const track = stream.getVideoTracks()[0];
            const settings = track.getSettings();
            const w = settings.width || video.videoWidth;
            const h = settings.height || video.videoHeight;
            const fps = settings.frameRate || '?';

            // Persist selected device id
            if (settings.deviceId) {
                state.selectedDeviceId = settings.deviceId;
            }

            // Re-populate dropdown now that permission is granted
            // (labels become available after first getUserMedia)
            await initCameraSelection();

            state.videoWidth = w;
            state.videoHeight = h;

            addLog(`📐 Resolution: ${w}×${h} @ ${Math.round(fps)}fps`, 'success');
            addLog(`📷 Device: ${track.label}`, 'info');

            // Update status bar resolution
            const resEl = document.getElementById('resolutionDisplay');
            if (resEl) resEl.textContent = `${w}×${h}`;

            // Sync canvas to real video resolution
            const canvas = document.getElementById('outputCanvas');
            if (canvas) {
                canvas.width = w;
                canvas.height = h;
                addLog(`🖼️ Canvas synced: ${w}×${h}`, 'info');
            }
        }

        // Hide raw placeholder
        const phRaw = document.getElementById('placeholderRaw');
        if (phRaw) phRaw.style.display = 'none';

        addLog('✅ Camera started', 'success');
        return stream;

    } catch (err) {
        addLog(`❌ Camera error: ${err.message}`, 'error');
        showToast('Camera access denied or unavailable', 'error');
        throw err;
    }
}

/**
 * Stop webcam
 */
export function stopCamera() {
    if (state.webcamStream) {
        state.webcamStream.getTracks().forEach(t => t.stop());
        state.webcamStream = null;
    }
    state.isWebcamOn = false;
    state.videoWidth = 0;
    state.videoHeight = 0;

    const video = document.getElementById('webcamVideo');
    if (video) video.srcObject = null;

    // Show placeholders again
    const phRaw = document.getElementById('placeholderRaw');
    if (phRaw) phRaw.style.display = 'flex';

    const phSkel = document.getElementById('placeholderSkeleton');
    if (phSkel) phSkel.style.display = 'flex';

    // Reset resolution display
    const resEl = document.getElementById('resolutionDisplay');
    if (resEl) resEl.textContent = '—';

    addLog('📷 Camera stopped', 'info');
}
