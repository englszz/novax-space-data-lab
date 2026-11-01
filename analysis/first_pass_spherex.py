#!/usr/bin/env python3
"""First-pass, WCS-aligned comparison of two SPHEREx QR2 spectral images.

This produces residual maps and provisional detections for review. It does not
classify detections as asteroids, known objects, or Planet X candidates.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS
from photutils.detection import DAOStarFinder
from scipy.ndimage import map_coordinates
from scipy.interpolate import RegularGridInterpolator
from scipy.spatial import cKDTree


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "DATOS" / "IRSA_FITS_D1"
OUTPUT_DIR = DATA_DIR / "analysis"
BAD_FLAG_NAMES = (
    "TRANSIENT",
    "OVERFLOW",
    "SUR_ERROR",
    "PHANTOM",
    "REFERENCE",
    "NONFUNC",
    "DICHROIC",
    "MISSING_DATA",
    "HOT",
    "COLD",
    "PHANMISS",
    "NONLINEAR",
    "PERSIST",
    "OUTLIER",
)
DETECTION_THRESHOLD_SIGMA = 8.0
DAO_FWHM_PIXELS = 2.0
ROW_CHUNK = 128


def extension_array(hdul: fits.HDUList, name: str) -> np.ndarray:
    return np.asarray(hdul[name].data)


def resolve_flag_bits(header: fits.Header) -> dict[str, int]:
    return {
        name: int(header[f"MP_{name}"])
        for name in BAD_FLAG_NAMES
        if f"MP_{name}" in header
    }


def wavelength_interpolators(hdul: fits.HDUList):
    """Build interpolators for the local wavelength and bandpass maps.

    SPHEREx QR2 stores these values on a sparse detector grid in WCS-WAVE.
    The table coordinates are FITS 1-based pixel centers; the interpolators
    below use Astropy's 0-based pixel convention.
    """
    row = hdul["WCS-WAVE"].data[0]
    x = np.asarray(row["X"], dtype=float).reshape(-1) - 1.0
    y = np.asarray(row["Y"], dtype=float).reshape(-1) - 1.0
    values = np.asarray(row["VALUES"], dtype=float)
    wavelength = RegularGridInterpolator(
        (y, x), values[:, :, 0], bounds_error=False, fill_value=np.nan
    )
    bandwidth = RegularGridInterpolator(
        (y, x), values[:, :, 1], bounds_error=False, fill_value=np.nan
    )
    return wavelength, bandwidth


def sample_interpolator(interpolator, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    points = np.column_stack((y.ravel(), x.ravel()))
    return interpolator(points).reshape(x.shape)


def register_to_reference(
    image: np.ndarray,
    zodi: np.ndarray,
    variance: np.ndarray,
    flags: np.ndarray,
    reference_wcs: WCS,
    image_wcs: WCS,
    reference_wave,
    reference_bandwidth,
    image_wave,
    image_bandwidth,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Resample onto epoch 1; propagate diagonal variance with squared weights.

    Flags are categorical bitmaps, so every input pixel that contributes to
    the bilinear sample is included in the output flag mask.
    """
    height, width = image.shape
    aligned_image = np.full((height, width), np.nan, dtype=np.float32)
    aligned_zodi = np.full_like(aligned_image, np.nan)
    aligned_variance = np.full_like(aligned_image, np.nan)
    aligned_flags = np.full((height, width), -1, dtype=np.int32)
    spectral_delta = np.full_like(aligned_image, np.nan)
    spectral_tolerance = np.full_like(aligned_image, np.nan)
    x_reference = np.arange(width, dtype=np.float32)[None, :]

    for row_start in range(0, height, ROW_CHUNK):
        row_stop = min(row_start + ROW_CHUNK, height)
        y_reference = np.arange(row_start, row_stop, dtype=np.float32)[:, None]
        shape = (row_stop - row_start, width)
        sky = reference_wcs.pixel_to_world(
            np.broadcast_to(x_reference, shape),
            np.broadcast_to(y_reference, shape),
        )
        x_image, y_image = image_wcs.world_to_pixel(sky)
        coordinates = np.asarray([y_image, x_image])
        rows = slice(row_start, row_stop)

        # The detector wavelength changes across the image. Compare both
        # epochs at the same sky positions and retain only samples whose
        # local bandpasses overlap. The accepted mismatch is at most half of
        # the narrower local bandpass; no spectral interpolation is implied.
        local_wave_reference = sample_interpolator(
            reference_wave,
            np.broadcast_to(x_reference, shape),
            np.broadcast_to(y_reference, shape),
        )
        local_band_reference = sample_interpolator(
            reference_bandwidth,
            np.broadcast_to(x_reference, shape),
            np.broadcast_to(y_reference, shape),
        )
        local_wave_image = sample_interpolator(image_wave, x_image, y_image)
        local_band_image = sample_interpolator(image_bandwidth, x_image, y_image)
        spectral_delta[rows] = np.abs(local_wave_image - local_wave_reference)
        spectral_tolerance[rows] = 0.5 * np.minimum(
            local_band_reference, local_band_image
        )

        aligned_image[rows] = map_coordinates(
            image, coordinates, order=1, mode="constant", cval=np.nan,
            prefilter=False,
        )
        aligned_zodi[rows] = map_coordinates(
            zodi, coordinates, order=1, mode="constant", cval=np.nan,
            prefilter=False,
        )
        # Variances do not interpolate like intensities. For independent
        # input pixels, Var(sum(w_i * I_i)) = sum(w_i**2 * Var(I_i)).
        x0 = np.floor(x_image).astype(np.int32)
        y0 = np.floor(y_image).astype(np.int32)
        dx = x_image - x0
        dy = y_image - y0
        x1, y1 = x0 + 1, y0 + 1
        inside = (x0 >= 0) & (y0 >= 0) & (x1 < width) & (y1 < height)
        x0c, x1c = np.clip(x0, 0, width - 1), np.clip(x1, 0, width - 1)
        y0c, y1c = np.clip(y0, 0, height - 1), np.clip(y1, 0, height - 1)
        weights = (
            (1 - dx) * (1 - dy), dx * (1 - dy),
            (1 - dx) * dy, dx * dy,
        )
        corners = (
            variance[y0c, x0c], variance[y0c, x1c],
            variance[y1c, x0c], variance[y1c, x1c],
        )
        propagated = sum(w * w * v for w, v in zip(weights, corners))
        aligned_variance[rows] = np.where(inside, propagated, np.nan)

        flag_corners = (
            flags[y0c, x0c], flags[y0c, x1c],
            flags[y1c, x0c], flags[y1c, x1c],
        )
        combined_flags = np.zeros(shape, dtype=np.int32)
        for weight, corner_flags in zip(weights, flag_corners):
            combined_flags |= np.where(weight > 1e-6, corner_flags, 0).astype(np.int32)
        aligned_flags[rows] = np.where(inside, combined_flags, -1)

    return (
        aligned_image, aligned_zodi, aligned_variance, aligned_flags,
        spectral_delta, spectral_tolerance,
    )


def detect_residuals(
    residual: np.ndarray,
    uncertainty: np.ndarray,
    valid: np.ndarray,
    wcs: WCS,
    flags_reference: np.ndarray,
    flags_registered: np.ndarray,
    source_bit: int | None,
    polarity: str,
    median: float,
    sigma: float,
) -> list[dict[str, object]]:
    signed_image = (residual - median) / uncertainty
    if polarity == "negative":
        signed_image = -signed_image

    finder = DAOStarFinder(
        fwhm=DAO_FWHM_PIXELS,
        threshold=DETECTION_THRESHOLD_SIGMA * sigma,
        exclude_border=True,
    )
    sources = finder(signed_image, mask=~valid)
    if sources is None:
        return []

    x_name = "x_centroid" if "x_centroid" in sources.colnames else "xcentroid"
    y_name = "y_centroid" if "y_centroid" in sources.colnames else "ycentroid"
    result: list[dict[str, object]] = []
    height, width = residual.shape
    for source in sources:
        x = float(source[x_name])
        y = float(source[y_name])
        ix = int(np.clip(np.rint(x), 0, width - 1))
        iy = int(np.clip(np.rint(y), 0, height - 1))
        sky = wcs.pixel_to_world(x, y)
        mapped_source_ref = bool(
            source_bit is not None
            and (int(flags_reference[iy, ix]) & (1 << source_bit))
        )
        mapped_source_second = bool(
            source_bit is not None
            and (int(flags_registered[iy, ix]) & (1 << source_bit))
        )
        result.append(
            {
                "polarity": polarity,
                "x_pixel": round(x, 3),
                "y_pixel": round(y, 3),
                "peak_significance": round(float(source["peak"]), 3),
                "ra_deg": round(float(sky.ra.deg), 7),
                "dec_deg": round(float(sky.dec.deg), 7),
                "detection_threshold_sigma": DETECTION_THRESHOLD_SIGMA,
                "mp_source_flag_epoch1": mapped_source_ref,
                "mp_source_flag_epoch2": mapped_source_second,
                "classification": "provisional residual; not cross-matched",
            }
        )
    return result


def main() -> None:
    paths = sorted(DATA_DIR.glob("level2_*D1_spx_l2b-*.fits"))
    if len(paths) != 2:
        raise SystemExit(
            f"Expected exactly two D1 FITS in {DATA_DIR}, found {len(paths)}"
        )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with fits.open(paths[0], memmap=True) as first, fits.open(
        paths[1], memmap=True
    ) as second:
        h1, h2 = first["IMAGE"].header, second["IMAGE"].header
        if int(h1.get("DETECTOR", -1)) != int(h2.get("DETECTOR", -2)):
            raise SystemExit("The two FITS files do not use the same detector.")

        image1 = extension_array(first, "IMAGE").astype(np.float32)
        zodi1 = extension_array(first, "ZODI").astype(np.float32)
        variance1 = extension_array(first, "VARIANCE").astype(np.float32)
        flags1 = extension_array(first, "FLAGS").astype(np.int32)

        image2 = extension_array(second, "IMAGE").astype(np.float32)
        zodi2 = extension_array(second, "ZODI").astype(np.float32)
        variance2 = extension_array(second, "VARIANCE").astype(np.float32)
        flags2 = extension_array(second, "FLAGS").astype(np.int32)

        wcs1 = WCS(h1).celestial
        wcs2 = WCS(h2).celestial
        wave1, bandwidth1 = wavelength_interpolators(first)
        wave2, bandwidth2 = wavelength_interpolators(second)
        (
            aligned_image2, aligned_zodi2, aligned_variance2, aligned_flags2,
            spectral_delta, spectral_tolerance,
        ) = (
            register_to_reference(
                image2, zodi2, variance2, flags2, wcs1, wcs2,
                wave1, bandwidth1, wave2, bandwidth2,
            )
        )

        # A matched sky location is spectrally comparable when its local
        # wavelengths differ by no more than half the narrower bandpass.
        spectral_valid = (
            np.isfinite(spectral_delta)
            & np.isfinite(spectral_tolerance)
            & (spectral_delta <= spectral_tolerance)
        )
        spectral_sampled = np.isfinite(spectral_delta) & np.isfinite(spectral_tolerance)

        bit_names = resolve_flag_bits(first["FLAGS"].header)
        bad_mask = sum(1 << bit for bit in bit_names.values())
        valid = (
            np.isfinite(image1)
            & np.isfinite(zodi1)
            & np.isfinite(variance1)
            & (variance1 > 0)
            & np.isfinite(aligned_image2)
            & np.isfinite(aligned_zodi2)
            & np.isfinite(aligned_variance2)
            & (aligned_variance2 > 0)
            & ((flags1 & bad_mask) == 0)
            & ((aligned_flags2 & bad_mask) == 0)
            & spectral_valid
        )

        # The archive notes that ZODI is modeled separately and is not removed
        # from IMAGE. Subtract it before comparing the two epochs.
        science1 = image1 - zodi1
        science2 = aligned_image2 - aligned_zodi2
        residual = science2 - science1
        uncertainty = np.sqrt(variance1 + aligned_variance2)
        valid &= np.isfinite(uncertainty) & (uncertainty > 0)

        _, median, sigma = sigma_clipped_stats(
            residual, mask=~valid, sigma=3.0, maxiters=5
        )
        if not np.isfinite(sigma) or sigma <= 0:
            raise SystemExit("Could not estimate a finite residual noise level.")

        _, _, significance_sigma = sigma_clipped_stats(
            (residual - median) / uncertainty,
            mask=~valid, sigma=3.0, maxiters=5,
        )
        if not np.isfinite(significance_sigma) or significance_sigma <= 0:
            raise SystemExit("Could not estimate significance-map scatter.")

        source_bit = first["FLAGS"].header.get("MP_SOURCE")
        detections = detect_residuals(
            residual, uncertainty, valid, wcs1, flags1, aligned_flags2,
            int(source_bit) if source_bit is not None else None,
            "positive", float(median), float(significance_sigma),
        ) + detect_residuals(
            residual, uncertainty, valid, wcs1, flags1, aligned_flags2,
            int(source_bit) if source_bit is not None else None,
            "negative", float(median), float(significance_sigma),
        )

        positives = [d for d in detections if d["polarity"] == "positive"]
        negatives = [d for d in detections if d["polarity"] == "negative"]
        both_unmarked = lambda d: not d["mp_source_flag_epoch1"] and not d[
            "mp_source_flag_epoch2"
        ]
        positive_unmarked = [d for d in positives if both_unmarked(d)]
        negative_unmarked = [d for d in negatives if both_unmarked(d)]
        pair_count = 0
        if positive_unmarked and negative_unmarked:
            neg_xy = np.array(
                [[d["x_pixel"], d["y_pixel"]] for d in negative_unmarked]
            )
            distances, _ = cKDTree(neg_xy).query(
                np.array([[d["x_pixel"], d["y_pixel"]] for d in positive_unmarked])
            )
            pair_count = int(np.count_nonzero((distances >= 1) & (distances <= 40)))

        wave_values = first["WCS-WAVE"].data["VALUES"][0, :, :, 0]
        valid_values = np.asarray(wave_values, dtype=float)
        valid_values = valid_values[np.isfinite(valid_values)]
        diff_header = wcs1.to_header(relax=True)
        diff_header["BUNIT"] = "MJy / sr"
        diff_header["HISTORY"] = "Epoch2 - Epoch1 after WCS registration"
        diff_header["HISTORY"] = "ZODI modeled background subtracted per epoch"
        diff_header["HISTORY"] = f"Global median residual {float(median):.8g} removed for detections"
        fits.HDUList(
            [
                fits.PrimaryHDU(),
                fits.ImageHDU(data=residual.astype(np.float32), header=diff_header, name="DIFF"),
                fits.ImageHDU(data=uncertainty.astype(np.float32), header=diff_header, name="UNCERTAINTY"),
                fits.ImageHDU(data=valid.astype(np.uint8), header=diff_header, name="VALID"),
            ]
        ).writeto(OUTPUT_DIR / "difference_map.fits", overwrite=True, checksum=True)

        summary = {
            "status": "preliminary_residual_screen; no Planet X claim",
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "method": {
                "registration": "Astropy celestial WCS from epoch 2 onto epoch 1 grid; bilinear interpolation; diagonal variance propagated with squared weights; contributing bad flags OR-combined",
                "background": "subtract ZODI model from each IMAGE before differencing",
                "spectral_compatibility": "Before differencing, interpolate WCS-WAVE at matched sky positions and retain only pixels whose local wavelengths differ by no more than half the narrower local bandpass. This is a bandpass compatibility mask, not spectral interpolation or a full spectral regrid.",
                "quality_mask_bits": {name: 1 << bit for name, bit in bit_names.items()},
                "detection": "DAOStarFinder on residual divided by propagated per-pixel uncertainty; positive and negative; threshold 8 x sigma-clipped significance scatter",
                "source_flag_note": "MP_SOURCE marks pixels mapped to a source in the SPHEREx pipeline; it is not a JPL small-body cross-match.",
                "variance_note": "Diagonal input variances are propagated through bilinear weights and combined between epochs. Inter-pixel covariance from resampling, PSF matching, and correlated calibration errors are not modeled.",
            },
            "epochs": [
                {
                    "file": p.name,
                    "observation_id": h.get("OBS_ID", p.name.split("D1")[0].removeprefix("level2_")),
                    "detector": int(h.get("DETECTOR", 1)),
                    "date_obs": h["DATE-OBS"],
                    "mjd_obs": float(h["MJD-OBS"]),
                    "ra_center_deg": float(h["CRVAL1"]),
                    "dec_center_deg": float(h["CRVAL2"]),
                    "image_shape": list(image1.shape),
                    "bunit": h.get("BUNIT"),
                }
                for p, h in [(paths[0], h1), (paths[1], h2)]
            ],
            "wavelength_range_um_approx": [
                round(float(valid_values.min()), 6),
                round(float(valid_values.max()), 6),
            ],
            "valid_overlap_pixels": int(valid.sum()),
            "valid_overlap_percent_of_reference": round(float(valid.mean() * 100), 3),
            "spectral_compatibility": {
                "rule": "absolute wavelength difference <= half the narrower local bandpass",
                "median_delta_um": float(np.nanmedian(spectral_delta)),
                "p99_delta_um": float(np.nanpercentile(spectral_delta, 99)),
                "max_delta_um": float(np.nanmax(spectral_delta)),
                "median_narrower_bandpass_um": float(np.nanmedian(2 * spectral_tolerance)),
                "compatible_pixel_percent": round(float(np.count_nonzero(spectral_valid) / max(1, np.count_nonzero(spectral_sampled)) * 100), 4),
            },
            "residual_median_mjy_sr_before_centering": float(median),
            "residual_sigma_clipped_mjy_sr": float(sigma),
            "significance_sigma_clipped": float(significance_sigma),
            "positive_residual_count": len(positives),
            "negative_residual_count": len(negatives),
            "positive_with_mp_source_flag": sum(
                bool(d["mp_source_flag_epoch1"] or d["mp_source_flag_epoch2"])
                for d in positives
            ),
            "negative_with_mp_source_flag": sum(
                bool(d["mp_source_flag_epoch1"] or d["mp_source_flag_epoch2"])
                for d in negatives
            ),
            "positive_without_mp_source_flag_both_epochs": len(positive_unmarked),
            "negative_without_mp_source_flag_both_epochs": len(negative_unmarked),
            "unflagged_positive_negative_pairs_within_1_to_40_pixels": pair_count,
            "interpretation": "No residual pair from this first-pass screen is promoted to an object candidate. Cross-match and astrometric/photometric review are still required.",
        }
        (OUTPUT_DIR / "summary.json").write_text(
            json.dumps(summary, indent=2), encoding="utf-8"
        )
        (OUTPUT_DIR / "residual_detections.json").write_text(
            json.dumps({"detections": detections}, indent=2), encoding="utf-8"
        )
        print(json.dumps(summary, indent=2))
        print(f"Wrote {OUTPUT_DIR / 'difference_map.fits'}")
        print(f"Wrote {OUTPUT_DIR / 'residual_detections.json'}")


if __name__ == "__main__":
    main()
