from __future__ import annotations

import base64
import logging
from dataclasses import dataclass, field
from time import monotonic
from threading import Lock
from typing import Dict, Optional

import cv2
import numpy as np
from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.calibration import EyeCalibrationManager
from app.core.detector import (
    DetectionResult,
    DetectorInitializationError,
    MediaPipeFaceMeshDetector,
)
from app.core.fatigue_engine import EyeFatigueEngine, FatigueConfig, FatigueResult
from app.core.session_summary import calculate_metric_summary
from app.database.db import get_db
from app.database.models import AlertRecord, MetricRecord, MonitoringSession, User, utc_now

LOGGER = logging.getLogger(__name__)

router = APIRouter(prefix="/monitoring", tags=["Monitoring"])

MAX_IMAGE_BASE64_CHARS = 8_000_000


@dataclass
class ActiveMonitoringSession:
    session_id: int
    session_code: str
    user_id: int
    detector: Optional[MediaPipeFaceMeshDetector]
    calibration: EyeCalibrationManager
    fatigue_engine: EyeFatigueEngine
    is_calibrated: bool = False
    last_saved_at: float = 0.0
    storage_error_count: int = 0
    last_storage_error: Optional[str] = None
    lock: Lock = field(default_factory=Lock, repr=False)


active_sessions: Dict[str, ActiveMonitoringSession] = {}


class CreateUserRequest(BaseModel):
    user_code: str = Field(..., min_length=1, max_length=50, examples=["P001"])
    consent_given: bool = True

    @field_validator("user_code")
    @classmethod
    def normalize_user_code(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Kode responden tidak boleh kosong.")
        return normalized


class StartSessionRequest(BaseModel):
    user_code: str = Field(..., min_length=1, max_length=50, examples=["P001"])
    mode: str = Field(default="LIVE_CAMERA", max_length=30)
    calibration_duration_seconds: float = Field(default=8.0, ge=3.0, le=60.0)

    @field_validator("user_code")
    @classmethod
    def normalize_user_code(cls, value: str) -> str:
        return value.strip()


class FrameRequest(BaseModel):
    image_base64: str = Field(..., min_length=100)
    save_interval_seconds: float = Field(default=1.0, ge=0.25, le=30.0)


class ClientMetricRequest(BaseModel):
    """Snapshot kecil hasil MediaPipe dan analisis yang berjalan di browser."""

    success: bool = True
    phase: str = Field(default="MONITORING", max_length=30)
    message: str = Field(default="Monitoring lokal aktif.", max_length=500)
    is_calibrated: bool = False
    baseline_ear: Optional[float] = Field(default=None, ge=0.0, le=2.0)
    ear_left: float = Field(default=0.0, ge=0.0, le=2.0)
    ear_right: float = Field(default=0.0, ge=0.0, le=2.0)
    ear_avg: float = Field(default=0.0, ge=0.0, le=2.0)
    ear_threshold: float = Field(default=0.0, ge=0.0, le=2.0)
    is_eye_closed: bool = False
    eye_state: str = Field(default="TIDAK_TERDETEKSI", max_length=30)
    blink_event: bool = False
    blink_count_total: int = Field(default=0, ge=0)
    blink_rate_per_minute: float = Field(default=0.0, ge=0.0, le=300.0)
    blink_rate_ready: bool = False
    perclos: float = Field(default=0.0, ge=0.0, le=1.0)
    perclos_ready: bool = False
    screen_duration_seconds: float = Field(default=0.0, ge=0.0)
    duration_since_last_rest_seconds: float = Field(default=0.0, ge=0.0)
    current_eye_closed_seconds: float = Field(default=0.0, ge=0.0)
    fatigue_score: float = Field(default=0.0, ge=0.0, le=100.0)
    status: str = Field(default="NORMAL", max_length=50)
    should_alert: bool = False
    save_interval_seconds: float = Field(default=1.0, ge=0.25, le=30.0)


class RestRequest(BaseModel):
    note: Optional[str] = Field(default=None, max_length=500)


def decode_base64_image(image_base64: str) -> np.ndarray:
    if not image_base64:
        raise HTTPException(status_code=400, detail="Data gambar kosong.")
    if len(image_base64) > MAX_IMAGE_BASE64_CHARS:
        raise HTTPException(status_code=413, detail="Ukuran frame terlalu besar.")

    payload = image_base64.split(",", 1)[1] if "," in image_base64 else image_base64
    try:
        image_bytes = base64.b64decode(payload, validate=True)
        image_array = np.frombuffer(image_bytes, dtype=np.uint8)
        frame_bgr = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Frame kamera tidak valid.") from exc

    if frame_bgr is None:
        raise HTTPException(status_code=400, detail="Frame kamera gagal dibaca.")
    return frame_bgr


def _points_to_payload(points) -> list[dict[str, float]]:
    if not points:
        return []
    return [{"x": round(float(x), 2), "y": round(float(y), 2)} for x, y in points]


def build_detection_payload(detection: DetectionResult) -> dict:
    return {
        "image_width": detection.image_width,
        "image_height": detection.image_height,
        "left_eye_points": _points_to_payload(detection.left_eye_points),
        "right_eye_points": _points_to_payload(detection.right_eye_points),
    }


def build_fatigue_payload(result: FatigueResult) -> dict:
    return {
        "ear_threshold": result.ear_threshold,
        "is_eye_closed": result.is_eye_closed,
        "eye_state": result.eye_state,
        "blink_event": result.blink_event,
        "blink_count_total": result.blink_count_total,
        "blink_rate_per_minute": result.blink_rate_per_minute,
        "blink_rate_ready": result.blink_rate_ready,
        "perclos": result.perclos,
        "perclos_ready": result.perclos_ready,
        "screen_duration_seconds": result.screen_duration_seconds,
        "duration_since_last_rest_seconds": result.duration_since_last_rest_seconds,
        "current_eye_closed_seconds": result.current_eye_closed_seconds,
        "fatigue_score": result.fatigue_score,
        "status": result.status,
        "should_alert": result.should_alert,
    }


def get_or_create_user(db: Session, payload: CreateUserRequest) -> User:
    user = db.query(User).filter(User.user_code == payload.user_code).first()
    if user:
        user.consent_given = payload.consent_given
        db.commit()
        db.refresh(user)
        return user

    user = User(
        user_code=payload.user_code,
        consent_given=payload.consent_given,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def summarize_and_update_session(db: Session, session: MonitoringSession) -> MonitoringSession:
    metrics = (
        db.query(MetricRecord)
        .filter(MetricRecord.session_id == session.id)
        .order_by(MetricRecord.captured_at.asc())
        .all()
    )
    summary = calculate_metric_summary(metrics)

    session.total_duration_seconds = summary["total_duration_seconds"]
    session.total_blink_count = summary["total_blink_count"]
    session.avg_ear = summary["avg_ear"]
    session.avg_blink_rate = summary["avg_blink_rate"]
    session.avg_perclos = summary["avg_perclos"]
    session.avg_fatigue_score = summary["avg_fatigue_score"]
    session.max_fatigue_score = summary["max_fatigue_score"]
    session.final_status = summary["final_status"]

    db.commit()
    db.refresh(session)
    return session


def close_active_session(session_code: str) -> None:
    active_session = active_sessions.pop(session_code, None)
    if active_session:
        with active_session.lock:
            if active_session.detector is not None:
                active_session.detector.close()
                active_session.detector = None


def store_forced_client_metric(db: Session, db_session: MonitoringSession, payload: ClientMetricRequest) -> None:
    """Simpan snapshot metrik akhir dari browser tanpa throttling interval.

    Dipakai oleh endpoint penutupan tab agar durasi sesi terakhir tetap tercatat
    meskipun halaman sedang di-background dan tidak sempat melakukan sync reguler.
    """

    if not payload.is_calibrated:
        return

    if payload.baseline_ear and not db_session.baseline_ear:
        db_session.baseline_ear = payload.baseline_ear
    if payload.ear_threshold and not db_session.ear_threshold:
        db_session.ear_threshold = payload.ear_threshold

    db.add(
        MetricRecord(
            session_id=db_session.id,
            elapsed_seconds=payload.screen_duration_seconds,
            ear_left=payload.ear_left,
            ear_right=payload.ear_right,
            ear_avg=payload.ear_avg,
            ear=payload.ear_avg,
            ear_threshold=payload.ear_threshold,
            is_eye_closed=payload.is_eye_closed,
            blink_count_total=payload.blink_count_total,
            blink_rate_per_minute=payload.blink_rate_per_minute,
            blink_rate_ready=payload.blink_rate_ready,
            perclos=payload.perclos,
            perclos_ready=payload.perclos_ready,
            screen_duration_seconds=payload.screen_duration_seconds,
            duration_since_last_rest_seconds=payload.duration_since_last_rest_seconds,
            current_eye_closed_seconds=payload.current_eye_closed_seconds,
            fatigue_score=payload.fatigue_score,
            status=payload.status,
            message=payload.message,
        )
    )
    if payload.should_alert:
        db.add(
            AlertRecord(
                session_id=db_session.id,
                alert_type="REST_REMINDER",
                message=payload.message,
                fatigue_score_at_alert=payload.fatigue_score,
            )
        )


@router.post("/users")
def create_user(payload: CreateUserRequest, db: Session = Depends(get_db)):
    user = get_or_create_user(db, payload)
    return {"message": "Data responden berhasil disimpan.", "user": user.to_dict()}


@router.post("/session/start")
def start_monitoring_session(payload: StartSessionRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.user_code == payload.user_code).first()
    if not user:
        user = get_or_create_user(
            db,
            CreateUserRequest(user_code=payload.user_code, consent_given=True),
        )
    if not user.consent_given:
        raise HTTPException(status_code=400, detail="Responden belum memberikan persetujuan penggunaan data.")

    session = MonitoringSession(
        user_id=user.id,
        mode=payload.mode,
        started_at=utc_now(),
        final_status="BERJALAN",
    )
    try:
        db.add(session)
        db.commit()
        db.refresh(session)
    except Exception:
        db.rollback()
        raise

    fatigue_config = FatigueConfig()
    active_sessions[session.session_code] = ActiveMonitoringSession(
        session_id=session.id,
        session_code=session.session_code,
        user_id=user.id,
        detector=None,
        calibration=EyeCalibrationManager(
            duration_seconds=payload.calibration_duration_seconds,
            min_samples=30,
            threshold_ratio=fatigue_config.ear_threshold_ratio,
        ),
        fatigue_engine=EyeFatigueEngine(config=fatigue_config),
    )

    return {
        "message": "Sesi monitoring berhasil dibuat.",
        "session_code": session.session_code,
        "user_code": user.user_code,
        "mode": session.mode,
        "is_calibrated": False,
        "calibration_duration_seconds": payload.calibration_duration_seconds,
    }


@router.post("/client-metric/{session_code}")
def process_client_metric(
    session_code: str,
    payload: ClientMetricRequest,
    db: Session = Depends(get_db),
):
    """Menerima metrik dari MediaPipe yang berjalan di browser.

    Endpoint ini tidak menerima gambar. Browser tetap memproses kamera pada FPS
    perangkat, sedangkan Railway hanya menerima snapshot numerik sekitar sekali
    per detik untuk database dan laporan.
    """

    active_session = active_sessions.get(session_code)
    if not active_session:
        raise HTTPException(status_code=404, detail="Sesi monitoring tidak aktif atau sudah selesai.")

    db_session = (
        db.query(MonitoringSession)
        .filter(MonitoringSession.session_code == session_code)
        .first()
    )
    if not db_session:
        close_active_session(session_code)
        raise HTTPException(status_code=404, detail="Data sesi tidak ditemukan di database.")

    now = monotonic()
    with active_session.lock:
        if payload.is_calibrated and not active_session.is_calibrated:
            baseline = payload.baseline_ear or (
                payload.ear_threshold / FatigueConfig().ear_threshold_ratio
                if payload.ear_threshold > 0 else 0.0
            )
            if baseline <= 0:
                raise HTTPException(status_code=400, detail="Baseline EAR hasil kalibrasi tidak valid.")
            active_session.fatigue_engine.set_baseline(baseline)
            active_session.fatigue_engine.start_monitoring(timestamp=now)
            active_session.is_calibrated = True
            db_session.baseline_ear = baseline
            db_session.ear_threshold = payload.ear_threshold
            db.commit()

        if not payload.is_calibrated:
            return {
                "success": True,
                "stored": False,
                "phase": payload.phase,
                "message": "Kalibrasi browser diterima; metrik belum disimpan.",
            }

        should_save = (
            active_session.last_saved_at == 0.0
            or now - active_session.last_saved_at >= payload.save_interval_seconds
        )
        if not should_save:
            return {
                "success": True,
                "stored": False,
                "phase": payload.phase,
                "storage_ok": active_session.last_storage_error is None,
            }

        metric = MetricRecord(
            session_id=db_session.id,
            elapsed_seconds=payload.screen_duration_seconds,
            ear_left=payload.ear_left,
            ear_right=payload.ear_right,
            ear_avg=payload.ear_avg,
            ear=payload.ear_avg,
            ear_threshold=payload.ear_threshold,
            is_eye_closed=payload.is_eye_closed,
            blink_count_total=payload.blink_count_total,
            blink_rate_per_minute=payload.blink_rate_per_minute,
            blink_rate_ready=payload.blink_rate_ready,
            perclos=payload.perclos,
            perclos_ready=payload.perclos_ready,
            screen_duration_seconds=payload.screen_duration_seconds,
            duration_since_last_rest_seconds=payload.duration_since_last_rest_seconds,
            current_eye_closed_seconds=payload.current_eye_closed_seconds,
            fatigue_score=payload.fatigue_score,
            status=payload.status,
            message=payload.message,
        )
        try:
            db.add(metric)
            if payload.should_alert:
                db.add(
                    AlertRecord(
                        session_id=db_session.id,
                        alert_type="REST_REMINDER",
                        message=payload.message,
                        fatigue_score_at_alert=payload.fatigue_score,
                    )
                )
            db.commit()
            active_session.storage_error_count = 0
            active_session.last_storage_error = None
        except SQLAlchemyError as exc:
            db.rollback()
            active_session.storage_error_count += 1
            active_session.last_storage_error = (
                "Snapshot metrik browser gagal disimpan. Periksa koneksi database."
            )
            LOGGER.exception("Penyimpanan snapshot browser gagal untuk sesi %s.", session_code)
            raise HTTPException(status_code=503, detail=active_session.last_storage_error) from exc
        finally:
            active_session.last_saved_at = now

        return {
            "success": True,
            "stored": True,
            "phase": payload.phase,
            "storage_ok": True,
            "storage_error_count": 0,
        }


@router.post("/frame/{session_code}")
def process_frame(session_code: str, payload: FrameRequest, db: Session = Depends(get_db)):
    active_session = active_sessions.get(session_code)
    if not active_session:
        raise HTTPException(status_code=404, detail="Sesi monitoring tidak aktif atau sudah selesai.")

    db_session = (
        db.query(MonitoringSession)
        .filter(MonitoringSession.session_code == session_code)
        .first()
    )
    if not db_session:
        close_active_session(session_code)
        raise HTTPException(status_code=404, detail="Data sesi tidak ditemukan di database.")

    active_session.lock.acquire()
    try:
        # Sesi dapat diakhiri saat request frame sedang menunggu lock. Jangan
        # memakai detector yang sudah ditutup oleh endpoint akhir sesi.
        if active_sessions.get(session_code) is not active_session:
            raise HTTPException(status_code=409, detail="Sesi sedang diakhiri atau sudah selesai.")

        now = monotonic()
        if active_session.detector is None:
            try:
                active_session.detector = MediaPipeFaceMeshDetector()
            except DetectorInitializationError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
        detection = active_session.detector.detect(decode_base64_image(payload.image_base64))

        if not detection.success:
            if active_session.is_calibrated:
                fatigue_result = active_session.fatigue_engine.update_missing(timestamp=now)
                return {
                    "success": False,
                    "phase": "MONITORING",
                    "message": detection.message,
                    "is_calibrated": True,
                    "ear_left": 0.0,
                    "ear_right": 0.0,
                    "ear_avg": 0.0,
                    **build_fatigue_payload(fatigue_result),
                    **build_detection_payload(detection),
                }

            return {
                "success": False,
                "phase": "CALIBRATING",
                "message": detection.message,
                "is_calibrated": False,
                "status": "TIDAK_TERDETEKSI",
                "eye_state": "TIDAK_TERDETEKSI",
                "calibration_progress": active_session.calibration.progress(now),
                "calibration_sample_count": len(active_session.calibration.ear_samples),
                **build_detection_payload(detection),
            }

        if not active_session.is_calibrated:
            active_session.calibration.add_sample(detection.ear_avg, timestamp=now)

            if active_session.calibration.is_complete(now):
                calibration_result = active_session.calibration.get_result(now)
                if calibration_result.success:
                    active_session.fatigue_engine.set_baseline(calibration_result.baseline_ear)
                    active_session.fatigue_engine.start_monitoring(timestamp=now)
                    active_session.is_calibrated = True

                    db_session.baseline_ear = calibration_result.baseline_ear
                    db_session.ear_threshold = active_session.fatigue_engine.ear_threshold
                    db.commit()

                    return {
                        "success": True,
                        "phase": "CALIBRATION_DONE",
                        "message": "Kalibrasi berhasil. Monitoring dimulai dari 00:00.",
                        "is_calibrated": True,
                        "baseline_ear": calibration_result.baseline_ear,
                        "ear_threshold": active_session.fatigue_engine.ear_threshold,
                        "ear_left": detection.ear_left,
                        "ear_right": detection.ear_right,
                        "ear_avg": detection.ear_avg,
                        "is_eye_closed": False,
                        "eye_state": "TERBUKA",
                        "blink_event": False,
                        "blink_count_total": 0,
                        "blink_rate_per_minute": 0.0,
                        "blink_rate_ready": False,
                        "perclos": 0.0,
                        "perclos_ready": False,
                        "fatigue_score": 0.0,
                        "screen_duration_seconds": 0.0,
                        "duration_since_last_rest_seconds": 0.0,
                        "status": "NORMAL",
                        "should_alert": False,
                        "calibration_progress": 1.0,
                        **build_detection_payload(detection),
                    }

            return {
                "success": True,
                "phase": "CALIBRATING",
                "message": "Kalibrasi berjalan. Tatap layar secara normal dan hindari menutup mata terlalu lama.",
                "is_calibrated": False,
                "ear_left": detection.ear_left,
                "ear_right": detection.ear_right,
                "ear_avg": detection.ear_avg,
                "is_eye_closed": False,
                "eye_state": "KALIBRASI",
                "blink_event": False,
                "calibration_progress": active_session.calibration.progress(now),
                "calibration_sample_count": len(active_session.calibration.ear_samples),
                **build_detection_payload(detection),
            }

        fatigue_result = active_session.fatigue_engine.update(detection.ear_avg, timestamp=now)
        should_save = (
            active_session.last_saved_at == 0.0
            or now - active_session.last_saved_at >= payload.save_interval_seconds
        )

        if should_save:
            metric = MetricRecord(
                session_id=db_session.id,
                elapsed_seconds=fatigue_result.screen_duration_seconds,
                ear_left=detection.ear_left,
                ear_right=detection.ear_right,
                ear_avg=detection.ear_avg,
                ear=detection.ear_avg,
                ear_threshold=fatigue_result.ear_threshold,
                is_eye_closed=fatigue_result.is_eye_closed,
                blink_count_total=fatigue_result.blink_count_total,
                blink_rate_per_minute=fatigue_result.blink_rate_per_minute,
                blink_rate_ready=fatigue_result.blink_rate_ready,
                perclos=fatigue_result.perclos,
                perclos_ready=fatigue_result.perclos_ready,
                screen_duration_seconds=fatigue_result.screen_duration_seconds,
                duration_since_last_rest_seconds=fatigue_result.duration_since_last_rest_seconds,
                current_eye_closed_seconds=fatigue_result.current_eye_closed_seconds,
                fatigue_score=fatigue_result.fatigue_score,
                status=fatigue_result.status,
                message=fatigue_result.message,
            )
            try:
                db.add(metric)

                if fatigue_result.should_alert:
                    db.add(
                        AlertRecord(
                            session_id=db_session.id,
                            alert_type="REST_REMINDER",
                            message=fatigue_result.message,
                            fatigue_score_at_alert=fatigue_result.fatigue_score,
                        )
                    )
                db.commit()
                active_session.storage_error_count = 0
                active_session.last_storage_error = None
            except SQLAlchemyError as exc:
                # Analisis real-time tetap berjalan meskipun satu transaksi gagal.
                # Kesalahan dicatat dan ditampilkan secara eksplisit pada dashboard;
                # frame berikutnya dapat mencoba menyimpan kembali setelah interval.
                db.rollback()
                active_session.storage_error_count += 1
                active_session.last_storage_error = (
                    "Data metrik sementara gagal disimpan. Periksa status database "
                    "pada /api/health dan log data/logs/eye_fatigue.log."
                )
                if active_session.storage_error_count == 1 or active_session.storage_error_count % 30 == 0:
                    LOGGER.exception(
                        "Penyimpanan metrik gagal untuk sesi %s (percobaan %s).",
                        session_code,
                        active_session.storage_error_count,
                    )
                else:
                    LOGGER.warning(
                        "Penyimpanan metrik masih gagal untuk sesi %s (percobaan %s): %s",
                        session_code,
                        active_session.storage_error_count,
                        exc,
                    )
            finally:
                # Mencegah database dihantam ulang pada setiap frame (sekitar 10 FPS).
                active_session.last_saved_at = now

        return {
            "success": True,
            "storage_ok": active_session.last_storage_error is None,
            "storage_warning": active_session.last_storage_error,
            "storage_error_count": active_session.storage_error_count,
            "phase": "MONITORING",
            "message": fatigue_result.message,
            "is_calibrated": True,
            "ear_left": detection.ear_left,
            "ear_right": detection.ear_right,
            "ear_avg": detection.ear_avg,
            **build_fatigue_payload(fatigue_result),
            **build_detection_payload(detection),
        }
    finally:
        active_session.lock.release()


@router.post("/rest/{session_code}")
def mark_rest_taken(session_code: str, payload: RestRequest, db: Session = Depends(get_db)):
    active_session = active_sessions.get(session_code)
    if not active_session or not active_session.is_calibrated:
        raise HTTPException(status_code=409, detail="Monitoring belum aktif atau sesi sudah selesai.")

    with active_session.lock:
        active_session.fatigue_engine.mark_rest_taken(timestamp=monotonic())
    db_session = (
        db.query(MonitoringSession)
        .filter(MonitoringSession.session_code == session_code)
        .first()
    )
    if db_session:
        alerts = (
            db.query(AlertRecord)
            .filter(AlertRecord.session_id == db_session.id)
            .filter(AlertRecord.is_acknowledged.is_(False))
            .all()
        )
        for alert in alerts:
            alert.is_acknowledged = True
            alert.acknowledged_at = utc_now()
        db.commit()

    return {
        "message": "Istirahat dicatat. Timer dan evidence temporal telah direset.",
        "session_code": session_code,
        "note": payload.note,
    }


@router.post("/pause/{session_code}")
def pause_monitoring_session(session_code: str):
    """Menghentikan sementara timer saat kamera dimatikan.

    Endpoint ini sengaja tidak memerlukan body agar dapat dipanggil melalui
    ``navigator.sendBeacon`` ketika tab ditutup. Sesi yang masih berada pada fase
    kalibrasi tetap menghasilkan respons sukses, tetapi belum memiliki timer yang
    perlu dijeda.
    """

    active_session = active_sessions.get(session_code)
    if not active_session:
        raise HTTPException(status_code=404, detail="Sesi monitoring tidak aktif atau sudah selesai.")

    with active_session.lock:
        if active_session.is_calibrated:
            active_session.fatigue_engine.pause_monitoring(timestamp=monotonic())

    return {
        "message": "Monitoring dijeda.",
        "session_code": session_code,
        "is_calibrated": active_session.is_calibrated,
        "is_paused": active_session.fatigue_engine.paused_at is not None,
    }


@router.post("/resume/{session_code}")
def resume_monitoring_session(session_code: str):
    """Melanjutkan timer tanpa menghitung durasi ketika kamera tidak aktif."""

    active_session = active_sessions.get(session_code)
    if not active_session:
        raise HTTPException(status_code=404, detail="Sesi monitoring tidak aktif atau sudah selesai.")

    with active_session.lock:
        if active_session.is_calibrated:
            active_session.fatigue_engine.resume_monitoring(timestamp=monotonic())

    return {
        "message": "Monitoring dilanjutkan.",
        "session_code": session_code,
        "is_calibrated": active_session.is_calibrated,
        "is_paused": active_session.fatigue_engine.paused_at is not None,
    }


@router.get("/session/{session_code}")
def get_active_session_status(session_code: str, db: Session = Depends(get_db)):
    db_session = (
        db.query(MonitoringSession)
        .filter(MonitoringSession.session_code == session_code)
        .first()
    )
    if not db_session:
        raise HTTPException(status_code=404, detail="Sesi tidak ditemukan.")

    active_session = active_sessions.get(session_code)
    return {
        "session": db_session.to_dict(),
        "is_active": active_session is not None,
        "is_calibrated": active_session.is_calibrated if active_session else False,
    }


@router.post("/session/close/{session_code}")
def close_monitoring_session_from_browser(
    session_code: str,
    payload: Optional[ClientMetricRequest] = Body(default=None),
    db: Session = Depends(get_db),
):
    """Akhiri sesi saat tab browser ditutup.

    Endpoint ini menerima snapshot metrik terakhir melalui ``navigator.sendBeacon``.
    Dengan demikian durasi akhir tetap mengikuti jam sesi, bukan hanya snapshot
    terakhir sebelum tab masuk background.
    """

    db_session = (
        db.query(MonitoringSession)
        .filter(MonitoringSession.session_code == session_code)
        .first()
    )
    if not db_session:
        close_active_session(session_code)
        raise HTTPException(status_code=404, detail="Sesi tidak ditemukan.")

    try:
        if db_session.ended_at is None:
            db_session.ended_at = utc_now()
        if payload is not None:
            store_forced_client_metric(db, db_session, payload)
        db_session = summarize_and_update_session(db, db_session)
        return {
            "message": "Sesi monitoring ditutup dari browser.",
            "session": db_session.to_dict(),
        }
    except SQLAlchemyError as exc:
        db.rollback()
        LOGGER.exception("Gagal menutup sesi %s dari browser.", session_code)
        raise HTTPException(
            status_code=503,
            detail="Sesi belum dapat ditutup karena transaksi database gagal.",
        ) from exc
    finally:
        close_active_session(session_code)


@router.post("/session/end/{session_code}")
def end_monitoring_session(session_code: str, db: Session = Depends(get_db)):
    db_session = (
        db.query(MonitoringSession)
        .filter(MonitoringSession.session_code == session_code)
        .first()
    )
    if not db_session:
        raise HTTPException(status_code=404, detail="Sesi tidak ditemukan.")

    try:
        if db_session.ended_at is None:
            db_session.ended_at = utc_now()
        db_session = summarize_and_update_session(db, db_session)
        return {
            "message": "Sesi monitoring berhasil diakhiri.",
            "session": db_session.to_dict(),
        }
    except SQLAlchemyError as exc:
        db.rollback()
        LOGGER.exception("Gagal mengakhiri sesi %s.", session_code)
        raise HTTPException(
            status_code=503,
            detail=(
                "Sesi belum dapat diselesaikan karena transaksi database gagal. "
                "Periksa /api/health dan data/logs/eye_fatigue.log."
            ),
        ) from exc
    finally:
        # Detector harus selalu dilepas agar kamera/model tidak tertinggal di memori,
        # termasuk ketika penyimpanan ringkasan gagal.
        close_active_session(session_code)
