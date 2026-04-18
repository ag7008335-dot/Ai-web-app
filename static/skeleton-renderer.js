// ═══════════════════════════════════════════
// Skeleton Renderer (Original Style)
// Dark background + bone/joint rendering
// ═══════════════════════════════════════════

import { POSE_CONNECTIONS, KEY_JOINTS, SKELETON } from './config.js';

/**
 * Draw skeleton on dark canvas background (original style)
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} canvas
 * @param {Array} landmarks - Normalized landmarks [0..1]
 */
export function drawSkeleton(ctx, canvas, landmarks) {
    const W = canvas.width;
    const H = canvas.height;

    // Clear previous frame but keep canvas transparent
    // so the skeleton is drawn directly over the camera image.
    ctx.clearRect(0, 0, W, H);

    if (!landmarks || landmarks.length === 0) return;

    // ── Draw bone glow (behind main bones for glow effect) ──
    ctx.strokeStyle = 'rgba(169, 207, 230, 0.15)';
    ctx.lineWidth = SKELETON.BONE_WIDTH + 6;
    ctx.lineCap = SKELETON.BONE_LINE_CAP;

    for (const [i, j] of POSE_CONNECTIONS) {
        if (i >= landmarks.length || j >= landmarks.length) continue;
        const a = landmarks[i];
        const b = landmarks[j];
        if (a.visibility < SKELETON.VISIBILITY_THRESHOLD ||
            b.visibility < SKELETON.VISIBILITY_THRESHOLD) continue;

        ctx.beginPath();
        ctx.moveTo(a.x * W, a.y * H);
        ctx.lineTo(b.x * W, b.y * H);
        ctx.stroke();
    }

    // ── Draw main bones ──
    ctx.strokeStyle = SKELETON.BONE_COLOR;
    ctx.lineWidth = SKELETON.BONE_WIDTH;
    ctx.lineCap = SKELETON.BONE_LINE_CAP;

    for (const [i, j] of POSE_CONNECTIONS) {
        if (i >= landmarks.length || j >= landmarks.length) continue;
        const a = landmarks[i];
        const b = landmarks[j];
        if (a.visibility < SKELETON.VISIBILITY_THRESHOLD ||
            b.visibility < SKELETON.VISIBILITY_THRESHOLD) continue;

        ctx.beginPath();
        ctx.moveTo(a.x * W, a.y * H);
        ctx.lineTo(b.x * W, b.y * H);
        ctx.stroke();
    }

    // ── Draw joint glow (behind main joints) ──
    for (const idx of KEY_JOINTS) {
        if (idx >= landmarks.length) continue;
        const lm = landmarks[idx];
        if (lm.visibility < SKELETON.VISIBILITY_THRESHOLD) continue;

        const x = lm.x * W;
        const y = lm.y * H;
        const isNose = idx === 0;
        const radius = isNose ? SKELETON.NOSE_RADIUS : SKELETON.JOINT_RADIUS;

        // Outer glow
        ctx.beginPath();
        ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
        ctx.fillStyle = isNose
            ? 'rgba(255, 64, 129, 0.2)'
            : 'rgba(62, 162, 255, 0.2)';
        ctx.fill();
    }

    // ── Draw main joints ──
    for (const idx of KEY_JOINTS) {
        if (idx >= landmarks.length) continue;
        const lm = landmarks[idx];
        if (lm.visibility < SKELETON.VISIBILITY_THRESHOLD) continue;

        const x = lm.x * W;
        const y = lm.y * H;
        const isNose = idx === 0;

        // Joint fill
        ctx.beginPath();
        ctx.arc(
            x, y,
            isNose ? SKELETON.NOSE_RADIUS : SKELETON.JOINT_RADIUS,
            0, Math.PI * 2
        );
        ctx.fillStyle = isNose ? SKELETON.NOSE_COLOR : SKELETON.JOINT_COLOR;
        ctx.fill();

        // Joint border
        ctx.strokeStyle = isNose ? SKELETON.NOSE_BORDER_COLOR : SKELETON.JOINT_BORDER_COLOR;
        ctx.lineWidth = isNose ? SKELETON.NOSE_BORDER_WIDTH : SKELETON.JOINT_BORDER_WIDTH;
        ctx.stroke();
    }
}

/**
 * Clear canvas with dark background
 */
export function clearCanvas(ctx, canvas) {
    // Fully clear the canvas to transparent so the underlying
    // video frame remains visible when stopping the loop.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}
