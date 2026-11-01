#!/usr/bin/env bash
# Descarga los insumos públicos usados por el pipeline de NOVAX.
# Los FITS y la ePSF también se incluyen en el repositorio; este script sirve
# para recuperarlos desde IRSA si se prefiere no clonar los archivos grandes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FITS_DIR="${ROOT}/DATOS/IRSA_FITS_D1"
ANALYSIS_DIR="${FITS_DIR}/analysis"
mkdir -p "${FITS_DIR}" "${ANALYSIS_DIR}"

curl -L --fail --retry 3 -o "${FITS_DIR}/level2_2025W22_1B_0399_1D1_spx_l2b-v20-2025-250.fits" \
  "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/2025W22_1B/l2b-v20-2025-250/1/level2_2025W22_1B_0399_1D1_spx_l2b-v20-2025-250.fits"

curl -L --fail --retry 3 -o "${FITS_DIR}/level2_2025W27_2A_0443_1D1_spx_l2b-v20-2025-259.fits" \
  "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/2025W27_2A/l2b-v20-2025-259/1/level2_2025W27_2A_0443_1D1_spx_l2b-v20-2025-259.fits"

curl -L --fail --retry 3 -o "${ANALYSIS_DIR}/epsf_D1_spx_cal-epsf-v1-2026-191.fits" \
  "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr3/epsf/cal-epsf-v1-2026-191/1/epsf_D1_spx_cal-epsf-v1-2026-191.fits"

echo "Insumos descargados en ${FITS_DIR}"
echo "Verifica los SHA-256 en DATOS/entradas_manifest.json"
