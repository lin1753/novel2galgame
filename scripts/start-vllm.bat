@echo off
REM Start vLLM server with Qwen3-8B Novel Base SFT model
REM Requires: pip install vllm
REM
REM Usage: scripts\start-vllm.bat
REM API will be available at http://localhost:8000/v1

set MODEL_DIR=D:\Project\model
set MODEL_PATH=%MODEL_DIR%\qwen3-8b-novel-base-sft

if not exist "%MODEL_PATH%" (
    echo Model not found at %MODEL_PATH%
    echo Run: python scripts\download-models.py
    exit /b 1
)

echo Starting vLLM server...
echo Model: %MODEL_PATH%
echo API:   http://localhost:8000/v1
echo.

vllm serve "%MODEL_PATH%" ^
    --port 8000 ^
    --served-model-name qwen3-8b-sft ^
    --max-model-len 4096 ^
    --dtype auto ^
    --trust-remote-code
