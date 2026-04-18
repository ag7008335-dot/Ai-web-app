// ═══════════════════════════════════════════
// Video → processing canvas (rotate + mirror)
// Must match CSS order in app.js: rotate(deg) then scaleX(-1)
// ═══════════════════════════════════════════

/**
 * Logical size of the processing buffer after rotation (matches MediaPipe input aspect).
 */
export function getProcCanvasSize(vw, vh, rotDeg) {
    const r = ((rotDeg % 360) + 360) % 360;
    if (r === 90 || r === 270) {
        return { w: Math.max(1, Math.round(vh)), h: Math.max(1, Math.round(vw)) };
    }
    return { w: Math.max(1, Math.round(vw)), h: Math.max(1, Math.round(vh)) };
}

/**
 * Draw scaled video into proc canvas with same transform as the live view (rotate then mirror).
 */
export function drawVideoToProcCanvas(ctx, video, procW, procH, rotDeg, mirror, scale) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !procW || !procH) return;

    const videoW = vw * scale;
    const videoH = vh * scale;
    const r = ((rotDeg % 360) + 360) % 360;
    const rad = (r * Math.PI) / 180;

    ctx.clearRect(0, 0, procW, procH);
    ctx.save();
    ctx.translate(procW / 2, procH / 2);
    ctx.rotate(rad);
    if (mirror) ctx.scale(-1, 1);
    ctx.drawImage(video, -videoW / 2, -videoH / 2, videoW, videoH);
    ctx.restore();
}

/**
 * Inverse: normalized point in processed frame → normalized point in original video frame [0..1].
 * Used so skeleton / overlays align with the raw video layer (same CSS transform on both).
 */
export function mapNormPointToVideoSpace(nx, ny, vw, vh, procW, procH, rotDeg, mirror, scale) {
    const videoW = vw * scale;
    const videoH = vh * scale;
    const r = ((rotDeg % 360) + 360) % 360;
    const rad = (r * Math.PI) / 180;

    const px = nx * procW;
    const py = ny * procH;
    let x1 = px - procW / 2;
    let y1 = py - procH / 2;
    if (mirror) x1 = -x1;
    const lx0 = x1 * Math.cos(-rad) - y1 * Math.sin(-rad);
    const ly0 = x1 * Math.sin(-rad) + y1 * Math.cos(-rad);
    const u = lx0 / videoW + 0.5;
    const v = ly0 / videoH + 0.5;
    return { x: u, y: v };
}

/**
 * Map full landmark list from MediaPipe (processed image space) to original video space.
 */
export function mapLandmarksToVideoSpace(landmarks, vw, vh, procW, procH, rotDeg, mirror, scale) {
    if (!landmarks || landmarks.length === 0) return landmarks;
    return landmarks.map((lm) => {
        const { x, y } = mapNormPointToVideoSpace(lm.x, lm.y, vw, vh, procW, procH, rotDeg, mirror, scale);
        return { ...lm, x, y };
    });
}
