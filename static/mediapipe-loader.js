// ═══════════════════════════════════════════
// MediaPipe Library Loader
// ═══════════════════════════════════════════

import { IMPORT_SOURCES, WASM_PATHS, MODEL_URLS } from './config.js';
import { state } from './state.js';
import { addLog } from './logger.js';

/**
 * Attempt to import the MediaPipe vision bundle from multiple sources
 */
export async function loadMediaPipeLibrary() {
    for (const src of IMPORT_SOURCES) {
        try {
            const mod = await import(src);
            state.PoseLandmarker = mod.PoseLandmarker;
            state.FilesetResolver = mod.FilesetResolver;
            state.mpSourceUsed = src;
            console.log('[MP] ✅ Loaded from:', src);
            addLog(`MediaPipe loaded from: ${src}`, 'success');
            return true;
        } catch (e) {
            console.warn('[MP] ❌ Failed:', src, e.message);
            state.mpLoadError = e;
        }
    }
    return false;
}

/**
 * Create PoseLandmarker with GPU → CPU fallback
 */
export async function createPoseLandmarker() {
    if (!state.PoseLandmarker || !state.FilesetResolver) {
        throw new Error('MediaPipe library not loaded');
    }

    // Try each WASM path
    for (const wasmPath of WASM_PATHS) {
        // Try GPU first, then CPU
        for (const delegate of ['GPU', 'CPU']) {
            try {
                addLog(`Trying WASM: ${wasmPath} | Delegate: ${delegate}`, 'info');

                const vision = await state.FilesetResolver.forVisionTasks(wasmPath);

                // Try each model URL
                for (const modelUrl of MODEL_URLS) {
                    try {
                        const landmarker = await state.PoseLandmarker.createFromOptions(vision, {
                            baseOptions: {
                                modelAssetPath: modelUrl,
                                delegate: delegate,
                            },
                            runningMode: 'VIDEO',
                            numPoses: 1,
                        });

                        state.poseLandmarker = landmarker;
                        state.usedDelegate = delegate;
                        addLog(`✅ PoseLandmarker ready! Delegate: ${delegate} | Model: ${modelUrl}`, 'success');

                        // Update UI
                        const delegateEl = document.getElementById('delegateDisplay');
                        if (delegateEl) delegateEl.textContent = delegate;

                        return landmarker;
                    } catch (modelErr) {
                        console.warn(`[MP] Model failed: ${modelUrl}`, modelErr.message);
                    }
                }
            } catch (wasmErr) {
                console.warn(`[MP] WASM failed: ${wasmPath} (${delegate})`, wasmErr.message);
            }
        }
    }

    throw new Error('Failed to create PoseLandmarker with all combinations');
}
