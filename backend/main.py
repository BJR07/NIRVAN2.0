# main.py
import os
import shutil
from tempfile import NamedTemporaryFile
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

# Try load Whisper
whisper_model = None
try:
    import whisper
    whisper_model = whisper.load_model("base")  # change model if you want smaller/larger
    print("✅ Whisper loaded")
except Exception as e:
    print("⚠️ Whisper not available:", e)
    whisper_model = None

# Try load PANNs (AudioTagging)
panns_model = None
panns_labels = None
try:
    import torch
    import librosa
    from panns_inference import AudioTagging, labels as panns_labels
    # default checkpoint path: ~/panns_data/Cnn14_mAP=0.431.pth
    checkpoint_path = os.path.join(str(Path.home()), "panns_data", "Cnn14_mAP=0.431.pth")
    if not os.path.isfile(checkpoint_path):
        # If no checkpoint, initialize AudioTagging with checkpoint_path=None (library may try to download)
        # but on Windows it may fail; better to ask user to download manually if needed.
        print("PANNs checkpoint not found at", checkpoint_path)
        panns_model = AudioTagging(checkpoint_path=None, device="cpu")
    else:
        panns_model = AudioTagging(checkpoint_path=checkpoint_path, device="cpu")
    print("✅ PANNs AudioTagging initialized")
except Exception as e:
    print("⚠️ PANNs not available or failed to initialize:", e)
    panns_model = None

app = FastAPI(title="Simple Speech + Non-speech API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {"message": "Speech + Non-speech API running."}


@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """
    Accepts multipart file upload. Returns JSON:
    {
      "filename": "...",
      "transcription": "...",
      "detected_sounds": [{"label": "...", "score": 0.xx}, ...]
    }
    """
    try:
        # Save uploaded file to temporary file (preserve extension)
        suffix = os.path.splitext(file.filename)[1] or ".wav"
        with NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp_path = tmp.name

        # 1) Whisper transcription (if available)
        transcription = ""
        if whisper_model:
            try:
                result = whisper_model.transcribe(tmp_path)
                transcription = (result.get("text") or "").strip()
            except Exception as e:
                transcription = f"(Whisper error: {e})"
        else:
            transcription = "(Whisper not available on server)"

        # 2) PANNs classification (if available)
        detected = []
        if panns_model:
            try:
                # load audio with librosa at 32000 Hz
                audio, sr = librosa.load(tmp_path, sr=32000, mono=True)
                # panns expects shape (samples,), convert to tensor shape (1, n_samples)
                import numpy as np
                import torch
                audio_np = np.asarray(audio, dtype=np.float32)
                audio_t = torch.from_numpy(audio_np[None, :]).float()
                # model inference
                clipwise_output, _ = panns_model.inference(audio_t)  # shape maybe (1, classes) tensor or numpy
                if not isinstance(clipwise_output, torch.Tensor):
                    clipwise_output = torch.tensor(clipwise_output)
                scores, indices = torch.topk(clipwise_output[0], k=5)  # top 5 labels
                scores = scores.tolist()
                indices = indices.tolist()
                for idx, sc in zip(indices, scores):
                    label = panns_labels[idx] if idx < len(panns_labels) else f"label_{idx}"
                    detected.append({"label": label, "score": float(sc)})
            except Exception as e:
                detected = [{"label": f"(PANNs error: {e})", "score": 0.0}]
        else:
            detected = [{"label": "(PANNs not available on server)", "score": 0.0}]

        # remove temp file
        try:
            os.remove(tmp_path)
        except Exception:
            pass

        return {
            "filename": file.filename,
            "transcription": transcription,
            "detected_sounds": detected
        }

    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


if __name__ == "__main__":
    # Use uvicorn when running directly: python main.py
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
