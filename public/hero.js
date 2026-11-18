// Hero: "I ♥ NY" and "NYC" logos made of particles.
// Cursor pushes particles away (they flash briefly). When no one is hovering,
// the logo flashes, swirls, and re-forms as the other logo, on a loop.
(() => {
// ---- Tweak these to change the feel ----
const CFG = {
  gap: 10,        // px between sampled points (smaller = more particles)
  radius: 80,     // how far the cursor's influence reaches
  repel: 2.5,     // push straight away from the cursor
  spring: 0.05,   // pull back toward home position
  friction: 0.85, // velocity damping (lower = settles faster)
  flashDecay: 0.5,   // how fast flashing fades out after being disturbed (closer to 1 = longer; 1 = never stops)
  flashMaxSeconds: 3,  // stop flashing after this long, even if the cursor stays on it
  flashFadeSeconds: 1.5, // the last part of that time, where blinking gradually tapers off
  flashAmount: 1,   // how much a flicker dims a particle (0 = none, 1 = fully blinks out)

  // Logo switching
  idleSeconds: 5,    // how long a logo sits (with no hovering) before it starts flashing
  preFlashSeconds: 1.2, // how long every particle flashes before the swirl
  swirlSeconds: 1.6, // how long the swirl lasts before particles fly into the next logo
  swirlTurns: 2,     // how many full turns the swirl makes (inner particles spin faster)
};
const RED = '#e8262b', INK = '#111';

const canvas = document.getElementById('hero');
const ctx = canvas.getContext('2d');
let W, H, particles = [], logos = [], logoIndex = 0, visible = true;
const mouse = { x: -1e4, y: -1e4 };

// Logo-switch loop (runs forever while no one is hovering):
//   'hold'  = sitting in the current logo for idleSeconds
//   'flash' = every particle flashes for preFlashSeconds
//   'swirl' = spinning, then flies into the next logo -> back to 'hold'
// Hovering pauses the loop; it restarts idleSeconds after the cursor leaves.
let state = 'hold', lastHover = performance.now(), phaseStart = 0;

// ---------- Logo drawings (drawn once onto a hidden canvas, then sampled) ----------

// Classic parametric heart curve, filled as a polygon
function drawHeart(g, cx, cy, size) {
  const k = size / 34;
  g.beginPath();
  for (let t = 0; t <= Math.PI * 2; t += 0.02) {
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    g.lineTo(cx + x * k, cy - y * k);
  }
  g.fill();
}

function drawILoveNY(g) {
  const F = Math.min(W * 0.4, H * 0.36);           // font size
  g.font = `bold ${F}px "American Typewriter", Rockwell, Georgia, serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const wNY = g.measureText('NY').width;
  const left = W / 2 - wNY / 2;
  const row1 = H / 2 - F * 0.45, row2 = H / 2 + F * 0.5;

  g.fillStyle = '#000';
  // Capital "I" built from 3 rounded rectangles (top serif, stem, bottom serif)
  const m = g.measureText('I');
  const iCx = left + wNY * 0.25;
  const iTop = row1 - m.actualBoundingBoxAscent, iH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const iW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;  // full serif width
  const stemW = F * 0.2, slabH = iH * 0.16;
  const rad = slabH * 0.5;                                   // corner rounding
  g.beginPath();
  g.roundRect(iCx - iW / 2, iTop, iW, slabH, rad);              // top serif
  g.roundRect(iCx - stemW / 2, iTop, stemW, iH, rad);           // stem
  g.roundRect(iCx - iW / 2, iTop + iH - slabH, iW, slabH, rad); // bottom serif
  g.fill();
  g.fillText('NY', W / 2, row2);

  g.fillStyle = '#f00';
  drawHeart(g, left + wNY * 0.74, row1, F * 0.95);
}

// NYC wordmark traced as one outline, in a 2000 x 1125 coordinate space
const NYC_PATH = [
  [80,241],[239,241],[440,442],[440,281],[480,241],[639,241],[680,281],[720,241],
  [879,241],[920,281],[920,361],[1000,442],[1080,361],[1080,281],[1120,241],[1279,241],
  [1320,281],[1320,361],[1440,241],[1840,241],[1960,361],[1960,482],[1920,522],[1720,522],
  [1720,482],[1560,482],[1560,642],[1720,642],[1720,602],[1920,602],[1960,642],[1960,763],
  [1840,883],[1440,883],[1320,763],[1320,522],[1120,722],[1120,843],[1080,883],[920,883],
  [880,843],[880,722],[680,522],[680,843],[639,883],[480,883],[280,682],[280,843],
  [239,883],[80,883],[40,843],[40,281],
];
function drawNYC(g) {
  const bw = 1920, bh = 642;                        // wordmark's own width/height
  const s = Math.min((W * 0.85) / bw, (H * 0.45) / bh);
  const ox = W / 2 - (40 + bw / 2) * s, oy = H / 2 - (241 + bh / 2) * s;
  g.fillStyle = '#000';
  g.beginPath();
  for (const [x, y] of NYC_PATH) g.lineTo(ox + x * s, oy + y * s);
  g.closePath();
  g.fill();
}

// Draw a logo on a hidden canvas and sample its pixels on a grid -> list of points
function sampleLogo(drawFn) {
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const g = off.getContext('2d', { willReadFrequently: true });
  drawFn(g);
  const data = g.getImageData(0, 0, W, H).data;
  const pts = [];
  for (let y = 0; y < H; y += CFG.gap) {
    for (let x = 0; x < W; x += CFG.gap) {
      const i = (y * W + x) * 4;
      if (data[i + 3] < 128) continue;
      pts.push({ x, y, red: data[i] > 128 && data[i + 1] < 100 });
    }
  }
  return pts;
}

// Give every particle a home in the given logo. The logos have different
// numbers of points, so leftover particles fade out and hide in the logo.
function assign(points) {
  const shuffled = [...points].sort(() => Math.random() - 0.5);
  particles.forEach((p, i) => {
    const t = shuffled[i] || shuffled[(Math.random() * shuffled.length) | 0];
    p.hx = t.x; p.hy = t.y; p.red = t.red;
    p.targetAlpha = i < shuffled.length ? 1 : 0;
  });
}

function build() {
  const dpr = window.devicePixelRatio || 1;
  W = canvas.clientWidth; H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  logos = [sampleLogo(drawILoveNY), sampleLogo(drawNYC)];
  const count = Math.max(...logos.map(l => l.length));
  particles = Array.from({ length: count }, () => ({
    x: Math.random() * W, y: Math.random() * H,    // start scattered -> fly in
    vx: 0, vy: 0, a: 0, targetAlpha: 1,
    flash: 0,                                      // 1 = just disturbed, fades to 0
    hoverStart: null,                              // when the cursor first got near it
  }));
  assign(logos[logoIndex]);
  state = 'hold';
}

function tick() {
  requestAnimationFrame(tick);
  if (!visible || !particles.length) return;     // hero scrolled out of view: skip work

  const R = CFG.radius, now = performance.now();
  const cx = W / 2, cy = H / 2, maxD = Math.hypot(W, H) / 2;
  let hovering = false;

  // Swirl progress: eases in so the spin speeds up, then particles fly to the next logo
  let swirlAngle = 0;
  if (state === 'swirl') {
    const e = Math.min(1, (now - phaseStart) / (CFG.swirlSeconds * 1000));
    swirlAngle = e * e * CFG.swirlTurns * Math.PI * 2;
  }

  for (const p of particles) {
    const dx = p.x - mouse.x, dy = p.y - mouse.y;
    const d = Math.hypot(dx, dy);
    if (d < R && d > 0.1) {
      if (p.a > 0.5) hovering = true;
      const f = 1 - d / R;               // stronger near the cursor
      const nx = dx / d, ny = dy / d;    // unit vector away from cursor
      p.vx += nx * CFG.repel * f;
      p.vy += ny * CFG.repel * f;
      // Full flashing at first, then a linear taper to 0 over the last flashFadeSeconds
      if (p.hoverStart === null) p.hoverStart = now;
      const t = (now - p.hoverStart) / 1000;
      const fadeStart = CFG.flashMaxSeconds - CFG.flashFadeSeconds;
      p.flash = t < fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / CFG.flashFadeSeconds);
    } else if (d > R * 1.3) {
      // cursor clearly left (the 1.3 buffer stops edge particles that drift
      // in and out of range from restarting their timer): next visit flashes again
      p.hoverStart = null;
    }
    if (state === 'flash') p.flash = 1;  // pre-swirl: everything flashes
    p.flash *= CFG.flashDecay;           // ...and slowly stop

    // Where this particle is headed: its home, or its home spun around the center
    let tx = p.hx, ty = p.hy;
    if (swirlAngle) {
      const hx = p.hx - cx, hy = p.hy - cy;
      const ang = swirlAngle * (0.6 + 0.8 * (1 - Math.hypot(hx, hy) / maxD));
      const c = Math.cos(ang), s = Math.sin(ang);
      tx = cx + hx * c - hy * s;
      ty = cy + hx * s + hy * c;
    }
    p.vx += (tx - p.x) * CFG.spring;
    p.vy += (ty - p.y) * CFG.spring;
    p.vx *= CFG.friction; p.vy *= CFG.friction;
    p.x += p.vx; p.y += p.vy;
    p.a += (p.targetAlpha - p.a) * 0.08;
  }

  // ---- Logo-switch state machine ----
  if (hovering) {
    lastHover = now;
    state = 'hold';                           // user is on it: pause (cancels a flash or swirl)
  } else if (state === 'hold' && now - lastHover > CFG.idleSeconds * 1000) {
    state = 'flash'; phaseStart = now;
  } else if (state === 'flash' && now - phaseStart >= CFG.preFlashSeconds * 1000) {
    state = 'swirl'; phaseStart = now;
  } else if (state === 'swirl' && now - phaseStart >= CFG.swirlSeconds * 1000) {
    logoIndex = (logoIndex + 1) % logos.length;
    assign(logos[logoIndex]);                 // particles fly from the swirl into the new logo
    state = 'hold'; lastHover = now;          // sit for idleSeconds, then repeat
  }

  // ---- Draw ----
  ctx.clearRect(0, 0, W, H);
  const s = CFG.gap;
  ctx.font = `bold ${s * 1.15}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const red of [false, true]) {
    ctx.fillStyle = red ? RED : INK;
    for (const p of particles) {
      if (p.red !== red || p.a < 0.01) continue;
      // Flicker: hard on/off blink; blinks get rarer as flash fades.
      const blink = p.flash > 0.03 && Math.random() < p.flash * 0.6 ? 1 - CFG.flashAmount : 1;
      ctx.globalAlpha = p.a * blink;
      if (red) ctx.fillText('♥', p.x, p.y);
      else ctx.fillRect(p.x - s * 0.35, p.y - s * 0.35, s * 0.7, s * 0.7);
    }
  }
  ctx.globalAlpha = 1;
}

// Cursor position relative to the canvas (the page scrolls, so use its rect)
addEventListener('pointermove', e => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const inside = x >= 0 && y >= 0 && x <= r.width && y <= r.height && e.target === canvas;
  mouse.x = inside ? x : -1e4; mouse.y = inside ? y : -1e4;
});
document.addEventListener('pointerout', e => { if (!e.relatedTarget) mouse.x = mouse.y = -1e4; });

new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(canvas);
let rt; new ResizeObserver(() => {
  if (canvas.clientWidth === W && canvas.clientHeight === H) return;  // ignore no-op (and the initial) callbacks
  clearTimeout(rt); rt = setTimeout(build, 150);
}).observe(canvas);

build();
tick();
})();
