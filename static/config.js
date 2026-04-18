// ═══════════════════════════════════════════
// Configuration & Constants
// ═══════════════════════════════════════════

export const API_BASE = window.location.origin;

// MediaPipe import sources (local first, then CDN fallbacks)
export const IMPORT_SOURCES = [
    '/static/mediapipe/vision_bundle.mjs',
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/vision_bundle.mjs',
    'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
];

// Pose landmarker model URLs
export const MODEL_URLS = [
    '/static/mediapipe/pose_landmarker_lite.task',
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
];

// WASM file paths
export const WASM_PATHS = [
    '/static/mediapipe',
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm',
    'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm',
];

// Pose topology connections (skeleton bones)
export const POSE_CONNECTIONS = [
    [31, 27], [27, 25], [25, 23],   // Left leg
    [32, 28], [28, 26], [26, 24],   // Right leg
    [23, 24],                        // Hip line
    [11, 12],                        // Shoulder line
    [23, 11], [24, 12],             // Torso sides
    [11, 13], [13, 15],             // Left arm
    [12, 14], [14, 16],             // Right arm
];

// Key joints to render as circles
export const KEY_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];

// ─── Skeleton visual settings ───
export const SKELETON = {
    BG_COLOR: '#0a0e1a',
    BONE_COLOR: '#A9CFE6',
    BONE_WIDTH: 2.5,
    BONE_LINE_CAP: 'round',
    JOINT_COLOR: '#3EA2FF',
    JOINT_RADIUS: 5,
    JOINT_BORDER_COLOR: '#ffffff',
    JOINT_BORDER_WIDTH: 2,
    NOSE_COLOR: '#ff4081',
    NOSE_RADIUS: 7,
    NOSE_BORDER_COLOR: '#ffffff',
    NOSE_BORDER_WIDTH: 2,
    VISIBILITY_THRESHOLD: 0.5,
};

// Camera constraints — Dynamic max resolution
export const CAMERA_CONSTRAINTS = {
    video: {
        facingMode: 'user',
        width: { ideal: 1920, min: 640 },
        height: { ideal: 1080, min: 480 },
        frameRate: { ideal: 30, min: 15 },
    },
    audio: false,
};

// Health check interval (ms)
export const HEALTH_CHECK_INTERVAL = 10000;

// Max log entries
export const MAX_LOG_ENTRIES = 200;
