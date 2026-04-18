import { state } from './state.js';
// ═══════════════════════════════════════════
// Rapid Jump Detector — aligned with rapid_jump_detector.py
// Landmarks are always in the same normalized space as the MediaPipe input
// (video is rotated + mirrored in the processing canvas first).
// ═══════════════════════════════════════════

class KalmanFilter1D {
    constructor(processNoise = 0.08, measurementNoise = 0.05, estimatedError = 1.0) {
        this.q = processNoise;
        this.r = measurementNoise;
        this.p = estimatedError;
        this.x = 0.0;
        this.k = 0.0;
        this.firstRun = true;
    }

    update(measurement) {
        if (this.firstRun) {
            this.x = measurement;
            this.firstRun = false;
        }
        this.p = this.p + this.q;
        this.k = this.p / (this.p + this.r);
        this.x = this.x + this.k * (measurement - this.x);
        this.p = (1 - this.k) * this.p;
        return this.x;
    }

    reset() {
        this.firstRun = true;
        this.x = 0.0;
        this.p = 1.0;
    }
}

const DEFAULT_CONFIG = {
    riseThreshold: 0.15,
    fallThreshold: 0.075,
    calibFrames: 15,
    minVisibility: 0.5,
    minTimeBetweenPeaks: 0.01,
    avgTorsoLengthCm: 52.0,
};

const LANDMARKS = {
    LEFT_SHOULDER: 11,
    RIGHT_SHOULDER: 12,
    LEFT_HIP: 23,
    RIGHT_HIP: 24,
    LEFT_ANKLE: 27,
    RIGHT_ANKLE: 28,
    LEFT_TOE: 31,
    RIGHT_TOE: 32,
};

export class RapidJumpDetector {
    constructor(sensitivity = 0.15, calibFrames = 15) {
        this.config = { ...DEFAULT_CONFIG };
        this.config.riseThreshold = sensitivity;
        this.config.fallThreshold = sensitivity * 0.5;
        this.config.calibFrames = calibFrames;

        this.kfY = new KalmanFilter1D(0.08, 0.05);
        this.dataBuffer = [];
        this.maxBufferSize = 20;

        this.reset();
    }

    reset() {
        this.isCalibrated = false;
        this.baseTorsoLen = 0.0;
        this.currentTorso = 0.0;
        this.currentY = null;
        this.currentX = null;
        this.calFrames = 0;
        this.calibBuffer = [];

        this.counter = 0;

        this.state = 'SEARCHING_LOW';
        this.localMin = 1000.0;
        this.localMax = -1000.0;

        this.lastPeakTime = -1.0;
        this.lastLandingTime = -10.0;
        this.jumpStartTime = 0.0;
        this.jumpStartY = 0.0;
        this.jumpStartX = 0.0;
        this.apexX = 0.0;

        this.prevY = null;
        this.prevTime = null;

        this.yHistory = [];
        this.maxYHistory = 5;

        this.vizEventText = '';
        this.vizEventTime = 0;
        this.vizEventColor = '#000000';
        this.vizTakeoffPoint = null;
        this.vizLandingPoint = null;

        this.kfY.reset();
        this.dataBuffer = [];
        this.lastJumpData = null;

        this.feetGroundY = null;
        this.currentAnkleX = null;
        this.currentAnkleY = null;
        this.isFeetOff = false;
    }

    updateSensitivity(value) {
        const thresh = parseFloat(value);
        if (!isNaN(thresh)) {
            this.config.riseThreshold = thresh;
            this.config.fallThreshold = thresh * 0.5;
        }
    }

    _median(arr) {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    _getSmoothCorrection(rawDuration) {
        const tMin = 0.4;
        const tMax = 0.65;
        const fHigh = 0.88;
        const fLow = 0.74;
        if (rawDuration <= tMin) return fHigh;
        if (rawDuration >= tMax) return fLow;
        const t = (rawDuration - tMin) / (tMax - tMin);
        return fHigh + t * (fLow - fHigh);
    }

    process(landmarks, timestamp) {
        const currTime = parseFloat(timestamp);
        if (isNaN(currTime)) {
            return { event: null, isJumping: false };
        }

        if (this.state === 'SEARCHING_PEAK') {
            if (
                this.vizTakeoffPoint === null ||
                (this.vizLandingPoint !== null &&
                    this.vizTakeoffPoint.y !== this.jumpStartY)
            ) {
                this.vizTakeoffPoint = { x: this.jumpStartX, y: this.jumpStartY };
                this.vizLandingPoint = null;
            }
        }

        let currY;
        let currTorso;
        let hipX;
        let feetLift = 0.0;
        let isFeetOffGround = false;

        try {
            const lHip = landmarks[LANDMARKS.LEFT_HIP];
            const rHip = landmarks[LANDMARKS.RIGHT_HIP];
            const lSh = landmarks[LANDMARKS.LEFT_SHOULDER];
            const rSh = landmarks[LANDMARKS.RIGHT_SHOULDER];

            if (
                lHip.visibility < this.config.minVisibility ||
                rHip.visibility < this.config.minVisibility
            ) {
                return { event: null, isJumping: false };
            }

            const hipY = (lHip.y + rHip.y) / 2.0;
            hipX = (lHip.x + rHip.x) / 2.0;

            if (
                lSh.visibility > this.config.minVisibility &&
                rSh.visibility > this.config.minVisibility
            ) {
                const shY = (lSh.y + rSh.y) / 2.0;
                currTorso = Math.abs(hipY - shY);
                const rawY = hipY * 0.4 + shY * 0.6;
                currY = this.kfY.update(rawY);
            } else {
                currY = this.kfY.update(hipY);
                currTorso = this.baseTorsoLen;
            }

            const lAnkle = landmarks[LANDMARKS.LEFT_ANKLE];
            const rAnkle = landmarks[LANDMARKS.RIGHT_ANKLE];
            const leftToe = landmarks[LANDMARKS.LEFT_TOE];
            const rightToe = landmarks[LANDMARKS.RIGHT_TOE];

            if (
                lAnkle.visibility > this.config.minVisibility &&
                rAnkle.visibility > this.config.minVisibility
            ) {
                const ankleY = (lAnkle.y + rAnkle.y) / 2.0;
                const ankleX = (lAnkle.x + rAnkle.x) / 2.0;

                if (this.feetGroundY === null || this.feetGroundY === undefined) {
                    this.feetGroundY = ankleY;
                } else {
                    if (this.state === 'SEARCHING_LOW' || ankleY > this.feetGroundY) {
                        this.feetGroundY = this.feetGroundY * 0.92 + ankleY * 0.08;
                    }
                }

                feetLift = this.feetGroundY - ankleY;
                this.currentAnkleX = ankleX;
                this.currentAnkleY = ankleY;
            } else {
                feetLift = 0.0;
            }

            let liftThreshold;
            let toeMargin;
            if (this.state === 'SEARCHING_LOW') {
                liftThreshold = currTorso * 0.08;
                toeMargin = currTorso * 0.01;
            } else {
                liftThreshold = currTorso * 0.03;
                toeMargin = currTorso * 0.04;
            }

            const groundY = this.feetGroundY != null ? this.feetGroundY : hipY;
            const leftInAir =
                leftToe.visibility > this.config.minVisibility
                    ? leftToe.y < groundY - toeMargin
                    : true;
            const rightInAir =
                rightToe.visibility > this.config.minVisibility
                    ? rightToe.y < groundY - toeMargin
                    : true;

            this.isFeetOff = leftInAir && rightInAir && feetLift > liftThreshold;

            isFeetOffGround = feetLift > currTorso * 0.05;

            this.currentTorso = currTorso;
            this.currentY = currY;
            this.yHistory.push(currY);
            if (this.yHistory.length > this.maxYHistory) this.yHistory.shift();
            this.currentX = hipX;

            if (this.prevY === null) this.prevY = currY;
            if (this.prevTime === null) this.prevTime = currTime;

            this.dataBuffer.push({ t: currTime, y: currY });
            if (this.dataBuffer.length > this.maxBufferSize) {
                this.dataBuffer.shift();
            }
        } catch (e) {
            console.warn('[JumpDetector] Landmark error:', e);
            return { event: null, isJumping: false };
        }

        if (!this.isCalibrated) {
            if (currTorso > 0) {
                this.calibBuffer.push(currTorso);
            }

            this.localMin = currY;
            this.localMax = currY;
            this.calFrames++;

            if (this.calFrames >= Math.max(15, this.config.calibFrames)) {
                if (this.calibBuffer.length > 0) {
                    this.baseTorsoLen = this._median(this.calibBuffer);
                } else {
                    this.baseTorsoLen = 0.3;
                }
                this.isCalibrated = true;
                console.log(
                    `[JumpDetector] Calibrated. Base Torso: ${this.baseTorsoLen.toFixed(3)}`
                );
            }

            return { event: null, isJumping: false };
        }

        const dynamicRise = this.config.riseThreshold * this.currentTorso;
        const dynamicFall = this.config.fallThreshold * this.currentTorso;

        let event = null;
        let isJumping = false;

        if (this.state === 'SEARCHING_LOW') {
            if (currY > this.localMin) {
                this.localMin = currY;
            } else {
                if (!isFeetOffGround) {
                    this.localMin = this.localMin * 0.85 + currY * 0.15;
                } else {
                    this.localMin = this.localMin * 0.92 + currY * 0.08;
                }
            }

            const riseAmount = this.localMin - currY;

            if (riseAmount > dynamicRise && isFeetOffGround) {
                const offset = this.currentTorso * 0.12;
                const virtualStartY = this.localMin - offset;

                let realStartTime = currTime;
                let foundStart = false;

                for (let i = this.dataBuffer.length - 1; i > 0; i--) {
                    const pCurr = this.dataBuffer[i];
                    const pPrev = this.dataBuffer[i - 1];

                    if (pPrev.y >= virtualStartY && pCurr.y < virtualStartY) {
                        const fraction =
                            (pPrev.y - virtualStartY) /
                            (pPrev.y - pCurr.y + 0.00001);
                        realStartTime =
                            pPrev.t + fraction * (pCurr.t - pPrev.t);
                        foundStart = true;
                        break;
                    }
                }

                if (!foundStart) {
                    realStartTime = currTime;
                }

                this.jumpStartTime = realStartTime;
                this.jumpStartY = virtualStartY;
                this.jumpStartX = this.currentX;
                this.apexX = this.currentX;

                this.state = 'SEARCHING_PEAK';
                this.localMax = currY;

                this.vizEventText = 'UP';
                this.vizEventColor = '#00FF00';
                this.vizEventTime = currTime;
                this.vizTakeoffPoint = { x: this.jumpStartX, y: this.jumpStartY };

                isJumping = true;
            }
        } else if (this.state === 'SEARCHING_PEAK') {
            isJumping = true;

            if (currY <= this.localMax) {
                this.apexX = this.currentX;
                this.localMax = currY;
            }

            const fallAmount = currY - this.localMax;
            const totalJumpHeight = Math.abs(this.jumpStartY - this.localMax);
            const distFromStart = currY - this.jumpStartY;

            const dynFall = this.config.fallThreshold * this.currentTorso;
            const isStandardDrop = fallAmount > dynFall;

            let hasReturnedMostly = false;
            if (totalJumpHeight > 0) {
                if (fallAmount > totalJumpHeight * 0.9) {
                    hasReturnedMostly = true;
                }
            }

            if (
                (isStandardDrop &&
                    distFromStart > -(this.currentTorso * 0.15)) ||
                hasReturnedMostly
            ) {
                const tTakeoff = this.jumpStartTime;

                let tLandingExact;
                if (currY !== this.prevY) {
                    let fraction =
                        (this.jumpStartY - this.prevY) / (currY - this.prevY);
                    fraction = Math.max(0.0, Math.min(1.0, fraction));
                    tLandingExact =
                        this.prevTime +
                        (currTime - this.prevTime) * fraction;
                } else {
                    tLandingExact = currTime;
                }

                const rawDuration = tLandingExact - tTakeoff;
                const correctionFactor = this._getSmoothCorrection(rawDuration);
                let airTimeS = rawDuration * correctionFactor;

                if (airTimeS > 0.6 && airTimeS * airTimeS * 122.625 < 50) {
                    airTimeS *= 0.95;
                }

                const physicsHeightCm = 122.625 * (airTimeS * airTimeS);

                let skipReason = null;
                if (airTimeS < 0.12) skipReason = 'Short Air';
                else if (physicsHeightCm < 1.0) skipReason = 'Low Height';

                const finalizeLanding = () => {
                    this.state = 'SEARCHING_LOW';
                    this.localMin = currY;
                    this.localMax = -1000.0;
                    this.lastPeakTime = currTime;
                    this.lastLandingTime = currTime;
                    this.vizEventText = skipReason ? '' : 'DOWN';
                    this.vizEventColor = '#FF0000';
                    this.vizEventTime = currTime;
                    this.vizLandingPoint = {
                        x: this.currentX,
                        y: this.currentY,
                    };
                };

                if (skipReason !== null) {
                    finalizeLanding();
                    this.vizTakeoffPoint = null;
                    this.prevY = currY;
                    this.prevTime = currTime;
                    return { event: null, isJumping: false };
                }

                const finalApexX = this.apexX !== 0.0 ? this.apexX : this.jumpStartX;
                const dx = finalApexX - this.jumpStartX;
                let jumpHeightPx = this.jumpStartY - this.localMax;
                if (jumpHeightPx < 1.0) jumpHeightPx = 1.0;

                let angleDeg =
                    (Math.atan2(dx, jumpHeightPx) * 180) / Math.PI;
                if (state.viewMirrored) {
                    angleDeg = -angleDeg;
                }

                this.counter++;

                event = {
                    type: 'jump_complete',
                    count: this.counter,
                    flightTime: airTimeS,
                    flightTimeRaw: rawDuration,
                    jumpHeightCm: physicsHeightCm,
                    takeoffTime: tTakeoff,
                    landingTime: tLandingExact,
                    peakY: this.localMax,
                    startY: this.jumpStartY,
                    jumpAngleDeg: angleDeg,
                };

                this.lastJumpData = event;

                console.log(
                    `[JumpDetector] Jump #${this.counter}: ${airTimeS.toFixed(3)}s, ${physicsHeightCm.toFixed(1)}cm`
                );

                finalizeLanding();
                this.vizTakeoffPoint = null;
                isJumping = false;
            }
        }

        this.prevY = currY;
        this.prevTime = currTime;

        return { event, isJumping };
    }

    getVisualizationData() {
        return {
            isCalibrated: this.isCalibrated,
            state: this.state,
            currentY: this.currentY,
            currentX: this.currentX,
            localMin: this.localMin,
            localMax: this.localMax,
            torsoLen: this.currentTorso,
            riseThreshold: this.config.riseThreshold,
            fallThreshold: this.config.fallThreshold,
            counter: this.counter,
            eventText: this.vizEventText,
            eventColor: this.vizEventColor,
            eventTime: this.vizEventTime,
            takeoffPoint: this.vizTakeoffPoint,
            landingPoint: this.vizLandingPoint,
            isJumping: this.state === 'SEARCHING_PEAK',
            feetGroundY: this.feetGroundY,
        };
    }
}

export const jumpDetector = new RapidJumpDetector();
