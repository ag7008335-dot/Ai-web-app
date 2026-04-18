// ═══════════════════════════════════════════
// Shared Application State
// ═══════════════════════════════════════════

export const state = {
    // MediaPipe references
    PoseLandmarker: null,
    FilesetResolver: null,
    poseLandmarker: null,
    mpLoadError: null,
    mpSourceUsed: '',
    usedDelegate: '—',

    // Camera
    webcamStream: null,
    isWebcamOn: false,
    videoWidth: 0,
    videoHeight: 0,

    // View transform (UI mirror / rotation)
    // Rotation is in degrees: one of 0, 90, 180, 270
    viewRotation: 0,
    viewMirrored: false,

    // Guard to avoid spamming warning when rotation is active
    jumpRotationWarningShown: false,

    selectedDeviceId: null,
    availableCameras: [],

    // Pose detection
    poseRunning: false,
    animFrameId: null,

    // Jump detection (off by default, user must activate manually)
    jumpEnabled: false,

    // Timed jump test configuration & runtime
    testDurationSeconds: 10,
    preCountdownSeconds: 3,
    startTimerOnFirstJump: false,
    testRunning: false,
    countdownRunning: false,
    testStartTimeMs: 0,
    testDurationMs: 0,

    // Active test / movement type (future extensibility)
    // For now we only support 'jump'
    activeTestId: 'jump',

    // User role for test selection: 'guest' | 'coach'
    userRole: 'guest',

    // Simple coach auth state (can be extended later)
    coachAuthenticated: false,

    // Athlete info (shown in PDF reports)
    athleteName: '',

    // Coach: currently selected athlete from dashboard (raw object from API)
    selectedAthlete: null,

    // Group test: list of athletes in the selected group, current index for Prev/Next
    groupTestAthletes: [],
    groupTestIndex: 0,
    /** Display name of the group currently being tested (e.g. from Run group test) */
    groupTestGroupName: '',

    // FPS tracking
    lastFpsTime: performance.now(),
    fpsCounter: 0,
    currentFps: 0,

    // Server health
    serverMPReady: false,
};
