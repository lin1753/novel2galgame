@echo off
REM Start Ollama with Qwen3-8B Novel SFT model
REM Requires: ollama installed (https://ollama.com)
REM
REM Usage: scripts\start-ollama.bat
REM API will be available at http://localhost:11434/v1

set MODEL_DIR=%~dp0..\model

echo Creating ollama model from local weights...
ollama create qwen3-8b-sft -f "%~dp0Modelfile.qwen3-sft"

echo.
echo Starting ollama with qwen3-8b-sft...
echo API: http://localhost:11434/v1
echo.
echo Test: curl http://localhost:11434/v1/models
echo.
echo Switch pipeline to local model:
echo   curl -X POST http://localhost:3002/config/profiles/qwen3-8b-local/activate

ollama run qwen3-8b-sft
