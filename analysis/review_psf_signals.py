#!/usr/bin/env python3
"""Fit the official SPHEREx D1 ePSF to every residual in the two raw epochs.

This is a source-level review of the difference-screen positions, not a search
or classification of Planet X candidates. It measures the same sky coordinate
in each original image, records local wavelength/ePSF provenance, and writes
small original-image cutouts for the unassociated residuals and controls.
"""

from __future__ import annotations

import json
import math
import struct
import zlib
from pathlib import Path

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS
from photutils.psf import ImagePSF


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "DATOS" / "IRSA_FITS_D1"
ANALYSIS_DIR = DATA_DIR / "analysis"
CATALOG_PATH = ROOT / "DATOS" / "real_residual_catalog.json"
EPSF_PATH = ANALYSIS_DIR / "epsf_D1_spx_cal-epsf-v1-2026-191.fits"
OUTPUT_PATH = ANALYSIS_DIR / "psf_signal_review.json"
CUTOUT_DIR = ANALYSIS_DIR / "psf_cutouts"
STAMP_SIZE = 13
MIN_VALID_PIXELS = 100
BAD_FLAG_NAMES = (
    "TRANSIENT", "OVERFLOW", "SUR_ERROR", "PHANTOM", "REFERENCE",
    "NONFUNC", "DICHROIC", "MISSING_DATA", "HOT", "COLD", "PHANMISS",
    "NONLINEAR", "PERSIST", "OUTLIER",
)


def json_scalar(value):
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    return value


def wave_at_pixel(hdul: fits.HDUList, x: float, y: float) -> tuple[float, float]:
    """Bilinearly evaluate the embedded wavelength lookup table.

    The table's X/Y control points use FITS 1-based detector coordinates;
    Astropy's WCS returns 0-based coordinates.
    """
    row = hdul["WCS-WAVE"].data[0]
    xs = np.asarray(row["X"], dtype=float)
    ys = np.asarray(row["Y"], dtype=float)
    values = np.asarray(row["VALUES"], dtype=float)
    px, py = x + 1.0, y + 1.0
    ix = int(np.clip(np.searchsorted(xs, px) - 1, 0, len(xs) - 2))
    iy = int(np.clip(np.searchsorted(ys, py) - 1, 0, len(ys) - 2))
    tx = np.clip((px - xs[ix]) / (xs[ix + 1] - xs[ix]), 0, 1)
    ty = np.clip((py - ys[iy]) / (ys[iy + 1] - ys[iy]), 0, 1)
    interpolated = (
        (1 - ty) * ((1 - tx) * values[iy, ix] + tx * values[iy, ix + 1])
        + ty * ((1 - tx) * values[iy + 1, ix] + tx * values[iy + 1, ix + 1])
    )
    return float(interpolated[0]), float(interpolated[1])


def bad_mask_for(flags_hdu: fits.ImageHDU) -> int:
    header = flags_hdu.header
    return sum(
        1 << int(header[f"MP_{name}"])
        for name in BAD_FLAG_NAMES
        if f"MP_{name}" in header
    )


def get_epsf_model(table, x: float, y: float):
    """Select the nearest spatial ePSF zone and build its oversampled model."""
    centers = np.column_stack((table["XCENTER"], table["YCENTER"])).astype(float)
    zone_index = int(np.argmin(np.sum((centers - [x, y]) ** 2, axis=1)))
    row = table[zone_index]
    model = ImagePSF(
        data=np.asarray(row["EPSF"], dtype=float),
        oversampling=(5, 5),
    )
    return model, row, zone_index


def render_stamp(model: ImagePSF, x0: float, y0: float):
    half = (STAMP_SIZE - 1) / 2
    x_start = int(np.floor(x0 - half))
    y_start = int(np.floor(y0 - half))
    x = x_start + np.arange(STAMP_SIZE, dtype=float)
    y = y_start + np.arange(STAMP_SIZE, dtype=float)
    yy, xx = np.meshgrid(y, x, indexing="ij")
    stamp = np.asarray(model.evaluate(xx, yy, flux=1.0, x_0=x0, y_0=y0), dtype=float)
    total = float(np.sum(stamp))
    if not np.isfinite(total) or total <= 0:
        return None, x_start, y_start
    return stamp / total, x_start, y_start


def fit_at_position(epoch: dict, epsf_table, sky: SkyCoord) -> dict:
    x0, y0 = map(float, epoch["wcs"].world_to_pixel(sky))
    height, width = epoch["image"].shape
    result = {
        "inside_image": bool(0 <= x0 < width and 0 <= y0 < height),
        "x_pixel": x0,
        "y_pixel": y0,
    }
    if not result["inside_image"] or x0 < 7 or y0 < 7 or x0 >= width - 7 or y0 >= height - 7:
        result["fit_status"] = "fuera del campo o demasiado cerca del borde"
        return result

    wavelength, bandwidth = wave_at_pixel(epoch["hdul"], x0, y0)
    model, zone, zone_index = get_epsf_model(epsf_table, x0, y0)
    psf, x_start, y_start = render_stamp(model, x0, y0)
    if psf is None:
        result["fit_status"] = "ePSF inválida"
        return result

    y_slice = slice(y_start, y_start + STAMP_SIZE)
    x_slice = slice(x_start, x_start + STAMP_SIZE)
    data = epoch["science"][y_slice, x_slice].astype(float)
    variance = epoch["variance"][y_slice, x_slice].astype(float)
    flags = epoch["flags"][y_slice, x_slice]
    valid = (
        np.isfinite(data)
        & np.isfinite(variance)
        & (variance > 0)
        & ((flags & epoch["bad_mask"]) == 0)
    )
    if int(valid.sum()) < MIN_VALID_PIXELS:
        result["fit_status"] = "demasiados píxeles enmascarados"
        result["valid_pixel_count"] = int(valid.sum())
        return result

    yy, xx = np.indices(data.shape, dtype=float)
    xx = xx + x_start - x0
    yy = yy + y_start - y0
    design = np.column_stack((psf[valid], np.ones(valid.sum()), xx[valid], yy[valid]))
    inverse_sigma = 1.0 / np.sqrt(variance[valid])
    weighted_design = design * inverse_sigma[:, None]
    weighted_data = data[valid] * inverse_sigma
    coeffs, _, _, _ = np.linalg.lstsq(weighted_design, weighted_data, rcond=None)
    normal = weighted_design.T @ weighted_design
    covariance = np.linalg.pinv(normal)
    model_data = design @ coeffs
    residual = data[valid] - model_data
    chi2 = float(np.sum((residual / np.sqrt(variance[valid])) ** 2))
    dof = max(1, int(valid.sum()) - len(coeffs))
    flux_error = float(np.sqrt(max(covariance[0, 0], 0)))
    flux = float(coeffs[0])

    result.update({
        "fit_status": "ok",
        "flux_psf_mjy_sr_pixel": flux,
        "flux_error_mjy_sr_pixel": flux_error,
        "psf_snr": flux / flux_error if flux_error > 0 else None,
        "chi2_reduced": chi2 / dof,
        "valid_pixel_count": int(valid.sum()),
        "wavelength_um": wavelength,
        "bandwidth_um": bandwidth,
        "epsf_cwave_um": float(zone["CWAVE"]),
        "epsf_cband_um": float(zone["CBAND"]),
        "epsf_neff": float(zone["NEFF_MEAN"]),
        "epsf_zone_row": zone_index,
        "epsf_zone_xy": [int(zone["BINX"]), int(zone["BINY"])],
    })
    result["display_stamp"] = np.asarray(data, dtype=np.float32)
    return result


def srgb(gray: np.ndarray) -> np.ndarray:
    return np.repeat(np.clip(gray, 0, 255).astype(np.uint8)[..., None], 3, axis=2)


def write_png(path: Path, rgb: np.ndarray) -> None:
    height, width, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[row].tobytes() for row in range(height))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    )


def stretch_stamp(stamp: np.ndarray) -> np.ndarray:
    valid = stamp[np.isfinite(stamp)]
    if valid.size == 0:
        return np.zeros((*stamp.shape, 3), dtype=np.uint8)
    low, high = np.percentile(valid, [15, 99.7])
    if high <= low:
        high = low + 1e-6
    scaled = np.clip((stamp - low) / (high - low), 0, 1)
    scaled = np.power(scaled, 0.55)
    return srgb(scaled * 255)


def draw_crosshair(rgb: np.ndarray, color: tuple[int, int, int]) -> None:
    center = rgb.shape[0] // 2
    rgb[center, :, :] = color
    rgb[:, center, :] = color


def save_cutouts(objects: list[dict], outputs: dict[str, dict], difference: np.ndarray) -> None:
    CUTOUT_DIR.mkdir(parents=True, exist_ok=True)
    for obj in objects:
        result = outputs[obj["id"]]
        measurements = result["epochs"]
        panels = []
        for epoch_name, edge_color in (("epoch1", (80, 170, 255)), ("epoch2", (255, 110, 80))):
            stamp = measurements[epoch_name].get("display_stamp")
            if stamp is None:
                panel = np.zeros((STAMP_SIZE, STAMP_SIZE, 3), dtype=np.uint8)
            else:
                panel = stretch_stamp(stamp)
                draw_crosshair(panel, edge_color)
            panels.append(np.repeat(np.repeat(panel, 10, axis=0), 10, axis=1))

        reference_x = float(obj["pixel_pos"]["x"])
        reference_y = float(obj["pixel_pos"]["y"])
        half = STAMP_SIZE // 2
        x0, y0 = int(round(reference_x)) - half, int(round(reference_y)) - half
        diff_stamp = difference[
            max(0, y0):min(difference.shape[0], y0 + STAMP_SIZE),
            max(0, x0):min(difference.shape[1], x0 + STAMP_SIZE),
        ].astype(float)
        symmetric = np.nanpercentile(np.abs(diff_stamp), 99.5) if diff_stamp.size else 1
        symmetric = max(float(symmetric), 1e-12)
        t = np.clip(diff_stamp / symmetric, -1, 1)
        diff_rgb = np.zeros((*t.shape, 3), dtype=np.uint8)
        neg, pos = t < 0, t >= 0
        diff_rgb[neg] = (25, 75, 175) * (-t[neg][:, None]) + np.array([5, 8, 20]) * (1 + t[neg][:, None])
        diff_rgb[pos] = (230, 70, 45) * t[pos][:, None] + np.array([5, 8, 20]) * (1 - t[pos][:, None])
        diff_rgb = np.clip(diff_rgb, 0, 255).astype(np.uint8)
        if diff_rgb.shape == (STAMP_SIZE, STAMP_SIZE, 3):
            draw_crosshair(diff_rgb, (220, 220, 220))
        panels.append(np.repeat(np.repeat(diff_rgb, 10, axis=0), 10, axis=1))

        separator = np.full((STAMP_SIZE * 10, 4, 3), 50, dtype=np.uint8)
        canvas = np.concatenate((panels[0], separator, panels[1], separator, panels[2]), axis=1)
        write_png(CUTOUT_DIR / f"{obj['id']}_epoch1_epoch2_difference.png", canvas)


def main() -> None:
    if not EPSF_PATH.is_file():
        raise SystemExit(f"Missing official D1 ePSF calibration: {EPSF_PATH}")
    objects = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    fits_paths = sorted(DATA_DIR.glob("level2_*D1_spx_l2b-*.fits"))
    if len(fits_paths) != 2:
        raise SystemExit(f"Expected two D1 observations; found {len(fits_paths)}")

    with fits.open(EPSF_PATH, memmap=True) as epsf_hdul:
        epsf_table = epsf_hdul["EPSF"].data
        epsf_header = epsf_hdul["EPSF"].header
        if int(epsf_header["DETECTOR"]) != 1:
            raise SystemExit("The ePSF calibration is not for detector D1.")
        if (int(epsf_header["OVSMPX"]), int(epsf_header["OVSMPY"])) != (5, 5):
            raise SystemExit("Unexpected ePSF oversampling factors.")

        epochs = []
        for path in fits_paths:
            hdul = fits.open(path, memmap=True)
            flags_hdu = hdul["FLAGS"]
            image = np.asarray(hdul["IMAGE"].data, dtype=np.float32)
            zodi = np.asarray(hdul["ZODI"].data, dtype=np.float32)
            variance = np.asarray(hdul["VARIANCE"].data, dtype=np.float32)
            flags = np.asarray(flags_hdu.data, dtype=np.int32)
            epochs.append({
                "path": path,
                "hdul": hdul,
                "wcs": WCS(hdul["IMAGE"].header).celestial,
                "image": image,
                "science": image - zodi,
                "variance": variance,
                "flags": flags,
                "bad_mask": bad_mask_for(flags_hdu),
                "date_obs": hdul["IMAGE"].header["DATE-OBS"],
            })

        results: dict[str, dict] = {}
        for obj in objects:
            sky = SkyCoord(
                float(obj["coordenadas"]["ra"]) * u.deg,
                float(obj["coordenadas"]["dec"]) * u.deg,
                frame="icrs",
            )
            fitted = {
                "epoch1": fit_at_position(epochs[0], epsf_table, sky),
                "epoch2": fit_at_position(epochs[1], epsf_table, sky),
            }
            e1, e2 = fitted["epoch1"], fitted["epoch2"]
            contrast_snr = None
            wave_delta = None
            comparable = False
            if e1.get("fit_status") == "ok" and e2.get("fit_status") == "ok":
                denom = math.hypot(e1["flux_error_mjy_sr_pixel"], e2["flux_error_mjy_sr_pixel"])
                polarity_sign = 1 if obj["procedencia"]["polaridad"] == "positive" else -1
                if denom > 0:
                    contrast_snr = polarity_sign * (
                        e2["flux_psf_mjy_sr_pixel"] - e1["flux_psf_mjy_sr_pixel"]
                    ) / denom
                wave_delta = e2["wavelength_um"] - e1["wavelength_um"]
                allowed_delta = 0.5 * max(e1["bandwidth_um"], e2["bandwidth_um"])
                comparable = abs(wave_delta) <= allowed_delta

            results[obj["id"]] = {
                "classification": obj["clase"],
                "polarity": obj["procedencia"]["polaridad"],
                "sky_coordinates_deg": obj["coordenadas"],
                "source_flag_epoch1": obj["procedencia"]["mp_source_epoca_1"],
                "source_flag_epoch2": obj["procedencia"]["mp_source_epoca_2"],
                "catalog_peak_significance": obj["brillo_snr"],
                "epochs": fitted,
                "wavelength_delta_um": wave_delta,
                "wavelengths_comparable_within_half_band": comparable,
                "psf_contrast_snr_in_residual_direction": contrast_snr,
                "interpretation": (
                    "Fotometría ePSF en las dos imágenes originales; lectura pendiente"
                    if comparable else "No comparar amplitudes: posiciones fuera del campo o bandas incompatibles"
                ),
            }

        # Retain only a focused, reviewable subset of cutouts: all unassociated
        # and known residuals plus strongest source-flagged examples as controls.
        selected = [o for o in objects if o["clase"] in ("residuo", "conocido")]
        flagged = [o for o in objects if o["clase"] == "fuente"]
        selected += sorted(flagged, key=lambda o: o["brillo_snr"], reverse=True)[:2]
        with fits.open(ANALYSIS_DIR / "difference_map.fits", memmap=True) as diff_hdul:
            difference = np.asarray(diff_hdul["DIFF"].data, dtype=np.float32)
        save_cutouts(selected, results, difference)

        status_counts: dict[str, int] = {}
        unassociated = [results[o["id"]] for o in objects if o["clase"] == "residuo"]
        for row in results.values():
            e1, e2 = row["epochs"]["epoch1"], row["epochs"]["epoch2"]
            if e1.get("fit_status") == "ok" and e2.get("fit_status") == "ok" and row["wavelengths_comparable_within_half_band"]:
                contrast = row["psf_contrast_snr_in_residual_direction"]
                expected_epoch = "epoch2" if row["polarity"] == "positive" else "epoch1"
                expected_fit = row["epochs"][expected_epoch]
                if (
                    contrast is not None and contrast >= 5
                    and expected_fit["psf_snr"] >= 5
                    and expected_fit["chi2_reduced"] < 5
                ):
                    status = f"ePSF recupera una fuente puntual positiva en {expected_epoch}; compatible con el sentido del residuo"
                elif expected_fit["psf_snr"] < 0:
                    status = f"no corroborado: el ajuste ePSF da flujo negativo en {expected_epoch}, no una fuente puntual positiva"
                else:
                    status = "no corroborado como fuente puntual positiva en la época esperada"
            else:
                status = "no evaluable: ajuste ePSF incompleto o longitudes de onda incompatibles"
            row["review_status"] = status
            row["interpretation"] = status
            status_counts[status] = status_counts.get(status, 0) + 1

        unassociated_status_counts: dict[str, int] = {}
        for row in unassociated:
            status = row["review_status"]
            unassociated_status_counts[status] = unassociated_status_counts.get(status, 0) + 1

        output = {
            "status": "ePSF photometry at residual coordinates in original SPHEREx D1 images; not object confirmation",
            "method": {
                "calibration_file": EPSF_PATH.name,
                "calibration_url": "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr3/epsf/cal-epsf-v1-2026-191/1/epsf_D1_spx_cal-epsf-v1-2026-191.fits",
                "image_model": "IRSA ePSF calibration (21x21 spatial zones; 33x33 oversampled by 5); nearest zone selected at each epoch's detector pixel",
                "photometry": "weighted least-squares ePSF amplitude plus local tilted-plane background; uses each FITS VARIANCE and excludes bad quality bits",
                "wavelength": "embedded WCS-WAVE bilinearly interpolated at each original-image pixel; compare epoch amplitudes only within half the larger local bandwidth",
                "limits": "No fitted centroid search, no multi-source deblending, no correlated-noise covariance, and no orbit fit. A point-like difference remains only a transient/source candidate for follow-up.",
            },
            "counts": {
                "catalog_records_reviewed": len(objects),
                "unassociated_residuals": len(unassociated),
                "review_status_all_records": status_counts,
                "unassociated_review_status": unassociated_status_counts,
                "cutouts_written": len(selected),
            },
            "records": {
                object_id: {
                    **record,
                    "epochs": {
                        epoch_name: {
                            key: value for key, value in epoch_result.items()
                            if key != "display_stamp"
                        }
                        for epoch_name, epoch_result in record["epochs"].items()
                    },
                }
                for object_id, record in results.items()
            },
            "unassociated_summary": [
                {
                    "id": obj["id"],
                    "catalog_peak_significance": results[obj["id"]]["catalog_peak_significance"],
                    "polarity": results[obj["id"]]["polarity"],
                    "epoch1": {k: v for k, v in results[obj["id"]]["epochs"]["epoch1"].items() if k != "display_stamp"},
                    "epoch2": {k: v for k, v in results[obj["id"]]["epochs"]["epoch2"].items() if k != "display_stamp"},
                    "wavelength_delta_um": results[obj["id"]]["wavelength_delta_um"],
                    "psf_contrast_snr": results[obj["id"]]["psf_contrast_snr_in_residual_direction"],
                    "review_status": results[obj["id"]].get("review_status"),
                }
                for obj in objects if obj["clase"] == "residuo"
            ],
        }
        OUTPUT_PATH.write_text(json.dumps(output, indent=2, ensure_ascii=False, default=json_scalar), encoding="utf-8")
        for epoch in epochs:
            epoch["hdul"].close()
        print(json.dumps({"output": str(OUTPUT_PATH), "counts": output["counts"], "unassociated_summary": output["unassociated_summary"]}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
