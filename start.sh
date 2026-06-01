#!/usr/bin/env bash
cd "$(dirname "$0")"
source venv/bin/activate
uvicorn backend.main:app --host 0.0.0.0 --port 8080
