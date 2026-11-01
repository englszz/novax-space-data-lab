#!/usr/bin/env python3
"""Build a traceable catalog and preview image from the real SPHEREx run.

Reads the outputs produced by ``first_pass_spherex.py`` and
``crossmatch_skybot.py`` and writes:

- ``DATOS/real_residual_catalog.json``: one record per residual detection,
  with the FITS file, observation dates, DOI and SkyBoT association.
- ``DATOS/IRSA_FITS_D1/analysis/difference_preview.png``: the real
  difference map, resampled to the viewer canvas.

No detection is promoted to a Planet X candidate. The three classes are
``conocido`` (positional SkyBoT association), ``fuente`` (residual on a
pixel flagged as a mapped source by SPHEREx) and ``residuo`` (unassociated
residual pending review).
"""

from __future__ import annotations

import json
import math
import struct
import zlib
from pathlib import Path

import numpy as np
from astropy.io import fits
from scipy.ndimage import gaussian_filter, zoom

ROOT = Path(__file__).resolve().parents[1]
FITS_DIR = ROOT / "DATOS" / "IRSA_FITS_D1"
ANALYSIS_DIR = FITS_DIR / "analysis"
CATALOG_PATH = ROOT / "DATOS" / "real_residual_catalog.json"
META_PATH = ROOT / "DATOS" / "real_residual_catalog.meta.json"
PREVIEW_PATH = ANALYSIS_DIR / "difference_preview.png"
PREVIEW_WIDTH = 1392
PREVIEW_HEIGHT = 500
DOI = "10.26131/IRSA652"
HIGH_CONFIDENCE_ARCSEC = 5.0
MAX_EPHEMERIS_ERROR_ARCSEC = 1.0


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def build_skybot_index(crossmatch: dict) -> dict[tuple[str, int], dict]:
    """Map (epoch, order) to the match row, preserving detection order."""
    index: dict[tuple[str, int], dict] = {}
    for epoch in ("epoch1", "epoch2"):
        for order, match in enumerate(crossmatch["epochs"][epoch]["matches"]):
            index[(epoch, order)] = match
    return index


def classify(match: dict | None, detection: dict) -> tuple[str, str]:
    if match:
        obj = match["nearest_skybot_object"]
        error = obj.get("ephemeris_error_arcsec")
        if (
            match["separation_arcsec"] <= HIGH_CONFIDENCE_ARCSEC
            and error is not None
            and float(error) <= MAX_EPHEMERIS_ERROR_ARCSEC
        ):
            return (
                "conocido",
                f"Asociación con objeto conocido (SkyBoT): {obj.get('name')}",
            )
    if detection["mp_source_flag_epoch1"] or detection["mp_source_flag_epoch2"]:
        return (
            "fuente",
            "Residuo sobre una fuente marcada por SPHEREx",
        )
    return (
        "residuo",
        "Residuo sin asociación confirmada (revisión pendiente)",
    )


def write_png(path: Path, rgb: np.ndarray) -> None:
    """Minimal RGB PNG writer (no Pillow/matplotlib required)."""
    height, width, channels = rgb.shape
    if channels != 3:
        raise ValueError("Expected an RGB array")
    raw = b"".join(b"\x00" + rgb[row].tobytes() for row in range(height))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def build_preview(
    residual: np.ndarray, valid: np.ndarray, sigma: float, median: float
) -> None:
    # Smooth only the display layer (not the detections) to suppress pixel
    # noise. Normalize by the smoothed validity mask to avoid dark mask edges.
    weights = gaussian_filter(valid.astype(np.float32), sigma=2.0)
    centered = np.where(valid, residual - median, 0.0).astype(np.float32)
    smoothed = gaussian_filter(centered, sigma=2.0) / np.maximum(weights, 1e-6)
    smoothed[weights < 0.85] = np.nan
    filled = np.nan_to_num(smoothed, nan=0.0)
    zoom_factors = (PREVIEW_HEIGHT / residual.shape[0], PREVIEW_WIDTH / residual.shape[1])
    small = zoom(filled, zoom_factors, order=1)[:PREVIEW_HEIGHT, :PREVIEW_WIDTH]
    if small.shape != (PREVIEW_HEIGHT, PREVIEW_WIDTH):
        padded = np.zeros((PREVIEW_HEIGHT, PREVIEW_WIDTH), dtype=np.float32)
        padded[: small.shape[0], : small.shape[1]] = small
        small = padded

    # Smoothing reduces the display noise; use a smaller diverging scale so
    # compact positive/negative residual structure remains visible.
    scale = max(float(sigma) * 0.6, 1e-12)
    t = np.tanh(small / (3.0 * scale))
    t = np.clip(t, -1.0, 1.0)

    negative = np.array([28, 86, 196], dtype=np.float32)
    zero = np.array([5, 8, 20], dtype=np.float32)
    positive = np.array([244, 81, 46], dtype=np.float32)

    rgb = np.empty((*t.shape, 3), dtype=np.float32)
    neg_mask = t < 0
    pos_mask = t >= 0
    rgb[neg_mask] = zero + (negative - zero) * (-t[neg_mask][:, None])
    rgb[pos_mask] = zero + (positive - zero) * (t[pos_mask][:, None])
    write_png(PREVIEW_PATH, np.clip(rgb, 0, 255).astype(np.uint8))


def main() -> None:
    summary = load_json(ANALYSIS_DIR / "summary.json")
    detections = load_json(ANALYSIS_DIR / "residual_detections.json")["detections"]
    crossmatch = load_json(ANALYSIS_DIR / "skybot_crossmatch.json")
    skybot_index = build_skybot_index(crossmatch)

    with fits.open(ANALYSIS_DIR / "difference_map.fits", memmap=True) as hdul:
        residual = np.asarray(hdul["DIFF"].data, dtype=np.float32)
        uncertainty = np.asarray(hdul["UNCERTAINTY"].data, dtype=np.float32)
        valid = np.asarray(hdul["VALID"].data).astype(bool)

    review_path = ANALYSIS_DIR / "psf_signal_review.json"
    review_document = load_json(review_path) if review_path.exists() else {}
    review = review_document.get("records", {})

    median = float(summary["residual_median_mjy_sr_before_centering"])
    sigma = float(summary["residual_sigma_clipped_mjy_sr"])
    epochs = {row["file"]: row for row in summary["epochs"]}
    epoch1_file = summary["epochs"][0]["file"]
    epoch2_file = summary["epochs"][1]["file"]
    date1 = summary["epochs"][0]["date_obs"]
    date2 = summary["epochs"][1]["date_obs"]

    projection = {
        row["name"]: row
        for row in crossmatch.get("epoch1_high_confidence_object_motion_projections", [])
    }

    records = []
    counts = {"conocido": 0, "fuente": 0, "residuo": 0}
    positive_order = 0
    negative_order = 0

    for detection in detections:
        polarity = detection["polarity"]
        if polarity == "negative":
            epoch, order = "epoch1", negative_order
            negative_order += 1
        else:
            epoch, order = "epoch2", positive_order
            positive_order += 1

        match = skybot_index.get((epoch, order))
        clase, estado = classify(match, detection)
        counts[clase] += 1
        signed_snr = float(detection["peak_significance"])
        snr = abs(signed_snr)

        obj = match["nearest_skybot_object"] if match else None
        skybot_name = obj.get("name") if obj else None
        motion = projection.get(skybot_name) if skybot_name else None

        record_id = f"SPX-D1-{polarity[0].upper()}{len(records) + 1:04d}"
        records.append(
            {
                "id": record_id,
                "clase": clase,
                "estado": estado,
                "coordenadas": {
                    "ra": round(float(detection["ra_deg"]), 7),
                    "dec": round(float(detection["dec_deg"]), 7),
                },
                "pixel_pos": {
                    "x": round(float(detection["x_pixel"]), 3),
                    "y": round(float(detection["y_pixel"]), 3),
                },
                "brillo_snr": round(float(snr), 2),
                "mision": "SPHEREx D1 · Level 2 QR2",
                "doi_fuente": DOI,
                "procedencia": {
                    "fits_epoca_1": epoch1_file,
                    "fits_epoca_2": epoch2_file,
                    "fecha_epoca_1_utc": date1,
                    "fecha_epoca_2_utc": date2,
                    "detector": "D1",
                    "polaridad": polarity,
                    "umbral_deteccion_sigma": detection["detection_threshold_sigma"],
                    "residual_mediana_mjy_sr": median,
                    "residual_sigma_mjy_sr": sigma,
                    "snr_firmado": round(float(signed_snr), 2),
                    "incertidumbre_local_mjy_sr": round(float(uncertainty[
                        int(round(detection["y_pixel"])),
                        int(round(detection["x_pixel"])),
                    ]), 8),
                    "mp_source_epoca_1": detection["mp_source_flag_epoch1"],
                    "mp_source_epoca_2": detection["mp_source_flag_epoch2"],
                    "skybot_objeto": skybot_name if clase == "conocido" else None,
                    "skybot_mas_cercano": skybot_name,
                    "skybot_separacion_arcsec": (
                        match["separation_arcsec"] if match else None
                    ),
                    "skybot_error_efemerides_arcsec": (
                        obj.get("ephemeris_error_arcsec") if obj else None
                    ),
                    "skybot_proyeccion_epoca_2": motion,
                    "nota": (
                        "Residuo de diferencia entre dos épocas SPHEREx D1. "
                        "No es una confirmación de objeto ni de Planeta X."
                    ),
                },
                "revision_epsf": review.get(record_id),
            }
        )

    CATALOG_PATH.write_text(
        json.dumps(records, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    meta = {
        "status": "catálogo real de residuos; sin candidato a Planeta X",
        "created_from": str(ANALYSIS_DIR),
        "doi": DOI,
        "epochs": summary["epochs"],
        "method": summary["method"],
        "preview_note": (
            "La imagen del visor se centra y suaviza solo para facilitar la lectura; "
            "el catálogo de posiciones se calcula con la diferencia sin suavizar."
        ),
        "counts": {"total": len(records), **counts},
        "known_association": next(
            (r["procedencia"]["skybot_objeto"] for r in records if r["clase"] == "conocido"),
            None,
        ),
        "known_association_projection": projection,
        "spectral_compatibility": summary.get("spectral_compatibility"),
        "epsf_review": (
            review_document.get("counts")
            if review_document
            else None
        ),
        "caveat": (
            "Criba inicial con varianza diagonal propagada; no incluye covarianza de "
            "remuestreo ni incertidumbre del fondo zodiacal, fotometría PSF o ajuste "
            "astrométrico refinado. No demuestra objetos nuevos. Un candidato a Planeta X "
            "requiere más épocas y movimiento comprobable."
        ),
    }
    META_PATH.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    build_preview(residual, valid, sigma, median)

    print(json.dumps({"catalog": str(CATALOG_PATH), "meta": str(META_PATH), "preview": str(PREVIEW_PATH), "counts": meta["counts"]}, indent=2))


if __name__ == "__main__":
    main()
