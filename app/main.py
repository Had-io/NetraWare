from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import monitoring, report
from app.database.db import get_database_status, init_db, verify_database_connection
from app.logging_config import configure_logging
from app.utils.file_cleanup import cleanup_old_files

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = PROJECT_ROOT / "frontend"
REPORT_DIR = PROJECT_ROOT / "data" / "reports"
LOG_PATH = configure_logging(PROJECT_ROOT)
APP_VERSION = "5.4.3"
REPORT_MAX_AGE_HOURS = 24
REPORT_CLEANUP_INTERVAL_SECONDS = 3600


def create_runtime_directories() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)


async def cleanup_reports_periodically() -> None:
    while True:
        await asyncio.sleep(REPORT_CLEANUP_INTERVAL_SECONDS)
        cleanup_old_files(REPORT_DIR, max_age_hours=REPORT_MAX_AGE_HOURS)


@asynccontextmanager
async def lifespan(_: FastAPI):
    create_runtime_directories()
    init_db()
    cleanup_old_files(REPORT_DIR, max_age_hours=REPORT_MAX_AGE_HOURS)
    cleanup_task = asyncio.create_task(cleanup_reports_periodically())
    try:
        yield
    finally:
        cleanup_task.cancel()
        for session_code in list(monitoring.active_sessions):
            monitoring.close_active_session(session_code)
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="NetraWare",
    description="Aplikasi penelitian monitoring indikasi kelelahan mata.",
    version=APP_VERSION,
    lifespan=lifespan,
)

app.include_router(monitoring.router, prefix="/api")
app.include_router(report.router, prefix="/api")
app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")


@app.get("/", include_in_schema=False)
def index_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/index.html", include_in_schema=False)
def index_html() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/dashboard", include_in_schema=False)
@app.get("/dashboard.html", include_in_schema=False)
def dashboard_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "dashboard.html")


@app.get("/api", tags=["System"])
def api_root() -> dict:
    return {
        "application": "NetraWare",
        "status": "running",
        "version": APP_VERSION,
        "documentation": "/docs",
        "health": "/api/health",
    }


@app.get("/api/health", tags=["System"])
def health_check() -> dict:
    database_ok = verify_database_connection()
    database_status = get_database_status().to_dict()
    ready = database_ok and database_status["ready"]
    return {
        "status": "healthy" if ready else "degraded",
        "message": (
            "Aplikasi dan database berjalan normal."
            if ready
            else "Aplikasi berjalan, tetapi database memerlukan pemeriksaan."
        ),
        "version": APP_VERSION,
        "database": database_status,
        "log_file": str(LOG_PATH.relative_to(PROJECT_ROOT)),
    }
