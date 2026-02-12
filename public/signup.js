document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("signup-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const roomCodeInput = document.getElementById("room-code");
    const room_code = roomCodeInput?.value.trim();

    if (!username || !password) {
      alert("Fill all fields");
      return;
    }

    const payload = { username, password };

    if (room_code) {
      payload.room_code = room_code;
    }

    try {
      const res = await fetch("/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error(await res.text());

      const data = await res.json();

      localStorage.setItem("token", data.token);
      localStorage.setItem("user_id", data.user_id);
      localStorage.setItem("username", data.username);
      localStorage.setItem("room_id", data.room_id);

      window.location.href = "/index.html";
    } catch (err) {
      alert(err.message);
    }
  });
});

// =========================
// DIVINE FLUTE – FREE LIVING MOTION
// =========================
const flute = document.querySelector(".divine-flute");

if (flute && window.innerWidth > 768) {
  let x = window.innerWidth * 0.5;
  let y = window.innerHeight * 0.55;

  let vx = (Math.random() - 0.5) * 1.5;
  let vy = (Math.random() - 0.5) * 1.5;

  const REPEL_RADIUS = 170;
  const REPEL_FORCE = 0.7;
  const DRIFT = 0.985;
  const MAX_SPEED = 6;

  document.addEventListener("mousemove", (e) => {
    const rect = flute.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const dx = cx - e.clientX;
    const dy = cy - e.clientY;
    const dist = Math.hypot(dx, dy) || 1;

    if (dist < REPEL_RADIUS) {
      const strength = (REPEL_RADIUS - dist) / REPEL_RADIUS;

      vx += (dx / dist) * strength * REPEL_FORCE;
      vy += (dy / dist) * strength * REPEL_FORCE;

      spawnParticle(cx, cy);
    }
  });

  function animate() {
    vx *= DRIFT;
    vy *= DRIFT;

    vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, vx));
    vy = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, vy));

    x += vx;
    y += vy;

    const pad = 90;
    if (x < pad || x > window.innerWidth - pad) vx *= -0.8;
    if (y < pad || y > window.innerHeight - pad) vy *= -0.8;

    x = Math.max(pad, Math.min(window.innerWidth - pad, x));
    y = Math.max(pad, Math.min(window.innerHeight - pad, y));

    flute.style.left = x + "px";
    flute.style.top = y + "px";
    flute.style.transform = `translate(-50%, -50%) rotate(${vx * 2}deg)`;

    requestAnimationFrame(animate);
  }

  animate();
}

// =========================
// DIVINE GOLDEN PARTICLES
// =========================
function spawnParticle(x, y) {
  for (let i = 0; i < 2; i++) {
    const p = document.createElement("div");
    p.className = "divine-particle";

    p.style.left = x + (Math.random() * 14 - 7) + "px";
    p.style.top = y + (Math.random() * 14 - 7) + "px";

    document.body.appendChild(p);

    setTimeout(() => p.remove(), 1600);
  }
}
