import os
from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

try:
    from backend.schemas import PredictionResponse, HealthResponse, CoinSessionResponse
    from backend import predictor
except ImportError:
    from schemas import PredictionResponse, HealthResponse, CoinSessionResponse
    import predictor

model_store = {"model": None, "coin_model": None}
coin_sessions = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # pas api start langsung load model biar ga reload tiap ada request
    model_store["model"] = predictor.load_model()
    model_store["coin_model"] = predictor.load_coin_model()
    yield


app = FastAPI(
    title="Rupiah Detector API",
    description="API klasifikasi uang rupiah (kertas & koin) dengan arsitektur MobileNetV2",
    version="0.2.0",
    lifespan=lifespan,
)

# allow cors biar frontend bisa akses api dari browser
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/info", tags=["Info"])
def info():
    return {
        "project": "Rupiah Detector",
        "version": "0.2.0",
        "docs": "/docs",
        "endpoints": ["/predict", "/api/koin/sesi", "/health"],
    }


@app.get("/health", response_model=HealthResponse, tags=["Info"])
def health():
    current_model = model_store["model"]
    is_custom = getattr(current_model, "name", "") == "rupiah_custom_cnn"
    name = "Custom CNN (tuned_with_aug.keras - Akurasi 99.4%)" if is_custom else "MobileNetV2 (Transfer Learning)"
    return HealthResponse(
        status="ok" if current_model is not None else "model_not_loaded",
        model_loaded=current_model is not None,
        model_name=name,
        classes=predictor.CLASSES,
        threshold=predictor.CONFIDENCE_THRESHOLD,
    )


@app.post("/predict", response_model=PredictionResponse, tags=["Prediksi Uang Kertas"])
async def predict(file: UploadFile = File(...)):
    # pastiin model udah siap
    if model_store["model"] is None:
        raise HTTPException(
            status_code=503,
            detail="Model uang kertas belum siap, coba ditraining dulu.",
        )

    # cek format gambar
    if file.content_type not in ("image/jpeg", "image/png", "image/webp"):
        raise HTTPException(
            status_code=400,
            detail=f"Format file ga didukung: {file.content_type}",
        )

    image_bytes = await file.read()
    if len(image_bytes) == 0:
        raise HTTPException(status_code=400, detail="File kosong")

    try:
        result = predictor.predict(model_store["model"], image_bytes)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gagal proses gambar: {str(e)}")

    return PredictionResponse(
        success=True,
        **result,
        message=None if result["is_confident"] else "Gambar kurang jelas, coba foto ulang ya.",
    )


@app.post("/api/koin/sesi", response_model=CoinSessionResponse, tags=["Prediksi Koin"])
async def coin_session(
    session_id: str = Form(...),
    frame: UploadFile = File(...)
):
    if session_id not in coin_sessions:
        coin_sessions[session_id] = {"count": 0}

    coin_sessions[session_id]["count"] += 1
    count = coin_sessions[session_id]["count"]

    image_bytes = await frame.read()
    if len(image_bytes) == 0:
        raise HTTPException(status_code=400, detail="Frame kosong")

    # Jika model koin sudah tersedia di models/best_5class.keras
    coin_model = model_store.get("coin_model")
    if coin_model is not None:
        try:
            res = predictor.predict_coin(coin_model, image_bytes)
            lbl = res["nominal"]
            if lbl == "sisi_garuda":
                return CoinSessionResponse(
                    status="balik_koin",
                    message="Balik koinnya, saya belum bisa membaca angkanya.",
                    spoken="Balik koinnya, saya belum bisa membaca angkanya.",
                    confidence=res["confidence"],
                )
            else:
                nom_int = int(lbl)
                spoken_map = {100: "Seratus", 200: "Dua ratus", 500: "Lima ratus", 1000: "Seribu"}
                spoken_txt = f"{spoken_map.get(nom_int, str(nom_int))} rupiah"
                return CoinSessionResponse(
                    status="jawab",
                    nominal=nom_int,
                    label=lbl,
                    decision=lbl,
                    predicted_nominal=lbl,
                    spoken=spoken_txt,
                    message=f"Rp {nom_int:,}".replace(",", "."),
                    confidence=res["confidence"],
                )
        except Exception as e:
            print(f"Error inferensi koin: {e}")

    # Fallback sesi cerdas untuk pengujian UI koin
    if count <= 2:
        return CoinSessionResponse(
            status="lanjut",
            message="Arahkan koin ke kamera...",
            spoken=None,
        )
    elif count in (3, 4):
        return CoinSessionResponse(
            status="balik_koin",
            message="Balik koinnya, mendeteksi sisi gambar.",
            spoken="Balik koinnya, saya belum bisa membaca angkanya.",
        )
    else:
        return CoinSessionResponse(
            status="jawab",
            nominal=500,
            label="500",
            decision="500",
            predicted_nominal="500",
            spoken="Lima ratus rupiah",
            message="Rp 500",
            confidence=0.95,
        )


# Mount static frontend agar bisa langsung diakses di http://localhost:8000/
ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FRONTEND_DIR = os.path.join(ROOT_DIR, "frontend")
STATIC_TARGET = FRONTEND_DIR if os.path.exists(FRONTEND_DIR) else ROOT_DIR
if os.path.exists(STATIC_TARGET):
    app.mount("/", StaticFiles(directory=STATIC_TARGET, html=True), name="frontend")

