"""
로컬 개발 전용 — ems_realtime 라우터만 떼서 standalone FastAPI 로 실행.

목적:
  vite dev (/api) 가 라이브 백엔드 대신 이 로컬 서버로 forward 되게 해,
  backend/ems_realtime.py 수정사항을 브라우저 테스트에 즉시 반영하기 위함.
  운영 컨테이너는 절대 건드리지 않는다.

실행:
  ./.venv/Scripts/python dev_server.py
  (또는 venv 활성화 후) python dev_server.py

  -> http://127.0.0.1:8119/api/119/realtime/{health,process,...}

vite 쪽 토글은 vite.config.ts 의 VITE_EMS_LOCAL_API=1 참조.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

# Windows cp949 콘솔이 em-dash / Vietnamese 다이아크리틱 등 비-cp949 글자에서
# UnicodeEncodeError 를 내는 걸 막기 위해 stdout/stderr 를 utf-8 로 강제.
# (운영 컨테이너는 utf-8 이라 dev 한정 문제 — 로그 가독성 보호용.)
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ems_realtime.py 와 같은 디렉터리에 있다고 가정 — cwd 와 무관하게 import 가능하도록
# 자기 디렉터리를 sys.path 맨 앞에 넣는다.
sys.path.insert(0, str(Path(__file__).parent))

# ems_realtime 의 log.info / _diag 출력이 uvicorn stdout 까지 도달하도록 핸들러 부착.
# (uvicorn 기본 설정은 자기 logger 만 구성하고 루트는 WARNING 이라 INFO 가 묻힌다.)
_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(
    logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
)
_ems_logger = logging.getLogger("ems_realtime")
_ems_logger.setLevel(logging.INFO)
_ems_logger.addHandler(_handler)
_ems_logger.propagate = False

import uvicorn
from fastapi import FastAPI

from ems_realtime import router as ems_realtime_router

app = FastAPI(title="ems_realtime dev (local)")
app.include_router(ems_realtime_router)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8119, log_level="info")
