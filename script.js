import React, { useState, useEffect, useRef, useMemo } from 'react';
import DETECTION_CATALOG from './DATOS/real_residual_catalog.json';
import REAL_DATA_META from './DATOS/real_residual_catalog.meta.json';
import PREVIEW_URL from './DATOS/IRSA_FITS_D1/analysis/difference_preview.png';
import LOGO_URL from './src/Imagen pegada.png';
import BACKGROUND_URL from './src/IMAGENfondo.png';
const PSF_CUTOUTS = import.meta.glob('./DATOS/IRSA_FITS_D1/analysis/psf_cutouts/*.png', { eager: true, query: '?url', import: 'default' });
import { 
  Search, Sliders, Play, Pause, ZoomIn, ZoomOut, RotateCcw, 
  Download, ExternalLink, HelpCircle, Eye, EyeOff, Layers, 
  Sparkles, FileText, CheckCircle2, 
  Activity, Info, ChevronRight, Share2, Compass, Sun, Moon
} from 'lucide-react';

const CATALOG_IMAGE_WIDTH = 1392;
const CATALOG_IMAGE_HEIGHT = 500;
const DETECTOR_IMAGE_WIDTH = 2040;
const DETECTOR_IMAGE_HEIGHT = 2040;
const CATALOG_PLOT_PADDING = 0;
const DETECTION_LIST_LIMIT = 60;
const OBSERVATION_GAP_DAYS = Math.round((Date.parse(REAL_DATA_META.epochs[1].date_obs) - Date.parse(REAL_DATA_META.epochs[0].date_obs)) / 86400000);
const CLASE_LABELS = {
  conocido: 'Conocido (SkyBoT)',
  residuo: 'Sin asociar',
  fuente: 'Sobre fuente',
};
const CLASE_NOTE = {
  conocido: 'Asociación posicional con un objeto de catálogo; no es un descubrimiento.',
  residuo: 'Residuo sin asociación confirmada. Requiere más épocas antes de llamarlo candidato.',
  fuente: 'El píxel está marcado por SPHEREx como mapeado a una fuente; no implica objeto nuevo.',
};

export default function App() {
  const [activeTab, setActiveTab] = useState('home'); // 'home' | 'dashboard' | 'docs'
  const [isLaunching, setIsLaunching] = useState(false);
  const [objects, setObjects] = useState(DETECTION_CATALOG);
  const [psfReview, setPsfReview] = useState(null);
  const [catalogFileName, setCatalogFileName] = useState('real_residual_catalog.json · pipeline SPHEREx D1');
  const [catalogUploadError, setCatalogUploadError] = useState('');
  const [selectedId, setSelectedId] = useState(DETECTION_CATALOG[0].id);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [minSnr, setMinSnr] = useState(0);

  const [zoom, setZoom] = useState(0.75);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [showCrosshair, setShowCrosshair] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const canvasRef = useRef(null);
  const catalogFileInputRef = useRef(null);
  const [canvasDimensions, setCanvasDimensions] = useState({ width: CATALOG_IMAGE_WIDTH, height: CATALOG_IMAGE_HEIGHT });
  const [previewImage, setPreviewImage] = useState(null);

  useEffect(() => {
    const image = new Image();
    image.onload = () => setPreviewImage(image);
    image.src = PREVIEW_URL;
  }, []);

  useEffect(() => {
    if (activeTab !== 'dashboard' || psfReview) return undefined;
    let active = true;
    import('./DATOS/IRSA_FITS_D1/analysis/psf_signal_review.json').then(({ default: review }) => {
      if (active) setPsfReview(review);
    });
    return () => { active = false; };
  }, [activeTab, psfReview]);

  const selectedObject = useMemo(() => objects.find(o => o.id === selectedId) || objects[0], [objects, selectedId]);
  const selectedPsfReview = psfReview?.records[selectedObject.id];
  const selectedPsfCutout = PSF_CUTOUTS[`./DATOS/IRSA_FITS_D1/analysis/psf_cutouts/${selectedObject.id}_epoch1_epoch2_difference.png`];
  const catalogStats = useMemo(() => objects.reduce((stats, obj) => {
    if (obj.clase === 'residuo') stats.residual += 1;
    if (obj.clase === 'conocido') stats.known += 1;
    if (obj.clase === 'fuente') stats.source += 1;
    return stats;
  }, { residual: 0, known: 0, source: 0 }), [objects]);
  const catalogPlotStyles = useMemo(() => new Map(objects.map(obj => [obj.id, {
    color: obj.clase === 'residuo' ? '#f4512e' : obj.clase === 'conocido' ? '#a8c2ef' : '#5b6b8c',
    radius: Math.min(1 + Math.sqrt(Math.max(0, obj.brillo_snr)) * 0.12, 2.4),
    alpha: Math.min(0.88, 0.28 + Math.log10(Math.max(0, obj.brillo_snr) + 1) * 0.2),
  }])), [objects]);
  const canvasCssWidth = canvasDimensions.cssWidth || CATALOG_IMAGE_WIDTH;
  const canvasCssHeight = canvasDimensions.cssHeight || CATALOG_IMAGE_HEIGHT;
  const selectedCanvasX = canvasCssWidth * (1 - zoom) / 2 + (CATALOG_PLOT_PADDING + selectedObject.pixel_pos.x * ((canvasCssWidth - CATALOG_PLOT_PADDING * 2) / DETECTOR_IMAGE_WIDTH)) * zoom;
  const selectedCanvasY = canvasCssHeight * (1 - zoom) / 2 + (CATALOG_PLOT_PADDING + selectedObject.pixel_pos.y * ((canvasCssHeight - CATALOG_PLOT_PADDING * 2) / DETECTOR_IMAGE_HEIGHT)) * zoom;
  const selectedCanvasLabel = `${selectedObject.id} (pico: ${selectedObject.brillo_snr}σ)`;
  const estimatedLabelWidth = selectedCanvasLabel.length * 7.2;
  const selectedLabelX = Math.min(Math.max(selectedCanvasX + 18, 8), canvasCssWidth - estimatedLabelWidth - 8);
  const selectedLabelY = selectedCanvasY + 26 < canvasCssHeight - 8
    ? selectedCanvasY + 26
    : Math.max(18, selectedCanvasY - 18);

  const filteredObjects = useMemo(() => {
    const normalizedSearch = searchQuery.toLowerCase();
    return objects.filter(obj => {
      const matchesSearch = obj.id.toLowerCase().includes(normalizedSearch) || obj.estado.toLowerCase().includes(normalizedSearch);
      const matchesStatus = statusFilter === 'ALL' || obj.clase === statusFilter;
      return matchesSearch && matchesStatus && obj.brillo_snr >= minSnr;
    });
  }, [objects, searchQuery, statusFilter, minSnr]);
  const visibleObjects = useMemo(() => filteredObjects.slice(0, DETECTION_LIST_LIMIT), [filteredObjects]);
  const monitoringTargetsRef = useRef(filteredObjects);
  const overlayCanvasRef = useRef(null);

  const loadCatalogJSON = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const rows = Array.isArray(parsed)
        ? parsed
        : parsed.detections || parsed.objetos_json || parsed.objects;
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('El archivo no contiene una lista de detecciones.');
      }
      const validRows = rows.every(obj =>
        obj && typeof obj.id === 'string' && typeof obj.estado === 'string' &&
        Number.isFinite(Number(obj.coordenadas?.ra)) && Number.isFinite(Number(obj.coordenadas?.dec)) &&
        Number.isFinite(Number(obj.pixel_pos?.x)) && Number.isFinite(Number(obj.pixel_pos?.y)) &&
        Number.isFinite(Number(obj.brillo_snr))
      );
      if (!validRows) {
        throw new Error('Faltan campos requeridos: id, estado, coordenadas, pixel_pos o brillo_snr.');
      }
      const normalizedRows = rows.map(obj => ({
        ...obj,
        clase: obj.clase || (obj.estado.includes('Candidato') ? 'residuo' : 'conocido'),
        procedencia: obj.procedencia || null,
      }));
      setObjects(normalizedRows);
      setSelectedId(rows[0].id);
      setCatalogFileName(file.name);
      setCatalogUploadError('');
      setIsMonitoring(false);
      setSearchQuery('');
      setStatusFilter('ALL');
      setMinSnr(0);
    } catch (error) {
      setCatalogUploadError(error instanceof Error ? error.message : 'No se pudo leer el JSON.');
    } finally {
      event.target.value = '';
    }
  };

  useEffect(() => {
    monitoringTargetsRef.current = filteredObjects;
  }, [filteredObjects]);

  useEffect(() => {
    if (!isMonitoring) return undefined;
    const interval = window.setInterval(() => {
      const targets = monitoringTargetsRef.current;
      if (targets.length < 2) {
        setIsMonitoring(false);
        return;
      }
      setSelectedId(currentId => {
        const currentIndex = targets.findIndex(obj => obj.id === currentId);
        return targets[(currentIndex + 1) % targets.length].id;
      });
    }, 900);
    return () => window.clearInterval(interval);
  }, [isMonitoring]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = canvas?.parentElement;
    if (!canvas || !frame || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      const scale = Math.min(box.width / CATALOG_IMAGE_WIDTH, box.height / CATALOG_IMAGE_HEIGHT);
      const cssWidth = Math.max(1, Math.floor(CATALOG_IMAGE_WIDTH * scale));
      const cssHeight = Math.max(1, Math.floor(CATALOG_IMAGE_HEIGHT * scale));
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
      const width = Math.max(1, Math.round(cssWidth * pixelRatio));
      const height = Math.max(1, Math.round(cssHeight * pixelRatio));
      setCanvasDimensions(current => current.width === width && current.height === height && current.cssWidth === cssWidth && current.cssHeight === cssHeight
        ? current
        : { width, height, cssWidth, cssHeight });
    });

    observer.observe(frame);
    return () => observer.disconnect();
  }, [activeTab]);

  useEffect(() => {
    if (!isLaunching) return undefined;
    const launchTimer = window.setTimeout(() => {
      setActiveTab('dashboard');
      setIsLaunching(false);
    }, 2200);
    return () => window.clearTimeout(launchTimer);
  }, [isLaunching]);

  // High-density rendering of catalog positions (this JSON has no FITS pixel array).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const pixelRatio = canvasDimensions.width / Math.max(1, canvasDimensions.cssWidth || CATALOG_IMAGE_WIDTH);
    const width = canvasDimensions.cssWidth || CATALOG_IMAGE_WIDTH;
    const height = canvasDimensions.cssHeight || CATALOG_IMAGE_HEIGHT;
    // Draw in CSS pixels while keeping a high-density backing bitmap for crisp lines and labels.
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Filter adjustments context
    ctx.save();
    ctx.translate(width * (1 - zoom) / 2, height * (1 - zoom) / 2);
    ctx.scale(zoom, zoom);
    ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;

    // Real difference map from the FITS pipeline (epoch 2 - epoch 1).
    ctx.fillStyle = '#050814';
    ctx.fillRect(0, 0, width, height);
    if (previewImage) {
      ctx.globalAlpha = 1;
      ctx.drawImage(previewImage, 0, 0, width, height);
    }

    // Draw a light reference grid behind the catalog points.
    if (showGrid) {
      const gridSize = 40;
      for (let x = 0, index = 0; x < width; x += gridSize, index += 1) {
        const majorLine = index % 5 === 0;
        ctx.strokeStyle = majorLine ? 'rgba(168, 194, 239, 0.38)' : 'rgba(92, 132, 210, 0.28)';
        ctx.lineWidth = majorLine ? 1.25 : 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0, index = 0; y < height; y += gridSize, index += 1) {
        const majorLine = index % 5 === 0;
        ctx.strokeStyle = majorLine ? 'rgba(168, 194, 239, 0.38)' : 'rgba(92, 132, 210, 0.28)';
        ctx.lineWidth = majorLine ? 1.25 : 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    }

    // Static catalog layer: redrawn only when data, filters or display settings change.
    filteredObjects.forEach((obj) => {
      // Map object pixel_pos to canvas space
      const canvasX = CATALOG_PLOT_PADDING + obj.pixel_pos.x * ((width - CATALOG_PLOT_PADDING * 2) / DETECTOR_IMAGE_WIDTH);
      const canvasY = CATALOG_PLOT_PADDING + obj.pixel_pos.y * ((height - CATALOG_PLOT_PADDING * 2) / DETECTOR_IMAGE_HEIGHT);
      const style = catalogPlotStyles.get(obj.id);
      ctx.globalAlpha = style.alpha;
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.arc(canvasX, canvasY, style.radius / zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    });

    ctx.restore();
  }, [filteredObjects, catalogPlotStyles, zoom, brightness, contrast, showGrid, canvasDimensions, previewImage]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const pixelRatio = canvasDimensions.width / Math.max(1, canvasDimensions.cssWidth || CATALOG_IMAGE_WIDTH);
    const width = canvasDimensions.cssWidth || CATALOG_IMAGE_WIDTH;
    const height = canvasDimensions.cssHeight || CATALOG_IMAGE_HEIGHT;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!showCrosshair || !filteredObjects.some(obj => obj.id === selectedObject.id)) return;

    const x = selectedCanvasX;
    const y = selectedCanvasY;
    const radius = catalogPlotStyles.get(selectedObject.id).radius;
    const crosshairSize = 18;
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, radius + 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - radius - 4);
    ctx.lineTo(x, y - radius - 4 - crosshairSize);
    ctx.moveTo(x, y + radius + 4);
    ctx.lineTo(x, y + radius + 4 + crosshairSize);
    ctx.moveTo(x - radius - 4, y);
    ctx.lineTo(x - radius - 4 - crosshairSize, y);
    ctx.moveTo(x + radius + 4, y);
    ctx.lineTo(x + radius + 4 + crosshairSize, y);
    ctx.stroke();
  }, [selectedObject, selectedCanvasX, selectedCanvasY, filteredObjects, catalogPlotStyles, zoom, showCrosshair, canvasDimensions]);

  // Handler for Exporting Data
  const exportJSON = () => {
    const exportRecord = {
      ...selectedObject,
      nota_procedencia: 'Registro derivado de dos FITS Level 2 QR2 de SPHEREx D1. DOI 10.26131/IRSA652. No es una confirmación de objeto ni de Planeta X.',
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportRecord, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `${selectedObject.id}_data.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const exportCSV = () => {
    const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const header = ['id','clase','ra','dec','pixel_x','pixel_y','brillo_snr','estado','fits_epoca_1','fits_epoca_2','fecha_epoca_1_utc','fecha_epoca_2_utc','doi'].join(',') + '\n';
    const p = selectedObject.procedencia || {};
    const row = [selectedObject.id, selectedObject.clase, selectedObject.coordenadas.ra, selectedObject.coordenadas.dec, selectedObject.pixel_pos.x, selectedObject.pixel_pos.y, selectedObject.brillo_snr, selectedObject.estado, p.fits_epoca_1, p.fits_epoca_2, p.fecha_epoca_1_utc, p.fecha_epoca_2_utc, selectedObject.doi_fuente].map(csvCell).join(',') + '\n';
    const dataStr = "data:text/csv;charset=utf-8," + encodeURIComponent(header + row);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `${selectedObject.id}_data.csv`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (


    <div className="novax-app min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans antialiased selection:bg-cyan-500 selection:text-slate-950">
      <style>{`
        .novax-app { --space-950:#11141c; --space-900:#171c28; --space-800:#293d67; --space-700:#354c79; --ice:#a8c2ef; --paper:#eff0f4; --flare:#f4512e; --font-novax-display:'Mokoto','Arial Black',sans-serif; --font-novax-ui:'Century Gothic','Avenir Next','Trebuchet MS',Arial,sans-serif; background:var(--space-950); color:var(--paper); font-family:var(--font-novax-ui); letter-spacing:.01em; }
        .novax-app h1,.novax-app h2,.novax-app h3 { font-family:var(--font-novax-display); font-weight:400; letter-spacing:.045em; text-transform:none; text-shadow:none; }
        .novax-app .font-mono { font-family:var(--font-novax-ui)!important; letter-spacing:.035em; }
        .novax-app [class*="bg-slate-950"] { background-color:var(--space-950)!important; }
        .novax-app [class*="bg-slate-900"] { background-color:rgba(23,28,40,.94)!important; }
        .novax-app [class*="border-slate-800"] { border-color:rgba(168,194,239,.16)!important; }
        .novax-app [class*="border-slate-700"] { border-color:rgba(168,194,239,.25)!important; }
        .novax-app [class*="text-cyan-"] { color:var(--ice)!important; }
        .novax-app [class*="bg-cyan-"] { background-color:rgba(168,194,239,.12)!important; }
        .novax-app [class*="border-cyan-"] { border-color:rgba(168,194,239,.5)!important; }
        .novax-app [class*="text-amber-"] { color:var(--flare)!important; }
        .novax-app [class*="bg-amber-"] { background-color:rgba(244,81,46,.12)!important; }
        .novax-app [class*="border-amber-"] { border-color:rgba(244,81,46,.42)!important; }
        .novax-app [class*="text-emerald-"] { color:var(--ice)!important; }
        .novax-app [class*="bg-emerald-"] { background-color:rgba(168,194,239,.12)!important; }
        .novax-app [class*="border-emerald-"] { border-color:rgba(168,194,239,.38)!important; }
        .novax-app header { background:rgba(17,20,28,.88)!important; border-color:rgba(168,194,239,.18)!important; }
        .novax-app button { letter-spacing:.02em; }
        .novax-app button:hover { filter:brightness(1.16); }
        .novax-app input[type="range"] { accent-color:var(--flare); }
        .novax-app .novax-logo { width:118px;height:58px;object-fit:contain;filter:brightness(0) invert(1);opacity:.95; }
        .novax-app .novax-header-logo { width:88px;height:42px;object-fit:contain;filter:brightness(0) invert(1);opacity:.96; }
        .novax-app input { font-family:var(--font-novax-ui); letter-spacing:.025em; }
        .novax-app .novax-panel { box-shadow:none; }
        .novax-app .novax-hero { min-height:calc(100vh - 70px); background-image:linear-gradient(180deg,rgba(12,16,25,.34),rgba(12,16,25,.7)),url('${BACKGROUND_URL}'); background-position:center; background-size:cover; background-repeat:no-repeat; }
        .novax-app .novax-hero-logo { width:min(390px,78vw);height:auto;object-fit:contain;filter:brightness(0) invert(1); }
        .novax-app .novax-hero-content { text-shadow:0 2px 24px rgba(0,0,0,.7); }
        .novax-dashboard-grid { display:grid;grid-template-columns:minmax(0,1fr); }
        .novax-center-column { min-height:520px; }
        @media (min-width:900px) and (min-aspect-ratio:4/3) { .novax-dashboard-grid { flex:0 0 calc(100vh - 7rem);height:calc(100vh - 7rem);grid-template-columns:240px minmax(0,1fr) 300px;grid-template-rows:minmax(0,1fr); } .novax-left-column { grid-column:1;grid-row:1; } .novax-center-column { grid-column:2;grid-row:1;min-height:0;align-self:start;height:max-content; } .novax-right-column { grid-column:3;grid-row:1;height:100%; } }
        @media (min-width:900px) and (max-aspect-ratio:4/3) { .novax-dashboard-grid { height:auto;grid-template-columns:240px minmax(0,1fr);align-items:start; } .novax-left-column { grid-column:1;grid-row:1/span 2;height:min(720px,calc(100vh - 7rem)); } .novax-center-column { grid-column:2;grid-row:1;min-height:520px; } .novax-right-column { grid-column:2;grid-row:2; } }
        .novax-launch-screen { position:fixed;inset:0;z-index:100;overflow:hidden;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 100%,rgba(41,61,103,.95),rgba(17,20,28,.98) 68%),url('${BACKGROUND_URL}') center/cover; }
        .novax-launch-screen::before,.novax-launch-screen::after { content:'';position:absolute;inset:-40%;background-image:radial-gradient(2px 2px at 10% 20%,#eff0f4 40%,transparent 60%),radial-gradient(1px 1px at 70% 33%,#a8c2ef 40%,transparent 60%),radial-gradient(2px 2px at 84% 72%,#eff0f4 40%,transparent 60%),radial-gradient(1px 1px at 38% 66%,#eff0f4 40%,transparent 60%);background-size:370px 320px;animation:novax-stars 10s linear infinite;opacity:.65; }
        .novax-launch-screen::after { background-position:170px 120px;animation-duration:15s;opacity:.35; }
        .novax-launch-copy { position:absolute;z-index:2;top:17%;width:100%;padding:0 1.5rem;text-align:center;animation:novax-copy-in .5s ease-out both; }
        .novax-launch-copy h2 { margin:0;color:#eff0f4;font-size:clamp(1.4rem,4vw,2.5rem);letter-spacing:.12em;text-transform:uppercase; }
        .novax-launch-copy p { margin:.7rem 0 0;color:#a8c2ef;font-size:.8rem;letter-spacing:.18em;text-transform:uppercase; }
        .novax-rocket-flight { position:absolute;z-index:3;left:50%;bottom:-230px;width:128px;height:220px;transform:translateX(-50%);animation:novax-rocket-flight 2.05s cubic-bezier(.48,0,.82,.6) forwards; }
        .novax-rocket-flight svg { position:relative;z-index:2;width:100%;height:160px;filter:drop-shadow(0 0 20px rgba(168,194,239,.35)); }
        .novax-rocket-flame { position:absolute;z-index:1;left:50%;top:128px;width:30px;height:125px;transform:translateX(-50%);transform-origin:top;background:linear-gradient(180deg,#fff 0%,#a8c2ef 22%,#f4512e 67%,transparent 100%);clip-path:polygon(24% 0,76% 0,100% 100%,50% 76%,0 100%);animation:novax-flame .12s ease-in-out infinite alternate;filter:drop-shadow(0 0 14px rgba(244,81,46,.75)); }
        @keyframes novax-rocket-flight { 0% { bottom:-230px;transform:translateX(-50%) rotate(-5deg); } 18% { bottom:20%;transform:translateX(-50%) rotate(0); } 100% { bottom:125%;transform:translateX(-50%) rotate(8deg); } }
        @keyframes novax-flame { from { transform:translateX(-50%) scaleY(.76) scaleX(.85); } to { transform:translateX(-50%) scaleY(1.12) scaleX(1.08); } }
        @keyframes novax-stars { from { transform:translateY(0); } to { transform:translateY(25%); } }
        @keyframes novax-copy-in { from { opacity:0;transform:translateY(12px); } to { opacity:1;transform:translateY(0); } }
        @media (prefers-reduced-motion: reduce) { .novax-launch-screen *, .novax-launch-screen::before, .novax-launch-screen::after { animation-duration:.01ms!important;animation-iteration-count:1!important; } }
        @media (max-width:640px) { .novax-app .novax-logo { width:90px;height:44px; } }
      `}</style>
      
      {/* HEADER / NAVIGATION BAR */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50 px-4 py-3">
        <div className="max-w-[1680px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            {activeTab !== 'home' && <img src={LOGO_URL} alt="NOVAX" className="novax-header-logo" />}
          </div>
          <nav aria-label="Navegación principal" className="flex items-center gap-2">
            <button onClick={() => setActiveTab('home')} className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${activeTab === 'home' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-slate-100'}`}>
              Inicio
            </button>
            <button onClick={() => setActiveTab('dashboard')} className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${activeTab === 'dashboard' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-slate-100'}`}>
              Visor
            </button>
            <button onClick={() => setActiveTab('docs')} className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${activeTab === 'docs' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-slate-100'}`}>
              Ayuda
            </button>
          </nav>
        </div>
      </header>

      {/* BODY CONTENT AREA */}
      {activeTab === 'home' ? (
        <main className="novax-hero relative flex flex-1 items-center justify-center px-6 py-16 text-center">
          <div className="novax-hero-content relative z-10 mx-auto flex max-w-3xl flex-col items-center">
            <img src={LOGO_URL} alt="NOVAX" className="novax-hero-logo mb-8" />
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.24em] text-sky-200">Exploración infrarroja</p>
            <h2 className="mb-4 text-3xl font-bold leading-tight text-white sm:text-5xl">Descubre lo que se mueve en el cielo</h2>
            <p className="mb-8 max-w-xl text-sm leading-relaxed text-slate-200 sm:text-base">
              Explora detecciones, revisa su posición y consulta sus mediciones en un solo lugar.
            </p>
            <button
              onClick={() => setIsLaunching(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-6 py-3 text-sm font-semibold text-slate-950 shadow-lg shadow-black/30 transition-transform hover:-translate-y-0.5"
            >
              Abrir visor infrarrojo <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-slate-950/70 to-transparent" />
        </main>
      ) : activeTab === 'dashboard' ? (
        <main className="novax-dashboard-grid flex-1 min-h-0 max-w-[1680px] w-full mx-auto px-4 py-3 gap-3">
          
          {/* LEFT SIDEBAR: FILTERS AND OBJECT LIST (3 cols) */}
          <div className="novax-left-column min-h-0 space-y-3 flex flex-col">
            
            {/* Filter Controls Card */}
          <div className="novax-panel bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                <span className="flex items-center"><Sliders className="h-3.5 w-3.5 mr-1.5 text-cyan-400" /> Filtros</span>
                <button 
                  onClick={() => { setStatusFilter('ALL'); setMinSnr(0); setSearchQuery(''); }}
                  className="text-[10px] text-slate-500 hover:text-slate-300"
                >
                  Restablecer
                </button>
              </div>

              <input
                ref={catalogFileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                aria-label="Seleccionar archivo JSON de detecciones"
                onChange={loadCatalogJSON}
              />
              <button
                type="button"
                onClick={() => catalogFileInputRef.current?.click()}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-[10px] font-medium text-slate-200 hover:border-cyan-500/60"
              >
                <FileText className="h-3.5 w-3.5 text-cyan-400" />
                Cargar JSON de resultados
              </button>
              <p className="truncate text-[9px] text-slate-500" title={catalogFileName} aria-live="polite">
                Archivo: {catalogFileName}
              </p>
              {catalogUploadError && (
                <p role="alert" className="rounded border border-orange-500/30 bg-orange-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-orange-300">
                  No se cargó: {catalogUploadError}
                </p>
              )}

              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  type="search"
                  aria-label="Buscar detecciones"
                  placeholder="Buscar por ID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 py-2 pl-8 pr-2 text-[11px] text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-500"
                />
              </div>

              {/* Status Select Buttons */}
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wide text-slate-500">Clasificación</label>
                <div className="grid grid-cols-4 gap-1">
                  <button
                    onClick={() => setStatusFilter('ALL')}
                    className={`py-1 text-[10px] rounded border ${statusFilter === 'ALL' ? 'bg-cyan-950 border-cyan-500 text-cyan-300' : 'bg-slate-950 border-slate-800 text-slate-400'}`}
                  >
                    Todas
                  </button>
                  <button
                    onClick={() => setStatusFilter('residuo')}
                    className={`py-1 text-[10px] rounded border ${statusFilter === 'residuo' ? 'bg-amber-950 border-amber-500 text-amber-300' : 'bg-slate-950 border-slate-800 text-slate-400'}`}
                  >
                    Sin asociar
                  </button>
                  <button
                    onClick={() => setStatusFilter('conocido')}
                    className={`py-1 text-[10px] rounded border ${statusFilter === 'conocido' ? 'bg-emerald-950 border-emerald-500 text-emerald-300' : 'bg-slate-950 border-slate-800 text-slate-400'}`}
                  >
                    Conocidos
                  </button>
                  <button
                    onClick={() => setStatusFilter('fuente')}
                    className={`py-1 text-[10px] rounded border ${statusFilter === 'fuente' ? 'bg-slate-800 border-slate-500 text-slate-200' : 'bg-slate-950 border-slate-800 text-slate-400'}`}
                  >
                    Fuente
                  </button>
                </div>
              </div>

              {/* Minimum SNR Slider */}
              <div className="space-y-1 pt-1">
                <div className="flex justify-between text-[11px] text-slate-400">
                  <span>Pico local mínimo (σ):</span>
                  <span className="font-mono text-cyan-400 font-semibold">{minSnr}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="150"
                  value={minSnr}
                  onChange={(e) => setMinSnr(Number(e.target.value))}
                  className="w-full accent-cyan-500 bg-slate-950 h-1.5 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>

            {/* Object List Container */}
            <div className="novax-panel bg-slate-900 border border-slate-800 rounded-xl p-3 flex-1 flex flex-col min-h-[220px] lg:min-h-0 overflow-hidden">
              <div className="text-xs font-semibold text-slate-300 mb-2 flex justify-between items-center">
                <span>Residuos ({filteredObjects.length.toLocaleString('es-ES')})</span>
              </div>

              <div className="space-y-2 overflow-y-auto flex-1 pr-1 custom-scrollbar">
                {filteredObjects.length === 0 ? (
                  <div className="text-center py-8 text-xs text-slate-500">
                    No se encontraron objetos con los filtros aplicados.
                  </div>
                ) : (
                  visibleObjects.map((obj) => {
                    const isSelected = obj.id === selectedObject.id;
                    const isUnassociated = obj.clase === 'residuo';
                    const isKnown = obj.clase === 'conocido';

                    return (
                      <div
                        key={obj.id}
                        onClick={() => setSelectedId(obj.id)}
                        className={`p-3 rounded-lg border text-left cursor-pointer transition-all duration-150 ${
                          isSelected
                            ? 'bg-cyan-950/40 border-cyan-500/70 shadow-sm shadow-cyan-500/10'
                            : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex flex-col items-start gap-1 mb-1">
                          <span className="font-mono font-bold text-[10px] text-slate-100 flex items-center whitespace-nowrap">
                            {isSelected && <ChevronRight className="h-3 w-3 text-cyan-400 mr-1 animate-pulse" />}
                            {obj.id}
                          </span>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                            isUnassociated
                              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                              : isKnown
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                : 'bg-slate-500/10 text-slate-300 border border-slate-500/20'
                          }`}>
                            Pico {obj.brillo_snr}σ
                          </span>
                        </div>

                        <div className="text-[11px] text-slate-400 space-y-0.5 font-mono">
                          <div>RA: {obj.coordenadas.ra.toFixed(4)}° | DEC: {obj.coordenadas.dec.toFixed(4)}°</div>
                        </div>

                        <div className="mt-2 pt-1.5 border-t border-slate-800/50 flex justify-between items-center text-[10px]">
                          <span className={isUnassociated ? 'text-amber-400 font-medium' : isKnown ? 'text-emerald-400 font-medium' : 'text-slate-400'}>
                            {CLASE_LABELS[obj.clase] || obj.clase}
                          </span>
                          <span className="text-slate-500">{obj.mision.replace(' · Level 2 QR2', '')}</span>
                        </div>
                      </div>
                    );
                  })
                )}
                {filteredObjects.length > visibleObjects.length && (
                  <p className="px-1 py-2 text-center text-[10px] leading-relaxed text-slate-500">
                    Mostrando {visibleObjects.length} de {filteredObjects.length.toLocaleString('es-ES')}. Usa la búsqueda para localizar otra detección.
                  </p>
                )}
              </div>
            </div>

          </div>

          {/* CENTER VIEWPORT: CATALOG POSITION MAP AND CONTROLS */}
          <div className="novax-center-column flex flex-col gap-3">
            
            <div className="novax-panel bg-slate-900 border border-slate-800 rounded-xl p-3 flex flex-col relative overflow-hidden">
              
              {/* Canvas Controls Header */}
              <div className="flex flex-wrap items-center justify-between pb-2 mb-2 border-b border-slate-800 gap-2">
                <div className="flex items-center space-x-2 text-xs font-semibold text-slate-200">
                  <Compass className="h-4 w-4 text-cyan-400" />
                  <span>Mapa de detecciones</span>
                  <span className="text-[10px] text-slate-500">FITS D1 · 2 épocas · {OBSERVATION_GAP_DAYS} días · rojo: aumenta / azul: disminuye</span>
                </div>

                <div className="flex items-center space-x-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
                  <button 
                    onClick={() => setZoom(z => Math.min(z + 0.25, 2.5))}
                    className="p-1 hover:bg-slate-800 rounded text-slate-300"
                    title="Acercar Zoom"
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </button>
                  <button 
                    onClick={() => setZoom(z => Math.max(z - 0.25, 0.75))}
                    className="p-1 hover:bg-slate-800 rounded text-slate-300"
                    title="Alejar Zoom"
                  >
                    <ZoomOut className="h-3.5 w-3.5" />
                  </button>
                  <button 
                    onClick={() => { setZoom(0.75); setBrightness(100); setContrast(100); }}
                    className="p-1 hover:bg-slate-800 rounded text-slate-300"
                    title="Restablecer Vista"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                  <div className="h-3 w-px bg-slate-800 mx-0.5" />
                  <button 
                    onClick={() => setShowCrosshair(!showCrosshair)}
                    className={`p-1 rounded ${showCrosshair ? 'text-cyan-400 bg-cyan-950' : 'text-slate-500'}`}
                    title="Alternar Retícula de Selección"
                  >
                    {showCrosshair ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  </button>
                  <button 
                    onClick={() => setShowGrid(!showGrid)}
                    className={`p-1 rounded ${showGrid ? 'text-cyan-400 bg-cyan-950' : 'text-slate-500'}`}
                    title="Alternar Cuadrícula"
                  >
                    <Layers className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Catalog Position Map */}
              <div className="relative w-full aspect-[1392/500] bg-slate-950 rounded-lg overflow-hidden border border-slate-800 flex-none flex items-center justify-center">
                <canvas
                  ref={canvasRef}
                  width={canvasDimensions.width}
                  height={canvasDimensions.height}
                  style={{ width: canvasDimensions.cssWidth || '100%', height: canvasDimensions.cssHeight || '100%' }}
                  className="max-w-full max-h-full cursor-crosshair"
                />
                <canvas
                  ref={overlayCanvasRef}
                  width={canvasDimensions.width}
                  height={canvasDimensions.height}
                  style={{ width: canvasDimensions.cssWidth || '100%', height: canvasDimensions.cssHeight || '100%' }}
                  className="pointer-events-none absolute left-1/2 top-1/2 max-w-full max-h-full -translate-x-1/2 -translate-y-1/2"
                  aria-hidden="true"
                />

                {showCrosshair && (
                  <span
                    className="absolute z-10 pointer-events-none rounded bg-slate-950/80 px-1.5 py-0.5 text-[11px] leading-4 font-mono text-slate-100 shadow-[0_1px_8px_rgba(0,0,0,.85)] whitespace-nowrap"
                    style={{
                      left: `calc(50% - ${canvasCssWidth / 2}px + ${selectedLabelX}px)`,
                      top: `calc(50% - ${canvasCssHeight / 2}px + ${selectedLabelY}px)`,
                    }}
                  >
                    {selectedCanvasLabel}
                  </span>
                )}

                {/* Status Overlay Badge */}
                <div className="absolute top-3 left-3 bg-slate-900/80 backdrop-blur border border-slate-800 px-2.5 py-1 rounded text-[10px] font-mono text-slate-300">
                  <span className="text-cyan-400 font-bold">RESIDUO</span> · {selectedObject.id}
                </div>

                <div className="absolute top-3 right-3 bg-slate-900/80 backdrop-blur border border-slate-800 px-2.5 py-1 rounded text-[10px] font-mono text-slate-400">
                  Zoom {(zoom * 100).toFixed(0)}%
                </div>
              </div>

              {/* Brand mark directly below the detection map */}
              <div className="flex justify-center items-center py-3" aria-label="NOVAX">
                <img
                  src={LOGO_URL}
                  alt="NOVAX"
                  className="h-16 w-auto object-contain opacity-90"
                  style={{ filter: 'brightness(0) invert(1)' }}
                />
              </div>

              {/* Catalog legend and display controls */}
              <div className="mt-3 pt-2 border-t border-slate-800/80 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div className="flex flex-col justify-center gap-2 bg-slate-950 p-2 rounded-lg border border-slate-800 text-[10px]">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setIsMonitoring(value => !value)}
                      className={`shrink-0 rounded-full p-1.5 transition-colors ${isMonitoring ? 'bg-orange-500/20 text-orange-300' : 'bg-cyan-500/20 text-cyan-300'}`}
                      title={isMonitoring ? 'Pausar recorrido del catálogo' : 'Recorrer detecciones del catálogo'}
                      aria-label={isMonitoring ? 'Pausar recorrido del catálogo' : 'Recorrer detecciones del catálogo'}
                    >
                      {isMonitoring ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </button>
                    <div className="min-w-0">
                      <div className="text-slate-300">{isMonitoring ? 'Recorriendo detecciones' : 'Catálogo de residuos'}</div>
                      <div className="text-slate-500">{filteredObjects.length.toLocaleString('es-ES')} registros · no es una animación temporal</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-slate-800 pt-1.5">
                    <span className="inline-flex items-center gap-1.5 text-slate-300"><i className="inline-block h-2 w-2 rounded-full bg-orange-500" />Sin asociar</span>
                    <span className="inline-flex items-center gap-1.5 text-slate-300"><i className="inline-block h-2 w-2 rounded-full bg-[#a8c2ef]" />Conocido</span>
                    <span className="inline-flex items-center gap-1.5 text-slate-300"><i className="inline-block h-2 w-2 rounded-full bg-[#5b6b8c]" />Fuente</span>
                  </div>
                </div>

                {/* Brightness Control */}
                <div className="flex flex-col justify-center bg-slate-950 p-2 rounded-lg border border-slate-800 space-y-1">
                  <div className="flex justify-between text-[10px] text-slate-400">
                    <span className="flex items-center"><Sun className="h-3 w-3 mr-1 text-slate-500" /> Brillo</span>
                    <span className="font-mono">{brightness}%</span>
                  </div>
                  <input
                    type="range"
                    min="50"
                    max="200"
                    value={brightness}
                    onChange={(e) => setBrightness(Number(e.target.value))}
                    className="w-full accent-cyan-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                  />
                </div>

                {/* Contrast Control */}
                <div className="flex flex-col justify-center bg-slate-950 p-2 rounded-lg border border-slate-800 space-y-1">
                  <div className="flex justify-between text-[10px] text-slate-400">
                    <span className="flex items-center"><Moon className="h-3 w-3 mr-1 text-slate-500" /> Contraste</span>
                    <span className="font-mono">{contrast}%</span>
                  </div>
                  <input
                    type="range"
                    min="50"
                    max="200"
                    value={contrast}
                    onChange={(e) => setContrast(Number(e.target.value))}
                    className="w-full accent-cyan-500 bg-slate-800 h-1 rounded appearance-none cursor-pointer"
                  />
                </div>

              </div>

            </div>

          </div>

          {/* RIGHT SIDEBAR: OBJECT DETAILS & EXPORT (3 cols) */}
          <div className="novax-right-column min-h-0 overflow-y-auto">

            <section className="mb-2 rounded-xl border border-cyan-900/70 bg-cyan-950/20 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-cyan-300">Etapa 2 · revisión ePSF</div>
              {psfReview ? <>
                <div className="mt-1 text-xs font-semibold text-slate-100">{psfReview.counts.unassociated_residuals} residuos sin asociar: ninguno corroborado como fuente puntual</div>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-400">La señal conocida 1994 WZ3 sí muestra flujo puntual positivo en la primera época y desaparece de esa posición en la segunda. No se identifica Planeta X.</p>
              </> : <p className="mt-1 text-[10px] text-slate-400">Cargando mediciones ePSF…</p>}
            </section>
            
            <div className="novax-panel bg-slate-900 border border-slate-800 rounded-xl p-3.5 space-y-3">
              
              <div className="border-b border-slate-800 pb-3">
                <div className="flex items-center justify-between">
                  <h2 className="font-mono font-bold text-[11px] leading-tight text-slate-100">{selectedObject.id}</h2>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${
                    selectedObject.clase === 'residuo'
                      ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                      : selectedObject.clase === 'conocido'
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : 'bg-slate-500/10 text-slate-300 border-slate-500/30'
                  }`}>
                    {CLASE_LABELS[selectedObject.clase] || selectedObject.clase}
                  </span>
                </div>
              </div>

              {/* Data Breakdown Table */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
                <section className={`col-span-2 rounded-lg border p-3 ${selectedObject.clase === 'residuo' ? 'border-orange-500/30 bg-orange-500/5' : selectedObject.clase === 'conocido' ? 'border-[#a8c2ef]/25 bg-[#a8c2ef]/5' : 'border-slate-500/25 bg-slate-500/5'}`}>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Clasificación del pipeline</div>
                  <p className={`font-semibold ${selectedObject.clase === 'residuo' ? 'text-[#f4512e]' : selectedObject.clase === 'conocido' ? 'text-[#a8c2ef]' : 'text-slate-300'}`}>{selectedObject.estado}</p>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{CLASE_NOTE[selectedObject.clase] || ''}</p>
                </section>
                <section className="col-span-2 grid grid-cols-2 gap-x-3 border-b border-slate-800 pb-3">
                  <h3 className="col-span-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Coordenadas</h3>
                  <div><div className="text-slate-500">RA</div><div className="font-medium text-cyan-300">{selectedObject.coordenadas.ra}°</div></div>
                  <div><div className="text-slate-500">Dec</div><div className="font-medium text-cyan-300">{selectedObject.coordenadas.dec}°</div></div>
                </section>

                <section className="col-span-2 grid grid-cols-2 gap-x-3 gap-y-2 border-b border-slate-800 pb-3">
                  <h3 className="col-span-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-0">Mediciones</h3>
                  <div><div className="text-slate-500">Pico local (σ)</div><div className="font-bold text-slate-100">{selectedObject.brillo_snr}</div></div>
                  <div><div className="text-slate-500">Píxel (x, y)</div><div className="text-slate-200">{selectedObject.pixel_pos.x}, {selectedObject.pixel_pos.y}</div></div>
                  <div><div className="text-slate-500">Polaridad</div><div className="text-slate-200">{selectedObject.procedencia?.polaridad || '—'}</div></div>
                  <div><div className="text-slate-500">Umbral DAO</div><div className="text-slate-200">{selectedObject.procedencia?.umbral_deteccion_sigma ?? '—'}σ</div></div>
                  <p className="col-span-2 text-[10px] text-slate-500">El pico local puede quedar bajo el umbral DAO, que se aplica a la respuesta convolucionada.</p>
                </section>

                {selectedPsfReview && <section className="col-span-2 border-b border-slate-800 pb-3 space-y-2">
                  <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Revisión ePSF en los FITS originales</h3>
                  <p className={`text-[10px] leading-relaxed ${selectedPsfReview.classification === 'residuo' ? 'text-amber-300' : 'text-slate-300'}`}>
                    {selectedPsfReview.classification === 'residuo'
                      ? selectedPsfReview.review_status
                      : 'Ajuste ePSF disponible como control; no es una clasificación de objeto.'}
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    {['epoch1', 'epoch2'].map((epochKey, index) => {
                      const fit = selectedPsfReview.epochs[epochKey];
                      const date = REAL_DATA_META.epochs[index].date_obs.slice(0, 10);
                      return <div key={epochKey} className="rounded border border-slate-800 bg-slate-950/60 p-2">
                        <div className="text-slate-500">{index === 0 ? 'Época 1' : 'Época 2'} · {date}</div>
                        <div className="mt-1 text-slate-200">SNR ePSF: {fit.psf_snr == null ? '—' : Number(fit.psf_snr).toFixed(1)}σ</div>
                        <div className="text-slate-400">χ² reducido: {fit.chi2_reduced == null ? '—' : Number(fit.chi2_reduced).toFixed(2)}</div>
                      </div>;
                    })}
                  </div>
                  {selectedPsfCutout && <div>
                    <img src={selectedPsfCutout} alt={`Recortes ePSF de ${selectedObject.id}: época 1, época 2 y diferencia`} className="w-full rounded border border-slate-800" />
                    <div className="mt-1 text-[9px] text-slate-500">De izquierda a derecha: FITS original época 1, FITS original época 2 y mapa de diferencia. La cruz marca la posición consultada.</div>
                  </div>}
                  <p className="text-[9px] leading-relaxed text-slate-500">La ePSF oficial de D1 se ajustó en la misma coordenada celeste en ambas épocas. Un ajuste negativo o con χ² alto no representa una fuente física; con solo dos épocas no se demuestra movimiento orbital.</p>
                </section>}

                <section className="col-span-2 grid grid-cols-2 items-center gap-x-3 gap-y-2 border-b border-slate-800 pb-3">
                  <h3 className="col-span-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Procedencia</h3>
                  <div className="col-span-2"><div className="text-slate-500">FITS época 1</div><div className="break-all font-mono text-[9px] text-slate-300">{selectedObject.procedencia?.fits_epoca_1 || '—'}</div><div className="text-[9px] text-slate-500">{selectedObject.procedencia?.fecha_epoca_1_utc}</div></div>
                  <div className="col-span-2"><div className="text-slate-500">FITS época 2</div><div className="break-all font-mono text-[9px] text-slate-300">{selectedObject.procedencia?.fits_epoca_2 || '—'}</div><div className="text-[9px] text-slate-500">{selectedObject.procedencia?.fecha_epoca_2_utc}</div></div>
                  <div><div className="text-slate-500">SkyBoT más cercano</div><div className="text-slate-200">{selectedObject.procedencia?.skybot_mas_cercano || 'ninguno'}</div></div>
                  <div><div className="text-slate-500">Separación</div><div className="text-slate-200">{selectedObject.procedencia?.skybot_separacion_arcsec != null ? `${selectedObject.procedencia.skybot_separacion_arcsec}"` : '—'}</div></div>
                </section>

                <section className="col-span-2 grid grid-cols-2 items-center gap-x-3">
                  <h3 className="col-span-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Fuente</h3>
                  <div><div className="text-slate-500">Misión / detector</div><div className="text-slate-200">{selectedObject.mision}</div></div>
                  <a href={`https://doi.org/${selectedObject.doi_fuente}`} target="_blank" rel="noopener noreferrer" className="justify-self-end text-cyan-300 hover:text-cyan-200 text-[10px] flex items-center underline">
                    DOI {selectedObject.doi_fuente} <ExternalLink className="h-3 w-3 ml-1" />
                  </a>
                  <p className="col-span-2 text-[10px] leading-relaxed text-slate-500">
                    Registro derivado de dos FITS Level 2 QR2 de SPHEREx D1 mediante resta alineada con WCS. No es una confirmación de objeto ni de Planeta X.
                  </p>
                </section>
              </div>

              {/* Export Action Buttons */}
              <div className="pt-2 space-y-2">
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Descargar ficha</div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={exportJSON}
                    className="flex items-center justify-center space-x-1 py-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-700 rounded-lg text-xs font-medium text-slate-200 transition-colors"
                  >
                    <Download className="h-3.5 w-3.5 text-cyan-400" />
                    <span>JSON</span>
                  </button>
                  <button
                    onClick={exportCSV}
                    className="flex items-center justify-center space-x-1 py-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-700 rounded-lg text-xs font-medium text-slate-200 transition-colors"
                  >
                    <Download className="h-3.5 w-3.5 text-emerald-400" />
                    <span>CSV</span>
                  </button>
                </div>
              </div>

            </div>

          </div>

        </main>
      ) : (
        /* DOCUMENTATION & METHODOLOGY VIEW */
        <main className="flex-1 max-w-6xl w-full mx-auto p-4 space-y-6">
          
          {/* Header intro */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 relative overflow-hidden">
            <h2 className="text-2xl font-bold text-slate-100 mb-2">
              Ayuda del visor
            </h2>
            <p className="text-slate-300 text-sm max-w-4xl leading-relaxed">
              NOVAX visualiza y documenta una criba de diferencias entre dos imágenes espectrales Level 2 del detector D1 de SPHEREx, separadas por {OBSERVATION_GAP_DAYS} días. Los {objects.length.toLocaleString('es-ES')} registros son residuos detectados, no objetos confirmados. En esta muestra no hay candidato corroborado a Planeta X.
            </p>
          </div>

          <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center space-x-2 text-cyan-400 font-semibold text-sm">
              <FileText className="h-4 w-4" />
              <h3>Trazabilidad de los datos</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 mb-1">DOI del archivo SPHEREx</div>
                <a className="text-cyan-300 underline" href="https://doi.org/10.26131/IRSA652" target="_blank" rel="noopener noreferrer">10.26131/IRSA652 <ExternalLink className="inline h-3 w-3" /></a>
              </div>
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 mb-1">Archivo NASA/IPAC IRSA</div>
                <a className="text-cyan-300 underline" href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noopener noreferrer">SPHEREx en IRSA <ExternalLink className="inline h-3 w-3" /></a>
              </div>
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 mb-1">Copia de datos en la nube</div>
                <a className="text-cyan-300 underline" href="https://registry.opendata.aws/spherex-qr/" target="_blank" rel="noopener noreferrer">AWS Open Data Registry <ExternalLink className="inline h-3 w-3" /></a>
              </div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full min-w-[850px] text-left text-[11px]">
                <thead className="bg-slate-950 text-slate-400"><tr><th className="p-2">Observación / archivo FITS</th><th className="p-2">Fecha de observación (UTC)</th><th className="p-2">Centro RA</th><th className="p-2">Centro Dec</th><th className="p-2">Tamaño</th></tr></thead>
                <tbody>{REAL_DATA_META.epochs.map((epoch) => <tr key={epoch.file} className="border-t border-slate-800 text-slate-300">
                  <td className="p-2"><div className="font-mono">{epoch.observation_id}</div><div className="break-all font-mono text-slate-500">{epoch.file}</div></td>
                  <td className="p-2 whitespace-nowrap">{new Date(epoch.date_obs + 'Z').toLocaleString('es-ES', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'medium' })} UTC</td>
                  <td className="p-2">{epoch.ra_center_deg.toFixed(6)}°</td><td className="p-2">{epoch.dec_center_deg.toFixed(6)}°</td>
                  <td className="p-2">{epoch.image_shape[0]} × {epoch.image_shape[1]} px</td>
                </tr>)}</tbody>
              </table>
            </div>
            <p className="text-[10px] text-slate-500">Las fechas de observación y centros vienen de los encabezados/metadatos FITS. La fecha exacta de consulta o descarga de IRSA no quedó registrada en los archivos del proyecto; no se debe confundir con la fecha de observación.</p>
          </section>

          <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
            <div className="flex items-center space-x-2 text-cyan-400 font-semibold text-sm"><Activity className="h-4 w-4" /><h3>Cómo se procesaron las observaciones</h3></div>
            <ol className="list-decimal list-inside space-y-2 text-xs text-slate-300 leading-relaxed">
              <li>Se leyó la imagen calibrada <code>IMAGE</code> y se restó el modelo zodiacal <code>ZODI</code> de cada época.</li>
              <li>Se usó el WCS de los FITS para transformar posiciones entre píxeles y cielo y realinear la época 2 en la cuadrícula de la época 1. Luego se calculó época 2 menos época 1.</li>
              <li><code>FLAGS</code> se usó para excluir píxeles marcados con problemas de calidad. <code>VARIANCE</code> estima incertidumbre: se propagó con los pesos de interpolación y se combinó con la incertidumbre de ambas épocas.</li>
              <li>La búsqueda usa DAOStarFinder sobre la significancia residual convolucionada con umbral de <strong>8σ</strong>. Es el umbral elegido para esta criba del proyecto, no un umbral oficial de NASA. El pico local que se muestra en cada ficha puede ser menor.</li>
            </ol>
            <div className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-3 text-[11px] leading-relaxed text-amber-100/80">
              <strong>Alineación espectral y límites:</strong> se consultó la tabla <code>WCS-WAVE</code> para revisar la longitud de onda local. Para los cuatro residuos sin asociar, las longitudes de onda entre épocas son compatibles dentro de su banda. No se hizo una re-rejilla/corrección espectral global de todo el campo; por eso el mapa es una criba comparativa, no una resta espectral plenamente homogeneizada. La varianza propagada es diagonal y no modela la covarianza inducida por el remuestreo.
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs text-slate-300 leading-relaxed">
              <strong className="text-cyan-300">Etapa 2 · revisión ePSF.</strong> La ePSF es un modelo calibrado de cómo la óptica y el detector distribuyen la luz de una fuente puntual en varios píxeles. Se ajustó en las ubicaciones de las detecciones sobre los FITS de ambas épocas. Ninguno de los cuatro residuos sin asociar quedó corroborado como una fuente puntual positiva en la época esperada. Esto no identifica su causa ni demuestra que sea imposible que exista un objeto; tampoco confirma Planeta X.
              {' '}Calibración utilizada: <a className="text-cyan-300 underline" href="https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr3/epsf/cal-epsf-v1-2026-191/1/epsf_D1_spx_cal-epsf-v1-2026-191.fits" target="_blank" rel="noopener noreferrer">ePSF D1 de IRSA <ExternalLink className="inline h-3 w-3" /></a>.
            </div>
          </section>

          {/* Technical Glossary & Data Dictionary */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center space-x-2 text-cyan-400 font-semibold text-sm">
              <HelpCircle className="h-4 w-4" />
              <h3>Qué significan los datos</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 text-xs">
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                  <div className="font-mono text-cyan-300 font-bold mb-1">RA y Dec</div>
                <p className="text-slate-400 text-[11px]">
                  Indican la posición del objeto en el cielo, en grados.
                </p>
              </div>

              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                  <div className="font-mono text-emerald-400 font-bold mb-1">Señal / ruido</div>
                <p className="text-slate-400 text-[11px]">
                  El pico local es cuántas veces supera el ruido en ese punto. La detección se seleccionó con un filtro convolucionado de 8σ, así que el pico mostrado puede ser menor; ninguno de los dos confirma que sea un objeto nuevo.
                </p>
              </div>

              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                  <div className="font-mono text-amber-300 font-bold mb-1">Píxel (x, y)</div>
                <p className="text-slate-400 text-[11px]">
                  Posición medida en el mapa de diferencia: X es la columna horizontal e Y la fila vertical. No son coordenadas del cielo; esas son RA y Dec.
                </p>
              </div>
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                <div className="font-mono text-orange-300 font-bold mb-1">Polaridad P / N</div>
                <p className="text-slate-400 text-[11px]">P: aumento residual en época 2. N: disminución en época 2 (o señal mayor en época 1). Es el signo de la diferencia, no una clase de objeto.</p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px] text-slate-300">
              <p><strong className="text-slate-100">Buscar por ID:</strong> escribe el identificador completo, por ejemplo <code>SPX-D1-P0002</code>. El ID de NOVAX no es un número oficial de asteroide.</p>
              <p><strong className="text-slate-100">Filtro de señal mínima:</strong> oculta o muestra registros según su pico local en σ; actualiza la lista y el mapa, pero no vuelve a procesar FITS.</p>
              <p><strong className="text-slate-100">JSON / CSV:</strong> descarga la ficha técnica del registro seleccionado, no las imágenes FITS ni el catálogo entero.</p>
              <p><strong className="text-slate-100">Seleccionar:</strong> elige una fila para centrar la retícula y consultar mediciones, procedencia y revisión ePSF cuando existe.</p>
            </div>
          </div>

          {/* Example observations */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2 text-amber-400 font-semibold text-sm">
                <CheckCircle2 className="h-4 w-4" />
                <h3>En esta muestra</h3>
              </div>
              <span className="text-[10px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">
                {objects.length.toLocaleString('es-ES')} detecciones
              </span>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              <strong>Observado:</strong> dos imágenes Level 2 calibradas de SPHEREx D1. <strong>Detectado:</strong> {objects.length.toLocaleString('es-ES')} residuos en la diferencia. <strong>Clasificado:</strong> {catalogStats.source.toLocaleString('es-ES')} caen en píxeles marcados MP_SOURCE, {catalogStats.known.toLocaleString('es-ES')} tienen asociación posicional con 1994 WZ3 y {catalogStats.residual.toLocaleString('es-ES')} quedan sin asociar. No son {objects.length.toLocaleString('es-ES')} cuerpos confirmados.
            </p>

            <div className="bg-slate-950/80 p-3 rounded-lg border border-slate-800 text-xs text-slate-300">
              <strong>Inferencia:</strong> {objects.find(o => o.clase === 'conocido')?.procedencia?.skybot_objeto || '1994 WZ3'} coincide a {(objects.find(o => o.clase === 'conocido')?.procedencia?.skybot_separacion_arcsec ?? 2.416)}&quot; con la posición catalogada por <a className="text-cyan-300 underline" href="https://ssp.imcce.fr/webservices/skybot/" target="_blank" rel="noopener noreferrer">SkyBoT/IMCCE</a>; su efeméride de la segunda época cae fuera del detector. Este pipeline usó SkyBoT, no una consulta independiente a JPL SBDB. <strong>Sin asociar:</strong> no hubo coincidencia confirmada en esta criba y la ePSF no corroboró las cuatro como fuentes puntuales positivas en la época esperada. <strong>Especulación:</strong> ningún registro se identifica como Planeta X.
            </div>
          </div>

          <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
            <div className="flex items-center space-x-2 text-cyan-400 font-semibold text-sm"><ExternalLink className="h-4 w-4" /><h3>Reproducibilidad y código</h3></div>
            <p className="text-xs text-slate-300 leading-relaxed">El pipeline local se ejecuta en Python sobre los FITS Level 2 ya descargados. Los scripts y dependencias están en esta entrega; esto no equivale a descargar automáticamente datos crudos ni a una reproducción desde telemetría. La fecha de consulta/descarga de IRSA no está registrada.</p>
            <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-[10px] text-cyan-200"><code>{`.venv-astro/bin/python analysis/first_pass_spherex.py\n.venv-astro/bin/python analysis/crossmatch_skybot.py\n.venv-astro/bin/python analysis/build_real_catalog.py\n.venv-astro/bin/python analysis/review_psf_signals.py`}</code></pre>
            <div className="text-[11px] text-amber-200">Repositorio público de GitHub: aún no hay una URL configurada en el proyecto. No se muestra un enlace inventado.</div>
          </section>

        </main>
      )}

      {/* FOOTER */}
      <footer className={`${activeTab === 'home' ? 'hidden' : ''} border-t border-slate-800 bg-slate-950 py-4 px-4 text-center text-xs text-slate-500`}>
        <div className="max-w-[1680px] mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
          <div>NOVAX · Visor infrarrojo</div>
          <div className="flex items-center space-x-4">
            <span>DOI: 10.26131/IRSA652</span>
            <span>•</span>
            <button onClick={() => setActiveTab('docs')} className="hover:text-cyan-400 underline">
              Ayuda del visor
            </button>
          </div>
        </div>
      </footer>

      {isLaunching && (
        <div className="novax-launch-screen" role="status" aria-live="polite" aria-label="Abriendo visor infrarrojo">
          <div className="novax-launch-copy">
            <h2>Iniciando visor</h2>
            <p>Preparando exploración</p>
          </div>
          <div className="novax-rocket-flight" aria-hidden="true">
            <div className="novax-rocket-flame" />
            <svg viewBox="0 0 100 150" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M50 5C33 20 25 43 25 78v30h50V78C75 43 67 20 50 5Z" fill="#EFF0F4" />
              <path d="M25 72 8 101l17-5M75 72l17 29-17-5" fill="#A8C2EF" />
              <circle cx="50" cy="57" r="11" fill="#293D67" stroke="#F4512E" strokeWidth="4" />
              <path d="M38 107h24l-5 20H43l-5-20Z" fill="#F4512E" />
              <path d="M44 127h12l-6 17-6-17Z" fill="#A8C2EF" />
            </svg>
          </div>
        </div>
      )}

    </div>
  );
}
