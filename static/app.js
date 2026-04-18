// ═══════════════════════════════════════════
// App.js — Main Entry Point
// Sportify AI — Ai Tests v1.0
// ═══════════════════════════════════════════

import { state } from './state.js';
import { addLog, showDebug, hideDebug } from './logger.js';
import { showToast } from './toast.js';
import { loadMediaPipeLibrary, createPoseLandmarker } from './mediapipe-loader.js';
import { startCamera, stopCamera, initCameraSelection } from './camera.js';
import { startLoop, stopLoop } from './pose-loop.js';
import { startHealthChecks } from './server-health.js';
import { clearCanvas } from './skeleton-renderer.js';
import { getActiveDetector, resetActiveDetector } from './movement-detectors.js';

// ════════════════════════════════════════════
// JUMP HISTORY TRACKER
// ════════════════════════════════════════════

const jumpHistory = {
    jumps: [],
    maxHeight: 0,
    totalHeight: 0,

    add(heightCm, flightTime, takeoffTime, landingTime, apexDataUrl) {
        this.jumps.push({
            height: heightCm,
            time: flightTime,
            t_takeoff: typeof takeoffTime === 'number' ? takeoffTime : null,
            t_landing: typeof landingTime === 'number' ? landingTime : null,
            timestamp: Date.now(),
            apex_png_b64: apexDataUrl || null,
        });
        if (heightCm > this.maxHeight) this.maxHeight = heightCm;
        this.totalHeight += heightCm;
    },

    getAvgHeight() {
        if (this.jumps.length === 0) return 0;
        return this.totalHeight / this.jumps.length;
    },

    reset() {
        this.jumps = [];
        this.maxHeight = 0;
        this.totalHeight = 0;
    },

    // Get last N jumps for bar chart
    getLastN(n = 20) {
        return this.jumps.slice(-n);
    }
};

/** True after current test results were successfully sent to site; reset when starting a new test. */
let jumpResultsAlreadyUploaded = false;

// ════════════════════════════════════════════
// TIMED TEST / COUNTDOWN STATE
// ════════════════════════════════════════════

let countdownIntervalId = null;
let testIntervalId = null;
let liveTimerRafId = null;
let jumpAudioCtx = null;
let jumpAudioEnabled = true;
let lastJumpToastElement = null;

// ════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════

async function init() {
    addLog('🚀 Application initializing...', 'info');

    // 0. Setup test selection overlay (first screen)
    setupTestSelection();

    // Setup camera selection UI (if available)
    await initCameraSelection();

    // 1. Check server health
    startHealthChecks();

    // 2. Load MediaPipe library
    const mpLoaded = await loadMediaPipeLibrary();

    if (mpLoaded) {
        const el = document.getElementById('mpStatus');
        if (el) { el.textContent = '✅ Loaded'; el.style.color = '#00e676'; }

        const dot = document.getElementById('mpDot');
        if (dot) dot.classList.add('active');

        addLog('✅ MediaPipe library ready', 'success');
    } else {
        const el = document.getElementById('mpStatus');
        if (el) { el.textContent = '❌ Failed'; el.style.color = '#ff1744'; }

        const cdnNotice = document.getElementById('cdnFailNotice');
        if (cdnNotice) cdnNotice.style.display = 'block';

        addLog('❌ MediaPipe failed to load from all sources', 'error');
        showToast('MediaPipe failed to load', 'error');
    }

    // 3. Setup video tool buttons (mirror / rotate)
    setupVideoTools();

    // 4. Setup jump counter controls
    setupJumpControls();

    // 5. Setup sidebar tabs (Last Jump / Test Report)
    setupSidebarTabs();

    // 6. Setup test summary modal
    setupTestSummaryModal();

    // 7. Setup athlete list modal (coach)
    setupAthleteListModal();

    addLog('✅ Application ready', 'success');
}

// ════════════════════════════════════════════
// TEST SELECTION OVERLAY
// ════════════════════════════════════════════

function setupTestSelection() {
    const overlay = document.getElementById('testSelectOverlay');
    const appWrapper = document.querySelector('.app-wrapper');
    if (!overlay || !appWrapper) return;

    // Restore simple coach auth from localStorage (if present)
    try {
        const storedCoachAuth = localStorage.getItem('coachAuthenticated');
        if (storedCoachAuth === '1') {
            state.coachAuthenticated = true;
        }
    } catch (err) {
        // ignore storage errors
    }

    const coachLoginPanel = document.getElementById('coachLoginPanel');
    const guestNamePanel = document.getElementById('guestNamePanel');
    const guestFullNameInput = document.getElementById('guestFullNameInput');
    const coachAccessKeyInput = document.getElementById('coachAccessKeyInput');
    const coachLoginBtn = document.getElementById('btnCoachLogin');

    function updateCoachLoginVisibility() {
        if (!coachLoginPanel) return;
        const isCoach = state.userRole === 'coach';
        const needsLogin = !state.coachAuthenticated;
        coachLoginPanel.classList.toggle('visible', isCoach && needsLogin);
    }

    function updateGuestNameVisibility() {
        if (!guestNamePanel) return;
        const isGuest = state.userRole === 'guest';
        guestNamePanel.style.display = isGuest ? 'block' : 'none';
    }

    function updateBrandRoleBadge() {
        const badge = document.getElementById('brandRoleBadge');
        const coachListBtn = document.getElementById('btnCoachAthleteList');
        const groupTestNav = document.getElementById('groupTestNav');
        if (!badge) return;

        if (state.groupTestAthletes && state.groupTestAthletes.length > 0) {
            badge.textContent = state.athleteName || '';
            badge.style.display = 'inline-flex';
            if (groupTestNav) groupTestNav.style.display = 'inline-flex';
            if (coachListBtn) coachListBtn.style.display = 'flex';
            return;
        }
        if (groupTestNav) groupTestNav.style.display = 'none';

        const fullName = (state.athleteName || '').trim();
        const isCoachMode = state.userRole === 'coach' && state.coachAuthenticated;

        if (isCoachMode) {
            badge.textContent = 'Coach mode';
            badge.style.display = 'inline-flex';
            if (coachListBtn) coachListBtn.style.display = 'flex';
        } else if (state.userRole === 'guest' && fullName) {
            badge.textContent = fullName;
            badge.style.display = 'inline-flex';
            if (coachListBtn) coachListBtn.style.display = 'none';
        } else {
            badge.style.display = 'none';
            if (coachListBtn) coachListBtn.style.display = 'none';
        }
    }

    function updateRoleUI() {
        updateCoachLoginVisibility();
        updateGuestNameVisibility();
        updateBrandRoleBadge();
    }

    // Load cached athlete name into guest panel (if any)
    try {
        const storedFirst = localStorage.getItem('jumpAthleteFirstName') || '';
        const storedLast = localStorage.getItem('jumpAthleteLastName') || '';
        const full = `${storedFirst} ${storedLast}`.trim();
        if (guestFullNameInput) guestFullNameInput.value = full;
        if (full) {
            state.athleteName = full;
        }
    } catch (err) {
        // ignore
    }

    function updateAthleteFromGuestPanel() {
        const full = guestFullNameInput ? guestFullNameInput.value.trim() : '';
        state.athleteName = full;

        // split into first / last for reuse in sidebar + storage
        let first = '';
        let last = '';
        if (full) {
            const parts = full.split(/\s+/);
            first = parts[0] || '';
            last = parts.slice(1).join(' ') || '';
        }

        try {
            localStorage.setItem('jumpAthleteFirstName', first);
            localStorage.setItem('jumpAthleteLastName', last);
        } catch (err) {
            // ignore
        }

        // mirror into sidebar inputs if they exist
        const sideFirst = document.getElementById('athleteFirstNameInput');
        const sideLast = document.getElementById('athleteLastNameInput');
        if (sideFirst && sideFirst.value !== first) sideFirst.value = first;
        if (sideLast && sideLast.value !== last) sideLast.value = last;

        updateBrandRoleBadge();
    }

    if (guestFullNameInput) {
        guestFullNameInput.addEventListener('input', updateAthleteFromGuestPanel);
    }

    // Role selection (Guest / Coach)
    const rolePills = overlay.querySelectorAll('.test-role-pill');
    rolePills.forEach(pill => {
        pill.addEventListener('click', () => {
            const role = pill.getAttribute('data-role') || 'guest';

            rolePills.forEach(p => p.classList.toggle('active', p === pill));

            // Store selected role in global state for later use
            try {
                state.userRole = role;
            } catch (err) {
                // ignore if state is not accessible for any reason
            }

            updateRoleUI();

            const label = role === 'coach' ? 'Coach' : 'Guest';
            addLog(`🙋 Role selected: ${label}`, 'info');
        });
    });

    // Default role = guest
    if (rolePills.length) {
        const guestPill = overlay.querySelector('.test-role-pill[data-role="guest"]');
        if (guestPill) {
            guestPill.classList.add('active');
            state.userRole = 'guest';
        }
    }

    updateRoleUI();

    if (coachLoginBtn && coachAccessKeyInput) {
        const submitCoachLogin = async () => {
            const key = coachAccessKeyInput.value.trim();

            if (!key) {
                showToast('Please enter coach access key.', 'warning');
                return;
            }

            try {
                const res = await fetch('/api/coach/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ access_key: key }),
                });

                if (!res.ok) {
                    throw new Error(`Login failed with status ${res.status}`);
                }

                const data = await res.json();
                if (!data.ok) {
                    throw new Error('Login rejected');
                }

                state.coachAuthenticated = true;

                try {
                    localStorage.setItem('coachAuthenticated', '1');
                } catch (err) {
                    // ignore storage errors
                }

                updateRoleUI();
                showToast('Coach mode unlocked', 'success');
                addLog('🔐 Coach access granted', 'info');
            } catch (err) {
                console.error(err);
                showToast('Coach login failed. Please check your access key.', 'error');
            }
        };

        coachLoginBtn.addEventListener('click', submitCoachLogin);
        coachAccessKeyInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitCoachLogin();
            }
        });
    }

    // Test cards
    const cards = overlay.querySelectorAll('[data-test]');
    cards.forEach(card => {
        card.addEventListener('click', () => {
            const testId = card.getAttribute('data-test');
            handleTestSelection(testId || 'unknown');
        });
    });
}

function handleTestSelection(testId) {
    const overlay = document.getElementById('testSelectOverlay');
    const appWrapper = document.querySelector('.app-wrapper');

    if (overlay) {
        overlay.classList.add('hidden');
    }
    if (appWrapper) {
        appWrapper.classList.remove('blurred');
    }

    if (testId === 'vertical_jump') {
        addLog('🧪 Selected test: Vertical Jump', 'info');
    } else if (testId === 'demo') {
        addLog('🧪 Selected test: Demo (uses Vertical Jump layout)', 'info');
        showToast('Demo mode is currently using the same layout as the Vertical Jump test.', 'info');
    } else {
        addLog(`🧪 Selected test: ${testId}`, 'info');
    }
}

// Re-open test selection overlay from header button
function openTestSelection() {
    const overlay = document.getElementById('testSelectOverlay');
    const appWrapper = document.querySelector('.app-wrapper');
    if (!overlay || !appWrapper) return;

    overlay.classList.remove('hidden');
    appWrapper.classList.add('blurred');

    addLog('🎯 Opened test selection overlay', 'info');
}

// ════════════════════════════════════════════
// VIDEO TOOLS — Mirror & Rotate
// ════════════════════════════════════════════

function setupVideoTools() {
    const btnMirror = document.getElementById('btnMirror');
    const btnRotate = document.getElementById('btnRotate');
    const video  = document.getElementById('webcamVideo');
    const canvas = document.getElementById('outputCanvas');
    const rawFrame  = document.querySelector('.video-raw-frame');
    const skelFrame = document.querySelector('.video-skeleton-frame');

    function updateRotationClasses() {
        const rotation = state.viewRotation || 0;
        const frames = [rawFrame, skelFrame].filter(Boolean);
        const allClasses = ['rot-0', 'rot-90', 'rot-180', 'rot-270'];

        frames.forEach(frame => {
            frame.classList.remove(...allClasses);
            if (rotation !== 0) {
                frame.classList.add(`rot-${rotation}`);
            }
        });
    }

    function applyTransform() {
        const rotation = state.viewRotation || 0;
        const mirrored = !!state.viewMirrored;

        const transforms = [];
        if (rotation !== 0) transforms.push(`rotate(${rotation}deg)`);
        if (mirrored)       transforms.push('scaleX(-1)');
        const value = transforms.length ? transforms.join(' ') : '';
        if (video)  video.style.transform  = value;
        if (canvas) canvas.style.transform = value;
        updateRotationClasses();
    }

    if (btnMirror) {
        btnMirror.addEventListener('click', () => {
            state.viewMirrored = !state.viewMirrored;
            btnMirror.classList.toggle('active', state.viewMirrored);
            applyTransform();
            addLog(`🪞 Mirror ${state.viewMirrored ? 'ON' : 'OFF'}`, 'info');
        });
    }

    if (btnRotate) {
        btnRotate.addEventListener('click', () => {
            const next = ((state.viewRotation || 0) + 90) % 360;
            state.viewRotation = next;
            btnRotate.classList.toggle('active', state.viewRotation !== 0);
            applyTransform();
            addLog(`🔄 Rotated to ${state.viewRotation}°`, 'info');
        });
    }
}

// ════════════════════════════════════════════
// JUMP COUNTER CONTROLS
// ════════════════════════════════════════════

function setupJumpControls() {
    // Reset button
    const resetBtn = document.getElementById('resetJumpBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetActiveDetector();
            jumpHistory.reset();
            jumpResultsAlreadyUploaded = false;
            updateJumpSidebar();
            renderJumpHistoryBars();
            showToast('Jump counter reset', 'info');
            addLog('🔄 Jump counter reset', 'info');
        });
    }

    // Sensitivity slider
    const slider = document.getElementById('jumpSensitivity');
    const sliderVal = document.getElementById('sensitivityValue');
    if (slider) {
        slider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            const detector = getActiveDetector();
            if (detector && typeof detector.updateSensitivity === 'function') {
                detector.updateSensitivity(val);
            }
            if (sliderVal) sliderVal.textContent = val.toFixed(2);
        });
    }

    // Overlay toggle
    const overlayToggle = document.getElementById('showJumpOverlay');
    if (overlayToggle) {
        overlayToggle.addEventListener('change', (e) => {
            state.showJumpOverlay = e.target.checked;
        });
    }

    // Test timing inputs
    const testDurationInput = document.getElementById('testDurationInput');
    const countdownInput = document.getElementById('countdownInput');
    const startOnFirstJumpToggle = document.getElementById('startOnFirstJumpToggle');
    const athleteFirstNameInput = document.getElementById('athleteFirstNameInput');
    const athleteLastNameInput = document.getElementById('athleteLastNameInput');

    // Load cached values (if any)
    try {
        const storedDuration = parseInt(localStorage.getItem('jumpTestDurationSeconds') || '', 10);
        if (!isNaN(storedDuration)) {
            state.testDurationSeconds = Math.max(3, Math.min(600, storedDuration));
        }
        const storedCountdown = parseInt(localStorage.getItem('jumpPreCountdownSeconds') || '', 10);
        if (!isNaN(storedCountdown)) {
            state.preCountdownSeconds = Math.max(0, Math.min(10, storedCountdown));
        }
        const storedStartOnFirst = localStorage.getItem('jumpStartOnFirstJump');
        if (storedStartOnFirst != null) {
            state.startTimerOnFirstJump = storedStartOnFirst === '1';
        }
        const storedFirstName = localStorage.getItem('jumpAthleteFirstName') || '';
        const storedLastName = localStorage.getItem('jumpAthleteLastName') || '';
        if (athleteFirstNameInput) athleteFirstNameInput.value = storedFirstName;
        if (athleteLastNameInput) athleteLastNameInput.value = storedLastName;
        const fullName = `${storedFirstName} ${storedLastName}`.trim();
        state.athleteName = fullName;
    } catch (err) {
        // Ignore storage errors (e.g. disabled cookies)
    }

    if (testDurationInput) {
        testDurationInput.value = state.testDurationSeconds ?? 10;
        testDurationInput.addEventListener('change', () => {
            let val = parseInt(testDurationInput.value, 10);
            if (isNaN(val)) val = 10;
            val = Math.max(3, Math.min(600, val));
            state.testDurationSeconds = val;
            testDurationInput.value = val;
            try {
                localStorage.setItem('jumpTestDurationSeconds', String(val));
            } catch (err) {
                // ignore
            }
        });
    }

    if (countdownInput) {
        countdownInput.value = state.preCountdownSeconds ?? 3;
        countdownInput.addEventListener('change', () => {
            let val = parseInt(countdownInput.value, 10);
            if (isNaN(val)) val = 3;
            val = Math.max(0, Math.min(10, val));
            state.preCountdownSeconds = val;
            countdownInput.value = val;
            try {
                localStorage.setItem('jumpPreCountdownSeconds', String(val));
            } catch (err) {
                // ignore
            }
        });
    }

    if (startOnFirstJumpToggle) {
        startOnFirstJumpToggle.checked = !!state.startTimerOnFirstJump;
        startOnFirstJumpToggle.addEventListener('change', (e) => {
            state.startTimerOnFirstJump = e.target.checked;
            try {
                localStorage.setItem('jumpStartOnFirstJump', e.target.checked ? '1' : '0');
            } catch (err) {
                // ignore
            }
        });
    }

    function updateAthleteNameFromInputs() {
        const first = athleteFirstNameInput ? athleteFirstNameInput.value.trim() : '';
        const last = athleteLastNameInput ? athleteLastNameInput.value.trim() : '';
        const full = `${first} ${last}`.trim();
        state.athleteName = full;
        try {
            localStorage.setItem('jumpAthleteFirstName', first);
            localStorage.setItem('jumpAthleteLastName', last);
        } catch (err) {
            // ignore
        }
    }

    if (athleteFirstNameInput) {
        athleteFirstNameInput.addEventListener('input', updateAthleteNameFromInputs);
    }
    if (athleteLastNameInput) {
        athleteLastNameInput.addEventListener('input', updateAthleteNameFromInputs);
    }

    // Listen for jump events
    window.addEventListener('jumpDetected', (e) => {
        const { count, jumpHeightCm, flightTime, takeoffTime, landingTime } = e.detail;

        // If test is armed to start on first jump and not yet running,
        // start the main timer now (first valid jump is already recorded).
        if (state.startTimerOnFirstJump && !state.testRunning && state.testDurationMs > 0) {
            state.testRunning = true;
            state.testStartTimeMs = performance.now();

            updateTestStatus('Running', state.testDurationMs / 1000);
            startLiveTestTimer();

            let remaining = state.testDurationMs / 1000;
            if (testIntervalId) {
                clearInterval(testIntervalId);
                testIntervalId = null;
            }

            testIntervalId = setInterval(() => {
                remaining -= 1;
                if (remaining >= 0) {
                    updateTestStatus('Running', remaining);
                }
                if (remaining <= 0) {
                    stopTimedTest(false);
                }
            }, 1000);

            addLog(`🧪 Jump test started on first jump (${remaining.toFixed(0)}s)`, 'success');
            showToast(`Jump test started for ${Math.floor(remaining)} seconds (on first jump)`, 'success');
        }

        // Apex snapshot (if provided by pose-loop) is already attached to the event
        const apexDataUrl = e.detail.apex_png_b64 || null;

        // Add to history
        jumpHistory.add(jumpHeightCm, flightTime, takeoffTime, landingTime, apexDataUrl);

        // Update sidebar UI
        updateJumpSidebar();
        renderJumpHistoryBars();

        // Bump animation on counter
        const counterEl = document.getElementById('jumpCount');
        if (counterEl) {
            counterEl.classList.remove('bump');
            void counterEl.offsetWidth; // force reflow
            counterEl.classList.add('bump');
        }

        const heightStr = `${jumpHeightCm.toFixed(1)} cm`;
        const flightMs = `${(flightTime * 1000).toFixed(0)} ms`;
        addLog(`⬆️ Jump #${count}: ${heightStr}, ${flightMs}`, 'success');
        // Show a single, rolling toast for the latest jump
        showJumpToast(count, heightStr, flightMs);

        // Play a short audio cue so the athlete feels each registered jump
        playJumpBeep();
    });
}

// ════════════════════════════════════════════
// UPDATE SIDEBAR UI
// ════════════════════════════════════════════

function updateJumpSidebar() {
    // Counter
    const countEl = document.getElementById('jumpCount');
    const detector = getActiveDetector();
    if (countEl && detector) countEl.textContent = detector.counter ?? 0;

    // Last jump data
    const lastJump = detector ? detector.lastJumpData : null;
    const heightEl = document.getElementById('jumpHeight');
    const flightEl = document.getElementById('jumpFlightTime');
    const maxEl = document.getElementById('jumpMaxHeight');
    const avgEl = document.getElementById('jumpAvgHeight');

    if (lastJump) {
        if (heightEl) heightEl.textContent = `${lastJump.jumpHeightCm.toFixed(1)} cm`;
        if (flightEl) flightEl.textContent = `${(lastJump.flightTime * 1000).toFixed(0)} ms`;
    }

    if (maxEl) maxEl.textContent = `${jumpHistory.maxHeight.toFixed(1)} cm`;
    if (avgEl) avgEl.textContent = `${jumpHistory.getAvgHeight().toFixed(1)} cm`;

    // Status
    updateJumpStatus();
}

function updateJumpStatus() {
    const indicator = document.getElementById('jumpStatusIndicator');
    const statusText = document.getElementById('jumpStatus');

    if (!indicator || !statusText) return;

    const detector = getActiveDetector();

    // Remove all status classes
    indicator.className = 'jump-status-indicator';

    if (!detector || !detector.isCalibrated) {
        indicator.classList.add('status-calibrating');
        statusText.textContent = 'Calibrating...';
    } else if (detector.state === 'SEARCHING_PEAK') {
        indicator.classList.add('status-jumping');
        statusText.textContent = 'In Air!';
    } else {
        indicator.classList.add('status-ready');
        statusText.textContent = 'Ready';
    }
}

// ════════════════════════════════════════════
// RENDER JUMP HISTORY BAR CHART
// ════════════════════════════════════════════

function renderJumpHistoryBars() {
    const container = document.getElementById('jumpHistoryBars');
    if (!container) return;

    const lastJumps = jumpHistory.getLastN(20);

    if (lastJumps.length === 0) {
        container.innerHTML = '<div class="history-empty">No jumps yet</div>';
        return;
    }

    const maxH = Math.max(...lastJumps.map(j => j.height), 1);
    const containerHeight = 64; // px

    container.innerHTML = '';

    lastJumps.forEach((jump, i) => {
        const bar = document.createElement('div');
        bar.className = 'history-bar';
        if (i === lastJumps.length - 1) bar.classList.add('latest');

        const barHeight = Math.max(4, (jump.height / maxH) * containerHeight);
        bar.style.height = `${barHeight}px`;
        const heightStr = `${jump.height.toFixed(1)}cm`;
        const flightMs = `${(jump.time * 1000).toFixed(0)}ms`;
        bar.setAttribute('data-metrics', `${heightStr} • ${flightMs}`);

        container.appendChild(bar);
    });
}

// ════════════════════════════════════════════
// START — Camera + Pose together
// ════════════════════════════════════════════

async function startAll() {
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStopAll');

    try {
        if (btnStart) {
            btnStart.disabled = true;
            btnStart.innerHTML = '<span class="spinner"></span> Starting...';
        }

        // Step 1: Start camera
        addLog('📷 Starting camera...', 'info');
        await startCamera();

        // Step 2: Create PoseLandmarker if not already created
        if (!state.poseLandmarker) {
            addLog('🧠 Initializing pose model...', 'info');
            showToast('Loading pose model...', 'info');
            try {
                await createPoseLandmarker();
            } catch (err) {
                addLog(`❌ Pose model failed: ${err.message}`, 'error');
                showToast('Pose model failed to load', 'error');
                showDebug(`Pose model error: ${err.message}`);
                throw err;
            }
        }

        // Step 3: Start pose detection loop
        startLoop();

        // Step 4: Reset active detector for fresh session
        resetActiveDetector();
        jumpHistory.reset();
        jumpResultsAlreadyUploaded = false;
        updateJumpSidebar();
        renderJumpHistoryBars();

        // ── Activate UI elements ──
        if (btnStart) btnStart.style.display = 'none';
        if (btnStop) btnStop.style.display = 'flex';

        const placeholder = document.getElementById('placeholderRaw');
        if (placeholder) placeholder.style.display = 'none';

        const darkOverlay = document.getElementById('smartDarkOverlay');
        if (darkOverlay) darkOverlay.classList.add('active');

        const liveDot = document.getElementById('rawLiveDot');
        if (liveDot) liveDot.classList.add('active');

        // Enable jump detection button (but keep detection OFF by default)
        state.jumpEnabled = false;
        const btnJump = document.getElementById('btnToggleJump');
        if (btnJump) {
            btnJump.disabled = false;
            btnJump.classList.remove('active');
            document.getElementById('btnToggleJumpIcon').textContent = '▶';
            document.getElementById('btnToggleJumpText').textContent = 'Start Test';
        }

        showToast('Camera started — press Start Detection to track jumps', 'success');
        addLog('✅ Camera & skeleton running. Press Start Detection to enable jump tracking.', 'success');

    } catch (err) {
        addLog(`❌ Start failed: ${err.message}`, 'error');
        if (btnStart) {
            btnStart.disabled = false;
            btnStart.innerHTML = '<span class="btn-connect-dot"></span><span>Connect Camera</span>';
        }
    }
}

// ════════════════════════════════════════════
// STOP — Everything
// ════════════════════════════════════════════

function stopAll() {
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStopAll');

    stopLoop();
    stopCamera();

    // Stop any running timed test / countdown
    stopTimedTest(true);

    // Clear canvas
    const canvas = document.getElementById('outputCanvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        clearCanvas(ctx, canvas);
    }

    // Reset counters
    state.fpsCounter = 0;
    state.currentFps = 0;

    // Reset jump detection state
    state.jumpEnabled = false;
    const btnJump = document.getElementById('btnToggleJump');
    if (btnJump) {
        btnJump.disabled = true;
        btnJump.classList.remove('active');
        document.getElementById('btnToggleJumpIcon').textContent = '▶';
        document.getElementById('btnToggleJumpText').textContent = 'Start Test';
    }

    // Reset jump sidebar
    resetJumpSidebar();

    // ── Reset UI ──
    if (btnStart) {
        btnStart.style.display = 'flex';
        btnStart.disabled = false;
        btnStart.innerHTML = '<span class="btn-connect-dot"></span><span>Connect Camera</span>';
    }
    if (btnStop) btnStop.style.display = 'none';

    const placeholder = document.getElementById('placeholderRaw');
    if (placeholder) placeholder.style.display = 'flex';

    const darkOverlay = document.getElementById('smartDarkOverlay');
    if (darkOverlay) darkOverlay.classList.remove('active');

    const liveDot = document.getElementById('rawLiveDot');
    if (liveDot) liveDot.classList.remove('active');

    // Hide FPS badge overlay
    const fpsBadge = document.getElementById('fpsBadgeOverlay');
    if (fpsBadge) fpsBadge.classList.remove('visible', 'fps-good', 'fps-mid', 'fps-low');

    updateDisplay('fpsDisplay', '0');
    updateDisplay('mergedResBadge', '—');

    hideDebug();
    showToast('Stopped', 'info');
    addLog('⏹️ All stopped', 'info');
}

// ════════════════════════════════════════════
// RESET JUMP SIDEBAR
// ════════════════════════════════════════════

function resetJumpSidebar() {
    const countEl = document.getElementById('jumpCount');
    const heightEl = document.getElementById('jumpHeight');
    const flightEl = document.getElementById('jumpFlightTime');
    const maxEl = document.getElementById('jumpMaxHeight');
    const avgEl = document.getElementById('jumpAvgHeight');

    if (countEl) countEl.textContent = '0';
    if (heightEl) heightEl.textContent = '— cm';
    if (flightEl) flightEl.textContent = '— ms';
    if (maxEl) maxEl.textContent = '— cm';
    if (avgEl) avgEl.textContent = '— cm';

    const indicator = document.getElementById('jumpStatusIndicator');
    const statusText = document.getElementById('jumpStatus');
    if (indicator) indicator.className = 'jump-status-indicator status-ready';
    if (statusText) statusText.textContent = 'Ready';

    const container = document.getElementById('jumpHistoryBars');
    if (container) container.innerHTML = '<div class="history-empty">No jumps yet</div>';

    const reportSummary = document.getElementById('testReportSummary');
    const reportDetails = document.getElementById('testReportDetails');
    if (reportSummary) {
        reportSummary.textContent = 'No test report yet. Run a timed test to see the summary here.';
    }
    if (reportDetails) {
        reportDetails.innerHTML = '';
    }
}

// ════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════

function updateDisplay(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

// Simple audio cue for each registered jump (Web Audio API)
function playJumpBeep() {
    try {
        if (!jumpAudioEnabled) return;

        if (!jumpAudioCtx) {
            jumpAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        const ctx = jumpAudioCtx;
        const now = ctx.currentTime;

        // Classic short "beep" for a successful jump
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(900, now);

        gain.gain.setValueAtTime(0.0, now);
        gain.gain.linearRampToValueAtTime(0.3, now + 0.01);
        gain.gain.linearRampToValueAtTime(0.0, now + 0.12);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.14);
    } catch (err) {
        // Fail silently if audio is blocked (e.g. autoplay policies)
        jumpAudioEnabled = false;
    }
}

// Short countdown beep (slightly different feel from jump beep)
function playCountdownBeep(remainingSeconds) {
    try {
        if (!jumpAudioEnabled) return;

        if (!jumpAudioCtx) {
            jumpAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        const ctx = jumpAudioCtx;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        // Clear countdown "tick" — last 3 seconds slightly higher
        const baseFreq = remainingSeconds <= 3 ? 900 : 650;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(baseFreq, now);

        gain.gain.setValueAtTime(0.0, now);
        gain.gain.linearRampToValueAtTime(0.24, now + 0.01);
        gain.gain.linearRampToValueAtTime(0.0, now + 0.11);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.13);
    } catch (err) {
        jumpAudioEnabled = false;
    }
}

// Modal helpers for test summary
function setupTestSummaryModal() {
    const backdrop = document.getElementById('testSummaryModal');
    const closeBtn = document.getElementById('closeTestSummaryModal');
    const exportBtn = document.getElementById('btnExportTestSummaryPdf');
    const sendToServerBtn = document.getElementById('btnSendJumpResultsToServer');
    if (!backdrop) return;

    if (closeBtn) {
        closeBtn.addEventListener('click', hideTestSummaryModal);
    }

    if (exportBtn) {
        exportBtn.addEventListener('click', exportTestSummaryPdf);
    }

    if (sendToServerBtn) {
        sendToServerBtn.addEventListener('click', sendJumpResultsToServer);
    }

    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
            hideTestSummaryModal();
        }
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideTestSummaryModal();
        }
    });
}

function hideTestSummaryModal() {
    const backdrop = document.getElementById('testSummaryModal');
    if (!backdrop) return;
    backdrop.classList.remove('open');
    backdrop.setAttribute('aria-hidden', 'true');
}

function showTestSummaryModal() {
    const backdrop = document.getElementById('testSummaryModal');
    const headerEl = document.getElementById('testSummaryModalHeader');
    const listEl = document.getElementById('testSummaryModalList');
    if (!backdrop || !headerEl || !listEl) return;

    const totalJumps = jumpHistory.jumps.length;

    if (totalJumps === 0) {
        headerEl.textContent = 'No valid jumps were detected during this test.';
        listEl.innerHTML = '';
    } else {
        const bestHeight = jumpHistory.maxHeight;
        const avgHeight = jumpHistory.getAvgHeight();

        headerEl.textContent =
            `Total jumps: ${totalJumps} • Best: ${bestHeight.toFixed(1)} cm • Avg: ${avgHeight.toFixed(1)} cm`;

        const items = jumpHistory.jumps.map((jump, idx) => {
            const heightStr = `${jump.height.toFixed(1)} cm`;
            const flightMs = `${(jump.time * 1000).toFixed(0)} ms`;
            return `<li><span class="modal-jump-label">Jump ${idx + 1}</span><span class="modal-jump-metrics">${heightStr} • ${flightMs}</span></li>`;
        });

        listEl.innerHTML = `<ul class="modal-jump-list">${items.join('')}</ul>`;
    }

    const isCoach = state.userRole === 'coach' && state.coachAuthenticated;
    const sendBlock = document.getElementById('sendToServerBlock');
    const sendBtnWrap = document.getElementById('sendToServerBtnWrap');
    if (sendBlock) sendBlock.style.display = isCoach ? 'flex' : 'none';
    if (sendBtnWrap) sendBtnWrap.style.display = isCoach ? 'inline-flex' : 'none';
    setSendToServerStatus('', '');

    backdrop.classList.add('open');
    backdrop.setAttribute('aria-hidden', 'false');

    // Coach only: auto-send once per test run (skip if already uploaded)
    if (isCoach && totalJumps > 0 && !jumpResultsAlreadyUploaded) {
        sendJumpResultsToServer();
    }
}

function setSendToServerStatus(message, type) {
    const el = document.getElementById('sendToServerStatus');
    if (!el) return;
    el.className = 'modal-footer-status' + (type ? ` modal-footer-status--${type}` : '');
    if (type === 'loading') {
        el.innerHTML = '<span class="spinner athlete-list-spinner" aria-hidden="true"></span><span class="modal-footer-status-text">' + (message || 'Sending...') + '</span>';
    } else {
        el.textContent = message || '';
    }
}

function sendJumpResultsToServer() {
    if (!jumpHistory.jumps || jumpHistory.jumps.length === 0) {
        showToast('No jump data to send', 'info');
        return;
    }
    if (jumpResultsAlreadyUploaded) {
        showToast('Already saved to site', 'info');
        setSendToServerStatus('Saved to site', 'success');
        return;
    }

    const a = state.selectedAthlete || {};
    const payload = {
        jumps: jumpHistory.jumps.map(j => ({
            height: j.height,
            time: j.time,
            timestamp_ms: j.timestamp,
            t_takeoff: j.t_takeoff,
            t_landing: j.t_landing,
        })),
        user_id: a.did != null ? String(a.did) : '',
        first_name: a.dFirstName || '',
        last_name: a.dLastName || '',
        athlete_name: state.athleteName || '',
        weight_kg: 75.0,
        test_duration_seconds: state.testDurationSeconds || null,
    };

    const btn = document.getElementById('btnSendJumpResultsToServer');
    if (btn) {
        btn.disabled = true;
        btn.classList.add('loading');
    }
    setSendToServerStatus('Sending to server...', 'loading');
    showToast('Sending results to server...', 'info');

    fetch('/api/jump-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })
        .then(async (res) => {
            let data = {};
            try {
                const text = await res.text();
                if (text) data = JSON.parse(text);
            } catch (_) {
                data = { detail: res.statusText || 'Unknown error' };
            }
            if (res.ok && data.ok) {
                jumpResultsAlreadyUploaded = true;
                setSendToServerStatus('Saved to site', 'success');
                showToast('Results saved to site successfully', 'success');
            } else {
                const msg = data.detail || data.response_text || data.error || res.statusText || 'Upload failed';
                const msgStr = typeof msg === 'string' ? msg : (msg.message || 'Upload failed');
                setSendToServerStatus('Error: ' + msgStr, 'error');
                showToast(msgStr, 'error');
            }
        })
        .catch((err) => {
            console.error(err);
            const errMsg = err && err.message ? err.message : 'Could not connect to server';
            setSendToServerStatus('Error: ' + errMsg, 'error');
            showToast('Failed to send results to server', 'error');
        })
        .finally(() => {
            if (btn) {
                btn.disabled = false;
                btn.classList.remove('loading');
            }
        });
}

function exportTestSummaryPdf() {
    // Build payload and ask backend (FastAPI + ReportLab) to generate PDF
    if (!jumpHistory.jumps || jumpHistory.jumps.length === 0) {
        showToast('No jump data to export', 'info');
        return;
    }

    const includeSnapshotsCheckbox = document.getElementById('includeSnapshotsForPdf');
    const includeSnapshots = includeSnapshotsCheckbox ? !!includeSnapshotsCheckbox.checked : true;

    const payload = {
        jumps: jumpHistory.jumps.map(j => ({
            height_cm: j.height,
            flight_time_s: j.time,
            timestamp_ms: j.timestamp,
            t_takeoff: j.t_takeoff,
            t_landing: j.t_landing,
            apex_png_b64: j.apex_png_b64 || null,
        })),
        athlete_name: state.athleteName || null,
        test_name: 'Vertical Jump',
        body_weight_kg: 75.0,
        include_snapshots: includeSnapshots,
    };

    showToast('Preparing PDF download...', 'info');

    fetch('/api/report/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })
        .then(async (res) => {
            if (!res.ok) {
                throw new Error('Failed to generate PDF');
            }
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `jump_report_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
            showToast('PDF saved successfully', 'success');
        })
        .catch((err) => {
            console.error(err);
            showToast('Failed to export PDF', 'error');
        });
}

// Modal helpers for coach athlete list
function setupAthleteListModal() {
    const backdrop = document.getElementById('athleteListModal');
    const closeBtn = document.getElementById('closeAthleteListModal');
    const triggerBtn = document.getElementById('btnCoachAthleteList');
    const searchInput = document.getElementById('athleteSearchInput');
    if (!backdrop) return;

    if (closeBtn) {
        closeBtn.addEventListener('click', hideAthleteListModal);
    }

    if (triggerBtn) {
        triggerBtn.addEventListener('click', () => {
            showAthleteListModal();
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            if (!athleteListCache.length) return;
            applyAthleteFilters();
        });
    }

    const groupSelect = document.getElementById('athleteGroupSelect');
    if (groupSelect) {
        groupSelect.addEventListener('change', () => {
            activeGroupFilter = groupSelect.value || null;
            applyAthleteFilters();
        });
    }

    const groupRunBtn = document.getElementById('btnGroupRunTest');
    if (groupRunBtn) {
        groupRunBtn.addEventListener('click', () => {
            if (!activeGroupFilter) {
                showToast('Please select a group first.', 'warning');
                return;
            }
            const list = athleteListCache.filter((a) => athleteBelongsToGroup(a, activeGroupFilter));
            if (!list.length) {
                showToast('No athletes in this group.', 'warning');
                return;
            }
            state.groupTestAthletes = list;
            state.groupTestIndex = 0;
            state.groupTestGroupName = activeGroupFilter;
            state.selectedAthlete = list[0];
            state.athleteName = getAthletePrimaryName(list[0]);
            hideAthleteListModal();
            updateGroupTestNav();
            showToast(`Group test: ${list.length} athletes. First: ${state.athleteName}`, 'success');
            addLog(`🏃 Group test started for "${activeGroupFilter}" (${list.length} athletes). Current: ${state.athleteName}`, 'info');
        });
    }

    const btnGroupPrev = document.getElementById('btnGroupPrev');
    const btnGroupNext = document.getElementById('btnGroupNext');
    if (btnGroupPrev) {
        btnGroupPrev.addEventListener('click', () => {
            if (!state.groupTestAthletes.length || state.groupTestIndex === 0) return;
            state.groupTestIndex -= 1;
            state.selectedAthlete = state.groupTestAthletes[state.groupTestIndex];
            state.athleteName = getAthletePrimaryName(state.selectedAthlete);
            updateGroupTestNav();
            showToast(`Previous: ${state.athleteName}`, 'info');
        });
    }
    if (btnGroupNext) {
        btnGroupNext.addEventListener('click', () => {
            if (!state.groupTestAthletes.length || state.groupTestIndex === state.groupTestAthletes.length - 1) return;
            state.groupTestIndex += 1;
            state.selectedAthlete = state.groupTestAthletes[state.groupTestIndex];
            state.athleteName = getAthletePrimaryName(state.selectedAthlete);
            updateGroupTestNav();
            showToast(`Next: ${state.athleteName}`, 'info');
        });
    }

    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
            hideAthleteListModal();
        }
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const m = document.getElementById('athleteListModal');
            if (m && m.classList.contains('open')) hideAthleteListModal();
        }
    });
}

function hideAthleteListModal() {
    const backdrop = document.getElementById('athleteListModal');
    if (!backdrop) return;
    backdrop.classList.remove('open');
    backdrop.setAttribute('aria-hidden', 'true');
}

/** Update header badge and Prev/Next nav when in group test */
function updateGroupTestNav() {
    const badge = document.getElementById('brandRoleBadge');
    const nav = document.getElementById('groupTestNav');
    const positionEl = document.getElementById('groupTestPosition');
    const btnPrev = document.getElementById('btnGroupPrev');
    const btnNext = document.getElementById('btnGroupNext');
    if (!nav) return;
    const groupBadgeEl = document.getElementById('groupTestGroupBadge');
    if (state.groupTestAthletes && state.groupTestAthletes.length > 0) {
        const total = state.groupTestAthletes.length;
        const current = state.groupTestIndex + 1;
        if (groupBadgeEl) {
            groupBadgeEl.textContent = state.groupTestGroupName || '—';
            groupBadgeEl.style.display = 'inline-flex';
        }
        if (positionEl) positionEl.textContent = current + ' / ' + total;
        if (btnPrev) {
            btnPrev.disabled = state.groupTestIndex === 0;
            btnPrev.title = state.groupTestIndex === 0 ? 'اول گروه هستید' : 'ورزشکار قبلی';
        }
        if (btnNext) {
            btnNext.disabled = state.groupTestIndex === total - 1;
            btnNext.title = state.groupTestIndex === total - 1 ? 'آخر گروه هستید' : 'ورزشکار بعدی';
        }
        if (badge) {
            badge.textContent = state.athleteName || '';
            badge.style.display = 'inline-flex';
        }
        nav.style.display = 'inline-flex';
    } else {
        nav.style.display = 'none';
        if (groupBadgeEl) groupBadgeEl.style.display = 'none';
        if (positionEl) positionEl.textContent = '';
        if (btnPrev) btnPrev.disabled = false;
        if (btnNext) btnNext.disabled = false;
        if (badge) {
            const isCoach = state.userRole === 'coach' && state.coachAuthenticated;
            const fullName = (state.athleteName || '').trim();
            if (isCoach) badge.textContent = 'Coach mode';
            else if (state.userRole === 'guest' && fullName) badge.textContent = fullName;
            else badge.style.display = 'none';
        }
    }
}

// Cache for athlete list (so search filters without re-fetching)
let athleteListCache = [];
// Currently displayed list (after search filter) for click index mapping
let athleteListFiltered = [];
// Active group filter: when set, only athletes in this group are shown
let activeGroupFilter = null;

function getAthletePrimaryName(a) {
    const raw = a || {};
    return (
        raw.fullName ||
        raw.name ||
        raw.title ||
        raw.displayName ||
        raw.athlete_name ||
        raw.athleteName ||
        raw.email ||
        ''
    );
}

function getAthleteSearchText(a) {
    const raw = a || {};
    const parts = [
        // Generic/common fields
        raw.fullName,
        raw.name,
        raw.title,
        raw.displayName,
        raw.athlete_name,
        raw.athleteName,
        raw.email,
        raw.mobile,
        raw.phone,
        raw.country,
        // Legacy / desktop-app specific fields
        raw.dFirstName,
        raw.dLastName,
        raw.dName,
        raw.dNumber,
        raw.dMail,
        raw.dPhone,
        raw.gName,
        raw.sengName,
        raw.did && String(raw.did),
        Array.isArray(raw.groupNames) ? raw.groupNames.join(' ') : null,
    ].filter(Boolean);
    return parts.join(' ').toLowerCase();
}

/** Returns all group names for an athlete (gName + groupNames + etc.) */
function getAthleteGroups(a) {
    const raw = a || {};
    const groupNames = [];
    if (raw.gName) groupNames.push(raw.gName);
    if (Array.isArray(raw.groupNames)) groupNames.push(...raw.groupNames);
    if (raw.group) groupNames.push(raw.group);
    if (raw.group_name) groupNames.push(raw.group_name);
    if (raw.groupName) groupNames.push(raw.groupName);
    if (raw.run_group) groupNames.push(raw.run_group);
    if (raw.runGroup) groupNames.push(raw.runGroup);
    if (raw.team) groupNames.push(raw.team);
    if (raw.team_name) groupNames.push(raw.team_name);
    if (raw.category) groupNames.push(raw.category);
    return Array.from(new Set(groupNames.filter(Boolean)));
}

/** True if athlete belongs to the given group name */
function athleteBelongsToGroup(a, groupName) {
    return getAthleteGroups(a).some((g) => String(g).toLowerCase() === String(groupName).toLowerCase());
}

/** Collect all unique group/team names from the current cache */
function getAllUniqueGroups() {
    const set = new Set();
    athleteListCache.forEach((a) => getAthleteGroups(a).forEach((g) => set.add(g)));
    return Array.from(set).sort((a, b) => String(a).localeCompare(String(b)));
}

/** Populate the group dropdown from athleteListCache */
function populateGroupDropdown() {
    const sel = document.getElementById('athleteGroupSelect');
    if (!sel) return;
    const current = sel.value;
    const groups = getAllUniqueGroups();
    sel.innerHTML = '<option value="">All groups</option>' + groups.map((g) => `<option value="${String(g).replace(/"/g, '&quot;')}">${String(g).replace(/</g, '&lt;')}</option>`).join('');
    sel.value = activeGroupFilter && groups.includes(activeGroupFilter) ? activeGroupFilter : '';
    if (current && groups.includes(current)) sel.value = current;
}

/** Apply group + search filters and re-render; syncs group dropdown */
function applyAthleteFilters() {
    const searchInput = document.getElementById('athleteSearchInput');
    const groupSelect = document.getElementById('athleteGroupSelect');

    let list = athleteListCache;
    if (activeGroupFilter) {
        list = list.filter((a) => athleteBelongsToGroup(a, activeGroupFilter));
    }
    const q = (searchInput && searchInput.value || '').trim().toLowerCase();
    if (q) {
        list = list.filter((a) => getAthleteSearchText(a).includes(q));
    }

    if (groupSelect) groupSelect.value = activeGroupFilter || '';

    const selectedPrimary = state.selectedAthlete ? getAthletePrimaryName(state.selectedAthlete) : '';
    renderAthleteList(list, selectedPrimary);
}

function renderAthleteList(items, selectedPrimary) {
    const bodyEl = document.getElementById('athleteListBody');
    const headerEl = document.getElementById('athleteListHeader');
    const selectedEl = document.getElementById('athleteDashboardSelected');
    if (!bodyEl || !headerEl) return;

    athleteListFiltered = items;

    if (!items.length) {
        headerEl.textContent = 'No athletes match your search.';
        bodyEl.innerHTML = '';
        if (selectedEl) {
            selectedEl.textContent = state.selectedAthlete ? `Selected: ${state.athleteName || getAthletePrimaryName(state.selectedAthlete)}` : 'Double-click a row to select.';
            selectedEl.classList.toggle('has-selection', !!state.selectedAthlete);
        }
        return;
    }

    headerEl.textContent = `${items.length} athlete${items.length !== 1 ? 's' : ''}`;

    const ul = document.createElement('ul');
    ul.className = 'modal-jump-list modal-athlete-list';

    items.forEach((raw, idx) => {
        const a = raw || {};
        const primary = getAthletePrimaryName(a) || `Athlete ${idx + 1}`;

        // --- Run group / team tags ---
        const groupNames = [];
        if (a.gName) groupNames.push(a.gName); // main club / group from API sample
        if (Array.isArray(a.groupNames)) groupNames.push(...a.groupNames); // extra groups from API sample
        if (a.group) groupNames.push(a.group);
        if (a.group_name) groupNames.push(a.group_name);
        if (a.groupName) groupNames.push(a.groupName);
        if (a.run_group) groupNames.push(a.run_group);
        if (a.runGroup) groupNames.push(a.runGroup);
        if (a.team) groupNames.push(a.team);
        if (a.team_name) groupNames.push(a.team_name);
        if (a.category) groupNames.push(a.category);
        const uniqueGroups = Array.from(new Set(groupNames.filter(Boolean)));

        // --- Meta line (email / phone / sport / country) ---
        const metaParts = [];
        if (a.dMail || a.email) metaParts.push(a.dMail || a.email);
        if (a.dPhone || a.mobile || a.phone) metaParts.push(a.dPhone || a.mobile || a.phone);
        if (a.sengName) metaParts.push(a.sengName); // e.g. Soccer
        if (a.dNation || a.country) metaParts.push(a.dNation || a.country);
        const meta = metaParts.join(' • ');

        const tags = [];
        const escapeAttr = (s) => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        uniqueGroups.forEach((g) => {
            tags.push(`<span class="athlete-tag athlete-tag--group athlete-tag--clickable" data-group="${escapeAttr(g)}">${escapeHtml(g)}</span>`);
        });
        const tagsHtml = tags.length ? `<div class="athlete-tags">${tags.join('')}</div>` : '';

        const metaHtml = meta ? `<div class="athlete-row-meta">${meta}</div>` : '';

        const li = document.createElement('li');
        li.dataset.index = String(idx);
        li.innerHTML = `
            <div class="athlete-row-main">
                <span class="modal-jump-label">${primary}</span>
                ${tagsHtml}
            </div>
            ${metaHtml}
        `;
        if (selectedPrimary && (primary === selectedPrimary || state.athleteName === primary)) {
            li.classList.add('selected');
        }
        const handleSelect = () => {
            state.selectedAthlete = raw;
            state.athleteName = primary;
            // Update selected summary
            const selEl = document.getElementById('athleteDashboardSelected');
            if (selEl) {
                selEl.textContent = `Selected: ${primary}`;
                selEl.classList.add('has-selection');
            }
            // Update badge in header
            const badge = document.getElementById('brandRoleBadge');
            if (badge && state.userRole === 'coach') {
                badge.textContent = primary;
                badge.style.display = 'inline-flex';
            }
            // Toggle selected state on rows
            ul.querySelectorAll('li').forEach((row) => row.classList.remove('selected'));
            li.classList.add('selected');
            showToast(`Selected: ${primary}`, 'success');
        };

        li.addEventListener('dblclick', () => {
            handleSelect();
            hideAthleteListModal();
        });
        ul.appendChild(li);

        li.querySelectorAll('.athlete-tag--group.athlete-tag--clickable').forEach((span) => {
            span.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                activeGroupFilter = span.getAttribute('data-group') || '';
                applyAthleteFilters();
                showToast(`Filter: ${activeGroupFilter}`, 'info');
            });
        });
    });

    bodyEl.innerHTML = '';
    bodyEl.appendChild(ul);

    if (selectedEl) {
        selectedEl.textContent = state.selectedAthlete
            ? `Selected: ${state.athleteName || getAthletePrimaryName(state.selectedAthlete)}`
            : 'Double-click a row to select.';
        selectedEl.classList.toggle('has-selection', !!state.selectedAthlete);
    }
}

function showAthleteListModal() {
    const backdrop = document.getElementById('athleteListModal');
    const headerEl = document.getElementById('athleteListHeader');
    const bodyEl = document.getElementById('athleteListBody');
    const searchInput = document.getElementById('athleteSearchInput');
    const selectedEl = document.getElementById('athleteDashboardSelected');
    if (!backdrop || !headerEl || !bodyEl) return;

    if (!(state.userRole === 'coach' && state.coachAuthenticated)) {
        showToast('Athlete list is only available in Coach mode.', 'info');
        return;
    }

    if (searchInput) searchInput.value = '';
    activeGroupFilter = null;
    const groupSelect = document.getElementById('athleteGroupSelect');
    if (groupSelect) groupSelect.value = '';
    headerEl.innerHTML = '<div class="athlete-list-loading"><span class="spinner athlete-list-spinner"></span></div>';
    bodyEl.innerHTML = '';
    if (selectedEl) {
        selectedEl.textContent = 'Double-click a row to select.';
        selectedEl.classList.remove('has-selection');
    }

    backdrop.classList.add('open');
    backdrop.setAttribute('aria-hidden', 'false');

    fetch('/api/coach/athletes')
        .then((res) => {
            if (!res.ok) throw new Error(`Failed to load athletes: ${res.status}`);
            return res.json();
        })
        .then((data) => {
            const items = Array.isArray(data?.items) ? data.items : [];
            athleteListCache = items;

            if (!items.length) {
                headerEl.textContent = 'No athletes found.';
                bodyEl.innerHTML = '';
                if (selectedEl) selectedEl.textContent = 'Double-click a row to select.';
                return;
            }

            populateGroupDropdown();
            applyAthleteFilters();
        })
        .catch((err) => {
            console.error(err);
            headerEl.textContent = 'Failed to load athletes from server.';
            bodyEl.innerHTML = '';
            if (selectedEl) selectedEl.textContent = 'Double-click a row to select.';
            showToast('Failed to load athlete list.', 'error');
        });
}

// Final, longer beep when countdown completes
function playCountdownFinalBeep() {
    try {
        if (!jumpAudioEnabled) return;

        if (!jumpAudioCtx) {
            jumpAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        const ctx = jumpAudioCtx;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        // Classic long countdown "BEEEP" to signal GO
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1000, now);

        gain.gain.setValueAtTime(0.0, now);
        gain.gain.linearRampToValueAtTime(0.45, now + 0.03);
        gain.gain.linearRampToValueAtTime(0.0, now + 0.55);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.6);
    } catch (err) {
        jumpAudioEnabled = false;
    }
}

// Dedicated toast for jump events: always show only the latest jump
function showJumpToast(count, heightStr, flightMs) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    // Remove previous jump toast if still visible
    if (lastJumpToastElement && lastJumpToastElement.parentElement === container) {
        lastJumpToastElement.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'toast success toast-jump';
    toast.textContent = `Jump ${count}: ${heightStr} • ${flightMs}`;
    container.appendChild(toast);
    lastJumpToastElement = toast;

    // Auto-hide, similar timing to generic toasts
    setTimeout(() => {
        if (toast.parentElement !== container) return;
        toast.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(() => {
            if (toast.parentElement === container) {
                toast.remove();
            }
            if (lastJumpToastElement === toast) {
                lastJumpToastElement = null;
            }
        }, 300);
    }, 3500);
}

// Sidebar tabs (Last Jump / Test Report)
function setupSidebarTabs() {
    const tabs = document.querySelectorAll('.sidebar-tab');
    if (!tabs.length) return;

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.getAttribute('data-tab');
            if (!targetId) return;
            selectSidebarTab(targetId);
        });
    });
}

function selectSidebarTab(targetId) {
    const tabs = document.querySelectorAll('.sidebar-tab');
    const panels = document.querySelectorAll('.sidebar-tab-panel');

    tabs.forEach(t => {
        const tabTarget = t.getAttribute('data-tab');
        t.classList.toggle('active', tabTarget === targetId);
    });

    panels.forEach(p => {
        p.classList.toggle('active', p.id === targetId);
    });

    // When user switches to Test Report tab, show the detailed popup.
    // When leaving it, hide the popup.
    if (targetId === 'testReportTab') {
        showTestSummaryModal();
    } else {
        hideTestSummaryModal();
    }
}

// Live timer with 0.1s precision for running tests
function startLiveTestTimer() {
    const displayEl = document.getElementById('testTimeRemainingLabel');
    if (!displayEl) return;

    if (liveTimerRafId) {
        cancelAnimationFrame(liveTimerRafId);
        liveTimerRafId = null;
    }

    const startMs = state.testStartTimeMs || performance.now();
    const totalMs = state.testDurationMs || 0;

    function tick() {
        if (!state.testRunning) {
            liveTimerRafId = null;
            return;
        }

        const now = performance.now();
        const elapsed = now - startMs;
        const remainingMs = Math.max(0, totalMs - elapsed);
        const remainingSec = remainingMs / 1000;

        displayEl.textContent = `${remainingSec.toFixed(1)}s`;

        liveTimerRafId = requestAnimationFrame(tick);
    }

    tick();
}

// Build and display a simple test report using the in-memory jump history
function showTestReport() {
    const totalJumps = jumpHistory.jumps.length;
    const reportSummary = document.getElementById('testReportSummary');
    const reportDetails = document.getElementById('testReportDetails');

    if (!reportSummary || !reportDetails) return;

    if (totalJumps === 0) {
        reportSummary.textContent = 'No valid jumps were detected during this test.';
        reportDetails.innerHTML = '';
        return;
    }

    const bestHeight = jumpHistory.maxHeight;
    const avgHeight = jumpHistory.getAvgHeight();

    reportSummary.textContent =
        `Total jumps: ${totalJumps} • Best: ${bestHeight.toFixed(1)} cm • Avg: ${avgHeight.toFixed(1)} cm`;

    // Show details for all jumps in this test
    const items = jumpHistory.jumps.map((jump, idx) => {
        const indexLabel = idx + 1;
        const heightStr = `${jump.height.toFixed(1)} cm`;
        const flightMs = `${(jump.time * 1000).toFixed(0)} ms`;
        return `<li><span class="test-report-jump-label">Jump ${indexLabel}</span><span class="test-report-jump-metrics">${heightStr} • ${flightMs}</span></li>`;
    });

    reportDetails.innerHTML = `<ul>${items.join('')}</ul>`;
}

// ════════════════════════════════════════════
// EXPORT for pose-loop (status updates each frame)
// ════════════════════════════════════════════

export { updateJumpStatus, updateJumpSidebar };

// ════════════════════════════════════════════
// EXPOSE TO GLOBAL
// ════════════════════════════════════════════

window.startAll = startAll;
window.stopAll = stopAll;
window.openTestSelection = openTestSelection;

// ════════════════════════════════════════════
// TOGGLE JUMP DETECTION
// ════════════════════════════════════════════

function toggleJumpDetection() {
    if (!state.poseRunning) return;

    // If a test or countdown is already running, stop it early
    if (state.testRunning || state.countdownRunning) {
        stopTimedTest(true);
        return;
    }

    // Start a new timed test (with optional pre-countdown)
    const duration = Math.max(3, Math.min(600, state.testDurationSeconds || 10));
    const countdown = Math.max(0, Math.min(10, state.preCountdownSeconds || 3));

    state.testDurationSeconds = duration;
    state.preCountdownSeconds = countdown;

    startTimedTestWithCountdown(countdown, duration);
}

window.toggleJumpDetection = toggleJumpDetection;

// ════════════════════════════════════════════
// TIMED TEST HELPERS
// ════════════════════════════════════════════

function updateTestStatus(status, remainingSeconds = null) {
    const statusEl = document.getElementById('testStatusLabel');
    const remainingEl = document.getElementById('testTimeRemainingLabel');
    if (statusEl) statusEl.textContent = status;
    if (remainingEl) {
        // Countdown uses integer seconds; running test uses live timer
        if (status === 'Countdown') {
            if (remainingSeconds != null && remainingSeconds >= 0) {
                remainingEl.textContent = `${remainingSeconds}s`;
            } else {
                remainingEl.textContent = '';
            }
        } else if (status !== 'Running') {
            remainingEl.textContent = '';
        }
    }
}

function updateTestButton(running) {
    const btn  = document.getElementById('btnToggleJump');
    const icon = document.getElementById('btnToggleJumpIcon');
    const text = document.getElementById('btnToggleJumpText');

    if (!btn || !icon || !text) return;

    if (running) {
        btn.classList.add('active');
        icon.textContent = '⏹';
        text.textContent = 'Stop Test';
    } else {
        btn.classList.remove('active');
        icon.textContent = '▶';
        text.textContent = 'Start Test';
    }
}

function startTimedTestWithCountdown(countdownSeconds, testSeconds) {
    const overlay = document.getElementById('testCountdownOverlay');

    // Ensure previous timers are cleared
    if (countdownIntervalId) {
        clearInterval(countdownIntervalId);
        countdownIntervalId = null;
    }
    if (testIntervalId) {
        clearInterval(testIntervalId);
        testIntervalId = null;
    }

    // Fresh test: reset detector & history BEFORE any new jumps
    resetActiveDetector();
    jumpHistory.reset();
    jumpResultsAlreadyUploaded = false;
    updateJumpSidebar();
    renderJumpHistoryBars();

    state.testRunning = false;
    state.countdownRunning = true;
    updateTestButton(true);

    if (countdownSeconds > 0 && overlay) {
        let remaining = Math.floor(countdownSeconds);
        overlay.textContent = remaining;
        overlay.classList.add('visible');
        updateTestStatus('Countdown', remaining);
        // Beep immediately for the first visible countdown value
        playCountdownBeep(remaining);

        countdownIntervalId = setInterval(() => {
            remaining -= 1;
            if (remaining > 0) {
                overlay.textContent = remaining;
                updateTestStatus('Countdown', remaining);
                // Countdown beeps on each tick (except final 0)
                playCountdownBeep(remaining);
            } else {
                clearInterval(countdownIntervalId);
                countdownIntervalId = null;
                state.countdownRunning = false;

                if (overlay) {
                    overlay.classList.remove('visible');
                }

                // Final, stronger beep to signal test start
                playCountdownFinalBeep();

                // Either start timer immediately, or arm it to start on first jump
                if (state.startTimerOnFirstJump) {
                    armTimedTestAfterFirstJump(testSeconds);
                } else {
                    startTimedTest(testSeconds);
                }
            }
        }, 1000);
    } else {
        // No countdown, start immediately
        if (overlay) overlay.classList.remove('visible');
        state.countdownRunning = false;
        if (state.startTimerOnFirstJump) {
            armTimedTestAfterFirstJump(testSeconds);
        } else {
            startTimedTest(testSeconds);
        }
    }
}

function startTimedTest(testSeconds) {
    const duration = Math.max(1, Math.floor(testSeconds));

    state.jumpEnabled = true;
    state.testRunning = true;
    state.testStartTimeMs = performance.now();
    state.testDurationMs = duration * 1000;

    updateTestButton(true);
    updateTestStatus('Running', duration);

    // Start smooth live countdown (0.1s precision)
    startLiveTestTimer();

    let remaining = duration;
    if (testIntervalId) {
        clearInterval(testIntervalId);
        testIntervalId = null;
    }

    testIntervalId = setInterval(() => {
        remaining -= 1;
        if (remaining >= 0) {
            updateTestStatus('Running', remaining);
        }
        if (remaining <= 0) {
            stopTimedTest(false);
        }
    }, 1000);

    addLog(`🧪 Jump test started (${duration}s)`, 'success');
    showToast(`Jump test started for ${duration} seconds`, 'success');
}

// Arm a test so that the main timer starts counting down only after the first jump
function armTimedTestAfterFirstJump(testSeconds) {
    const duration = Math.max(1, Math.floor(testSeconds));

    state.jumpEnabled = true;
    state.testRunning = false;
    state.testStartTimeMs = 0;
    state.testDurationMs = duration * 1000;
    state.startTimerOnFirstJump = true;

    updateTestButton(true);
    updateTestStatus('Waiting first jump', null);

    addLog(`🧪 Test armed for ${duration}s — waiting for first jump to start timer`, 'info');
}

function stopTimedTest(cancelled) {
    const overlay = document.getElementById('testCountdownOverlay');

    if (countdownIntervalId) {
        clearInterval(countdownIntervalId);
        countdownIntervalId = null;
    }
    if (testIntervalId) {
        clearInterval(testIntervalId);
        testIntervalId = null;
    }

    if (overlay) {
        overlay.classList.remove('visible');
    }

    state.jumpEnabled = false;
    state.testRunning = false;
    state.countdownRunning = false;
    state.testStartTimeMs = 0;
    state.testDurationMs = 0;

    if (liveTimerRafId) {
        cancelAnimationFrame(liveTimerRafId);
        liveTimerRafId = null;
    }

    updateTestButton(false);
    updateTestStatus(cancelled ? 'Cancelled' : 'Finished', null);

    if (cancelled) {
        addLog('⏹️ Jump test cancelled', 'info');
        showToast('Jump test cancelled', 'info');
    } else {
        addLog('✅ Jump test finished', 'success');
        showToast('Jump test finished', 'success');
        // Build test report from current jump history
        showTestReport();
        // Switch to Test Report tab so details are visible
        selectSidebarTab('testReportTab');
        // Also show a popup with details of all jumps in this test
        showTestSummaryModal();
    }
}

// ════════════════════════════════════════════
// MOBILE: Move skeleton canvas into raw-frame
// ════════════════════════════════════════════

function syncCanvasFrame() {
    const canvas    = document.getElementById('outputCanvas');
    const fpsBadge  = document.getElementById('fpsBadgeOverlay');
    const rawFrame  = document.querySelector('.video-raw-frame');
    const skelFrame = document.querySelector('.video-skeleton-frame');
    if (!canvas || !rawFrame || !skelFrame) return;

    const isMobile = window.matchMedia('(max-width: 540px)').matches;

    if (isMobile && canvas.parentElement !== rawFrame) {
        rawFrame.appendChild(canvas);
        if (fpsBadge) rawFrame.appendChild(fpsBadge);
    } else if (!isMobile && canvas.parentElement !== skelFrame) {
        skelFrame.insertBefore(canvas, skelFrame.firstChild);
        if (fpsBadge) {
            const frameLabel = skelFrame.querySelector('.frame-label');
            skelFrame.insertBefore(fpsBadge, frameLabel);
        }
    }
}

syncCanvasFrame();
window.addEventListener('resize', syncCanvasFrame);

// ════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════

init();
