// ═══════════════════════════════════════════
// Pose Detection Loop — With Jump Detection
// ═══════════════════════════════════════════

import { state } from './state.js';
import { addLog } from './logger.js';
import { drawSkeleton, clearCanvas } from './skeleton-renderer.js';
import {
    getProcCanvasSize,
    drawVideoToProcCanvas,
    mapLandmarksToVideoSpace,
    mapNormPointToVideoSpace,
} from './frame-transform.js';
import {
    getActiveDetector,
    resetActiveDetector,
    processActiveDetector,
    getActiveVisualizationData,
} from './movement-detectors.js';

let jumpOverlayEnabled = true;
const POSE_INPUT_SCALE = 0.5; // Processing frame ~50% of display frame
let pendingApexSnapshot = null;

/**
 * Start the pose detection loop
 */
export function startLoop() {
    if (state.poseRunning) return;
    state.poseRunning = true;

    const video = document.getElementById('webcamVideo');
    const canvas = document.getElementById('outputCanvas');
    const ctx = canvas.getContext('2d');

    // Offscreen canvas for smaller MediaPipe input frame
    const procCanvas = document.createElement('canvas');
    const procCtx = procCanvas.getContext('2d');

    addLog('🦴 Pose loop started', 'success');

    // Hide skeleton placeholder
    const phSkel = document.getElementById('placeholderSkeleton');
    if (phSkel) phSkel.style.display = 'none';

    // Reset active detector on start
    resetActiveDetector();
    updateJumpUI();

    function loop() {
        if (!state.poseRunning) return;

        if (video.readyState >= 2 && state.poseLandmarker) {

            // ── Dynamic canvas sync ──
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const rot = state.viewRotation || 0;
            const eff = getProcCanvasSize(vw, vh, rot);
            if (vw && vh && (canvas.width !== vw || canvas.height !== vh)) {
                canvas.width = vw;
                canvas.height = vh;
                state.videoWidth = vw;
                state.videoHeight = vh;

                const resEl = document.getElementById('resolutionDisplay');
                if (resEl) resEl.textContent = `${vw}×${vh}`;
            }

            if (vw && vh) {
                const needProcW = Math.max(1, Math.round(eff.w * POSE_INPUT_SCALE));
                const needProcH = Math.max(1, Math.round(eff.h * POSE_INPUT_SCALE));
                if (procCanvas.width !== needProcW || procCanvas.height !== needProcH) {
                    procCanvas.width = needProcW;
                    procCanvas.height = needProcH;
                }
            }

            const now = performance.now();
            const nowSeconds = now / 1000;

            // ── FPS ──
            state.fpsCounter++;
            if (now - state.lastFpsTime >= 1000) {
                state.currentFps = state.fpsCounter;
                state.fpsCounter = 0;
                state.lastFpsTime = now;
                updateFpsDisplay(state.currentFps);
            }

            // ── Detect ──
            try {
                // اگر رزولوشن پردازشی آماده است، فریم کوچک‌تر را به MediaPipe بده
                if (procCanvas.width && procCanvas.height) {
                    const mirror = !!state.viewMirrored;
                    drawVideoToProcCanvas(
                        procCtx,
                        video,
                        procCanvas.width,
                        procCanvas.height,
                        rot,
                        mirror,
                        POSE_INPUT_SCALE
                    );

                    const result = state.poseLandmarker.detectForVideo(procCanvas, now);

                    if (result && result.landmarks && result.landmarks.length > 0) {
                        const landmarksProcessed = result.landmarks[0];
                        const landmarksDraw = mapLandmarksToVideoSpace(
                            landmarksProcessed,
                            vw,
                            vh,
                            procCanvas.width,
                            procCanvas.height,
                            rot,
                            mirror,
                            POSE_INPUT_SCALE
                        );

                        drawSkeleton(ctx, canvas, landmarksDraw);

                        if (state.jumpEnabled) {
                            const { event } = processActiveDetector(landmarksProcessed, nowSeconds);

                            try {
                                const viz = getActiveVisualizationData();
                                if (
                                    viz &&
                                    viz.isCalibrated &&
                                    viz.state === 'SEARCHING_PEAK' &&
                                    !pendingApexSnapshot &&
                                    video &&
                                    video.videoWidth &&
                                    video.videoHeight
                                ) {
                                    const effSnap = getProcCanvasSize(vw, vh, rot);
                                    const snapCanvas = document.createElement('canvas');
                                    snapCanvas.width = effSnap.w;
                                    snapCanvas.height = effSnap.h;
                                    const sctx = snapCanvas.getContext('2d');
                                    if (sctx) {
                                        drawVideoToProcCanvas(
                                            sctx,
                                            video,
                                            effSnap.w,
                                            effSnap.h,
                                            rot,
                                            mirror,
                                            1.0
                                        );
                                        pendingApexSnapshot = snapCanvas.toDataURL('image/png');
                                    }
                                }
                            } catch (err) {
                                // ignore apex capture errors
                            }

                            if (event && event.type === 'jump_complete') {
                                if (pendingApexSnapshot) {
                                    event.apex_png_b64 = pendingApexSnapshot;
                                }
                                pendingApexSnapshot = null;
                                onJumpComplete(event);
                            }

                            if (jumpOverlayEnabled) {
                                drawJumpOverlay(ctx, canvas, {
                                    procW: procCanvas.width,
                                    procH: procCanvas.height,
                                    rot,
                                    mirror,
                                    scale: POSE_INPUT_SCALE,
                                });
                            }
                        }

                    } else {
                        clearCanvas(ctx, canvas);
                    }
                }
            } catch (err) {
                if (state.fpsCounter % 200 === 0) {
                    console.warn('[Pose] Frame error:', err.message);
                }
            }
        }

        state.animFrameId = requestAnimationFrame(loop);
    }

    state.animFrameId = requestAnimationFrame(loop);
}

/**
 * Stop pose loop
 */
export function stopLoop() {
    state.poseRunning = false;
    if (state.animFrameId) {
        cancelAnimationFrame(state.animFrameId);
        state.animFrameId = null;
    }
    addLog('🦴 Pose loop stopped', 'info');
}

/**
 * Handle jump completion
 */
function onJumpComplete(event) {
    // Logging and toast handling are centralized in app.js via the jumpDetected event.
    updateJumpUI();
    window.dispatchEvent(new CustomEvent('jumpDetected', { detail: event }));
}


/**
 * Update jump counter UI
 */
function updateJumpUI() {
    const countEl = document.getElementById('jumpCount');
    const heightEl = document.getElementById('jumpHeight');
    const flightEl = document.getElementById('jumpFlightTime');
    const statusEl = document.getElementById('jumpStatus');

    const detector = getActiveDetector();

    if (countEl && detector) {
        countEl.textContent = detector.counter ?? 0;
    }

    const lastJump = detector ? detector.lastJumpData : null;
    if (lastJump) {
        if (heightEl) heightEl.textContent = `${lastJump.jumpHeightCm.toFixed(1)} cm`;
        if (flightEl) flightEl.textContent = `${(lastJump.flightTime * 1000).toFixed(0)} ms`;
    }

    if (statusEl) {
        if (!detector || !detector.isCalibrated) {
            statusEl.textContent = 'Calibrating...';
            statusEl.className = 'status-calibrating';
        } else {
            statusEl.textContent = detector.state === 'SEARCHING_PEAK' ? 'In Air!' : 'Ready';
            statusEl.className = detector.state === 'SEARCHING_PEAK' ? 'status-jumping' : 'status-ready';
        }
    }
}

/**
 * Map normalized coords from jump detector (processed frame) to video canvas pixels.
 */
function mapVizToCanvas(nx, ny, canvas, mapping) {
    const vw = state.videoWidth || canvas.width;
    const vh = state.videoHeight || canvas.height;
    const { x, y } = mapNormPointToVideoSpace(
        nx,
        ny,
        vw,
        vh,
        mapping.procW,
        mapping.procH,
        mapping.rot,
        mapping.mirror,
        mapping.scale
    );
    return { cx: x * canvas.width, cy: y * canvas.height };
}

/** Horizontal line at fixed normalized Y in processed frame → segment on video canvas */
function mapHLineToCanvas(yNorm, canvas, mapping) {
    const a = mapVizToCanvas(0, yNorm, canvas, mapping);
    const b = mapVizToCanvas(1, yNorm, canvas, mapping);
    return { x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy };
}

/**
 * Draw jump detection overlay on canvas
 */
function drawJumpOverlay(ctx, canvas, mapping) {
    const viz = getActiveVisualizationData();
    if (!viz) return;
    const w = canvas.width;
    const h = canvas.height;

    if (!viz.isCalibrated) {
        ctx.fillStyle = 'rgba(255, 255, 0, 0.8)';
        ctx.font = 'bold 24px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Calibrating... Stand still', w / 2, 60);
        return;
    }

    const dynamicRise = viz.riseThreshold * viz.torsoLen;
    const dynamicFall = viz.fallThreshold * viz.torsoLen;

    if (viz.state === 'SEARCHING_LOW') {
        const lnUp = mapHLineToCanvas(viz.localMin - dynamicRise, canvas, mapping);
        ctx.strokeStyle = '#00FF00';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 5]);
        ctx.beginPath();
        ctx.moveTo(lnUp.x1, lnUp.y1);
        ctx.lineTo(lnUp.x2, lnUp.y2);
        ctx.stroke();
        ctx.setLineDash([]);

        const lnMin = mapHLineToCanvas(viz.localMin, canvas, mapping);
        ctx.strokeStyle = 'rgba(150, 150, 150, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lnMin.x1, lnMin.y1);
        ctx.lineTo(lnMin.x2, lnMin.y2);
        ctx.stroke();
    } else if (viz.state === 'SEARCHING_PEAK') {
        const lnDown = mapHLineToCanvas(viz.localMax + dynamicFall, canvas, mapping);
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 5]);
        ctx.beginPath();
        ctx.moveTo(lnDown.x1, lnDown.y1);
        ctx.lineTo(lnDown.x2, lnDown.y2);
        ctx.stroke();
        ctx.setLineDash([]);

        const lnMax = mapHLineToCanvas(viz.localMax, canvas, mapping);
        ctx.strokeStyle = '#FFFF00';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lnMax.x1, lnMax.y1);
        ctx.lineTo(lnMax.x2, lnMax.y2);
        ctx.stroke();
    }

    if (viz.currentY !== null && viz.currentY !== undefined) {
        const { cx, cy } = mapVizToCanvas(viz.currentX || 0.5, viz.currentY, canvas, mapping);
        const color = viz.state === 'SEARCHING_PEAK' ? '#00FF00' : '#0088FF';

        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    if (viz.takeoffPoint) {
        const { cx: tx, cy: ty } = mapVizToCanvas(viz.takeoffPoint.x, viz.takeoffPoint.y, canvas, mapping);

        ctx.beginPath();
        ctx.arc(tx, ty, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#00CC00';
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#00CC00';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('TO', tx, ty + 25);
    }

    if (viz.landingPoint) {
        const { cx: lx, cy: ly } = mapVizToCanvas(viz.landingPoint.x, viz.landingPoint.y, canvas, mapping);

        ctx.beginPath();
        ctx.arc(lx, ly, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#FF0000';
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#FF0000';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('LND', lx, ly + 25);
    }

    const now = performance.now() / 1000;
    if (viz.eventText && (now - viz.eventTime) < 0.5) {
        const { cx, cy } = mapVizToCanvas(viz.currentX || 0.5, viz.currentY || 0.5, canvas, mapping);

        ctx.fillStyle = viz.eventColor;
        ctx.font = 'bold 32px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(viz.eventText, cx + 30, cy);
    }

    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(10, 10, 140, 50);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 18px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`⬆️ Jumps: ${viz.counter}`, 20, 42);
}

function updateFpsDisplay(fps) {
    const el1 = document.getElementById('fpsDisplay');
    if (el1) el1.textContent = fps;

    // Update the fancy in-frame FPS badge
    const badge = document.getElementById('fpsBadgeOverlay');
    const badgeVal = document.getElementById('fpsBadgeValue');
    if (badge && badgeVal) {
        badgeVal.textContent = fps;
        badge.classList.add('visible');
        badge.classList.remove('fps-good', 'fps-mid', 'fps-low');
        if (fps >= 20)      badge.classList.add('fps-good');
        else if (fps >= 10) badge.classList.add('fps-mid');
        else                badge.classList.add('fps-low');
    }
}

// Export controls
export function resetJumpCounter() {
    resetActiveDetector();
    updateJumpUI();
    addLog('🔄 Jump counter reset', 'info');
}

export function setJumpSensitivity(value) {
    const detector = getActiveDetector();
    if (detector && typeof detector.updateSensitivity === 'function') {
        detector.updateSensitivity(value);
    }
    addLog(`⚙️ Jump sensitivity: ${value}`, 'info');
}

export function toggleJumpOverlay(enabled) {
    jumpOverlayEnabled = enabled;
}
