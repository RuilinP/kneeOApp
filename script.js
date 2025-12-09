const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const angleDisplay = document.getElementById("angleDisplay");
const repInfo = document.getElementById("repInfo");
const angleFeedbackEl = document.getElementById("angleFeedback");
const speedFeedbackEl = document.getElementById("speedFeedback");

let detector = null;
let currentPose = null;

// ---- smoothing for angle ----
let smoothedAngle = null;
const SMOOTHING_ALPHA = 0.3;

// ---- store last good keypoints to bridge short dropouts ----
let lastGood = {
  right_hip: null,
  right_knee: null,
  right_ankle: null,
  timestamp: 0
};
const MAX_GAP_SEC = 0.3; // reuse last good keypoint up to 0.3 s

// ---- rep detection & feedback thresholds ----
const BENT_THRESHOLD = 110;      // <= this = bent
const STRAIGHT_TARGET = 165;     // desired max angle for full extension
const ANGLE_OK_MARGIN = 5;       // within 5° of target = perfect
const MIN_REP_TIME = 5;        // total rep time (s) bent→straight→bent
const MIN_PHASE_TIME = 2;      // min extend/flex duration (s)

// state machine: BENT -> EXTENDING -> FLEXING -> BENT
let state = "BENT";
let repCount = 0;

let repStartTime = null;
let extendStartTime = null;
let flexStartTime = null;
let maxAngleThisRep = null;

function setAngleFeedback(text, level = "ok") {
  angleFeedbackEl.textContent = text;
  angleFeedbackEl.className = "";
  if (level === "ok") angleFeedbackEl.classList.add("ok");
  if (level === "warn") angleFeedbackEl.classList.add("warn");
  if (level === "bad") angleFeedbackEl.classList.add("bad");
}

function setSpeedFeedback(text, level = "ok") {
  speedFeedbackEl.textContent = text;
  speedFeedbackEl.className = "";
  if (level === "ok") speedFeedbackEl.classList.add("ok");
  if (level === "warn") speedFeedbackEl.classList.add("warn");
  if (level === "bad") speedFeedbackEl.classList.add("bad");
}

async function setupCamera() {
  // Check if getUserMedia is available
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Camera access not available. Please use HTTPS or localhost, and ensure your browser supports getUserMedia.");
  }

  const primaryConstraints = {
    video: {
      facingMode: "user", // front camera
      width: { ideal: 480 },
      height: { ideal: 360 }
    },
    audio: false
  };
  const fallbackConstraints = { video: true, audio: false };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(primaryConstraints);
    video.srcObject = stream;
  } catch (e) {
    console.warn("Primary camera failed, using fallback:", e);
    const stream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
    video.srcObject = stream;
  }

  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      video.play();
      resolve();
    };
  });
}

function getKeypoint(pose, name, minScore = 0.3) {
  if (!pose || !pose.keypoints) return null;
  const kp = pose.keypoints.find(k => k.name === name);
  if (!kp || kp.score < minScore) return null;
  return kp;
}

// Reuse last good location if current frame is missing but gap is short
function getStableKeypoint(pose, name, nowSec, minScore = 0.3) {
  const direct = getKeypoint(pose, name, minScore);
  if (direct) {
    lastGood[name] = { x: direct.x, y: direct.y, score: direct.score };
    lastGood.timestamp = nowSec;
    return direct;
  }
  if (lastGood[name] && (nowSec - lastGood.timestamp) <= MAX_GAP_SEC) {
    return lastGood[name];
  }
  return null;
}

function computeKneeAngle(hip, knee, ankle) {
  const v1x = hip.x - knee.x;
  const v1y = hip.y - knee.y;
  const v2x = ankle.x - knee.x;
  const v2y = ankle.y - knee.y;

  const dot = v1x * v2x + v1y * v2y;
  const mag1 = Math.hypot(v1x, v1y);
  const mag2 = Math.hypot(v2x, v2y);
  if (mag1 === 0 || mag2 === 0) return null;

  const cosTheta = dot / (mag1 * mag2);
  const clamped = Math.min(1, Math.max(-1, cosTheta));
  const angleRad = Math.acos(clamped);
  return (angleRad * 180) / Math.PI;
}

function drawSkeleton(pose) {
  if (!pose) return;
  const kp = pose.keypoints;

  kp.forEach(k => {
    if (k.score > 0.3) {
      ctx.beginPath();
      ctx.arc(k.x, k.y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = "cyan";
      ctx.fill();
    }
  });

  const rh = getKeypoint(pose, "right_hip", 0.3);
  const rk = getKeypoint(pose, "right_knee", 0.3);
  const ra = getKeypoint(pose, "right_ankle", 0.3);

  ctx.strokeStyle = "yellow";
  ctx.lineWidth = 3;
  if (rh && rk) {
    ctx.beginPath();
    ctx.moveTo(rh.x, rh.y);
    ctx.lineTo(rk.x, rk.y);
    ctx.stroke();
  }
  if (rk && ra) {
    ctx.beginPath();
    ctx.moveTo(rk.x, rk.y);
    ctx.lineTo(ra.x, ra.y);
    ctx.stroke();
  }
}

function updateLogic(pose) {
  const nowSec = performance.now() / 1000;

  const hip   = getStableKeypoint(pose, "right_hip",   nowSec);
  const knee  = getStableKeypoint(pose, "right_knee",  nowSec);
  const ankle = getStableKeypoint(pose, "right_ankle", nowSec);

  if (!hip || !knee || !ankle) {
    angleDisplay.textContent = "Angle: --° (right leg not clearly detected)";
    return;
  }

  let angle = computeKneeAngle(hip, knee, ankle);
  if (angle == null || isNaN(angle)) {
    angleDisplay.textContent = "Angle: --° (invalid)";
    return;
  }

  // smooth angle
  if (smoothedAngle == null) smoothedAngle = angle;
  smoothedAngle =
    SMOOTHING_ALPHA * angle + (1 - SMOOTHING_ALPHA) * smoothedAngle;
  angle = smoothedAngle;

  // ---- rep state machine ----
  switch (state) {
    case "BENT":
      if (angle <= BENT_THRESHOLD) {
        // still comfortably bent
        break;
      }
      // leaving bent → start extension
      state = "EXTENDING";
      repStartTime = nowSec;
      extendStartTime = nowSec;
      maxAngleThisRep = angle;
      angleDisplay.textContent = "Angle: --°";
      setAngleFeedback("Extending... straighten your knee.", "ok");
      setSpeedFeedback("", "ok");
      break;

    case "EXTENDING":
      if (angle > maxAngleThisRep) {
        maxAngleThisRep = angle;
      }
      // once angle stops increasing and starts decreasing, we assume we reached peak
      if (angle < maxAngleThisRep - 1.0) { // small hysteresis
        state = "FLEXING";
        flexStartTime = nowSec;
        angleDisplay.textContent = `Max Angle: ${maxAngleThisRep.toFixed(1)}°`;
        // ROM feedback at the top
        if (maxAngleThisRep >= STRAIGHT_TARGET - ANGLE_OK_MARGIN) {
          setAngleFeedback("Great extension! Now lower with control.", "ok");
        } else if (maxAngleThisRep >= STRAIGHT_TARGET - 20) {
          setAngleFeedback("Almost straight. Try a bit more next time.", "warn");
        } else {
          setAngleFeedback("Too shallow. Straighten your leg more.", "bad");
        }
      }
      break;

    case "FLEXING":
      // back to bent region → rep completed
      if (angle <= BENT_THRESHOLD) {
        const repEndTime = nowSec;
        const totalTime = repEndTime - (repStartTime || repEndTime);
        const extendTime = (flexStartTime || repEndTime) - (extendStartTime || repStartTime || repEndTime);
        const flexTime   = repEndTime - (flexStartTime || repEndTime);

        repCount += 1;
        repInfo.textContent = `Reps: ${repCount}`;

        // speed feedback based on duration
        if (totalTime < MIN_REP_TIME || extendTime < MIN_PHASE_TIME || flexTime < MIN_PHASE_TIME) {
          setSpeedFeedback(
            `Rep ${repCount}: Too fast. Slow down your movement.`,
            "bad"
          );
        } else {
          setSpeedFeedback(
            `Rep ${repCount}: Good tempo and control.`,
            "ok"
          );
        }

        // ROM feedback summary
        if (maxAngleThisRep >= STRAIGHT_TARGET - ANGLE_OK_MARGIN) {
          setAngleFeedback(
            `Rep ${repCount}: Excellent extension!`,
            "ok"
          );
        } else if (maxAngleThisRep >= STRAIGHT_TARGET - 20) {
          setAngleFeedback(
            `Rep ${repCount}: Good, try to extend a bit further.`,
            "warn"
          );
        } else {
          setAngleFeedback(
            `Rep ${repCount}: Extend your leg more.`,
            "bad"
          );
        }

        // reset for next rep
        state = "BENT";
        repStartTime = null;
        extendStartTime = null;
        flexStartTime = null;
        maxAngleThisRep = null;
      }
      break;
  }
}

async function main() {
  await setupCamera();
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;

  await tf.setBackend("webgl");
  await tf.ready();

  const model = poseDetection.SupportedModels.MoveNet;
  const detectorConfig = {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
    enableSmoothing: true
  };
  detector = await poseDetection.createDetector(model, detectorConfig);

  setAngleFeedback("Model ready. Sit sideways and start extending your right leg.", "ok");

  async function renderLoop() {
    const poses = await detector.estimatePoses(video, {
      maxPoses: 1,
      flipHorizontal: true
    });
    currentPose = poses[0] || null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    drawSkeleton(currentPose);
    updateLogic(currentPose);

    requestAnimationFrame(renderLoop);
  }

  renderLoop();
}

main().catch(err => {
  console.error(err);
  angleDisplay.textContent = "Error: " + err.message;
  setAngleFeedback("Error: " + err.message, "bad");
});
