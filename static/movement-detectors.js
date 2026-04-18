// ═══════════════════════════════════════════
// Movement Detectors Registry
// Single place to register all future tests
// (currently only vertical jump)
// ═══════════════════════════════════════════

import { state } from './state.js';
import { jumpDetector } from './jump-detector.js';

// Registry of available detectors
// Later you can add more entries here:
//   squat: { id: 'squat', label: 'Squat Test', detector: new SquatDetector() }
export const DETECTORS = {
    jump: {
        id: 'jump',
        label: 'Vertical Jump',
        detector: jumpDetector,
    },
};

export function getActiveDetectorId() {
    return state.activeTestId && DETECTORS[state.activeTestId]
        ? state.activeTestId
        : 'jump';
}

export function setActiveDetectorId(id) {
    if (DETECTORS[id]) {
        state.activeTestId = id;
    }
}

function getActiveEntry() {
    const id = getActiveDetectorId();
    return DETECTORS[id] || DETECTORS.jump;
}

export function getActiveDetector() {
    const entry = getActiveEntry();
    return entry.detector;
}

export function resetActiveDetector() {
    const detector = getActiveDetector();
    if (detector && typeof detector.reset === 'function') {
        detector.reset();
    }
}

export function processActiveDetector(landmarks, timestamp) {
    const detector = getActiveDetector();
    if (!detector || typeof detector.process !== 'function') {
        return { event: null, isJumping: false, detectorId: getActiveDetectorId() };
    }
    const baseResult = detector.process(landmarks, timestamp) || {};
    return { ...baseResult, detectorId: getActiveDetectorId() };
}

export function getActiveVisualizationData() {
    const detector = getActiveDetector();
    if (detector && typeof detector.getVisualizationData === 'function') {
        return detector.getVisualizationData();
    }
    return null;
}

