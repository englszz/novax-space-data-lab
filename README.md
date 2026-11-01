# NOVAX · Planet X and SPHEREx

Visor y pipeline reproducible para buscar objetos en movimiento comparando dos
observaciones reales del telescopio **SPHEREx** de la NASA en el detector **D1**.

Proyecto preparado para el **NASA Space Apps Challenge 2026**, desafío
*Planet X and SPHEREx*.

**Demo:** https://novax-space-data-lab.vercel.app

**Resultado de esta criba: no hay candidato a Planeta X.** Sí se recupera una
asociación posicional con el asteroide conocido **1994 WZ3** y se documentan los
límites del análisis sin sobreclamar.

## Qué hace

1. Lee dos FITS Level 2 QR2 de IRSA con `IMAGE`, `ZODI`, `VARIANCE`, `FLAGS`,
   `PSF` y `WCS-WAVE`.
2. Resta el fondo zodiacal modelado de cada época.
3. Realinea la época 2 sobre la época 1 con el WCS y propaga la varianza
   diagonal por los pesos bilineales.
4. Comprueba compatibilidad espectral con `WCS-WAVE`: descarta posiciones cuyo
   centro de banda difiere más de medio ancho de banda local.
5. Detecta residuos positivos y negativos con `DAOStarFinder` a 8σ.
6. Cruza posiciones con respuestas archivadas de **SkyBoT/IMCCE**.
7. Ajusta la **ePSF** oficial de D1 en las coordenadas de los residuos.
8. Genera el catálogo real que consume la web y el mapa de diferencias.

La web muestra el mapa real, las 218 detecciones, su procedencia (FITS, fechas
UTC, DOI), el cruce SkyBoT y la revisión ePSF. No usa datos simulados.

## Resultado

- 218 registros: 175 residuos positivos y 43 negativos.
- 213 caen sobre píxeles marcados `MP_SOURCE` por SPHEREx y se clasifican como
  fuente; 4 no llevan esa bandera y quedan como residuo.
- 1 asociación posicional con **1994 WZ3** (2.416 arcsec; SkyBoT la sitúa fuera
  del campo en la segunda época).
- Los 4 residuos sin asociación **no** se corroboran como fuentes puntuales
  positivas en la época esperada tras ajustar la ePSF.
- **Ningún registro se clasifica como Planeta X.**

## Inicio rápido · web

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # salida en dist/
```

La app usa React + Vite + Tailwind. En despliegue, Vercel detecta Vite y ejecuta
`npm run build`.

## Pipeline reproducible

Requiere Python 3.11 o posterior.

```bash
python3 -m venv .venv-astro
.venv-astro/bin/python -m pip install -r analysis/requirements-astro.txt
.venv-astro/bin/python analysis/run_pipeline.py
```

`run_pipeline.py` comprueba las entradas y ejecuta, en orden:

1. `analysis/first_pass_spherex.py`
2. `analysis/crossmatch_skybot.py`
3. `analysis/build_real_catalog.py`
4. `analysis/review_psf_signals.py`

Si falta una entrada o falla una etapa, se detiene. La ejecución es **offline**:
no descarga FITS ni consulta IRSA/SkyBoT/JPL en vivo.

### Entradas incluidas

- `DATOS/IRSA_FITS_D1/level2_2025W22_1B_0399_1D1_spx_l2b-v20-2025-250.fits`
- `DATOS/IRSA_FITS_D1/level2_2025W27_2A_0443_1D1_spx_l2b-v20-2025-259.fits`
- `DATOS/IRSA_FITS_D1/analysis/epsf_D1_spx_cal-epsf-v1-2026-191.fits`
- Respuestas SkyBoT archivadas en `DATOS/IRSA_FITS_D1/analysis/`
- Evidencia de la consulta IRSA en `DATOS/consulta_irsa/`

Los SHA-256, tamaños y rutas están en `DATOS/entradas_manifest.json`. Para
recuperar los archivos grandes sin clonarlos:
`bash analysis/download_inputs.sh`.

## Estructura

```text
analysis/                  pipeline Python y documentación científica
DATOS/IRSA_FITS_D1/        FITS reales, ePSF, respuestas SkyBoT y resultados
DATOS/real_residual_catalog.json   catálogo real que consume la web
DATOS/entradas_manifest.json       hashes y procedencia de insumos
DATOS/prueba/              JSON sintéticos de prueba, NO científicos
script.js                  aplicación React del visor
src/                       entrada de Vite, estilos y fuentes
```

## Límites declarados

- **Espectroscopía:** la comprobación con `WCS-WAVE` valida que las posiciones
  comparables tengan longitudes de onda compatibles (diferencia máxima
  0.0001352 µm frente a un ancho de banda mediano de 0.02333 µm). Justifica
  comparar esta pareja sin reescalar el flujo, pero **no** reconstruye ni
  interpola espectros completos.
- **Ejecución local:** se usan FITS Level 2, la calibración ePSF y respuestas
  SkyBoT archivadas. Los insumos se publican en el repositorio; el pipeline no
  consulta esos servicios en vivo.
- **Trazabilidad temporal:** la fecha exacta de descarga/consulta de IRSA no
  quedó registrada. El `mtime` del archivo aparece en el manifiesto solo como
  dato del sistema de archivos; las fechas `DATE-OBS` son de observación, no de
  descarga.
- **Umbral 8σ:** es una decisión documentada de esta criba, no un umbral
  oficial de NASA. Se contrastaron posiciones con SkyBoT, pero **no** se hizo
  una prueba de inyección y recuperación para demostrar que 8σ sea óptimo.
- **Alcance:** dos épocas no demuestran movimiento orbital. La varianza es
  diagonal y no modela covarianza de remuestreo, incertidumbre de ZODI,
  búsqueda de centroides, deblend ni ajuste orbital.

## Datos y referencias

- DOI del archivo SPHEREx en IRSA: [`10.26131/IRSA652`](https://doi.org/10.26131/IRSA652)
- [SPHEREx Data Products (IRSA)](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
- [SPHEREx Data Access (IRSA)](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)
- [SPHEREx en AWS Open Data](https://registry.opendata.aws/spherex-qr/)
- [SkyBoT/IMCCE](https://ssp.imcce.fr/webservices/skybot/)

Los archivos de `DATOS/prueba/` son material sintético de prueba y están
separados del catálogo científico.
