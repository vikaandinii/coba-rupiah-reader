(() => {
  "use strict";

  /*
   * Rupiah Reader – script.js (v10.1 Multi-Crop Full-Frame � No Viewfinder Dependency)
   * 
   * Penggerak antarmuka modern & inferensi AI in-browser via TensorFlow.js (WebGL GPU).
   * - Seluruh area kamera adalah area deteksi (Bebas ketergantungan pada crop viewfinder statis).
   * - Lokalisasi Uang Otomatis (Client-side, Fast & Lightweight):
   *   Downscale ke 320px, analisis gradient/saliency, skin-tone filtering, bounding box dengan safety margin 12%.
   * - Multi-Crop Fallback (Candidate Crop + Full-Frame Letterbox Mode 'pad' 224x224 RGB [0, 255]).
   * - Continuous Autonomous Scanning (~5-7 FPS) dengan 6-Frame Sliding Window Consensus.
   * - Non-Spamming Audio Guidance System untuk Penyandang Tunanetra (Cooldown >= 3.8s).
   * - Visual Debug Mode (?debug=1 di URL): Bounding box overlay, PIP tensor preview 224x224, FPS, voting buffer.
   * - Single Source of Truth Class Mapping (idr_1000 .. idr_100000).
   * - Kompatibilitas penuh dengan coin-reader.js dan fitur koin.
   */

  // ---------------------------------------------------------------------------
  // Single Source of Truth: Registri Kelas Nominal Rupiah (Sesuai Urutan Notebook)
  // ---------------------------------------------------------------------------
  const BANKNOTE_CLASSES = [
    { index: 0, code: "idr_1000",   nominal: 1000,   name: "Satu Ribu Rupiah",       badge: "1.000",   valClass: "val-1000",   hero: "Tjut Meutia",                    color: "#65a30d" },
    { index: 1, code: "idr_2000",   nominal: 2000,   name: "Dua Ribu Rupiah",        badge: "2.000",   valClass: "val-2000",   hero: "Mohammad Hoesni Thamrin",        color: "#64748b" },
    { index: 2, code: "idr_5000",   nominal: 5000,   name: "Lima Ribu Rupiah",       badge: "5.000",   valClass: "val-5000",   hero: "Dr. K.H. Idham Chalid",          color: "#b45309" },
    { index: 3, code: "idr_10000",  nominal: 10000,  name: "Sepuluh Ribu Rupiah",    badge: "10.000",  valClass: "val-10000",  hero: "Frans Kaisiepo",                 color: "#8b5cf6" },
    { index: 4, code: "idr_20000",  nominal: 20000,  name: "Dua Puluh Ribu Rupiah",  badge: "20.000",  valClass: "val-20000",  hero: "Dr. G.S.S.J. Ratulangi",         color: "#16a34a" },
    { index: 5, code: "idr_50000",  nominal: 50000,  name: "Lima Puluh Ribu Rupiah", badge: "50.000",  valClass: "val-50000",  hero: "Ir. H. Djuanda Kartawidjaja",    color: "#2563eb" },
    { index: 6, code: "idr_100000", nominal: 100000, name: "Seratus Ribu Rupiah",   badge: "100.000", valClass: "val-100000", hero: "Soekarno & Mohammad Hatta",     color: "#e11d48" }
  ];
  window.BANKNOTE_CLASSES = BANKNOTE_CLASSES;

  // Ambang Batas Keyakinan Terkalibrasi: Seimbang & responsif untuk kondisi kamera HP
  const THRESHOLDS = {
    CONFIRMED: 0.55,             // >= 55% dengan margin jelas langsung dikonfirmasi
    MARGIN: 0.10,                // 10% margin di atas peringkat kedua
    UNCERTAIN: 0.35,             // 35%-54% dianggap kurang jelas
    UNKNOWN: 0.20,               // Di bawah 20% dianggap tidak ada uang
    WINDOW_SIZE: 4,
    MIN_VOTES: 2,
    TARGET_FRAME_INTERVAL_MS: 130,
    GUIDANCE_COOLDOWN_MS: 3800,
    SPEECH_SAME_BILL_COOLDOWN_MS: 5000
  };

  // ---------------------------------------------------------------------------
  // Utilitas Nominal & Bahasa Indonesia
  // ---------------------------------------------------------------------------
  function terbilang(n) {
    const satuan = ["", "satu", "dua", "tiga", "empat", "lima", "enam",
      "tujuh", "delapan", "sembilan", "sepuluh", "sebelas"];
    const sisa = (x, kata) => (x ? " " + kata(x) : "");
    function t(x) {
      if (x < 12) return satuan[x];
      if (x < 20) return t(x - 10) + " belas";
      if (x < 100) return t(Math.floor(x / 10)) + " puluh" + sisa(x % 10, t);
      if (x < 200) return "seratus" + sisa(x - 100, t);
      if (x < 1000) return t(Math.floor(x / 100)) + " ratus" + sisa(x % 100, t);
      if (x < 2000) return "seribu" + sisa(x - 1000, t);
      if (x < 1e6) return t(Math.floor(x / 1e3)) + " ribu" + sisa(x % 1e3, t);
      if (x < 1e9) return t(Math.floor(x / 1e6)) + " juta" + sisa(x % 1e6, t);
      if (x < 1e12) return t(Math.floor(x / 1e9)) + " miliar" + sisa(x % 1e9, t);
      return t(Math.floor(x / 1e12)) + " triliun" + sisa(x % 1e12, t);
    }
    n = Math.floor(Math.abs(n));
    return n === 0 ? "nol" : t(n);
  }

  function nominalToSpeech(angka, isCoin = false) {
    let kalimat = terbilang(angka) + " rupiah";
    if (isCoin) kalimat += " koin";
    return kalimat.charAt(0).toUpperCase() + kalimat.slice(1);
  }

  function formatRupiah(angka) {
    return "Rp " + String(Math.floor(angka)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  function formatNumberShort(angka) {
    return String(Math.floor(angka)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // -------------------------------------------------------------------------
  // Referensi Elemen DOM
  // -------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = {
    video: $("camera-preview"),
    canvas: $("capture-canvas"),
    tapArea: $("tap-fullscreen"),
    viewfinder: $("viewfinder"),
    laserScanner: $("laser-scanner"),
    successBadge: $("success-badge"),

    // Nav bar
    btnBack: $("btn-back"),
    btnMenu: $("btn-menu"),
    btnSwitchCam: $("btn-switch-cam"),
    aiChip: $("ai-chip"),
    chipText: $("chip-text"),

    // Zoom
    btnZoom: $("btn-zoom"),
    zoomLabel: $("zoom-label"),

    // Bottom Pill Card
    bottomCard: $("bottom-card"),
    pillIconSlot: $("pill-icon-slot"),
    iconIdle: $("icon-idle"),
    iconScanning: $("icon-scanning"),
    iconResult: $("icon-result"),
    banknoteThumb: $("banknote-thumbnail"),
    thumbNumber: $("thumb-number"),
    pillSubtitle: $("pill-subtitle"),
    pillTitle: $("pill-title"),
    btnTorch: $("btn-torch"),

    // Bottom Sheet Menu
    menuBackdrop: $("menu-backdrop"),
    menuSheet: $("menu-sheet"),
    btnCloseSheet: $("btn-close-sheet"),
    sheetTotalVal: $("sheet-total-value"),
    btnAddTotal: $("btn-add-total"),
    btnResetTotal: $("btn-reset-total"),
    sheetGpuVal: $("sheet-gpu-val"),
    sheetCamVal: $("sheet-cam-val"),

    // MLOps Diagnostic Elements
    diagStateBadge: $("diag-state-badge"),
    diagModel: $("diag-model"),
    diagBackend: $("diag-backend"),
    diagInput: $("diag-input"),
    diagLatency: $("diag-latency"),
    diagPrediction: $("diag-prediction"),
    diagConf: $("diag-conf"),
    diagTop3List: $("diag-top3-list"),

    // Live status
    srStatus: $("sr-status"),

    // Visual Debug Elements (?debug=1)
    debugOverlayCanvas: $("debug-overlay-canvas"),
    debugHud: $("debug-hud"),
    debugFps: $("debug-fps"),
    debugTensorPreview: $("debug-tensor-preview"),
    debugStatus: $("debug-status"),
    debugSource: $("debug-source"),
    debugBbox: $("debug-bbox"),
    debugQuality: $("debug-quality"),
    debugWindow: $("debug-window"),
    debugWinner: $("debug-winner"),
    debugConf: $("debug-conf"),
    debugMargin: $("debug-margin")
  };

  // -------------------------------------------------------------------------
  // Status Aplikasi (State Management)
  // -------------------------------------------------------------------------
  const isDebugUrl = new URLSearchParams(window.location.search).get("debug") === "1";

  const app = {
    stream: null,
    currentFacingMode: "environment", // default environment, fallback user
    torchOn: false,
    zoomLevel: 1,
    total: 0,
    lastResult: null,
    lastTapTime: 0,
    tapTimer: null,
    voice: null,
    resetCardTimer: null,

    // In-Browser ML State
    tfModel: null,
    modelReady: false,
    backendName: "webgl",
    lastLatencyMs: 0,
    currentState: "IDLE",

    // Continuous Autonomous Scanning & Consensus State
    continuousScanning: true,
    scanLoopActive: false,
    slidingWindow: [], // Array objek: { nominal, code, prob, margin, timestamp }
    lastSpokenNominal: null,
    lastSpokenTimestamp: 0,
    lastGuidanceTimestamp: 0,
    unconfirmedFramesCount: 0,
    consecutiveEmptyFrames: 0,

    // Debug Mode & Performance Monitoring
    isDebug: isDebugUrl,
    fpsHistory: [],
    lastFrameTimestamp: performance.now(),
    currentFps: 0
  };

  // -------------------------------------------------------------------------
  // Audio Pipeline Ramah Mobile & Tunanetra: Web Audio Chime + SpeechSynthesis
  // -------------------------------------------------------------------------
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) audioCtx = new AudioCtx();
    }
    return audioCtx;
  }

  // Chime nada ganda (D5 -> A5) yang 100% selalu berbunyi di semua browser HP
  function playSuccessChime() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime;
      
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = "sine";
      osc1.frequency.setValueAtTime(587.33, now);
      gain1.gain.setValueAtTime(0.35, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.12);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = "sine";
      osc2.frequency.setValueAtTime(880, now + 0.08);
      gain2.gain.setValueAtTime(0.40, now + 0.08);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.08);
      osc2.stop(now + 0.32);
    } catch (_) {}
  }

  const ttsAda = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

  function pilihVoice() {
    if (!ttsAda) return;
    try {
      const daftar = speechSynthesis.getVoices();
      const norm = (v) => (v.lang || "").toLowerCase().replace("_", "-");
      app.voice =
        daftar.find((v) => norm(v) === "id-id") ||
        daftar.find((v) => norm(v).startsWith("id")) ||
        null;
    } catch (_) {}
  }

  if (ttsAda) {
    pilihVoice();
    speechSynthesis.addEventListener("voiceschanged", pilihVoice);
  }

  // Buka blokir Web Audio API pada sentuhan pertama (tanpa spam dummy speechSynthesis!)
  function unlockAudioPipeline() {
    const ctx = getAudioCtx();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    if (ttsAda) {
      try {
        pilihVoice();
        window.speechSynthesis.resume();
      } catch (_) {}
    }
  }
  window.addEventListener("touchstart", unlockAudioPipeline, { passive: true, once: true });
  window.addEventListener("click", unlockAudioPipeline, { passive: true, once: true });

  function playScanTick() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(660, now);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.055);
    } catch (_) {}
  }

  function speakSync(teks) {
    if (!ttsAda) return;
    try {
      pilihVoice();
      window.speechSynthesis.resume();
      const u = new SpeechSynthesisUtterance(teks);
      u.lang = "id-ID";
      u.rate = 1.05;
      u.pitch = 1.0;
      u.volume = 1.0;
      if (app.voice) u.voice = app.voice;
      window.__activeUtterance = u;
      window.speechSynthesis.speak(u);
    } catch (_) {}
  }

  let speakTimer = null;
  function speak(teks, replaceQueue = false) {
    announce(teks);
    if (!ttsAda) return;
    try {
      if (speakTimer) {
        clearTimeout(speakTimer);
        speakTimer = null;
      }
      pilihVoice();
      window.speechSynthesis.resume();

      const doSpeak = () => {
        const u = new SpeechSynthesisUtterance(teks);
        u.lang = "id-ID";
        u.rate = 1.0;
        u.pitch = 1.0;
        u.volume = 1.0;
        if (app.voice) u.voice = app.voice;
        // Simpan referensi di window agar tidak di-garbage-collect oleh Chrome Mobile sebelum selesai bicara
        window.__activeUtterance = u;
        u.onend = () => { window.__activeUtterance = null; };
        u.onerror = () => {
          window.__activeUtterance = null;
          // Fallback jika voice id-ID tidak tersedia di perangkat
          try {
            const fb = new SpeechSynthesisUtterance(teks);
            fb.rate = 1.0;
            window.__activeUtterance = fb;
            window.speechSynthesis.speak(fb);
          } catch (_) {}
        };
        window.speechSynthesis.speak(u);
      };

      // Jika replaceQueue=false, biarkan antrean setelah "Memindai" berjalan alami tanpa cancel()
      // agar browser HP (Android/iOS) tidak memblokir atau membatalkan suara hasil deteksi!
      if (replaceQueue && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
        window.speechSynthesis.cancel();
        speakTimer = setTimeout(doSpeak, 65);
      } else {
        doSpeak();
      }
    } catch (e) {
      console.warn("[TTS Exception]", e);
    }
  }

  function speakGuidance(teks) {
    const now = Date.now();
    if (now - app.lastGuidanceTimestamp < THRESHOLDS.GUIDANCE_COOLDOWN_MS) {
      return;
    }
    if (speechSynthesis && speechSynthesis.speaking) {
      return;
    }
    app.lastGuidanceTimestamp = now;
    speak(teks);
  }

  function announce(pesan) {
    if (!el.srStatus) return;
    el.srStatus.textContent = "";
    setTimeout(() => { el.srStatus.textContent = pesan; }, 40);
  }

  function getar(pola) {
    try {
      if (navigator.vibrate) navigator.vibrate(pola);
    } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // Inisialisasi Model In-Browser TensorFlow.js
  // -------------------------------------------------------------------------
  async function initTfjsModel() {
    if (typeof tf === "undefined") {
      console.warn("Library TensorFlow.js belum siap, menunggu script load...");
      setTimeout(initTfjsModel, 400);
      return;
    }

    try {
      if (el.chipText) el.chipText.textContent = "Loading AI Model...";
      await tf.ready();

      // Utamakan akselerasi WebGL GPU
      try {
        await tf.setBackend("webgl");
        app.backendName = "WebGL (GPU)";
      } catch (eGpu) {
        console.warn("WebGL tidak tersedia, fallback ke CPU:", eGpu);
        await tf.setBackend("cpu");
        app.backendName = "CPU";
      }

      console.log(`[Rupiah AI] TF.js Backend aktif: ${tf.getBackend()}`);

      const IDB_KEY = "indexeddb://rupiah-customcnn-v15";
      let loaded = null;

      // 1. Cek cache IndexedDB agar loading instan (< 0.5 detik) pada kunjungan berikutnya
      try {
        loaded = await tf.loadLayersModel(IDB_KEY);
        console.log("[Rupiah AI] Model dimuat instan dari cache IndexedDB!");
      } catch (_) {
        // Belum ada di cache, unduh dari server
      }

      // 2. Unduh dari server dengan progress bar persentase jika belum ada di cache
      if (!loaded) {
        const modelLocations = [
          "./model_tfjs/model.json",
          "model_tfjs/model.json"
        ];
        for (const loc of modelLocations) {
          try {
            console.log(`[Rupiah AI] Mengunduh model dari: ${loc}`);
            loaded = await tf.loadLayersModel(loc, {
              onProgress: (fraction) => {
                if (el.chipText) {
                  const pct = Math.min(99, Math.round(fraction * 100));
                  el.chipText.textContent = `Loading AI ${pct}%`;
                }
              }
            });
            if (loaded) {
              // Simpan ke IndexedDB di background untuk kunjungan berikutnya
              loaded.save(IDB_KEY).catch(() => {});
              break;
            }
          } catch (err) {
            console.warn(`[Rupiah AI] Gagal memuat dari ${loc}:`, err);
          }
        }
      }

      if (!loaded) {
        throw new Error("Tidak dapat memuat model.json dari semua path.");
      }

      app.tfModel = loaded;
      app.modelReady = true;

      // Warmup forward pass untuk mengompilasi shader WebGL
      tf.tidy(() => {
        const dummy = tf.zeros([1, 224, 224, 3]);
        app.tfModel.predict(dummy);
      });

      console.log("[Rupiah AI] Model siap! Mode Ketuk Layar aktif (hemat baterai & anti-lag).");
      if (el.chipText) el.chipText.textContent = "AI Ready";
      if (el.pillSubtitle) el.pillSubtitle.textContent = "Siap Memindai";
      if (el.pillTitle) el.pillTitle.textContent = "Ketuk Layar untuk Pindai";
    } catch (err) {
      console.error("[Rupiah AI Error] Gagal inisialisasi model:", err);
      if (el.chipText) el.chipText.textContent = "AI Fallback Active";
    }
  }

  // -------------------------------------------------------------------------
  // Perhitungan Koordinat Crop Presisi dari Kotak Viewfinder UI
  // -------------------------------------------------------------------------
  function getViewfinderCropCoords(videoEl, viewfinderEl) {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) {
      return { sx: 0, sy: 0, sw: 224, sh: 224 };
    }

    const vRect = videoEl.getBoundingClientRect ? videoEl.getBoundingClientRect() : { width: vw, height: vh, left: 0, top: 0 };
    const vf = viewfinderEl || el.viewfinder;
    const vfRect = (vf && vf.getBoundingClientRect) ? vf.getBoundingClientRect() : {
      left: vRect.left + vRect.width * 0.15,
      top: vRect.top + vRect.height * 0.20,
      width: vRect.width * 0.70,
      height: vRect.height * 0.55,
      right: vRect.left + vRect.width * 0.85
    };

    const scale = Math.max(vRect.width / vw, vRect.height / vh);
    const renderedW = vw * scale;
    const renderedH = vh * scale;
    const renderedLeft = vRect.left + (vRect.width - renderedW) / 2;
    const renderedTop = vRect.top + (vRect.height - renderedH) / 2;

    const isMirrored = document.body.classList.contains("cam-user") ||
      (app && app.currentFacingMode === "user");

    const screenLeft = isMirrored
      ? renderedW - (vfRect.right - renderedLeft)
      : (vfRect.left - renderedLeft);
    const screenTop = vfRect.top - renderedTop;

    const sxRaw = screenLeft / scale;
    const syRaw = screenTop / scale;
    const swRaw = vfRect.width / scale;
    const shRaw = vfRect.height / scale;

    const sx = Math.max(0, Math.min(vw - 1, Math.round(sxRaw)));
    const sy = Math.max(0, Math.min(vh - 1, Math.round(syRaw)));
    const sw = Math.max(1, Math.min(vw - sx, Math.round(swRaw)));
    const sh = Math.max(1, Math.min(vh - sy, Math.round(shRaw)));

    return { sx, sy, sw, sh };
  }

  // -------------------------------------------------------------------------
  // Lokalisasi Uang Kertas Otomatis (Lightweight Client-Side Saliency)
  // -------------------------------------------------------------------------
  // Menganalisis area foreground secara cerdas tanpa terjebak warna baju di bawah
  let analysisCanvas = null;
  let analysisCtx = null;

  function locateBanknoteCandidate(videoEl) {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) {
      return {
        status: "NO_FRAME",
        qualityStatus: "OK",
        sx: 0, sy: 0, sw: 224, sh: 224,
        confidence: 0,
        aspectRatio: 1.0,
        avgBrightness: 128,
        avgBlurEnergy: 10
      };
    }

    const analysisW = 320;
    const analysisH = Math.max(1, Math.round(analysisW * (vh / vw)));

    if (!analysisCanvas) {
      analysisCanvas = document.createElement("canvas");
      analysisCanvas.width = analysisW;
      analysisCanvas.height = analysisH;
      analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true });
    } else if (analysisCanvas.height !== analysisH) {
      analysisCanvas.height = analysisH;
    }

    // Salin frame video penuh ke kanvas analisis beresolusi rendah
    analysisCtx.drawImage(videoEl, 0, 0, analysisW, analysisH);
    const imgData = analysisCtx.getImageData(0, 0, analysisW, analysisH);
    const pixels = imgData.data;

    // Batasi pencarian aktif pada area atas/tengah (maks 76% tinggi frame)
    // agar baju/kerah/kancing di bagian dada bawah tidak mendominasi bounding box
    const searchH = Math.round(analysisH * 0.76);

    let totalLuma = 0;
    let totalGradient = 0;
    let sampleCount = 0;

    const blockSize = 16;
    const gridCols = Math.floor(analysisW / blockSize);
    const gridRows = Math.floor(searchH / blockSize);
    const gridEnergy = new Float32Array(gridCols * gridRows);

    const step = 2; // Step 2 piksel untuk kecepatan (< 4ms di CPU)
    for (let y = 1; y < searchH - 1; y += step) {
      const rowOffset = y * analysisW;
      const gridY = Math.min(gridRows - 1, Math.floor(y / blockSize));

      for (let x = 1; x < analysisW - 1; x += step) {
        const idx = (rowOffset + x) * 4;
        const r = pixels[idx];
        const g = pixels[idx + 1];
        const b = pixels[idx + 2];

        // Luminance Y
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        totalLuma += luma;
        sampleCount++;

        // Gradient Magnitude (Perbedaan sentral horizontal & vertikal)
        const idxRight = (rowOffset + x + 1) * 4;
        const idxLeft  = (rowOffset + x - 1) * 4;
        const idxDown  = ((y + 1) * analysisW + x) * 4;
        const idxUp    = ((y - 1) * analysisW + x) * 4;

        const lumaR = 0.299 * pixels[idxRight] + 0.587 * pixels[idxRight + 1] + 0.114 * pixels[idxRight + 2];
        const lumaL = 0.299 * pixels[idxLeft]  + 0.587 * pixels[idxLeft + 1]  + 0.114 * pixels[idxLeft + 2];
        const lumaD = 0.299 * pixels[idxDown]  + 0.587 * pixels[idxDown + 1]  + 0.114 * pixels[idxDown + 2];
        const lumaU = 0.299 * pixels[idxUp]    + 0.587 * pixels[idxUp + 1]    + 0.114 * pixels[idxUp + 2];

        const grad = Math.abs(lumaR - lumaL) + Math.abs(lumaD - lumaU);
        totalGradient += grad;

        // Deteksi Warna Kulit Manusia (Tangan / Jari / Wajah)
        const isSkin = (r > 75 && g > 40 && b > 20 && r > g && (r - b) > 15 && (Math.max(r, g, b) - Math.min(r, g, b) > 15));
        const colorSpread = Math.max(r, g, b) - Math.min(r, g, b);

        let saliency = grad;
        if (isSkin) {
          saliency *= 0.12; // Redam area jari/tangan
        } else {
          // Bobot tinggi pada tekstur guilloche & angka nominal uang kertas
          saliency += colorSpread * 0.35;
        }

        const gridX = Math.min(gridCols - 1, Math.floor(x / blockSize));
        gridEnergy[gridY * gridCols + gridX] += saliency;
      }
    }

    const avgBrightness = totalLuma / Math.max(1, sampleCount);
    const avgBlurEnergy = totalGradient / Math.max(1, sampleCount);

    let qualityStatus = "OK";
    if (avgBrightness < 35) {
      qualityStatus = "DARK";
    } else if (avgBrightness > 225) {
      qualityStatus = "OVEREXPOSED";
    } else if (avgBlurEnergy < 3.5) {
      qualityStatus = "BLURRY";
    }

    // 2. Evaluasi Bounding Box Kandidat Uang
    let totalGrid = 0;
    for (let i = 0; i < gridEnergy.length; i++) totalGrid += gridEnergy[i];
    const meanGrid = totalGrid / Math.max(1, gridEnergy.length);
    const energyThresh = meanGrid * 1.30;

    let minCol = gridCols, maxCol = -1, minRow = gridRows, maxRow = -1;
    let activeBlockCount = 0;

    for (let gy = 0; gy < gridRows; gy++) {
      for (let gx = 0; gx < gridCols; gx++) {
        if (gridEnergy[gy * gridCols + gx] > energyThresh) {
          activeBlockCount++;
          if (gx < minCol) minCol = gx;
          if (gx > maxCol) maxCol = gx;
          if (gy < minRow) minRow = gy;
          if (gy > maxRow) maxRow = gy;
        }
      }
    }

    // Jika blok aktif terlalu sedikit atau mencakup seluruh layar, gunakan default foreground tengah
    let candX, candY, candW, candH;
    const totalBlocks = gridCols * gridRows;
    const coverageRatio = activeBlockCount / Math.max(1, totalBlocks);

    if (activeBlockCount < 4 || minCol > maxCol || minRow > maxRow || coverageRatio > 0.72) {
      // Default: 70% lebar tengah, 55% tinggi atas (posisi alami memegang uang di depan kamera)
      candX = Math.round(analysisW * 0.15);
      candY = Math.round(analysisH * 0.12);
      candW = Math.round(analysisW * 0.70);
      candH = Math.round(analysisH * 0.55);
    } else {
      candX = minCol * blockSize;
      candY = minRow * blockSize;
      candW = (maxCol - minCol + 1) * blockSize;
      candH = (maxRow - minRow + 1) * blockSize;

      // Beri safety margin 10%
      const padX = Math.round(candW * 0.10);
      const padY = Math.round(candH * 0.10);
      candX = Math.max(0, candX - padX);
      candY = Math.max(0, candY - padY);
      candW = Math.min(analysisW - candX, candW + padX * 2);
      candH = Math.min(analysisH - candY, candH + padY * 2);
    }

    const candAreaRatio = (candW * candH) / (analysisW * analysisH);
    const candAspectRatio = candW / Math.max(1, candH);

    let candidateStatus = "OK";
    if (candAreaRatio < 0.05) {
      candidateStatus = "TOO_FAR";
    }

    const scaleX = vw / analysisW;
    const scaleY = vh / analysisH;

    const sx = Math.max(0, Math.min(vw - 1, Math.round(candX * scaleX)));
    const sy = Math.max(0, Math.min(vh - 1, Math.round(candY * scaleY)));
    const sw = Math.max(1, Math.min(vw - sx, Math.round(candW * scaleX)));
    const sh = Math.max(1, Math.min(vh - sy, Math.round(candH * scaleY)));

    return {
      status: candidateStatus,
      qualityStatus,
      avgBrightness,
      avgBlurEnergy,
      coverageRatio: candAreaRatio,
      aspectRatio: candAspectRatio,
      candPixelBox: { x: candX, y: candY, w: candW, h: candH },
      sx, sy, sw, sh,
      confidence: Math.min(1.0, activeBlockCount / 12)
    };
  }

  // -------------------------------------------------------------------------
  // Preprocessing Citra: Mode 'pad' (ImageOps.contain 224x224 RGB [0, 255])
  // -------------------------------------------------------------------------
  // Mendukung horizontal flip (un-mirroring) otomatis untuk kamera depan / webcam
  let preprocessCanvas = null;
  let preprocessCtx = null;

  function extractTensorAndCanvas(videoEl, sx, sy, sw, sh, flipHorizontal = false, autoRotateLandscape = true) {
    if (!preprocessCanvas) {
      preprocessCanvas = document.createElement("canvas");
      preprocessCanvas.width = 224;
      preprocessCanvas.height = 224;
      preprocessCtx = preprocessCanvas.getContext("2d", { willReadFrequently: true });
    }

    preprocessCtx.save();
    preprocessCtx.fillStyle = "#000000";
    preprocessCtx.fillRect(0, 0, 224, 224);

    // Otomatis putar jika uang dipegang vertikal/tegak oleh tunanetra agar sesuai dataset training
    const isVertical = autoRotateLandscape && (sh > sw * 1.15);
    const containScale = isVertical
      ? Math.min(224 / sh, 224 / sw)
      : Math.min(224 / sw, 224 / sh);
    const drawW = Math.max(1, Math.round(sw * containScale));
    const drawH = Math.max(1, Math.round(sh * containScale));

    preprocessCtx.save();
    preprocessCtx.fillStyle = "#000000";
    preprocessCtx.fillRect(0, 0, 224, 224);
    preprocessCtx.imageSmoothingEnabled = true;
    preprocessCtx.imageSmoothingQuality = "high";

    preprocessCtx.translate(112, 112);
    if (isVertical) {
      preprocessCtx.rotate(Math.PI / 2);
    }
    if (flipHorizontal) {
      preprocessCtx.scale(-1, 1);
    }
    preprocessCtx.drawImage(videoEl, sx, sy, sw, sh, -drawW / 2, -drawH / 2, drawW, drawH);
    preprocessCtx.restore();

    // 3. Konversi ke Tensor float32 [1, 224, 224, 3] dalam rentang [0, 255] RGB
    const tensor = tf.tidy(() => {
      return tf.browser.fromPixels(preprocessCanvas)
        .toFloat()
        .expandDims(0);
    });

    return { tensor, canvas: preprocessCanvas };
  }

  // -------------------------------------------------------------------------
  // Inferensi Multi-Posisi Ramah Tunanetra (Bebas Arah & Posisi Kamera)
  // -------------------------------------------------------------------------
  async function predictBanknoteFrame(videoEl) {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh || !app.tfModel) return null;

    const t0 = performance.now();
    const isFrontCam = document.body.classList.contains("cam-user") || (app.currentFacingMode === "user");

    // Gunakan 2 crop paling efektif (center + full) dalam 1 batch GPU agar super cepat & anti-lag di HP
    const cropList = [
      { id: "center", sx: Math.round(vw * 0.08), sy: Math.round(vh * 0.12), sw: Math.round(vw * 0.84), sh: Math.round(vh * 0.76) },
      { id: "full", sx: 0, sy: 0, sw: vw, sh: vh }
    ];

    const cropTensors = [];
    let lastCanvas = null;
    for (const crop of cropList) {
      const { tensor, canvas } = extractTensorAndCanvas(
        videoEl, crop.sx, crop.sy, crop.sw, crop.sh, isFrontCam
      );
      cropTensors.push(tensor);
      lastCanvas = canvas;
    }

    let batchProbs;
    const batchTensor = tf.concat(cropTensors, 0);
    cropTensors.forEach((t) => t.dispose());

    try {
      const pred = app.tfModel.predict(batchTensor);
      const flat = await pred.data();
      pred.dispose();
      const numClasses = BANKNOTE_CLASSES.length;
      batchProbs = [];
      for (let i = 0; i < cropList.length; i++) {
        batchProbs.push(Array.from(flat.slice(i * numClasses, (i + 1) * numClasses)));
      }
    } finally {
      batchTensor.dispose();
    }

    let bestResult = null;
    let bestScore = -1;

    for (let i = 0; i < cropList.length; i++) {
      const probs = batchProbs[i];
      const ranked = probs
        .map((prob, idx) => ({ ...BANKNOTE_CLASSES[idx], prob }))
        .sort((a, b) => b.prob - a.prob);

      const top = ranked[0];
      const second = ranked[1];
      const margin = top.prob - second.prob;

      // Score = prob × (1 + margin): menggabungkan confidence dan ketegasan prediksi
      const score = top.prob * (1 + margin);

      if (score > bestScore) {
        bestScore = score;
        bestResult = {
          source: cropList[i].id,
          top,
          second,
          margin,
          ranked,
          rawProbs: probs,
          canvas: lastCanvas
        };
      }
    }

    const latency = Math.round(performance.now() - t0);
    app.lastLatencyMs = latency;

    return {
      loc: null,
      chosen: bestResult,
      latency
    };
  }

  // -------------------------------------------------------------------------
  // Mode Debug Visual (?debug=1 di URL)
  // -------------------------------------------------------------------------
  function renderDebugOverlay(loc, chosen, latency, fps) {
    if (!app.isDebug || !el.debugOverlayCanvas || !el.debugHud) return;

    el.debugOverlayCanvas.hidden = false;
    el.debugHud.hidden = false;

    const overlay = el.debugOverlayCanvas;
    const v = el.video;
    const vRect = v.getBoundingClientRect();

    if (overlay.width !== vRect.width || overlay.height !== vRect.height) {
      overlay.width = vRect.width;
      overlay.height = vRect.height;
    }

    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (loc && loc.sx !== undefined && v.videoWidth) {
      // Petakan koordinat video asli ke koordinat layar kanvas
      const scale = Math.max(vRect.width / v.videoWidth, vRect.height / v.videoHeight);
      const renderedW = v.videoWidth * scale;
      const renderedH = v.videoHeight * scale;
      const leftOffset = (vRect.width - renderedW) / 2;
      const topOffset = (vRect.height - renderedH) / 2;

      const isMirrored = document.body.classList.contains("cam-user") || (app.currentFacingMode === "user");

      let boxX = leftOffset + loc.sx * scale;
      if (isMirrored) {
        boxX = vRect.width - (leftOffset + (loc.sx + loc.sw) * scale);
      }
      const boxY = topOffset + loc.sy * scale;
      const boxW = loc.sw * scale;
      const boxH = loc.sh * scale;

      // Gambar Bounding Box Hijau Neon di Sekitar Kandidat Uang
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = loc.status === "OK" ? "#22c55e" : "#f59e0b";
      ctx.fillStyle = loc.status === "OK" ? "rgba(34, 197, 94, 0.12)" : "rgba(245, 158, 11, 0.12)";
      ctx.strokeRect(boxX, boxY, boxW, boxH);
      ctx.fillRect(boxX, boxY, boxW, boxH);

      // Label Bounding Box
      ctx.font = "bold 11px monospace";
      ctx.fillStyle = "#ffffff";
      const tagText = `${chosen ? chosen.top.badge : "Target"} (${loc.aspectRatio.toFixed(2)}:1)`;
      const textW = ctx.measureText(tagText).width;
      ctx.fillStyle = loc.status === "OK" ? "#15803d" : "#b45309";
      ctx.fillRect(boxX, Math.max(0, boxY - 18), textW + 10, 18);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(tagText, boxX + 5, Math.max(13, boxY - 4));
    }

    // Perbarui PIP Thumbnail Canvas 224x224
    if (chosen && chosen.canvas && el.debugTensorPreview) {
      const pCtx = el.debugTensorPreview.getContext("2d");
      pCtx.drawImage(chosen.canvas, 0, 0, 224, 224);
    }

    // Perbarui HUD Metrics
    if (el.debugFps) el.debugFps.textContent = `${fps} FPS`;
    if (el.debugStatus) el.debugStatus.textContent = loc ? loc.status : "-";
    if (el.debugSource) el.debugSource.textContent = chosen ? chosen.source : "-";
    if (el.debugBbox && loc) el.debugBbox.textContent = `${loc.sw}×${loc.sh}`;
    if (el.debugQuality && loc) el.debugQuality.textContent = `${loc.qualityStatus} (L:${Math.round(loc.avgBrightness)})`;

    // Riwayat 6 Frame
    if (el.debugWindow) {
      const winStr = app.slidingWindow.map(f => {
        const k = f.nominal >= 1000 ? `${f.nominal / 1000}k` : f.nominal;
        return k;
      }).join(",");
      el.debugWindow.textContent = winStr || "[]";
    }

    if (chosen) {
      if (el.debugWinner) el.debugWinner.textContent = `Rp ${chosen.top.badge}`;
      if (el.debugConf) el.debugConf.textContent = `${(chosen.top.prob * 100).toFixed(1)}%`;
      if (el.debugMargin) el.debugMargin.textContent = `+${(chosen.margin * 100).toFixed(1)}%`;
    }
  }

  // -------------------------------------------------------------------------
  // Render MLOps Diagnostic Panel (Di dalam Bottom Sheet Menu)
  // -------------------------------------------------------------------------
  function updateDiagnosticPanel(state, top, top3, latency) {
    if (!el.diagStateBadge) return;

    el.diagStateBadge.textContent = state;
    el.diagStateBadge.className = `diag-badge badge-${state.toLowerCase()}`;

    if (el.diagLatency) el.diagLatency.textContent = `${latency} ms`;
    if (el.diagPrediction) el.diagPrediction.textContent = top ? `Rp ${top.badge}` : "-";
    if (el.diagConf) el.diagConf.textContent = top ? `${(top.prob * 100).toFixed(1)}%` : "-";

    if (el.diagTop3List && top3) {
      el.diagTop3List.innerHTML = top3.map((item, idx) => `
        <div class="diag-top3-row">
          <span class="top3-class">${idx + 1}. Rp ${item.badge} (${item.hero})</span>
          <span class="top3-pct">${(item.prob * 100).toFixed(1)}%</span>
        </div>
      `).join("");
    }
  }

  // -------------------------------------------------------------------------
  // UI Helpers (Animasi Sukses & Pembaruan Kartu)
  // -------------------------------------------------------------------------
  function showSuccessBloom() {
    document.body.classList.remove("state-scanning");
    document.body.classList.add("show-success");
    setTimeout(() => {
      document.body.classList.remove("show-success");
    }, 750);
  }

  function updateResultUI(banknote) {
    if (el.banknoteThumb && el.thumbNumber) {
      el.banknoteThumb.className = `banknote-thumbnail ${banknote.valClass}`;
      el.thumbNumber.textContent = banknote.badge;
    }

    el.bottomCard.className = "bottom-pill-card state-result";
    el.pillSubtitle.textContent = "Hasil Deteksi";
    el.pillTitle.textContent = formatRupiah(banknote.nominal);

    if (app.resetCardTimer) clearTimeout(app.resetCardTimer);
    app.resetCardTimer = setTimeout(() => {
      // Jika tidak ada uang lagi di frame, kembali ke state idle
      if (!app.lastSpokenNominal) {
        el.bottomCard.className = "bottom-pill-card state-idle";
        el.pillSubtitle.textContent = "Scanning...";
        el.pillTitle.textContent = "Arahkan Uang ke Kamera";
      }
    }, 4500);
  }

  // -------------------------------------------------------------------------
  // Loop Pemindaian Kontinu & Konsensus Sliding Window (Aksesibilitas Tunanetra)
  // -------------------------------------------------------------------------
  async function startContinuousScanLoop() {
    if (app.scanLoopActive) return;
    app.scanLoopActive = true;

    while (app.continuousScanning) {
      const loopStart = performance.now();

      // Hitung FPS real-time
      app.currentFps = Math.round(1000 / Math.max(1, loopStart - app.lastFrameTimestamp));
      app.lastFrameTimestamp = loopStart;

      // Jika video belum siap atau model belum termuat, tunggu
      if (!el.video || !el.video.videoWidth || !app.modelReady || !app.tfModel) {
        await sleep(200);
        continue;
      }

      try {
        const frameData = await predictBanknoteFrame(el.video);
        if (frameData) {
          const { loc, chosen, latency } = frameData;

          // Perbarui Debug Overlay
          renderDebugOverlay(loc, chosen, latency, app.currentFps);

          // Evaluasi deteksi frame
          if (chosen && chosen.top.prob >= THRESHOLDS.UNKNOWN) {
            app.slidingWindow.push({
              nominal: chosen.top.nominal,
              code: chosen.top.code,
              prob: chosen.top.prob,
              margin: chosen.margin,
              timestamp: Date.now()
            });

            if (app.slidingWindow.length > THRESHOLDS.WINDOW_SIZE) {
              app.slidingWindow.shift();
            }
            app.consecutiveEmptyFrames = 0;
          } else {
            app.consecutiveEmptyFrames++;
            // Jika uang disingkirkan dari depan kamera selama >= 6 frame berturut-turut (~1.2 detik),
            // reset lastSpokenNominal agar nominal berikutnya (atau uang baru) dapat diucapkan kembali!
            if (app.consecutiveEmptyFrames >= 6) {
              app.lastSpokenNominal = null;
              if (app.slidingWindow.length > 0) {
                app.slidingWindow.shift();
              }
            }
          }

          // -----------------------------------------------------------------
          // Evaluasi Konsensus Multi-Frame (6 Frame Buffer)
          // -----------------------------------------------------------------
          if (app.slidingWindow.length >= 4) {
            const votes = {};
            for (const item of app.slidingWindow) {
              votes[item.nominal] = (votes[item.nominal] || 0) + 1;
            }

            const sortedVotes = Object.entries(votes).sort((a, b) => b[1] - a[1]);
            const [votedNomStr, voteCount] = sortedVotes[0] || [null, 0];
            const votedNominal = votedNomStr ? parseInt(votedNomStr, 10) : null;

            const winFrames = app.slidingWindow.filter(f => f.nominal === votedNominal);
            const avgConf = winFrames.reduce((acc, f) => acc + f.prob, 0) / winFrames.length;
            const avgMargin = winFrames.reduce((acc, f) => acc + f.margin, 0) / winFrames.length;

            const isConfirmed = votedNominal &&
              (voteCount >= THRESHOLDS.MIN_VOTES) &&
              (avgConf >= THRESHOLDS.CONFIRMED) &&
              (avgMargin >= THRESHOLDS.MARGIN);

            if (isConfirmed) {
              app.unconfirmedFramesCount = 0;
              const matchedClass = BANKNOTE_CLASSES.find(c => c.nominal === votedNominal);

              if (matchedClass) {
                app.currentState = "CONFIRMED";
                updateDiagnosticPanel("CONFIRMED", matchedClass, chosen.ranked.slice(0, 3), latency);

                // CEGAH SPAM SUARA:
                // Ucapkan SEKALI saja untuk setiap uang yang dihadirkan.
                // Jangan ulangi ucapan jika uang yang sama masih di depan kamera!
                // Jika sedang terhubung ke FastAPI backend (localhost), jangan biarkan model TFJS menimpa hasil
                const isLocalBackend = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
                if (isLocalBackend) {
                  // Cukup update diagnostik, jangan timpa kartu hasil
                } else if (app.lastSpokenNominal !== matchedClass.nominal) {
                  app.lastSpokenNominal = matchedClass.nominal;
                  app.lastSpokenTimestamp = Date.now();
                  app.lastResult = {
                    ...matchedClass,
                    type: "banknote",
                    confidence: avgConf,
                    displayText: formatRupiah(matchedClass.nominal),
                    speechText: nominalToSpeech(matchedClass.nominal)
                  };

                  getar([80, 40, 80]);
                  showSuccessBloom();
                  updateResultUI(matchedClass);

                  // Bunyikan Chime instan dan ucapkan nominal dengan suara id-ID
                  playSuccessChime();
                  speak(nominalToSpeech(matchedClass.nominal));
                } else {
                  updateResultUI(matchedClass);
                }
              }
            } else {
              // Belum tercapai konsensus
              app.unconfirmedFramesCount++;
              app.currentState = (avgConf >= THRESHOLDS.UNCERTAIN) ? "UNCERTAIN" : "UNKNOWN";
              updateDiagnosticPanel(app.currentState, chosen.top, chosen.ranked.slice(0, 3), latency);
            }
          }
        }
      } catch (loopErr) {
        console.warn("[MLOps Loop] Peringatan frame:", loopErr);
      }

      // Pertahankan target interval ~160ms (~6 FPS)
      const elapsed = performance.now() - loopStart;
      const waitTime = Math.max(25, THRESHOLDS.TARGET_FRAME_INTERVAL_MS - elapsed);
      await sleep(waitTime);
    }

    app.scanLoopActive = false;
  }

  // -------------------------------------------------------------------------
  // Interaksi Manual: Ketuk Layar (Hanya Menganalisis Saat Layar Ditekan)
  // -------------------------------------------------------------------------
  let snapshotCanvas = null;
  let snapshotCtx = null;

  function captureFreshVideoSnapshot(videoEl) {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) return null;
    if (!snapshotCanvas) {
      snapshotCanvas = document.createElement("canvas");
      snapshotCtx = snapshotCanvas.getContext("2d", { willReadFrequently: false });
    }
    if (snapshotCanvas.width !== vw || snapshotCanvas.height !== vh) {
      snapshotCanvas.width = vw;
      snapshotCanvas.height = vh;
    }
    snapshotCtx.drawImage(videoEl, 0, 0, vw, vh);
    // Berikan properti videoWidth/videoHeight agar kompatibel dengan extractTensorAndCanvas
    snapshotCanvas.videoWidth = vw;
    snapshotCanvas.videoHeight = vh;
    return snapshotCanvas;
  }

  function speakBlindGuide() {
    playScanTick();
    getar([40, 40, 40]);
    speak(
      "Panduan Rupiah Reader. Arahkan kamera ke uang kertas, lalu ketuk layar di mana saja satu kali untuk memindai. " +
      "Tunggu bunyi bel dan suara nominalnya. Untuk mengganti uang, cukup arahkan ke uang baru lalu ketuk layar lagi.",
      true
    );
  }

  async function forceScanAndSpeak() {
    if (app.isScanning) return;
    app.isScanning = true;

    try {
      // 1. Segera hapus hasil analisis lama agar tidak terbawa ke uang baru
      app.lastResult = null;
      app.lastSpokenNominal = null;
      app.votingBuffer = [];
      app.unconfirmedFramesCount = 0;

      // 2. Putar bunyi tick & ucapkan "Memindai" SECARA SINKRON di dalam event tap
      //    (Wajib sinkron sebelum 'await' agar browser HP tidak memblokir suara!)
      playScanTick();
      getar(35);
      speakSync("Memindai");

      el.bottomCard.className = "bottom-pill-card state-scanning";
      el.pillSubtitle.textContent = "Memindai...";
      el.pillTitle.textContent = "Menganalisis uang...";
      if (el.thumbNumber) el.thumbNumber.textContent = "-";

      if (!app.tfModel) {
        speak("Model kecerdasan buatan masih dimuat, mohon tunggu sebentar.");
        return;
      }

      // 3. Ambil snapshot segar tepat saat layar diketuk (anti frame lama)
      const freshFrame = captureFreshVideoSnapshot(el.video);
      if (!freshFrame) {
        speak("Kamera belum siap, coba ketuk lagi.");
        return;
      }

      // Prioritas 1: Inferensi via Backend FastAPI (/predict) jika running di localhost
      try {
        const isLocalBackend = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
        if (el.video && el.video.videoWidth && isLocalBackend) {
          const isFrontCam = document.body.classList.contains("cam-user") || (app.currentFacingMode === "user");
          const vfCoords = getViewfinderCropCoords(el.video);
          const { canvas: cropCanvas } = extractTensorAndCanvas(
            el.video,
            vfCoords.sx,
            vfCoords.sy,
            vfCoords.sw,
            vfCoords.sh,
            isFrontCam
          );

          const blob = await new Promise((r) => cropCanvas.toBlob(r, "image/jpeg", 0.95));
          if (blob) {
            const fd = new FormData();
            fd.append("file", blob, "scan.jpg");
            const apiRes = await fetch("/predict", { method: "POST", body: fd });
            if (apiRes.ok) {
              const data = await apiRes.json();
              console.log("[FastAPI Predict]", data);
              if (data.success && data.nominal && (data.confidence === undefined || data.confidence >= THRESHOLDS.CONFIRMED)) {
                const nomInt = parseInt(data.nominal);
                const found = BANKNOTE_CLASSES.find((c) => c.nominal === nomInt);
                if (found) {
                  app.lastSpokenNominal = nomInt;
                  app.lastResult = {
                    ...found,
                    type: "banknote",
                    confidence: data.confidence,
                    displayText: data.label || formatRupiah(nomInt),
                    speechText: nominalToSpeech(nomInt),
                  };
                  getar([80, 40, 80]);
                  showSuccessBloom();
                  playSuccessChime();
                  speak(nominalToSpeech(nomInt));
                  updateResultUI(found);
                  return;
                }
              }
            }
          }
        }
      } catch (apiErr) {
        console.log("FastAPI backend offline, melanjutkan dengan TF.js client-side:", apiErr);
      }

      // Prioritas 2: Inferensi instan TensorFlow.js di browser (1x batch pass cepat, tanpa lag)
      const res = await predictBanknoteFrame(freshFrame);
      const bestPred = res ? res.chosen : null;

      if (bestPred && bestPred.top.prob >= THRESHOLDS.CONFIRMED && bestPred.margin >= THRESHOLDS.MARGIN) {
        const selected = bestPred.top;
        app.lastSpokenNominal = selected.nominal;
        app.lastResult = {
          ...selected,
          type: "banknote",
          confidence: bestPred.top.prob,
          displayText: formatRupiah(selected.nominal),
          speechText: nominalToSpeech(selected.nominal)
        };

        getar([80, 40, 80]);
        showSuccessBloom();
        playSuccessChime();
        speak(nominalToSpeech(selected.nominal));
        updateResultUI(selected);
      } else if (bestPred && bestPred.top.prob >= THRESHOLDS.UNCERTAIN) {
        el.bottomCard.className = "bottom-pill-card state-idle";
        el.pillSubtitle.textContent = "Kurang Jelas";
        el.pillTitle.textContent = "Pegang Stabil lalu Ketuk Lagi";
        getar([60, 40, 60]);
        speak("Uang belum terbaca jelas. Dekatkan sedikit lalu ketuk layar lagi.");
      } else {
        el.bottomCard.className = "bottom-pill-card state-idle";
        el.pillSubtitle.textContent = "Tidak Terdeteksi";
        el.pillTitle.textContent = "Arahkan Uang lalu Ketuk Layar";
        getar([100, 50, 100]);
        speak("Uang belum terdeteksi. Arahkan ke uang lalu ketuk layar.");
      }
    } finally {
      app.isScanning = false;
    }
  }

  // -------------------------------------------------------------------------
  // Akses Kamera Penuh & Switch Kamera
  // -------------------------------------------------------------------------
  async function startCamera(facingMode = null) {
    if (app.stream) {
      try {
        app.stream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      app.stream = null;
    }

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    // Di laptop/PC, utamakan webcam laptop ('user') agar Windows 11 tidak memaksa menyambung ke HP
    const targetFacing = facingMode ? facingMode : (isMobile ? "environment" : "user");
    app.currentFacingMode = targetFacing;

    if (document.body) {
      document.body.classList.toggle("cam-user", targetFacing === "user");
    }

    if (el.video) {
      el.video.muted = true;
      el.video.defaultMuted = true;
      el.video.setAttribute("muted", "");
      el.video.setAttribute("playsinline", "");
      el.video.setAttribute("webkit-playsinline", "");
    }

    let stream = null;

    // Cari webcam laptop secara eksplisit jika di desktop
    let preferredDeviceId = null;
    try {
      if (!isMobile && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevs = devices.filter((d) => d.kind === "videoinput");
        const internalCam = videoDevs.find((d) =>
          /integrated|internal|webcam|asus|usb|camera/i.test(d.label) && !/virtual|phone|link/i.test(d.label)
        );
        if (internalCam) {
          preferredDeviceId = internalCam.deviceId;
        }
      }
    } catch (_) {}

    // Tahap 1: Coba resolusi ideal 1280x720 dengan webcam yang ditargetkan
    try {
      const videoConstraints = {
        width: { ideal: 1280 },
        height: { ideal: 720 },
      };
      if (preferredDeviceId) {
        videoConstraints.deviceId = { ideal: preferredDeviceId };
      } else {
        videoConstraints.facingMode = { ideal: targetFacing };
      }

      stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });
    } catch (err1) {
      console.warn("Akses kamera tahap 1 (resolusi ideal) gagal, coba tahap 2:", err1);
      // Tahap 2: Coba tanpa constraint resolusi kaku
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: targetFacing } },
          audio: false,
        });
      } catch (err2) {
        console.warn("Akses kamera tahap 2 (facingMode) gagal, coba tahap 3 (generic video):", err2);
        // Tahap 3: Fallback generic video: true
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        } catch (err3) {
          console.error("Semua percobaan akses kamera ditolak atau perangkat tidak ditemukan:", err3);
          if (el.chipText) el.chipText.textContent = "Kamera Belum Aktif";
          if (el.pillSubtitle) el.pillSubtitle.textContent = "Izin Kamera Dibutuhkan";
          if (el.pillTitle) el.pillTitle.textContent = "Ketuk Layar untuk Aktifkan Kamera";
          speak("Izin kamera belum aktif. Ketuk layar atau izinkan akses kamera di browser Anda.");
          return;
        }
      }
    }

    if (stream && el.video) {
      app.stream = stream;
      el.video.srcObject = stream;
      el.video.muted = true;

      try {
        await el.video.play();
      } catch (playErr) {
        console.warn("Autoplay dicegah browser, menunggu interaksi gestur pengguna:", playErr);
      }

      if (el.sheetCamVal) {
        el.sheetCamVal.textContent = targetFacing === "user" ? "Kamera Depan / Webcam" : "Kamera Belakang";
      }
      if (el.chipText && !app.modelReady) {
        el.chipText.textContent = "Camera Ready";
      }
    }
  }

  async function switchCamera() {
    getar(35);
    const newFacing = app.currentFacingMode === "environment" ? "user" : "environment";
    await startCamera(newFacing);
    speak(newFacing === "user" ? "Beralih ke kamera depan" : "Beralih ke kamera belakang");
  }

  // -------------------------------------------------------------------------
  // Senter Kamera (Torch Toggle)
  // -------------------------------------------------------------------------
  async function toggleTorch() {
    if (!app.stream) return;
    try {
      const track = app.stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities ? track.getCapabilities() : {};
      
      if (!capabilities.torch) {
        app.torchOn = !app.torchOn;
        el.btnTorch.classList.toggle("torch-active", app.torchOn);
        getar(40);
        return;
      }

      app.torchOn = !app.torchOn;
      await track.applyConstraints({ advanced: [{ torch: app.torchOn }] });
      el.btnTorch.classList.toggle("torch-active", app.torchOn);
      getar(50);
    } catch (e) {
      console.warn("Gagal toggle torch:", e);
      app.torchOn = !app.torchOn;
      el.btnTorch.classList.toggle("torch-active", app.torchOn);
    }
  }

  // -------------------------------------------------------------------------
  // Zoom Kamera (1x / 2x Toggle)
  // -------------------------------------------------------------------------
  async function toggleZoom() {
    app.zoomLevel = app.zoomLevel === 1 ? 2 : 1;
    el.zoomLabel.textContent = `${app.zoomLevel}x`;
    getar(30);

    if (app.stream) {
      try {
        const track = app.stream.getVideoTracks()[0];
        const capabilities = track.getCapabilities ? track.getCapabilities() : {};
        if (capabilities.zoom) {
          const targetZoom = app.zoomLevel === 2 ? Math.min(2, capabilities.zoom.max) : capabilities.zoom.min;
          await track.applyConstraints({ advanced: [{ zoom: targetZoom }] });
          return;
        }
      } catch (_) {}
    }

    el.video.style.transform = app.zoomLevel === 2 ? "scale(1.3)" : "scale(1)";
    el.video.style.transition = "transform 0.3s ease";
  }

  // -------------------------------------------------------------------------
  // Akumulasi Total Uang (Hanya via Double Tap / Menu)
  // -------------------------------------------------------------------------
  function addToTotal() {
    if (!app.lastResult || !app.lastResult.nominal) {
      speak("Belum ada nominal yang dipindai untuk ditambahkan.");
      return;
    }
    app.total += app.lastResult.nominal;
    if (el.sheetTotalVal) el.sheetTotalVal.textContent = formatRupiah(app.total);
    getar([50, 50, 50]);
    speak(`Ditambahkan ${terbilang(app.lastResult.nominal)} rupiah. Total belanja sekarang ${terbilang(app.total)} rupiah.`);
  }

  function resetTotal() {
    app.total = 0;
    if (el.sheetTotalVal) el.sheetTotalVal.textContent = "Rp 0";
    getar(40);
    speak("Total akumulasi belanja direset ke nol rupiah.");
  }

  // -------------------------------------------------------------------------
  // Dispatcher Ketuk Layar (Langsung Pindai Sinkron Tanpa Delay 240ms)
  // -------------------------------------------------------------------------
  function handleScreenTap() {
    forceScanAndSpeak();
  }

  // -------------------------------------------------------------------------
  // Pengelolaan Bottom Sheet Menu
  // -------------------------------------------------------------------------
  function openMenu() {
    if (!el.menuBackdrop) return;
    el.menuBackdrop.hidden = false;
    getar(25);
    speak(`Menu opsi dibuka. Total belanja saat ini ${terbilang(app.total)} rupiah.`);
  }

  function closeMenu() {
    if (!el.menuBackdrop) return;
    el.menuBackdrop.hidden = true;
    getar(25);
  }

  // -------------------------------------------------------------------------
  // Pendaftaran Event Listeners
  // -------------------------------------------------------------------------
  function attachEventListeners() {
    if (el.tapArea) {
      let pressTimer = null;
      let longPressed = false;
      el.tapArea.addEventListener("touchstart", () => {
        longPressed = false;
        pressTimer = setTimeout(() => {
          longPressed = true;
          speakBlindGuide();
        }, 700);
      }, { passive: true });
      el.tapArea.addEventListener("touchend", () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      }, { passive: true });
      el.tapArea.addEventListener("touchmove", () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      }, { passive: true });

      el.tapArea.addEventListener("click", (e) => {
        if (longPressed) { longPressed = false; return; }
        if (e.target.closest(".nav-circle-btn, .floating-zoom-btn, .pill-torch-btn, .menu-bottom-sheet")) return;
        handleScreenTap();
      });
    }

    const btnGuide = $("btn-guide");
    if (btnGuide) {
      btnGuide.addEventListener("click", (e) => {
        e.stopPropagation();
        speakBlindGuide();
      });
    }

    if (el.btnTorch) {
      el.btnTorch.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleTorch();
      });
    }

    if (el.btnZoom) {
      el.btnZoom.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleZoom();
      });
    }

    if (el.btnSwitchCam) {
      el.btnSwitchCam.addEventListener("click", (e) => {
        e.stopPropagation();
        switchCamera();
      });
    }

    if (el.btnMenu) {
      el.btnMenu.addEventListener("click", (e) => {
        e.stopPropagation();
        openMenu();
      });
    }

    if (el.aiChip) {
      el.aiChip.addEventListener("click", (e) => {
        e.stopPropagation();
        openMenu();
      });
    }

    if (el.btnCloseSheet) {
      el.btnCloseSheet.addEventListener("click", closeMenu);
    }

    if (el.menuBackdrop) {
      el.menuBackdrop.addEventListener("click", (e) => {
        if (e.target === el.menuBackdrop) closeMenu();
      });
    }

    if (el.btnAddTotal) {
      el.btnAddTotal.addEventListener("click", addToTotal);
    }
    if (el.btnResetTotal) {
      el.btnResetTotal.addEventListener("click", resetTotal);
    }

    if (el.btnBack) {
      el.btnBack.addEventListener("click", (e) => {
        e.stopPropagation();
        forceScanAndSpeak();
      });
    }

    window.addEventListener("keydown", (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        handleScreenTap();
      } else if (e.key === "t" || e.key === "T") {
        addToTotal();
      } else if (e.key === "m" || e.key === "M") {
        openMenu();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Bootstrapping Aplikasi (Non-blocking & Auto-recovery)
  // -------------------------------------------------------------------------
  async function bootstrap() {
    attachEventListeners();

    // Jalankan inisialisasi AI model dan kamera secara paralel (non-blocking)
    initTfjsModel().catch((err) => console.warn("[MLOps] Error memuat model AI:", err));
    startCamera().catch((err) => console.warn("[MLOps] Error inisialisasi kamera:", err));

    // Fallback interaksi: jika browser memerlukan klik/sentuhan user untuk memulai kamera / video.play()
    const onUserInteraction = async () => {
      if (!app.stream) {
        console.log("[MLOps] Gestur pengguna diterima, mencoba mengaktifkan kamera...");
        await startCamera(app.currentFacingMode);
      } else if (el.video && el.video.paused) {
        try {
          el.video.muted = true;
          await el.video.play();
        } catch (err) {
          console.warn(`[MLOps] Gagal memuat dari ${loc}:`, err);
        }
      }
    };

    document.addEventListener("pointerdown", onUserInteraction, { passive: true });
    document.addEventListener("click", onUserInteraction, { passive: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
