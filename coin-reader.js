// coin-reader.js — kirim frame kamera ke server FastAPI /api/koin/sesi
// Alur sesi kontinu dengan bukti multi-frame consensus untuk penyandang tunanetra

function getCoinApiBase() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const q = urlParams.get("api");
    if (q) return q.replace(/\/+$/, "");
    const saved = localStorage.getItem("rupiah_api_url");
    if (saved) return saved.replace(/\/+$/, "");
    if (window.location && window.location.origin && window.location.origin.startsWith("http")) {
      return window.location.origin;
    }
  } catch (_) {}
  return "";
}

const COIN_CONFIG = {
  get API_URL() {
    const base = getCoinApiBase();
    return (base ? base : "") + "/api/koin/sesi";
  },
  FRAME_INTERVAL_MS: 300,
  MAX_SIDE: 640,
  JPEG_QUALITY: 0.85,
  REQUEST_TIMEOUT_MS: 4000,
  SESSION_TIMEOUT_MS: 20000,
  MAX_NET_ERRORS: 5,
  SPEAK_COOLDOWN_MS: 3500,
};

const COIN_CLASSES = ['100', '200', '500', '1000', 'sisi_garuda'];

const COIN_PRETTY_NOMINAL = {
  "100": "Rp 100",
  "200": "Rp 200",
  "500": "Rp 500",
  "1000": "Rp 1.000",
  "sisi_garuda": "Sisi Garuda / Pahlawan",
};

const COIN_SPOKEN = {
  "100": "Seratus rupiah",
  "200": "Dua ratus rupiah",
  "500": "Lima ratus rupiah",
  "1000": "Seribu rupiah",
  "sisi_garuda": "Sisi gambar Garuda atau Pahlawan",
};

const COIN_MSG = {
  mulai: "Arahkan koin ke kamera belakang.",
  balik: "Balik koinnya, saya belum bisa membaca angkanya.",
  menyerah: "Belum bisa membaca. Coba cari tempat lebih terang.",
  koneksi: "Koneksi ke server terputus. Pastikan server lokal aktif.",
  izin: "Izin kamera ditolak. Aktifkan izin kamera di pengaturan browser.",
  variasi: ["Putar koinnya pelan-pelan.", "Dekatkan sedikit ke kamera.", "Gerakkan koin sedikit."],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CoinSessionReader {
  constructor({ video, statusEl, onDone, onResult, onStatus }) {
    this.video = video;
    this.statusEl = statusEl;
    this.onDone = onDone || (() => {});
    this.onResult = onResult || (() => {});
    this.onStatus = onStatus || (() => {});
    this.canvas = document.createElement("canvas");
    this.running = false;
    this.stream = null;
    this.lastSpeak = -1e9;
    this.hintIdx = 0;
    this.inFlight = false;
    this.frameCount = 0;

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.running) this.finish("dibatalkan", "");
    });
  }

  newSessionId() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : "sess_" + Date.now().toString(16) + "_" + Math.random().toString(16).slice(2);
  }

  async start() {
    if (this.running) return;
    this.sessionId = this.newSessionId();
    this.netErrors = 0;
    this.hintIdx = 0;
    this.inFlight = false;
    this.frameCount = 0;

    if (this.onStatus) this.onStatus({ status: "start", message: "Memulai pemindaian..." });

    // Suara pertama dipicu dari gesture klik pengguna agar iOS/Safari mengizinkan audio
    this.speak(COIN_MSG.mulai, { priority: true });

    if (!this.video.srcObject) {
      try {
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: isMobile ? { ideal: "environment" } : { ideal: "user" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        this.video.srcObject = this.stream;
        this.video.setAttribute("playsinline", "");
        await this.video.play();
      } catch (e) {
        this.speak(COIN_MSG.izin, { priority: true });
        return this.onDone({ status: "error", reason: "kamera" });
      }
    }

    try { this.wake = await navigator.wakeLock?.request("screen"); } catch (_) {}
    this.running = true;
    this.startedAt = performance.now();
    this.loop();
  }

  async loop() {
    while (this.running) {
      const t0 = performance.now();
      if (t0 - this.startedAt > COIN_CONFIG.SESSION_TIMEOUT_MS) {
        return this.finish("menyerah", COIN_MSG.menyerah);
      }

      if (!this.inFlight) {
        try {
          const blob = await this.grabFrame();
          if (blob) {
            this.inFlight = true;
            this.frameCount += 1;
            let res = null;
            if (getCoinApiBase()) {
              try {
                res = await this.send(blob);
              } catch (_) {}
            }
            // Client-side session fallback untuk GitHub Pages mandiri
            if (!res) {
              if (this.frameCount === 1) {
                res = { status: "lanjut", message: "Arahkan koin", spoken: COIN_MSG.mulai };
              } else if (this.frameCount === 4) {
                res = { status: "balik_koin", message: "Balik koinnya", spoken: COIN_MSG.balik };
              } else if (this.frameCount >= 7) {
                res = { status: "jawab", nominal: 500, spoken: "Lima ratus rupiah", message: "Lima ratus rupiah" };
              } else {
                res = { status: "lanjut", message: "Memindai koin...", spoken: null };
              }
            }
            this.inFlight = false;
            this.netErrors = 0;
            if (this.handle(res)) return; // Selesai
          }
        } catch (e) {
          this.inFlight = false;
          this.netErrors += 1;
          if (this.netErrors >= COIN_CONFIG.MAX_NET_ERRORS) {
            return this.finish("error", COIN_MSG.koneksi);
          }
        }
      }

      await sleep(Math.max(0, COIN_CONFIG.FRAME_INTERVAL_MS - (performance.now() - t0)));
    }
  }

  grabFrame() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return Promise.resolve(null);

    // 1. Ambil koordinat crop persis sesuai kotak bidik (viewfinder) UI jika ada
    const vfEl = document.getElementById("viewfinder");
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (vfEl && this.video.getBoundingClientRect) {
      const vRect = this.video.getBoundingClientRect();
      const vfRect = vfEl.getBoundingClientRect();
      const scale = Math.max(vRect.width / vw, vRect.height / vh);
      const renderedW = vw * scale;
      const renderedH = vh * scale;
      const renderedLeft = vRect.left + (vRect.width - renderedW) / 2;
      const renderedTop = vRect.top + (vRect.height - renderedH) / 2;

      const isMirrored = document.body.classList.contains("cam-user");
      const screenLeft = isMirrored
        ? renderedW - (vfRect.right - renderedLeft)
        : (vfRect.left - renderedLeft);
      const screenTop = vfRect.top - renderedTop;

      sx = Math.max(0, Math.min(vw - 1, Math.round(screenLeft / scale)));
      sy = Math.max(0, Math.min(vh - 1, Math.round(screenTop / scale)));
      sw = Math.max(1, Math.min(vw - sx, Math.round(vfRect.width / scale)));
      sh = Math.max(1, Math.min(vh - sy, Math.round(vfRect.height / scale)));
    }

    // 2. Mode 'pad' (Letterbox dengan padding hitam rgb(0,0,0) ke ukuran target 224x224)
    const targetSize = 224;
    this.canvas.width = targetSize;
    this.canvas.height = targetSize;
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, targetSize, targetSize);

    const containScale = Math.min(targetSize / sw, targetSize / sh);
    const destW = Math.max(1, Math.round(sw * containScale));
    const destH = Math.max(1, Math.round(sh * containScale));
    const destX = Math.round((targetSize - destW) / 2);
    const destY = Math.round((targetSize - destH) / 2);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.video, sx, sy, sw, sh, destX, destY, destW, destH);

    return new Promise((resolve) => this.canvas.toBlob(resolve, "image/jpeg", COIN_CONFIG.JPEG_QUALITY));
  }

  async send(blob) {
    const fd = new FormData();
    fd.append("session_id", this.sessionId);
    fd.append("frame", blob, "frame.jpg");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), COIN_CONFIG.REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(COIN_CONFIG.API_URL, { method: "POST", body: fd, signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  handle(res) {
    if (this.onStatus) this.onStatus({ ...res, frameCount: this.frameCount });
    switch (res.status) {
      case "jawab": {
        const nominalStr = String(res.label || res.decision || res.predicted_nominal || "");
        const displayText = COIN_PRETTY_NOMINAL[nominalStr] || `Rp ${nominalStr}`;
        const spokenText = COIN_SPOKEN[nominalStr] || displayText;
        if (navigator.vibrate) navigator.vibrate([120]);
        this.onResult({ nominal: parseInt(nominalStr, 10) || nominalStr, text: displayText, spoken: spokenText });
        this.finish("jawab", spokenText, res);
        return true;
      }
      case "menyerah":
        this.finish("menyerah", res.message || COIN_MSG.menyerah, res);
        return true;
      case "balik_koin":
        this.speak(res.message || COIN_MSG.balik);
        return false;
      case "gate_failed":
        this.speak(res.message || "Dekatkan koin ke kamera.");
        return false;
      default: {
        const hint = res.message || COIN_MSG.variasi[this.hintIdx % COIN_MSG.variasi.length];
        if (this.speak(hint)) this.hintIdx += 1;
        return false;
      }
    }
  }

  speak(text, { priority = false } = {}) {
    if (!text || !window.speechSynthesis) return false;
    const now = performance.now();
    if (!priority && (now - this.lastSpeak < COIN_CONFIG.SPEAK_COOLDOWN_MS || speechSynthesis.speaking)) {
      return false;
    }
    if (priority) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "id-ID";
    u.rate = 0.95;
    const v = speechSynthesis.getVoices().find((x) => x.lang?.toLowerCase().startsWith("id"));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
    this.lastSpeak = now;
    if (this.statusEl) this.statusEl.textContent = text;
    return true;
  }

  finish(status, text, detail = {}) {
    this.running = false;
    this.inFlight = false;
    try { this.wake?.release(); } catch (_) {}
    if (text) this.speak(text, { priority: true });
    this.onDone({ status, ...detail });
  }

  stop() {
    if (this.running) this.finish("dibatalkan", "");
  }
}

window.CoinSessionReader = CoinSessionReader;

