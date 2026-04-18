# =========================================================================
# main.py — FastAPI Server for AI Body Processing
# =========================================================================

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi import HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from datetime import datetime
import uvicorn
import os
import io
import math
import base64
import mimetypes
import ssl

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Flowable
from reportlab.graphics.shapes import Drawing, Rect, String
from reportlab.graphics import renderPDF

try:
    from PIL import Image as PILImage
except Exception:
    PILImage = None


class DrawingFlowable(Flowable):
    """Wrap a reportlab.graphics Drawing so it can be used in a Platypus story,
    with optional extra labels rendered via the canvas (for rotated text, etc).
    """

    def __init__(self, drawing: Drawing, labels: Optional[List[Dict[str, Any]]] = None):
        super().__init__()
        self.drawing = drawing
        self.width = drawing.width
        self.height = drawing.height
        # labels: [{x, y, text, angle, font_size, color_hex}]
        self.labels = labels or []

    def draw(self):
        renderPDF.draw(self.drawing, self.canv, 0, 0)
        # Draw any extra labels (e.g. rotated height text inside bars)
        for lbl in self.labels:
            x = float(lbl.get("x", 0))
            y = float(lbl.get("y", 0))
            text = str(lbl.get("text", ""))
            angle = float(lbl.get("angle", 0))
            font_size = int(lbl.get("font_size", 7))
            color_hex = lbl.get("color_hex", "#020617")

            self.canv.saveState()
            self.canv.translate(x, y)
            if angle:
                self.canv.rotate(angle)
            self.canv.setFont("Helvetica", font_size)
            try:
                self.canv.setFillColor(colors.HexColor(color_hex))
            except Exception:
                self.canv.setFillColor(colors.black)
            # متن را وسط بچرخانیم
            self.canv.drawCentredString(0, 0, text)
            self.canv.restoreState()


class CoachLoginRequest(BaseModel):
    access_key: str


# =========================================================================
# Remote Sportify Academy API config (for coach athlete list)
# =========================================================================

API_BASE_URL = "https://sportifyacademy.ae/api"
API_LOGIN_URL = f"{API_BASE_URL}/Auth/swagger-login"
API_PEOPLE_URL = f"{API_BASE_URL}/Documents/view"

# Credentials – ideally override these via environment variables in production
API_LOGIN_EMAIL = os.getenv("SPORTIFY_API_LOGIN_EMAIL", "Amirhoseingohari33@gmail.com")
API_LOGIN_PASSWORD = os.getenv("SPORTIFY_API_LOGIN_PASSWORD", "QAZwsx123!")

# Global switch for remote API usage
ENABLE_REMOTE_API = os.getenv("SPORTIFY_ENABLE_REMOTE_API", "true").lower() == "true"

_API_TOKEN_CACHE: Optional[str] = None


class SSLContextAdapter(HTTPAdapter):
    """
    Simple HTTPS adapter with a custom SSL context.
    This mirrors the desktop app's behaviour to reduce SSLEOFError issues.
    """

    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        # We keep defaults; if needed, ciphers / options can be customized here.
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)

# ─── Fix MIME types for .mjs and .wasm ───
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")

# =========================================================================
# App Setup
# =========================================================================
app = FastAPI(title="AI Body Processing")

# تنظیمات CORS برای جلوگیری از خطاهای مرورگر
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


COACH_ACCESS_KEY = os.getenv("SPORTIFY_COACH_ACCESS_KEY", "6dPvhrpD2Gzd")


@app.post("/api/coach/login")
async def coach_login(payload: CoachLoginRequest) -> Dict[str, Any]:
    """
    Simple placeholder coach login endpoint.
    For now this checks a single access key. Later this can be
    replaced with real authentication and user management.
    """
    key = (payload.access_key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="Access key is required.")
    if key != COACH_ACCESS_KEY:
        raise HTTPException(status_code=401, detail="Invalid coach access key.")

    return {"ok": True}


@app.get("/api/coach/athletes")
async def get_coach_athletes() -> Dict[str, Any]:
    """
    Proxy endpoint for the desktop-app-compatible Sportify Academy API.
    Returns a normalized list of athlete records so the frontend can render them.
    """
    try:
        items = fetch_people_from_api()
    except Exception as e:  # noqa: BLE001
        print(f"[WARN] get_coach_athletes failed: {e}")
        items = []

    return {"items": items}


def _api_login_get_token(force_refresh: bool = False) -> Optional[str]:
    """
    Login helper for the remote Sportify Academy API.
    Ported from the desktop app, with retry & SSL handling.
    """
    global _API_TOKEN_CACHE

    if not ENABLE_REMOTE_API:
        return None

    if not force_refresh and _API_TOKEN_CACHE:
        return _API_TOKEN_CACHE

    if not API_LOGIN_EMAIL or not API_LOGIN_PASSWORD:
        print("[WARN] API login: email/password are empty.")
        return None

    session = requests.Session()

    retry_cfg = Retry(
        total=3,
        backoff_factor=1,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=["POST"],
    )

    adapter = SSLContextAdapter(max_retries=retry_cfg)
    session.mount("https://", adapter)
    session.mount("http://", adapter)

    try:
        payload = {
            "email": API_LOGIN_EMAIL,
            "password": API_LOGIN_PASSWORD,
        }

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Content-Type": "application/json",
            "Connection": "keep-alive",
        }

        resp = session.post(API_LOGIN_URL, json=payload, headers=headers, timeout=15)
        resp.raise_for_status()

        data = resp.json()
        token: Optional[str] = None

        if isinstance(data, str):
            token = data
        elif isinstance(data, dict):
            for key in ("token", "access_token", "accessToken", "jwt", "jwtToken"):
                val = data.get(key)
                if isinstance(val, str):
                    token = val
                    break

            if not token and isinstance(data.get("data"), dict):
                inner = data["data"]
                for key in ("token", "access_token", "accessToken", "jwt", "jwtToken"):
                    val = inner.get(key)
                    if isinstance(val, str):
                        token = val
                        break

        if not token:
            print(f"[WARN] API login: could not find token in response: {data}")
            return None

        _API_TOKEN_CACHE = token
        return token

    except Exception as e:  # noqa: BLE001
        print(f"[WARN] API login failed: {e}")
        return None
    finally:
        session.close()


def fetch_people_from_api() -> List[Dict[str, Any]]:
    """
    Fetch the coach's people/athlete list from the remote API.
    Mirrors the desktop app logic:
      * Uses GET with query params
      * Handles a few common response shapes.
    """
    if not ENABLE_REMOTE_API:
        return []

    token = _api_login_get_token()
    if not token:
        print("[WARN] No token available for fetch_people.")
        return []

    retry_strategy = Retry(
        total=3,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["HEAD", "GET", "POST", "OPTIONS"],
    )

    try:
        adapter = SSLContextAdapter(max_retries=retry_strategy)
    except NameError:
        adapter = HTTPAdapter(max_retries=retry_strategy)

    session = requests.Session()
    session.mount("https://", adapter)
    session.mount("http://", adapter)

    try:
        headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "application/json",
            "Connection": "keep-alive",
        }

        params = {"email": API_LOGIN_EMAIL}

        print(f"[INFO] Fetching people from: {API_PEOPLE_URL}")
        resp = session.get(API_PEOPLE_URL, params=params, headers=headers, timeout=30)
        resp.raise_for_status()

        data = resp.json()

        if isinstance(data, list):
            return data

        if isinstance(data, dict):
            for key in ("items", "data", "results", "documents", "value"):
                if isinstance(data.get(key), list):
                    return data[key]

        return []

    except requests.exceptions.HTTPError as e:  # type: ignore[attr-defined]
        print(f"[WARN] HTTP Error in fetch_people: {e}")
        if e.response is not None:
            print(f"[DEBUG] Server response: {e.response.text}")
        return []
    except Exception as e:  # noqa: BLE001
        print(f"[WARN] fetch_people_from_api failed: {e}")
        return []
    finally:
        session.close()

# مسیرهای دایرکتوری
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

# اطمینان از وجود دایرکتوری‌ها
os.makedirs(STATIC_DIR, exist_ok=True)
mp_dir = os.path.join(STATIC_DIR, "mediapipe")
os.makedirs(os.path.join(mp_dir, "wasm"), exist_ok=True)


# =========================================================================
# PDF Models
# =========================================================================


class JumpItem(BaseModel):
    height_cm: float
    flight_time_s: float
    timestamp_ms: Optional[int] = None
    t_takeoff: Optional[float] = None
    t_landing: Optional[float] = None
    apex_png_b64: Optional[str] = None


class PdfReportRequest(BaseModel):
    jumps: List[JumpItem]
    athlete_name: Optional[str] = None
    test_name: Optional[str] = "Vertical Jump"
    body_weight_kg: Optional[float] = 75.0
    include_snapshots: Optional[bool] = True


# ─── Submit jump results to Sportify Academy JumpingTest API (same format as desktop) ───
class JumpSubmitItem(BaseModel):
    height_cm: Optional[float] = None
    height: Optional[float] = None  # frontend may send "height"
    flight_time_s: Optional[float] = None
    time: Optional[float] = None  # frontend may send "time"
    timestamp_ms: Optional[int] = None
    t_takeoff: Optional[float] = None
    t_landing: Optional[float] = None


class JumpResultsSubmitRequest(BaseModel):
    jumps: List[JumpSubmitItem]
    user_id: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    athlete_name: Optional[str] = None  # full name when no first/last
    weight_kg: Optional[float] = None
    test_duration_seconds: Optional[float] = None


def build_jumping_test_api_body(
    jumps: List[JumpSubmitItem],
    user_id: str,
    first_name: str,
    last_name: str,
    weight_kg: Optional[float],
    test_duration_seconds: Optional[float],
) -> Optional[Dict[str, Any]]:
    """
    Build JSON body for Sportify Academy POST /JumpingTest (same structure as desktop build_jump_api_body).
    """
    if not jumps:
        return None

    user_id_str = str(user_id or "")
    first_name = first_name or ""
    last_name = last_name or ""
    full_name = (first_name + " " + last_name).strip()

    weight_val = None
    if weight_kg is not None:
        try:
            w = float(weight_kg)
            if w > 0:
                weight_val = w
        except Exception:
            pass

    heights: List[float] = []
    airs: List[float] = []
    cleaned_jumps: List[Dict[str, Any]] = []
    t_cursor = 0.0

    for idx, evt in enumerate(jumps):
        h_raw = evt.height_cm if evt.height_cm is not None else evt.height
        height_cm = 0.0
        if h_raw is not None:
            try:
                height_cm = float(h_raw)
                heights.append(height_cm)
            except Exception:
                pass

        at_raw = evt.flight_time_s if evt.flight_time_s is not None else evt.time
        try:
            air_time = float(at_raw) if at_raw is not None else 0.0
        except Exception:
            air_time = 0.0
        if air_time > 0:
            airs.append(air_time)
        air_time_raw = air_time

        t_takeoff = evt.t_takeoff
        t_landing = evt.t_landing
        try:
            if t_takeoff is None or t_landing is None:
                raise ValueError
            t_takeoff = float(t_takeoff)
            t_landing = float(t_landing)
        except Exception:
            t_takeoff = t_cursor
            t_landing = t_cursor + air_time
        t_cursor = t_landing

        cleaned_jumps.append({
            "jump_id": idx + 1,
            "type": "landing",
            "t_takeoff": t_takeoff,
            "t_landing": t_landing,
            "air_time_s": air_time,
            "air_time_raw": air_time_raw,
            "height_cm": height_cm,
            "flag": None,
            "k_row": 0.0,
            "b_row": 0.0,
            "user_id": user_id_str,
            "first_name": first_name,
            "last_name": last_name,
        })

    if not cleaned_jumps:
        return None

    total_jumps = len(cleaned_jumps)
    max_height = max(heights) if heights else 0.0
    avg_height = (sum(heights) / len(heights)) if heights else 0.0

    # Bosco power (W/kg): W = (Ft * Ts * g^2) / (4 * n * (Ts - Ft))
    g = 9.81
    Ft = sum(airs)
    Ts = test_duration_seconds
    if Ts is None or Ts <= 0:
        if cleaned_jumps:
            Ts = cleaned_jumps[-1]["t_landing"] - cleaned_jumps[0]["t_takeoff"]
        Ts = max(0.1, Ts or 1.0)
    n = total_jumps
    bosco_power_w_per_kg = None
    if n > 0 and Ts > Ft and Ft > 0:
        numerator = Ft * Ts * (g ** 2)
        denominator = 4.0 * n * (Ts - Ft)
        if denominator > 0:
            bosco_power_w_per_kg = round(numerator / denominator, 2)

    body = {
        "athlete": {
            "user_id": user_id_str,
            "first_name": first_name,
            "last_name": last_name,
            "full_name": full_name,
            "weight_kg": float(weight_val) if weight_val is not None else None,
        },
        "summary": {
            "total_jumps": total_jumps,
            "max_height_cm": float(max_height),
            "avg_height_cm": round(avg_height, 2),
            "weight_kg": float(weight_val) if weight_val is not None else None,
            "bosco_power_w_per_kg": bosco_power_w_per_kg,
        },
        "jumps": cleaned_jumps,
        "test_date": datetime.now().strftime("%H:%M:%S"),
    }
    return body


def _compute_kpis(jumps: List[JumpItem]):
    """Compute basic KPIs similar to desktop dialog."""
    total = len(jumps)
    if not jumps:
        return dict(
            total=0,
            avg_air=0.0,
            best_air=0.0,
            std_air=0.0,
            cv_air=0.0,
            avg_h=0.0,
            best_h=0.0,
            drop_height_pct=None,
            fatigue_pct=None,
            pace=0.0,
            test_duration_s=0.0,
        )

    import statistics

    airs = [float(j.flight_time_s or 0.0) for j in jumps]
    hs = [float(j.height_cm or 0.0) for j in jumps]
    total = len(jumps)
    avg_air = sum(airs) / total if total else 0.0
    best_air = max(airs) if airs else 0.0
    std_air = statistics.pstdev(airs) if len(airs) > 1 else 0.0
    cv_air = (std_air / avg_air * 100.0) if avg_air > 0 else 0.0

    hs_nonzero = [h for h in hs if h > 0]
    avg_h = sum(hs_nonzero) / len(hs_nonzero) if hs_nonzero else 0.0
    best_h = max(hs_nonzero) if hs_nonzero else 0.0

    drop_height_pct = None
    fatigue_pct = None
    if hs_nonzero:
        first = hs_nonzero[0]
        last = hs_nonzero[-1]
        if first > 0:
            drop_height_pct = 100.0 * (1.0 - (last / first))
    if airs:
        first_a = airs[0]
        last_a = airs[-1]
        if first_a > 0:
            fatigue_pct = 100.0 * (1.0 - (last_a / first_a))

    # approximate duration using timestamps if available, else sum of air times
    t0 = None
    t1 = None
    ts_with_values = [j.timestamp_ms for j in jumps if j.timestamp_ms is not None]
    if ts_with_values:
        t0 = min(ts_with_values)
        t1 = max(ts_with_values)
    if t0 is not None and t1 is not None and t1 > t0:
        elapsed = (t1 - t0) / 1000.0
    else:
        elapsed = max(0.1, sum(airs) + 0.1)

    pace = (len(jumps) / elapsed) * 60.0 if elapsed > 0 else 0.0

    return dict(
        total=total,
        avg_air=avg_air,
        best_air=best_air,
        std_air=std_air,
        cv_air=cv_air,
        avg_h=avg_h,
        best_h=best_h,
        drop_height_pct=drop_height_pct,
        fatigue_pct=fatigue_pct,
        pace=pace,
        test_duration_s=elapsed,
    )


def _compute_extra_formulas_for_api(jumps: List[JumpItem], body_weight: float) -> Dict[str, Dict[str, Any]]:
    """
    Port of _compute_extra_formulas from desktop dialog, adapted for API.
    """
    # --- build rows structure similar to desktop code ---
    if not jumps:
        return {}

    # Build synthetic time axis if takeoff/landing not provided
    # Prefer t_takeoff/t_landing; fallback to timestamps; else fallback to index-based
    rows: List[Dict[str, Any]] = []
    # Fallback using timestamps if needed
    ts = [j.timestamp_ms for j in jumps if j.timestamp_ms is not None]
    ts0 = min(ts) if ts else None

    for idx, j in enumerate(jumps):
        air_time = float(j.flight_time_s or 0.0)
        h_cm = float(j.height_cm or 0.0)

        if j.t_takeoff is not None and j.t_landing is not None:
            t0 = float(j.t_takeoff)
            t1 = float(j.t_landing)
        elif ts0 is not None and j.timestamp_ms is not None:
            # approximate takeoff/landing from timestamps
            t0 = (j.timestamp_ms - ts0) / 1000.0
            t1 = t0 + air_time
        else:
            # simple incremental timeline (less accurate, but keeps formulas defined)
            t0 = float(idx) * (air_time + 0.3)
            t1 = t0 + air_time

        rows.append(
            {
                "idx": idx + 1,
                "t_takeoff": t0,
                "t_landing": t1,
                "air_time_s": air_time,
                "height_cm": h_cm if h_cm > 0 else 0.0,
            }
        )

    # --- direct port of user's function (simplified flags) ---
    air = [float(r.get("air_time_s", 0.0) or 0.0) for r in rows]
    heights = [float(r.get("height_cm", 0.0) or 0.0) for r in rows]

    t_takeoff = [float(r.get("t_takeoff", 0.0) or 0.0) for r in rows]
    t_landing = [float(r.get("t_landing", 0.0) or 0.0) for r in rows]

    total_jumps = len(rows)
    sum_air = sum(air)
    mean_air = sum_air / total_jumps if total_jumps else 0.0

    # body weight
    bw_kg = body_weight or 75.0
    if not bw_kg or bw_kg <= 0:
        bw_kg = 75.0

    g = 9.81

    # 2. Contact time (Rebound)
    valid_cts: List[float] = []
    for i in range(1, total_jumps):
        gap = t_takeoff[i] - t_landing[i - 1]
        if 0.05 < gap < 1.5:
            valid_cts.append(gap)

    if valid_cts:
        mean_ct = sum(valid_cts) / len(valid_cts)
        sum_ct = sum(valid_cts)
        is_rebound_test = True
    else:
        mean_ct = 0.0
        sum_ct = 0.0
        is_rebound_test = False

    # 3. Heights
    sum_height_cm = sum(heights)
    mean_height_cm = sum_height_cm / total_jumps if total_jumps else 0.0
    mean_height_m = mean_height_cm / 100.0

    # 4. Main metrics
    if is_rebound_test and mean_ct > 0:
        rsi = mean_height_m / mean_ct
    else:
        rsi = None

    t_total_duration = max(0.1, t_landing[-1] - t_takeoff[0])
    jump_freq = (total_jumps / t_total_duration) if t_total_duration > 0 else None

    if is_rebound_test and sum_ct > 0:
        # RFT & Reflex
        rft = mean_air / mean_ct if mean_ct > 0 else None
        reflex = mean_ct / mean_air if mean_air > 0 else None
    else:
        rft = None
        reflex = None

    # Rhythm stability
    intervals: List[float] = []
    for i in range(1, len(t_takeoff)):
        diff = t_takeoff[i] - t_takeoff[i - 1]
        intervals.append(diff)

    if len(intervals) > 1:
        mean_int = sum(intervals) / len(intervals)
        sd_int = (sum((x - mean_int) ** 2 for x in intervals) / len(intervals)) ** 0.5
        if sd_int > 0.001:
            rhythm_stab = (0.1 / sd_int) * 10.0
            rhythm_stab = min(rhythm_stab, 100.0)
        else:
            rhythm_stab = 100.0
    else:
        rhythm_stab = None

    # CV Air
    if len(air) > 1 and mean_air > 0:
        sd_air = (sum((x - mean_air) ** 2 for x in air) / len(air)) ** 0.5
        cv_air = (sd_air / mean_air) * 100.0
    else:
        cv_air = 0.0

    # 5. Physics related
    takeoff_vel = (g * mean_air / 2.0) if mean_air > 0 else 0.0

    if mean_height_cm > 1.0:
        peak_power_watts = (60.7 * mean_height_cm) + (45.3 * bw_kg) - 2055
        peak_power_watts = max(0.0, peak_power_watts)
    else:
        peak_power_watts = 0.0

    if takeoff_vel > 0:
        force_est = peak_power_watts / takeoff_vel
    else:
        force_est = bw_kg * g

    accel = (force_est / bw_kg) - g

    # Bosco power (W/kg)
    bosco_power_w_per_kg = 0.0
    Ft = sum(air)
    Ts = t_total_duration
    n = total_jumps
    if is_rebound_test and n > 0 and Ts > Ft and Ft > 0:
        numerator = Ft * Ts * (g ** 2)
        denominator = 4.0 * n * (Ts - Ft)
        if denominator > 0:
            bosco_power_w_per_kg = numerator / denominator

    # 6. Fatigue
    if total_jumps >= 5:
        first_3_avg = sum(air[1:4]) / 3.0
        last_3_avg = sum(air[-3:]) / 3.0
        if first_3_avg > 0:
            fatigue = ((first_3_avg - last_3_avg) / first_3_avg) * 100.0
            preserve = 100.0 - fatigue
        else:
            fatigue, preserve = 0.0, 100.0
    elif total_jumps >= 3:
        first = air[1]
        last = air[-1]
        if first > 0:
            fatigue = ((first - last) / first) * 100.0
            preserve = 100.0 - fatigue
        else:
            fatigue, preserve = 0.0, 100.0
    else:
        fatigue = None
        preserve = None

    height_drop = None
    if total_jumps > 1 and heights:
        h1 = heights[0]
        h2 = heights[-1]
        if h1 > 0:
            height_drop = ((h1 - h2) / h1) * 100.0

    ct_increase = None
    if is_rebound_test and len(valid_cts) >= 2:
        ct_first = valid_cts[0]
        ct_last = valid_cts[-1]
        if ct_first > 0:
            ct_increase = ((ct_last - ct_first) / ct_first) * 100.0

    # symmetry (not available in web data, keep None)
    symmetry = None

    # JPI
    jpi = None
    power_rel = peak_power_watts / bw_kg if bw_kg > 0 else 0
    if power_rel > 0:
        fatigue_val = max(0.0, fatigue) if fatigue else 0.0
        denom = 1.0 + (fatigue_val / 50.0)
        factor_rsi = rsi if (rsi and rsi > 0) else 1.5
        jpi = (power_rel * 10.0 * factor_rsi) / denom

    # MQI
    mqi = None
    if rhythm_stab is not None:
        base_mqi = rhythm_stab
        if symmetry is not None:
            mqi = (base_mqi * 0.6) + (symmetry * 0.4)
        else:
            mqi = base_mqi

    raw_out: Dict[str, Any] = {
        "Jump frequency (Hz)": jump_freq,
        "Mean flight time (s)": mean_air,
        "Mean contact time (s)": mean_ct if is_rebound_test else None,
        "RFT (ΣFT / ΣCT)": None,  # not explicitly defined in pasted code
        "RFT (Flight/Contact)": rft,
        "RSI": rsi,
        "Reflex index (CT/FT)": reflex,
        "Rhythm stability": rhythm_stab,
        "CV Air (%)": cv_air,
        "Takeoff velocity (m/s)": takeoff_vel,
        "Acceleration (m/s²)": accel,
        "Effective force (N)": force_est,
        "Instant power (W)": peak_power_watts,
        "Fatigue (%)": fatigue,
        "Performance preserve (%)": preserve,
        "Height drop (%)": height_drop,
        "Contact time increase (%)": ct_increase,
        "Symmetry (%)": symmetry,
        "Bosco power (W/kg)": bosco_power_w_per_kg if is_rebound_test else None,
        "JPI (Jump Performance Index)": jpi,
        "MQI (Movement Quality Index)": mqi,
    }

    out: Dict[str, Dict[str, Any]] = {}
    for name, val in raw_out.items():
        if val is None or val == "":
            out[name] = {"value": "", "flag": None}
            continue

        disp = val
        if isinstance(val, (int, float)):
            abs_v = abs(val)
            if abs_v == 0:
                disp = 0
            elif abs_v < 0.01:
                disp = round(val, 4)
            elif abs_v < 1:
                disp = round(val, 3)
            elif abs_v < 10:
                disp = round(val, 2)
            elif abs_v >= 1000:
                disp = int(round(val))
            else:
                disp = round(val, 1)

        out[name] = {"value": disp, "flag": None}

    return out


def _draw_page_bg(canvas, doc):
    """Full-page background synced with web app dark theme."""
    canvas.saveState()
    width, height = A4

    # Base dark background
    canvas.setFillColor(colors.HexColor("#020617"))
    canvas.rect(0, 0, width, height, stroke=0, fill=1)

    # Top band (slightly lighter navy, hint of header)
    canvas.setFillColor(colors.HexColor("#0B1120"))
    band_height = height * 0.18
    canvas.rect(0, height - band_height, width, band_height, stroke=0, fill=1)

    canvas.restoreState()


def build_jump_report_pdf(req: PdfReportRequest) -> bytes:
    """Build a jump report PDF inspired by the desktop dialog layout."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=36, rightMargin=36, topMargin=40, bottomMargin=36)

    styles = getSampleStyleSheet()
    body = styles["BodyText"]
    body.fontSize = 9
    body.leading = 11

    title_style = styles["Heading1"]
    title_style.fontSize = 16
    title_style.leading = 18
    # Match web app accent color (cyan/electric blue on dark)
    title_style.textColor = colors.HexColor("#00D9FF")

    subtitle_style = ParagraphStyle(
        "subtitle",
        parent=body,
        fontSize=9,
        leading=11,
        textColor=colors.HexColor("#9CA3AF"),
    )

    kpi_big = ParagraphStyle(
        "kpi_big",
        parent=body,
        fontSize=9,
        leading=11,
        textColor=colors.white,
    )

    kpi_small = ParagraphStyle(
        "kpi_small",
        parent=body,
        fontSize=8,
        leading=10,
        textColor=colors.white,
    )

    story = []

    # Header
    title = f"{req.test_name or 'Jump Test'} — Report"
    story.append(Paragraph(title, title_style))

    subtitle_parts = ["Sportify AI — Ai Tests v1.0"]
    if req.athlete_name:
        subtitle_parts.append(f"Athlete: {req.athlete_name}")
    subtitle_parts.append(f"Generated at: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    story.append(Paragraph(" | ".join(subtitle_parts), subtitle_style))
    story.append(Spacer(1, 10))

    jumps = req.jumps or []
    k = _compute_kpis(jumps)

    # KPI row (similar feeling to desktop PDF)
    kpi_data = [[
        Paragraph(f"<b>Total Jumps</b><br/>{int(k['total'])}", kpi_big),
        Paragraph(f"<b>Avg Flight</b><br/>{k['avg_air']:.3f} s" if k["total"] else "<b>Avg Flight</b><br/>—", kpi_big),
        Paragraph(f"<b>Best Flight</b><br/>{k['best_air']:.3f} s" if k["total"] else "<b>Best Flight</b><br/>—", kpi_big),
        Paragraph(f"<b>CV Air</b><br/>{k['cv_air']:.1f} %" if k["total"] else "<b>CV Air</b><br/>—", kpi_big),
        Paragraph(f"<b>Avg Height</b><br/>{k['avg_h']:.1f} cm" if k["avg_h"] > 0 else "<b>Avg Height</b><br/>—", kpi_big),
        Paragraph(f"<b>Best Height</b><br/>{k['best_h']:.1f} cm" if k["best_h"] > 0 else "<b>Best Height</b><br/>—", kpi_big),
        Paragraph(f"<b>Pace</b><br/>{k['pace']:.1f} j/min" if k["pace"] > 0 else "<b>Pace</b><br/>—", kpi_big),
    ]]

    col_w = doc.width / 7.0
    kpi_table = Table(kpi_data, colWidths=[col_w] * 7, hAlign="CENTER")
    kpi_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#020617")),
        ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#00D9FF")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#1E293B")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(kpi_table)
    story.append(Spacer(1, 8))

    # Simple bar chart for per-jump height & flight time (first page)
    try:
        if jumps:
            chart_width = doc.width
            chart_height = 140
            d = Drawing(chart_width, chart_height)

            # chart background
            d.add(Rect(0, 0, chart_width, chart_height, fillColor=colors.HexColor("#020617"), strokeColor=None))

            # Safely cast values and ignore completely invalid ones
            heights = [float(getattr(j, "height_cm", 0.0) or 0.0) for j in jumps]
            flights = [float(getattr(j, "flight_time_s", 0.0) or 0.0) for j in jumps]
            n = len(heights)

            if n > 0:
                max_h = max(heights) if any(h > 0 for h in heights) else 1.0

                bar_gap = 4.0
                bar_width = max(6.0, (chart_width - (n + 1) * bar_gap) / max(1, n))
                max_bar_h = chart_height - 40  # leave room for labels

                height_labels: List[Dict[str, Any]] = []

                for idx, (h_val, f_val) in enumerate(zip(heights, flights), start=1):
                    # normalized height
                    norm = (h_val / max_h) if max_h > 0 else 0.0
                    bar_h = max_bar_h * max(0.0, min(1.0, norm))
                    x = bar_gap + (idx - 1) * (bar_width + bar_gap)
                    y = 18

                    # bar
                    d.add(
                        Rect(
                            x,
                            y,
                            bar_width,
                            bar_h,
                            fillColor=colors.HexColor("#00D9FF"),
                            strokeColor=colors.HexColor("#020617"),
                        )
                    )

                    # flight time on top of bar
                    ft_label = f"{f_val:.3f}s"
                    d.add(
                        String(
                            x + bar_width / 2.0,
                            y + bar_h + 6,
                            ft_label,
                            textAnchor="middle",
                            fillColor=colors.HexColor("#E5E7EB"),
                            fontSize=7,
                        )
                    )

                    # height inside bar (rotated 90 degrees in the center)
                    h_label = f"{h_val:.1f}cm"
                    label_x = x + bar_width / 2.0
                    label_y = y + (bar_h / 2.0 if bar_h > 0 else y + 8)
                    height_labels.append(
                        {
                            "x": label_x,
                            "y": label_y,
                            "text": h_label,
                            "angle": 90,  # rotate 90 degrees
                            "font_size": 7,
                            "color_hex": "#020617",
                        }
                    )

                story.append(DrawingFlowable(d, labels=height_labels))
                story.append(Spacer(1, 8))
    except Exception as chart_err:
        print("[PDF] Chart build error:", chart_err)

    # Extra formulas section using desktop logic
    extra_formulas = {}
    if jumps:
        extra_formulas = _compute_extra_formulas_for_api(
            jumps=jumps,
            body_weight=req.body_weight_kg or 75.0,
        )

        if extra_formulas:
            order = [
                "Jump frequency (Hz)",
                "Bosco power (W/kg)",
                "Mean flight time (s)",
                "Mean contact time (s)",
                "RSI",
                "RFT (Flight/Contact)",
                "Fatigue (%)",
                "Performance preserve (%)",
                "Height drop (%)",
                "Rhythm stability",
                "CV Air (%)",
                "Takeoff velocity (m/s)",
                "Acceleration (m/s²)",
                "Effective force (N)",
                "Instant power (W)",
                "JPI (Jump Performance Index)",
                "MQI (Movement Quality Index)",
            ]

            def fmt_cell(v: Any) -> str:
                if v in ("", None):
                    return "—"
                return str(v)

            metrics_list = []
            for name in order:
                meta = extra_formulas.get(name)
                if not meta:
                    continue
                value = meta.get("value", "")
                metrics_list.append((name, fmt_cell(value)))

            formula_rows = []
            for i in range(0, len(metrics_list), 2):
                left = metrics_list[i]
                right = metrics_list[i + 1] if i + 1 < len(metrics_list) else ("", " ")

                l_name, l_val = left
                r_name, r_val = right

                formula_rows.append([
                    Paragraph(f"<b>{l_name}</b>", kpi_small) if l_name else Paragraph("", kpi_small),
                    Paragraph(l_val, kpi_small),
                    Paragraph(f"<b>{r_name}</b>", kpi_small) if r_name else Paragraph("", kpi_small),
                    Paragraph(r_val, kpi_small),
                ])

            if formula_rows:
                formula_table = Table(
                    formula_rows,
                    hAlign="CENTER",
                    colWidths=[
                        doc.width * 0.28,
                        doc.width * 0.22,
                        doc.width * 0.28,
                        doc.width * 0.22,
                    ],
                )
                formula_table.setStyle(
                    TableStyle(
                        [
                            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#1E293B")),
                            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                            ("LEFTPADDING",  (0, 0), (-1, -1), 8),
                            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                            ("TOPPADDING",   (0, 0), (-1, -1), 6),
                            ("BOTTOMPADDING",(0, 0), (-1, -1), 6),
                            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                            ("BACKGROUND", (0, 0), (-1, -1),  colors.HexColor("#020617")),
                            ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
                            ("FONTNAME",  (0, 0), (-1, -1), "Helvetica"),
                        ]
                    )
                )

                story.append(formula_table)
                story.append(Spacer(1, 10))

    # Per-jump table
    table_data = [["#", "Flight (s)", "Height (cm)"]]
    for i, j in enumerate(jumps, start=1):
        table_data.append([
            i,
            f"{j.flight_time_s:.3f}",
            f"{j.height_cm:.1f}",
        ])

    def build_perjump_table(rows):
        tbl = Table(
            rows,
            colWidths=[doc.width * 0.15, doc.width * 0.35, doc.width * 0.5],
            hAlign="CENTER",
        )
        tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#00D9FF")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#020617")),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#1E293B")),
            ("BOX", (0, 0), (-1, -1), 1.0, colors.HexColor("#00D9FF")),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1),
             [colors.HexColor("#020617"), colors.HexColor("#0B1120")]),
            ("TEXTCOLOR", (0, 1), (-1, -1), colors.HexColor("#E5E7EB")),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        return tbl

    # اگر بیش از 16 پرش داریم، تیبل را به دو بخش تقسیم کن تا خواناتر شود
    if len(jumps) > 16:
        first_block = table_data[:17]  # header + 16 rows
        second_block = [table_data[0]] + table_data[17:]  # header + بقیه

        story.append(Spacer(1, 4))
        story.append(build_perjump_table(first_block))
        story.append(Spacer(1, 6))
        story.append(build_perjump_table(second_block))
    else:
        perjump_table = build_perjump_table(table_data)
        story.append(Spacer(1, 4))
        story.append(perjump_table)

    # Put apex snapshots on a new page
    story.append(PageBreak())

    # Per-jump apex gallery (web snapshots)
    include_snaps = bool(getattr(req, "include_snapshots", True))
    snaps = [j for j in jumps if include_snaps and j.apex_png_b64]
    if snaps:
        # کمتر فاصله از بالا تا بتوان عکس‌های بیشتری جا داد
        story.append(Spacer(1, 6))
        story.append(Paragraph("Per-jump apex snapshots", subtitle_style))
        story.append(Spacer(1, 4))

        # Show all available snapshots, 4 cards per row
        cards = snaps

        # 4 cards per row
        rows_tbl = []
        for i in range(0, len(cards), 4):
            row_cells = []
            for j_item in cards[i:i+4]:
                img_cell = Paragraph("No image", body)
                try:
                    data = j_item.apex_png_b64 or ""
                    if data.startswith("data:image"):
                        data = data.split(",", 1)[1]
                    raw = base64.b64decode(data)

                    # Downscale snapshot to reduce PDF size if Pillow is available
                    if PILImage is not None:
                        pil_img = PILImage.open(io.BytesIO(raw))
                        pil_img = pil_img.convert("RGB")
                        pil_img.thumbnail((640, 360))  # cap resolution
                        buf_img = io.BytesIO()
                        pil_img.save(buf_img, format="JPEG", quality=70, optimize=True)
                        buf_img.seek(0)
                        img_source = buf_img
                    else:
                        img_source = io.BytesIO(raw)

                    from reportlab.platypus import Image  # local import to avoid top clutter
                    # Smaller width so 4 کارت در هر ردیف جا شود
                    card_col_w = doc.width / 4.0 - 6
                    img = Image(img_source, width=card_col_w, height=card_col_w * 9 / 16.0)
                    img_cell = img
                except Exception:
                    img_cell = Paragraph("Image error", body)

                idx = jumps.index(j_item) + 1
                snap_desc_style = ParagraphStyle(
                    "snap_desc",
                    parent=body,
                    fontSize=8,
                    leading=10,
                    textColor=colors.HexColor("#E5E7EB"),
                )
                desc = Paragraph(
                    f"<b>Jump #{idx}</b><br/>"
                    f"Flight: {j_item.flight_time_s:.3f} s<br/>"
                    f"Height: {j_item.height_cm:.1f} cm",
                    snap_desc_style,
                )

                card_tbl = Table(
                    [[img_cell], [desc]],
                    colWidths=[doc.width / 4.0 - 6],
                )
                card_tbl.setStyle(TableStyle([
                    ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#1E293B")),
                    ("BACKGROUND", (0, 0), (0, 0), colors.HexColor("#020617")),
                    ("BACKGROUND", (0, 1), (0, 1), colors.HexColor("#0B1120")),
                    # پدینگ کمتر برای جا دادن ردیف‌های بیشتر
                    ("LEFTPADDING", (0, 0), (-1, -1), 2),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 2),
                    ("TOPPADDING", (0, 0), (-1, -1), 2),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                    ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ]))
                row_cells.append(card_tbl)

            # pad last row to full width (4 ستون)
            while len(row_cells) < 4:
                row_cells.append("")

            rows_tbl.append(row_cells)

        gallery = Table(rows_tbl, colWidths=[doc.width / 4.0 - 6] * 4, hAlign="CENTER")
        gallery.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 2),
            ("RIGHTPADDING", (0, 0), (-1, -1), 2),
            ("TOPPADDING", (0, 0), (-1, -1), 1),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ]))
        story.append(gallery)

    doc.build(story, onFirstPage=_draw_page_bg, onLaterPages=_draw_page_bg)
    buf.seek(0)
    return buf.read()

# =========================================================================
# API Routes (باید قبل از Mount کردن فایل‌های استاتیک باشند)
# =========================================================================

@app.get("/api/health")
async def health_check():
    """بررسی وضعیت سرور و فایل‌های مدیاپایپ"""
    wasm_dir = os.path.join(mp_dir, "wasm")

    files_status = {}
    required = [
        ("vision_bundle.mjs", mp_dir),
        ("pose_landmarker_lite.task", mp_dir),
        ("vision_wasm_internal.js", wasm_dir),
        ("vision_wasm_internal.wasm", wasm_dir),
    ]

    all_ok = True
    for fname, fdir in required:
        fpath = os.path.join(fdir, fname)
        exists = os.path.exists(fpath)
        size = os.path.getsize(fpath) if exists else 0
        files_status[fname] = {"exists": exists, "size_kb": round(size / 1024, 1)}
        if not exists:
            all_ok = False

    return JSONResponse(content={
        "status": "healthy" if all_ok else "missing_files",
        "service": "AI Body Processing",
        "version": "3.1",
        "timestamp": datetime.now().isoformat(),
        "mediapipe_files": files_status
    })


@app.post("/api/report/pdf")
async def generate_jump_report(req: PdfReportRequest):
    """Generate jump test PDF using ReportLab, inspired by desktop dialog."""
    try:
        pdf_bytes = build_jump_report_pdf(req)
    except Exception as e:
        # Fallback error response
        return JSONResponse(
            status_code=500,
            content={"error": "failed_to_build_pdf", "detail": str(e)},
        )

    filename = f"jump_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/jump-results")
async def submit_jump_results(req: JumpResultsSubmitRequest) -> Dict[str, Any]:
    """
    Submit jump test results to Sportify Academy JumpingTest API (same format as desktop).
    Proxies to POST {API_BASE_URL}/JumpingTest with Bearer token.
    """
    first_name = (req.first_name or "").strip()
    last_name = (req.last_name or "").strip()
    if not first_name and not last_name and req.athlete_name:
        parts = (req.athlete_name or "").strip().split(None, 1)
        first_name = parts[0] if parts else ""
        last_name = parts[1] if len(parts) > 1 else ""
    user_id = (req.user_id or "").strip()

    body = build_jumping_test_api_body(
        req.jumps,
        user_id,
        first_name,
        last_name,
        req.weight_kg,
        req.test_duration_seconds,
    )
    if not body or not body.get("jumps"):
        raise HTTPException(status_code=400, detail="No valid jumps to send")

    if not ENABLE_REMOTE_API:
        return {"ok": False, "error": "remote_api_disabled", "detail": "Sportify API is disabled."}

    token = _api_login_get_token()
    if not token:
        raise HTTPException(status_code=502, detail="Could not obtain API token")

    url = API_BASE_URL.rstrip("/") + "/JumpingTest"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }
    try:
        session = requests.Session()
        session.mount("https://", SSLContextAdapter())
        resp = session.post(url, json=body, headers=headers, timeout=30)
        return {
            "ok": 200 <= resp.status_code < 300,
            "status_code": resp.status_code,
            "response_text": resp.text[:2000] if resp.text else "",
        }
    except Exception as e:
        print(f"[WARN] JumpingTest POST failed: {e}")
        raise HTTPException(status_code=502, detail=f"Request to Sportify Academy failed: {e}")


@app.get("/")
async def serve_index():
    """نمایش صفحه اصلی"""
    index_path = os.path.join(BASE_DIR, "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse("<h1>Error: index.html not found!</h1>", status_code=404)

# =========================================================================
# Static Files (باید بعد از تمام روت‌های API باشد)
# =========================================================================
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# =========================================================================
# Run Server
# =========================================================================
if __name__ == "__main__":
    print()
    print("=" * 60)
    print("  🚀 AI Body Processing Server Starting...")
    print("=" * 60)
    print(f"  📂 Base Directory: {BASE_DIR}")
    print(f"  🌐 Main Page:      http://localhost:8000")
    print(f"  📡 API Health:     http://localhost:8000/api/health")
    print("=" * 60)
    print("  Press Ctrl+C to stop the server.")
    print()

    # غیرفعال کردن reload برای اطمینان از پایداری در اجراهای معمولی
    uvicorn.run(app, host="0.0.0.0", port=8000)
