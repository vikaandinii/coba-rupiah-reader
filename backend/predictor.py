import numpy as np
from PIL import Image, ImageOps
import io
import os

# 7 kelas nominal rupiah kertas
CLASSES = ["1000", "2000", "5000", "10000", "20000", "50000", "100000"]
# 5 kelas koin
COIN_CLASSES = ["100", "200", "500", "1000", "sisi_garuda"]
IMG_SIZE = (224, 224)

# batas minimal confidence, kalau di bawah ini dianggap ragu
CONFIDENCE_THRESHOLD = 0.50

# Semua model utama disimpan dalam 1 folder: models/
MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "models")
CUSTOM_CNN_PATH = os.path.join(MODELS_DIR, "tuned_with_aug.keras")
CUSTOM_CNN_SUBDIR_PATH = os.path.join(MODELS_DIR, "custom_cnn", "tuned_with_aug.keras")
MOBILENET_PATH = os.path.join(MODELS_DIR, "mobilenetv2_rupiah.keras")

# Prioritas: Custom CNN (tuned_with_aug) -> MobileNetV2
if os.path.exists(CUSTOM_CNN_PATH):
    MODEL_PATH = CUSTOM_CNN_PATH
elif os.path.exists(CUSTOM_CNN_SUBDIR_PATH):
    MODEL_PATH = CUSTOM_CNN_SUBDIR_PATH
else:
    MODEL_PATH = MOBILENET_PATH

COIN_MODEL_PATH = os.path.join(MODELS_DIR, "best_5class.keras")


def load_model():
    # load model pas server baru nyala
    try:
        import tensorflow as tf
        if os.path.exists(MODEL_PATH):
            model = tf.keras.models.load_model(MODEL_PATH)
            is_custom = getattr(model, "name", "") == "rupiah_custom_cnn"
            model_type = "Custom CNN (tuned_with_aug)" if is_custom else "MobileNetV2"
            print(f"[OK] Model {model_type} berhasil dimuat dari: {MODEL_PATH}")
            return model
        else:
            print(f"[WARN] File model belum ada di {MODEL_PATH}")
            return None
    except Exception as e:
        print(f"[ERROR] Gagal load model: {e}")
        return None


def load_coin_model():
    # load model koin jika file sudah tersedia
    try:
        import tensorflow as tf
        if os.path.exists(COIN_MODEL_PATH):
            model = tf.keras.models.load_model(COIN_MODEL_PATH, compile=False)
            print(f"model koin berhasil dimuat dari {COIN_MODEL_PATH}")
            return model
        return None
    except Exception as e:
        print(f"info: model koin belum dimuat: {e}")
        return None


def preprocess_image(model, image_bytes: bytes) -> np.ndarray:
    # sesuaikan orientasi EXIF, jaga rasio aspek dengan padding hitam 224x224
    with Image.open(io.BytesIO(image_bytes)) as im:
        img = ImageOps.exif_transpose(im).convert("RGB")
    resized = ImageOps.contain(img, IMG_SIZE, method=Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", IMG_SIZE, (0, 0, 0))
    offset = ((IMG_SIZE[0] - resized.width) // 2, (IMG_SIZE[1] - resized.height) // 2)
    canvas.paste(resized, offset)

    # Custom CNN (rupiah_custom_cnn) sudah memiliki layer Rescaling(1./255) bawaan di dalamnya,
    # sehingga menerima input piksel [0, 255].
    # Sedangkan MobileNetV2 menerima normalisasi [-1, 1].
    is_custom_cnn = getattr(model, "name", "") == "rupiah_custom_cnn" or (
        hasattr(model, "layers") and any("rescale" in l.name.lower() for l in model.layers)
    )
    if is_custom_cnn:
        arr = np.array(canvas, dtype=np.float32)
    else:
        arr = (np.array(canvas, dtype=np.float32) / 127.5) - 1.0

    arr = np.expand_dims(arr, axis=0)
    return arr


def predict(model, image_bytes: bytes) -> dict:
    arr = preprocess_image(model, image_bytes)
    probs = model.predict(arr, verbose=0)[0]

    pred_idx = int(np.argmax(probs))
    pred_class = CLASSES[pred_idx]
    confidence = float(probs[pred_idx])

    # simpen semua nilai probabilitas buat dikirim ke frontend
    all_probs = {cls: round(float(p), 4) for cls, p in zip(CLASSES, probs)}
    print(f"[API Predict] Hasil Prediksi: Rp {int(pred_class):,} (Keyakinan: {confidence:.2%})".replace(",", "."))

    return {
        "nominal": pred_class,
        "label": f"Rp {int(pred_class):,}".replace(",", "."),
        "confidence": round(confidence, 4),
        "is_confident": confidence >= CONFIDENCE_THRESHOLD,
        "all_probabilities": all_probs,
    }


def predict_coin(model, image_bytes: bytes) -> dict:
    arr = preprocess_image(model, image_bytes)
    probs = model.predict(arr, verbose=0)[0]

    pred_idx = int(np.argmax(probs))
    pred_class = COIN_CLASSES[pred_idx]
    confidence = float(probs[pred_idx])

    return {
        "nominal": pred_class,
        "confidence": round(confidence, 4),
    }

    return {
        "nominal": pred_class,
        "confidence": round(confidence, 4),
    }
