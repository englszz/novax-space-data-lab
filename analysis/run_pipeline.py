#!/usr/bin/env python3
"""Run the NOVAX SPHEREx analysis from the local archive products.

The calibrated Level 2 FITS files, official D1 ePSF calibration, and cached SkyBoT
responses must be present under DATOS/. The run itself is offline and does not
silently substitute simulated data or query a remote service.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "DATOS" / "IRSA_FITS_D1"
ANALYSIS_DIR = DATA_DIR / "analysis"
REQUIRED_INPUTS = (
    DATA_DIR / "analysis" / "epsf_D1_spx_cal-epsf-v1-2026-191.fits",
    DATA_DIR / "analysis" / "skybot_epoch1.json",
    DATA_DIR / "analysis" / "skybot_epoch2.json",
    DATA_DIR / "analysis" / "skybot_1994wz3_resolver_epoch2.json",
)
STAGES = (
    ("1/4 · Alineación, compatibilidad espectral y detección", "first_pass_spherex.py"),
    ("2/4 · Cruce posicional con respuestas SkyBoT archivadas", "crossmatch_skybot.py"),
    ("3/4 · Catálogo web y mapa de diferencias", "build_real_catalog.py"),
    ("4/4 · Revisión ePSF sobre las dos épocas", "review_psf_signals.py"),
)


def main() -> None:
    fits_files = sorted(DATA_DIR.glob("level2_*D1_spx_l2b-*.fits"))
    if len(fits_files) != 2:
        raise SystemExit(
            f"Se esperaban exactamente dos FITS Level 2 del detector D1 en {DATA_DIR}; "
            f"se encontraron {len(fits_files)}."
        )
    missing = [path for path in REQUIRED_INPUTS if not path.is_file()]
    if missing:
        listing = "\n".join(f"  - {path.relative_to(ROOT)}" for path in missing)
        raise SystemExit(f"Faltan entradas necesarias para el pipeline:\n{listing}")

    for label, script in STAGES:
        print(f"\n{label}", flush=True)
        subprocess.run([sys.executable, str(ROOT / "analysis" / script)], cwd=ROOT, check=True)

    catalog = json.loads((ROOT / "DATOS" / "real_residual_catalog.json").read_text(encoding="utf-8"))
    metadata = json.loads((ROOT / "DATOS" / "real_residual_catalog.meta.json").read_text(encoding="utf-8"))
    review = json.loads((ANALYSIS_DIR / "psf_signal_review.json").read_text(encoding="utf-8"))
    summary = json.loads((ANALYSIS_DIR / "summary.json").read_text(encoding="utf-8"))
    review_count = len(review.get("records", {}))
    expected_count = metadata["counts"]["total"]
    if len(catalog) != expected_count or review_count != expected_count:
        raise SystemExit(
            "Las salidas no coinciden: el catálogo, sus metadatos y la revisión ePSF "
            "deben tener el mismo número de posiciones."
        )

    print("\nPipeline terminado.")
    print(f"FITS de entrada: {', '.join(path.name for path in fits_files)}")
    print(f"Residuos en catálogo: {len(catalog)}")
    print(f"Clasificación: {json.dumps(metadata['counts'], ensure_ascii=False)}")
    print(f"Posiciones revisadas en ePSF: {review_count}")
    print(f"Compatibilidad espectral: {json.dumps(summary.get('spectral_compatibility', {}), ensure_ascii=False)}")
    print("La ejecución usa respuestas SkyBoT archivadas; no consulta IRSA/SkyBoT en vivo.")


if __name__ == "__main__":
    main()
