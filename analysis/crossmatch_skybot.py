#!/usr/bin/env python3
"""Cross-match provisional SPHEREx difference residuals with SkyBoT."""

from __future__ import annotations

import json
import math
from pathlib import Path

import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS


ROOT = Path(__file__).resolve().parents[1]
ANALYSIS_DIR = ROOT / "DATOS" / "IRSA_FITS_D1" / "analysis"
MATCH_RADII_ARCSEC = (10, 20, 30, 60, 120)
HIGH_CONFIDENCE_RADIUS_ARCSEC = 5


def load_skybot(path: Path) -> tuple[list[dict], SkyCoord]:
    objects = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(objects, list):
        raise ValueError(f"Expected a list of SkyBoT objects in {path}")
    if not objects:
        return objects, SkyCoord([], [], unit=(u.deg, u.deg))
    coords = SkyCoord(
        [row["RA (hms)"] for row in objects],
        [row["DEC (dms)"] for row in objects],
        unit=(u.hourangle, u.deg),
        frame="icrs",
    )
    return objects, coords


def match_epoch(
    detections: list[dict], objects: list[dict], object_coords: SkyCoord
) -> tuple[list[dict], dict[str, int]]:
    if not detections or not objects:
        return [], {str(radius): 0 for radius in MATCH_RADII_ARCSEC}
    detection_coords = SkyCoord(
        [row["ra_deg"] for row in detections],
        [row["dec_deg"] for row in detections],
        unit=u.deg,
        frame="icrs",
    )
    nearest_idx, sep2d, _ = detection_coords.match_to_catalog_sky(object_coords)
    separations = sep2d.to_value(u.arcsec)
    counts = {
        str(radius): int((separations <= radius).sum())
        for radius in MATCH_RADII_ARCSEC
    }
    matches = []
    for detection, object_index, separation in zip(detections, nearest_idx, separations):
        row = objects[int(object_index)]
        matches.append(
            {
                "detection": detection,
                "nearest_skybot_object": {
                    "name": row.get("Name"),
                    "number": row.get("Num"),
                    "class": row.get("Class"),
                    "v_magnitude": row.get("VMag (mag)"),
                    "ephemeris_error_arcsec": row.get("Err (arcsec)"),
                    "ra_hms": row.get("RA (hms)"),
                    "dec_dms": row.get("DEC (dms)"),
                    "d_ra_cosdec_arcsec_per_hour": row.get("dRA (arcsec/h)"),
                    "d_dec_arcsec_per_hour": row.get("dDEC (arcsec/h)"),
                },
                "separation_arcsec": round(float(separation), 3),
                "match_within_30_arcsec": bool(separation <= 30),
                "match_within_60_arcsec": bool(separation <= 60),
            }
        )
    return matches, counts


def main() -> None:
    residual_data = json.loads(
        (ANALYSIS_DIR / "residual_detections.json").read_text(encoding="utf-8")
    )["detections"]
    skybot = {
        "epoch1": load_skybot(ANALYSIS_DIR / "skybot_epoch1.json"),
        "epoch2": load_skybot(ANALYSIS_DIR / "skybot_epoch2.json"),
    }
    fits_paths = sorted((ROOT / "DATOS" / "IRSA_FITS_D1").glob("level2_*D1_spx_l2b-*.fits"))
    with fits.open(fits_paths[0], memmap=True) as h1, fits.open(
        fits_paths[1], memmap=True
    ) as h2:
        mjd1 = float(h1["IMAGE"].header["MJD-OBS"])
        mjd2 = float(h2["IMAGE"].header["MJD-OBS"])
        wcs2 = WCS(h2["IMAGE"].header).celestial
    resolver_path = ANALYSIS_DIR / "skybot_1994wz3_resolver_epoch2.json"
    resolver_objects = (
        json.loads(resolver_path.read_text(encoding="utf-8"))
        if resolver_path.exists()
        else []
    )
    resolver_by_name = {row.get("Name"): row for row in resolver_objects}

    # A negative residual records the source's earlier position; a positive
    # residual records its later position in the second observation.
    epoch_detections = {
        "epoch1": [d for d in residual_data if d["polarity"] == "negative"],
        "epoch2": [d for d in residual_data if d["polarity"] == "positive"],
    }
    result = {
        "status": "positional cross-match only; residuals remain provisional",
        "service": "SkyBoT / IMCCE cone search",
        "observer_location": "geocenter (code 500)",
        "match_radii_arcsec": list(MATCH_RADII_ARCSEC),
        "epochs": {},
    }
    match_names_by_epoch: dict[str, set[str]] = {}
    for epoch in ("epoch1", "epoch2"):
        objects, coords = skybot[epoch]
        detections = epoch_detections[epoch]
        matches, counts = match_epoch(detections, objects, coords)
        result["epochs"][epoch] = {
            "skybot_object_count": len(objects),
            "provisional_residual_count": len(detections),
            "nearest_object_match_counts_by_radius": counts,
            "matches": matches,
            "likely_positional_associations_within_5_arcsec": [
                m for m in matches
                if m["separation_arcsec"] <= HIGH_CONFIDENCE_RADIUS_ARCSEC
                and (m["nearest_skybot_object"]["ephemeris_error_arcsec"] or 0) <= 1
            ],
        }
        match_names_by_epoch[epoch] = {
            m["nearest_skybot_object"]["name"]
            for m in matches
            if m["match_within_30_arcsec"]
        }

    result["same_known_object_nearest_within_30_arcsec_both_epochs"] = sorted(
        match_names_by_epoch["epoch1"] & match_names_by_epoch["epoch2"]
    )
    projected_known_objects = []
    for match in result["epochs"]["epoch1"][
        "likely_positional_associations_within_5_arcsec"
    ]:
        obj = match["nearest_skybot_object"]
        detection = match["detection"]
        source = SkyCoord(detection["ra_deg"] * u.deg, detection["dec_deg"] * u.deg)
        hours = (mjd2 - mjd1) * 24
        exact_ephemeris = resolver_by_name.get(obj["name"])
        if exact_ephemeris:
            ra2 = float(exact_ephemeris["RA (deg)"])
            dec2 = float(exact_ephemeris["DEC (deg)"])
            projection_method = "SkyBoT resolver at exact epoch 2"
        else:
            dra = float(obj["d_ra_cosdec_arcsec_per_hour"])
            ddec = float(obj["d_dec_arcsec_per_hour"])
            ra2 = source.ra.deg + dra * hours / (3600 * math.cos(source.dec.radian))
            dec2 = source.dec.deg + ddec * hours / 3600
            projection_method = "linear-rate approximation from epoch 1"
        x2, y2 = wcs2.world_to_pixel_values(ra2, dec2)
        projected_known_objects.append(
            {
                "name": obj["name"],
                "epoch1_residual_separation_arcsec": match["separation_arcsec"],
                "epoch2_position_method": projection_method,
                "epoch2_ra_deg": float(ra2),
                "epoch2_dec_deg": float(dec2),
                "epoch2_x_pixel": float(x2),
                "epoch2_y_pixel": float(y2),
                "projection_inside_epoch2_image": bool(0 <= x2 < 2040 and 0 <= y2 < 2040),
                "projection_note": "Exact SkyBoT coordinates are used when a resolver response is cached; otherwise this is only a linear-rate approximation.",
            }
        )
    result["epoch1_high_confidence_object_motion_projections"] = projected_known_objects
    (ANALYSIS_DIR / "skybot_crossmatch.json").write_text(
        json.dumps(result, indent=2), encoding="utf-8"
    )
    print(json.dumps({
        "epoch1": result["epochs"]["epoch1"]["nearest_object_match_counts_by_radius"],
        "epoch2": result["epochs"]["epoch2"]["nearest_object_match_counts_by_radius"],
        "same_known_object_within_30_arcsec_both_epochs": result[
            "same_known_object_nearest_within_30_arcsec_both_epochs"
        ],
        "likely_epoch1_associations": [
            {
                "name": m["nearest_skybot_object"]["name"],
                "separation_arcsec": m["separation_arcsec"],
            }
            for m in result["epochs"]["epoch1"][
                "likely_positional_associations_within_5_arcsec"
            ]
        ],
        "epoch2_motion_projections": result[
            "epoch1_high_confidence_object_motion_projections"
        ],
        "output": str(ANALYSIS_DIR / "skybot_crossmatch.json"),
    }, indent=2))


if __name__ == "__main__":
    main()
