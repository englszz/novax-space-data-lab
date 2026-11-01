# Pipeline científico de NOVAX

Este directorio contiene el análisis Python que genera el catálogo real que
consume la web. La ejecución parte de los dos productos calibrados SPHEREx
Level 2 QR2 incluidos en `DATOS/IRSA_FITS_D1/`; no usa los FITS sintéticos de
`DATOS/prueba/`.

## Ejecutar de principio a fin

Desde la raíz del proyecto, con Python 3.11 o posterior:

```bash
python3 -m venv .venv-astro
.venv-astro/bin/python -m pip install -r analysis/requirements-astro.txt
.venv-astro/bin/python analysis/run_pipeline.py
```

En Windows, activa el entorno virtual y ejecuta `python analysis/run_pipeline.py`.
El programa comprueba las entradas y corre, en orden, alineación/detección,
cruce de catálogo, generación del catálogo web y revisión ePSF. Si una etapa
falla, la ejecución se detiene y muestra el error.

## Entradas necesarias

Los archivos deben conservar estas rutas y nombres:

- `DATOS/IRSA_FITS_D1/level2_2025W22_1B_0399_1D1_spx_l2b-v20-2025-250.fits`
- `DATOS/IRSA_FITS_D1/level2_2025W27_2A_0443_1D1_spx_l2b-v20-2025-259.fits`
- `DATOS/IRSA_FITS_D1/analysis/epsf_D1_spx_cal-epsf-v1-2026-191.fits`
- Respuestas archivadas de SkyBoT en
  `DATOS/IRSA_FITS_D1/analysis/skybot_epoch1.json`,
  `DATOS/IRSA_FITS_D1/analysis/skybot_epoch2.json` y
  `DATOS/IRSA_FITS_D1/analysis/skybot_1994wz3_resolver_epoch2.json`.

Los dos FITS de entrada son productos científicos calibrados Level 2 de IRSA,
no datos electrónicos sin calibrar. El pipeline se ejecuta localmente con esos
archivos y las respuestas de catálogo guardadas: no descarga FITS ni consulta
IRSA o SkyBoT en vivo. Los insumos se incluyen en este repositorio (los dos FITS
ocupan alrededor de 69 MB cada uno). Si se prefiere no clonar los archivos
grandes, `analysis/download_inputs.sh` los recupera desde IRSA. Los SHA-256,
tamaños y rutas están en `DATOS/entradas_manifest.json`.

La fecha exacta de descarga/consulta de IRSA no quedó registrada; las fechas
`DATE-OBS` describen las observaciones, no la descarga. El `mtime` local del
archivo aparece en el manifiesto solo como dato del sistema de archivos, no como
fecha de consulta certificada.

## Qué hace cada etapa

1. `first_pass_spherex.py` lee `IMAGE`, `ZODI`, `VARIANCE`, `FLAGS` y
   `WCS-WAVE`. Resta el fondo modelado ZODI, realinea la segunda época a la
   primera con WCS, propaga la varianza diagonal mediante los pesos bilineales,
   enmascara los bits de calidad seleccionados y compara ambas polaridades con
   un umbral DAOStarFinder de 8σ.
2. Antes de la resta, interpola `WCS-WAVE` en posiciones del mismo cielo y
   descarta muestras cuyo centro de banda difiera más de la mitad del ancho de
   la banda más estrecha. Esto es un filtro explícito de compatibilidad
   espectral; no es una interpolación/reconstrucción de espectros. En estos
   dos FITS, el 100 % de las posiciones comparables pasa el filtro; la
   diferencia máxima es 0.0001352 µm frente a un ancho de banda mediano de
   0.02333 µm. Por esa compatibilidad estrecha no se aplica un reescalado de
   flujo espectral. Si el requisito se interpreta como exigir una
   reconstrucción/interpolación espectral completa, esta versión no la hace.
3. `crossmatch_skybot.py` asocia posiciones con las respuestas SkyBoT/IMCCE
   archivadas. No consulta JPL SBDB ni demuestra identidad solo por cercanía.
4. `build_real_catalog.py` crea el catálogo consumido por React y la vista PNG
   del mapa. Distingue una asociación posicional conocida, píxeles marcados
   `MP_SOURCE` y residuos sin asociar; ninguna etiqueta significa Planeta X.
5. `review_psf_signals.py` ajusta la ePSF de calibración D1 a las posiciones
   del catálogo en las imágenes de ambas épocas y guarda métricas y recortes.
   Es una revisión en posiciones fijas, no un buscador completo de fuentes.

## Salidas principales

- `DATOS/IRSA_FITS_D1/analysis/difference_map.fits`
- `DATOS/IRSA_FITS_D1/analysis/summary.json`
- `DATOS/IRSA_FITS_D1/analysis/residual_detections.json`
- `DATOS/IRSA_FITS_D1/analysis/skybot_crossmatch.json`
- `DATOS/IRSA_FITS_D1/analysis/psf_signal_review.json`
- `DATOS/IRSA_FITS_D1/analysis/psf_cutouts/`
- `DATOS/real_residual_catalog.json` y `DATOS/real_residual_catalog.meta.json`
- `DATOS/IRSA_FITS_D1/analysis/difference_preview.png`

## Resultado e interpretación

La ejecución actual produce 218 residuos: 175 positivos y 43 negativos. El
catálogo los organiza como 213 residuos sobre píxeles `MP_SOURCE`, una
asociación posicional con 1994 WZ3 y cuatro residuos sin asociar. No son 218
cuerpos confirmados ni se identificó un candidato a Planeta X. El cruce
conocido proviene de SkyBoT/IMCCE, no de una consulta independiente a JPL SBDB.

El umbral configurado es 8σ en la imagen de significancia convolucionada por
DAOStarFinder. Se eligió como corte conservador para extraer señales compactas;
después se contrastaron posicionalmente las detecciones con las respuestas
SkyBoT archivadas. Una coincidencia cercana no basta para confirmar identidad:
solo una cumple aquí el criterio posicional/efemérides documentado. No se hizo
una prueba de inyección y recuperación para demostrar que 8σ sea el umbral
óptimo.

La salida es una criba reproducible de dos observaciones. La varianza propagada
es diagonal y no incluye covarianza de remuestreo, incertidumbre de ZODI,
refinamiento astrométrico, búsqueda de centroides, deblend ni ajuste orbital.
La selección por `WCS-WAVE` confirma compatibilidad de banda para esta pareja;
no reconstruye espectros. El umbral 8σ es una decisión documentada de este
análisis, no un umbral oficial de NASA.

## Datos y referencias

- DOI del archivo SPHEREx en IRSA: `10.26131/IRSA652`
- [SPHEREx Data Products (IRSA)](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
- [SPHEREx Data Access (IRSA)](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)
- [SPHEREx en AWS Open Data](https://registry.opendata.aws/spherex-qr/)
- [Tutorial ePSF de IRSA](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/)
- [SkyBoT/IMCCE](https://ssp.imcce.fr/webservices/skybot/)
