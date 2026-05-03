(function () {
  const COOLDOWN_MS  = 2500;
  const GESTURE_HOLD = 700;

  let gestureEnabled  = false;
  let lastGestureTime = 0;
  let holdTimer       = null;
  let lastPose        = null;
  let handsInstance   = null;
  let cameraInstance  = null;

  function showGestureToast(msg) {
    const el = document.getElementById("gesture-toast");
    if (!el) return;
    el.textContent    = msg;
    el.style.display  = "block";
    el.style.opacity  = "1";
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => { el.style.display = "none"; }, 400);
    }, 1800);
  }

  function fireGesture(pose) {
    const now = Date.now();
    if (now - lastGestureTime < COOLDOWN_MS) return;
    lastGestureTime = now;
    const s = window.__gestureSocket;
    if (!s) { console.warn("Gesture: socket not ready"); return; }
    console.log("🖐 Firing gesture:", pose);
    switch (pose) {
      case "palm_flip":
        showGestureToast("☠️ Clearing chat");
        s.emit("clear chat");
        break;
      case "thumbs_up":
        showGestureToast("👍 Music ON");
        s.emit("ndn start", { trackIndex: 0, startTime: Date.now() });
        break;
      case "thumbs_down":
        showGestureToast("👎 Music OFF");
        s.emit("ndn stop");
        break;
      case "fist":
        showGestureToast("✊ Flowers!");
        s.emit("ndn flowers");
        break;
      case "victory":
        showGestureToast("✌️ Dark mode");
        s.emit("ndn dark");
        break;
      case "stop_hand":
        showGestureToast("✋ Restoring background");
        s.emit("ndn return");
        break;
      case "point_right":
        showGestureToast("👉 Next track");
        s.emit("ndn next", { startTime: Date.now() });
        break;
      case "point_left":
        showGestureToast("👈 Previous track");
        s.emit("ndn prev", { startTime: Date.now() });
        break;
      case "call_me":
        showGestureToast("🤙 Random track");
        s.emit("ndn start", { trackIndex: Math.floor(Math.random() * 60), startTime: Date.now() });
        break;
    }
  }

  // ── Landmark helpers ─────────────────────────────────────────────────────

  // Is fingertip clearly above its PIP knuckle? (higher on screen = lower y)
  function fingerUp(lm, tip, pip) {
    return lm[tip].y < lm[pip].y - 0.035;
  }

  // Is fingertip roughly at or below its PIP? = curled
  function fingerDown(lm, tip, pip) {
    return lm[tip].y >= lm[pip].y - 0.02;
  }

  function idx(lm)  { return fingerUp(lm, 8,  6);  }
  function mid(lm)  { return fingerUp(lm, 12, 10); }
  function ring(lm) { return fingerUp(lm, 16, 14); }
  function pink(lm) { return fingerUp(lm, 20, 18); }

  function idxDown(lm)  { return fingerDown(lm, 8,  6);  }
  function midDown(lm)  { return fingerDown(lm, 12, 10); }
  function ringDown(lm) { return fingerDown(lm, 16, 14); }
  function pinkDown(lm) { return fingerDown(lm, 20, 18); }

  // Thumb pointing clearly upward — tip well above wrist
  function thumbUp(lm) {
    return lm[4].y < lm[2].y - 0.06;
  }

  // Thumb pointing clearly downward — tip well below wrist
  function thumbDown(lm) {
    return lm[4].y > lm[0].y + 0.03;
  }

  // Thumb sticking out to the side
  function thumbOut(lm) {
    return Math.abs(lm[4].x - lm[2].x) > 0.07;
  }

  // Palm facing camera = wrist below middle MCP
  function palmUp(lm) {
    return lm[0].y > lm[9].y + 0.04;
  }

  function classifyPose(lm) {
    const I = idx(lm),  M = mid(lm),  R = ring(lm), P = pink(lm);
    const iD = idxDown(lm), mD = midDown(lm), rD = ringDown(lm), pD = pinkDown(lm);
    const tUp   = thumbUp(lm);
    const tDown = thumbDown(lm);
    const tOut  = thumbOut(lm);
    const up    = palmUp(lm);

    // ── call_me: thumb out + pinky up, middle two curled ──
    if (tOut && P && mD && rD && !I) return "call_me";

    // ── thumbs up: all fingers curled, thumb pointing up ──
    if (tUp && iD && mD && rD && pD) return "thumbs_up";

    // ── thumbs down: all fingers curled, thumb pointing down ──
    if (tDown && iD && mD && rD && pD) return "thumbs_down";

    // ── fist: everything curled including thumb ──
    if (!tOut && !tUp && iD && mD && rD && pD) return "fist";

    // ── open palm facing camera ──
    if (I && M && R && P && up)  return "palm_flip";

    // ── stop hand facing away ──
    if (I && M && R && P && !up) return "stop_hand";

    // ── victory: index + middle up, ring + pinky down ──
    if (I && M && rD && pD) return "victory";

    // ── point right: only index up ──
    if (I && mD && rD && pD && !tOut) return "point_right";

    // ── point left: only pinky up ──
    if (P && iD && mD && rD && !tOut) return "point_left";

    return null;
  }

  function onPose(pose) {
    if (!pose) {
      clearTimeout(holdTimer);
      holdTimer = null;
      lastPose  = null;
      return;
    }
    if (pose !== lastPose) {
      clearTimeout(holdTimer);
      lastPose  = pose;
      holdTimer = setTimeout(() => fireGesture(pose), GESTURE_HOLD);
    }
  }

  function startGestureCamera() {
    if (gestureEnabled) return;
    const adminUsers = ["Thejus", "Nandhana", "Anjana"];
    const isAdminNow = adminUsers.includes(localStorage.getItem("username"))
                    || window.__isDevAdmin;
    if (!isAdminNow) { showGestureToast("❌ Admin only"); return; }

    gestureEnabled         = true;
    window.__gestureActive = true;
    showGestureToast("📷 Starting camera…");

    const videoEl = document.getElementById("gesture-video");

    handsInstance = new Hands({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
    });
    handsInstance.setOptions({
      maxNumHands:            1,
      modelComplexity:        1,       // bumped to 1 for better accuracy
      minDetectionConfidence: 0.7,
      minTrackingConfidence:  0.6
    });
    handsInstance.onResults((results) => {
      if (!results.multiHandLandmarks || !results.multiHandLandmarks.length) {
        onPose(null);
        return;
      }
      const pose = classifyPose(results.multiHandLandmarks[0]);
      onPose(pose);
    });

    cameraInstance = new Camera(videoEl, {
      onFrame: async () => { await handsInstance.send({ image: videoEl }); },
      width: 320, height: 240
    });
    cameraInstance.start().then(() => {
      showGestureToast("✅ Camera ready — show a gesture!");
    }).catch((err) => {
      showGestureToast("❌ Camera error: " + err.message);
      gestureEnabled         = false;
      window.__gestureActive = false;
    });
  }

  function stopGestureCamera() {
    gestureEnabled         = false;
    window.__gestureActive = false;
    if (cameraInstance) { try { cameraInstance.stop(); } catch(e) {} cameraInstance = null; }
    if (handsInstance)  { try { handsInstance.close(); } catch(e) {} handsInstance  = null; }
    showGestureToast("📷 Gesture control OFF");
    setTimeout(() => location.reload(), 1200);
  }

  window.gestureOn  = startGestureCamera;
  window.gestureOff = stopGestureCamera;

  document.addEventListener("DOMContentLoaded", () => {
    const divider = document.querySelector(".menu-divider");
    if (!divider) return;
    const row = document.createElement("div");
    row.className = "menu-row";
    row.id        = "gesture-menu-btn";
    row.innerHTML = `
      <div class="menu-icon-chip chip-purple">🖐</div>
      <span class="menu-label">Gestures</span>
      <div class="pill-toggle" id="gesture-pill"><div class="pill-knob"></div></div>
    `;
    divider.parentNode.insertBefore(row, divider);
    const pill = document.getElementById("gesture-pill");
    row.addEventListener("click", () => {
      const adminUsers = ["Thejus", "Nandhana", "Anjana"];
      const isAdminNow = adminUsers.includes(localStorage.getItem("username"))
                      || window.__isDevAdmin;
      if (!isAdminNow) { showGestureToast("❌ Admin only"); return; }
      if (!gestureEnabled) {
        pill.classList.add("on");
        startGestureCamera();
      } else {
        pill.classList.remove("on");
        stopGestureCamera();
      }
    });
  });
})();