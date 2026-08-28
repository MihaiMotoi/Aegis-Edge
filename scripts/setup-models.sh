#!/usr/bin/env bash
#
# Aegis Edge — model setup
#
# Downloads the multilingual toxicity model, exports it to ONNX, quantizes it
# to INT8, and places it in ./models/ where the SDK expects it.
#
# Why this script exists: the base model (textdetox/bert-multilingual-toxicity-classifier)
# has no ONNX build published, and the converted+quantized result is ~171MB —
# too large to commit to git sensibly. So we convert it locally, once, at setup.
#
# The other three models (image NSFW, speech transcription, speech emotion)
# already have ONNX builds on the Hub and are fetched automatically by
# transformers.js at runtime — no setup needed for those.
#
# Requirements: python3, pip. Takes a few minutes and ~2GB of temporary disk.
#
# Usage:  ./scripts/setup-models.sh

set -euo pipefail

BASE_MODEL="textdetox/bert-multilingual-toxicity-classifier"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_DIR="${REPO_ROOT}/models/multilingual-toxicity"
TMP_DIR="$(mktemp -d)"

cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

echo "==> Aegis Edge model setup"
echo "    base model : ${BASE_MODEL}"
echo "    output dir : ${MODEL_DIR}"
echo

if [ -f "${MODEL_DIR}/onnx/model_quantized.onnx" ]; then
  echo "==> Model already present at ${MODEL_DIR} — nothing to do."
  echo "    (delete that directory and re-run to rebuild)"
  exit 0
fi

echo "==> [1/4] Installing Python dependencies..."
python3 -m pip install --quiet --upgrade \
  optimum optimum-onnx onnx onnxruntime "transformers[torch]" sentencepiece

echo "==> [2/4] Exporting ${BASE_MODEL} to ONNX (this downloads ~700MB)..."
python3 -m optimum.commands.optimum_cli export onnx \
  -m "${BASE_MODEL}" \
  --task text-classification \
  "${TMP_DIR}/onnx" 2>/dev/null \
  || optimum-cli export onnx -m "${BASE_MODEL}" --task text-classification "${TMP_DIR}/onnx"

echo "==> [3/4] Quantizing to INT8 (711MB -> ~171MB)..."
python3 - <<PYEOF
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic(
    "${TMP_DIR}/onnx/model.onnx",
    "${TMP_DIR}/onnx/model_quantized.onnx",
    weight_type=QuantType.QUInt8,
)
PYEOF

echo "==> [4/4] Writing label map and installing into ${MODEL_DIR}..."
python3 - <<PYEOF
import json
p = "${TMP_DIR}/onnx/config.json"
with open(p) as f:
    cfg = json.load(f)
# The exported config has no id2label; the base model is binary neutral/toxic.
cfg["id2label"] = {"0": "neutral", "1": "toxic"}
cfg["label2id"] = {"neutral": 0, "toxic": 1}
with open(p, "w") as f:
    json.dump(cfg, f, indent=2)
PYEOF

mkdir -p "${MODEL_DIR}/onnx"
cp "${TMP_DIR}/onnx/model_quantized.onnx" "${MODEL_DIR}/onnx/"
cp "${TMP_DIR}/onnx/config.json"            "${MODEL_DIR}/"
cp "${TMP_DIR}/onnx/tokenizer.json"         "${MODEL_DIR}/"
cp "${TMP_DIR}/onnx/tokenizer_config.json"  "${MODEL_DIR}/"
cp "${TMP_DIR}/onnx/vocab.txt"              "${MODEL_DIR}/"
cp "${TMP_DIR}/onnx/special_tokens_map.json" "${MODEL_DIR}/"

echo
echo "==> Done. Model installed:"
du -sh "${MODEL_DIR}"
echo
echo "    Serve the repo over HTTP (not file://) and open examples/demo.html"
echo "    e.g.  npx serve .   or   python3 -m http.server 8000"
