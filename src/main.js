import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw";
import "leaflet-draw/dist/leaflet.draw.css";
import { createClient } from "@supabase/supabase-js";
import datosSemilla from "./datos_semilla.json";
import "./style.css";

// Fix para los iconos de Leaflet en Vite
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// Cliente opcional de Supabase (si están configuradas las llaves en .env)
const supabaseUrl = import.meta.env.SUPABASE_URL;
const supabaseKey = import.meta.env.SUPABASE_PUBLISHABLE_KEY;
const supabase =
  supabaseUrl && supabaseKey && supabaseUrl.startsWith("http")
    ? createClient(supabaseUrl, supabaseKey)
    : null;

// ============================================================================
// ESTADO CENTRAL DE LA APLICACIÓN
// ============================================================================
const estadoApp = {
  vistaActual: "tecnico", // "tecnico" | "agricultor" | "bitacora"
  plagas: datosSemilla.plagas || [],
  parcelas: datosSemilla.parcelas || [],
  tecnicos: datosSemilla.tecnicos || [],
  productores: datosSemilla.productores || [],
  reportes: datosSemilla.reportes || [],
  avisos: datosSemilla.avisos || [],
  casosPrevios: datosSemilla.casos_previos || [],
  casosHistorial: datosSemilla.casos_historial || [],
  bitacora: [],

  // Filtros en Vista Técnico
  filtroSemaforo: "todos",
  filtroCondicion: "todos",
  filtroPlaga: "todas",
  filtroTecnico: "todos",
  filtroBusqueda: "",
  mostrarRadiosBrote: true,
  mostrarBasesTecnicos: true,
  incluirCasosPrevios: false,

  // Selección en Vista Agricultor
  productorActualId: "PR-101",
  parcelaActual: null,
  plagaActual: null,
};

// Mapas de búsqueda rápida por ID
let mapaPlagas = new Map();
let mapaParcelas = new Map();
let mapaTecnicos = new Map();
let mapaProductores = new Map();
let mapaReportes = new Map();

function reconstruirIndices() {
  mapaPlagas = new Map(estadoApp.plagas.map((p) => [p.id, p]));
  mapaParcelas = new Map(estadoApp.parcelas.map((p) => [p.id, p]));
  mapaTecnicos = new Map(estadoApp.tecnicos.map((t) => [t.id, t]));
  mapaProductores = new Map(estadoApp.productores.map((pr) => [pr.id, pr]));
  mapaReportes = new Map(estadoApp.reportes.map((r) => [r.id, r]));
}
reconstruirIndices();

// ============================================================================
// UTILIDADES MATEMÁTICAS Y DE REGLAS OFICIALES (SECCIONES 7, 8 Y BROTES)
// ============================================================================
function redondearComercial(val) {
  return Math.floor(Number(val) + 0.5);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const toRad = (g) => (g * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcularPrioridadSemaforoDesglosado(plagaInfo, parcelaInfo, pctInput) {
  if (!plagaInfo || !parcelaInfo) {
    return {
      prioridad: 0,
      semaforo: "desconocido",
      ptsSeveridad: 0,
      ptsSuperficie: 0,
      ptsEtapa: 0,
      haAfectadas: 0,
      tiempoVisita: "--",
      esCuarentenaria: false,
    };
  }

  const supTotal = Number(parcelaInfo.superficie_ha) || 0;
  const pct = pctInput !== null && pctInput !== undefined ? Number(pctInput) : 10;
  const haAfectadas = (supTotal * pct) / 100;

  if (plagaInfo.cuarentenaria) {
    return {
      prioridad: 100,
      semaforo: "rojo",
      ptsSeveridad: 50,
      ptsSuperficie: 25,
      ptsEtapa: 25,
      haAfectadas,
      tiempoVisita: "Inmediata < 24h (Cuarentenaria)",
      esCuarentenaria: true,
    };
  }

  const mapaSev = { baja: 15, media: 25, alta: 40, critica: 50, crítica: 50 };
  const ptsSeveridad = mapaSev[(plagaInfo.severidad || "").toLowerCase()] || 25;
  const ptsSuperficie = Math.min(25, redondearComercial((haAfectadas / 4.0) * 25.0));

  const cultivo = (parcelaInfo.cultivo || "").toLowerCase();
  const etapa = parcelaInfo.etapa || "";
  const criticas = plagaInfo.etapas_criticas?.[cultivo] || [];
  const susceptibles = plagaInfo.etapas_susceptibles?.[cultivo] || [];

  let ptsEtapa = 5;
  if (criticas.includes(etapa)) ptsEtapa = 25;
  else if (susceptibles.includes(etapa)) ptsEtapa = 15;

  const prioridad = ptsSeveridad + ptsSuperficie + ptsEtapa;
  let semaforo = "verde";
  let tiempoVisita = "7 días";
  if (prioridad >= 85) {
    semaforo = "rojo";
    tiempoVisita = "24 horas";
  } else if (prioridad >= 70) {
    semaforo = "naranja";
    tiempoVisita = "48 horas";
  } else if (prioridad >= 40) {
    semaforo = "amarillo";
    tiempoVisita = "72 horas";
  }

  return {
    prioridad,
    semaforo,
    ptsSeveridad,
    ptsSuperficie,
    ptsEtapa,
    haAfectadas,
    tiempoVisita,
    esCuarentenaria: false,
  };
}

function seleccionarTecnicoOptimo(plagaInfo, parcelaInfo) {
  if (!plagaInfo || !parcelaInfo) return null;
  const espReq = (plagaInfo.especialidad || "").toLowerCase();
  const candidatos = [];

  for (const t of estadoApp.tecnicos) {
    if ((t.especialidad || "").toLowerCase() !== espReq) continue;
    const carga = Number(t.carga) || 0;
    if (carga >= 5) continue;
    const distKm = haversineKm(
      Number(parcelaInfo.lat),
      Number(parcelaInfo.lon),
      Number(t.lat),
      Number(t.lon),
    );
    const distMetros = redondearComercial(distKm * 1000);
    candidatos.push({
      tecnico: t,
      distKm,
      distMetros,
      carga,
    });
  }

  if (candidatos.length === 0) return null;
  candidatos.sort((a, b) => {
    if (a.distMetros !== b.distMetros) return a.distMetros - b.distMetros;
    if (a.carga !== b.carga) return a.carga - b.carga;
    return a.tecnico.id.localeCompare(b.tecnico.id);
  });
  return candidatos[0];
}

function obtenerMomentoReferenciaIso() {
  const fechaEl = document.querySelector("#fecha");
  const fechaVal = fechaEl?.value;
  if (fechaVal && /^\d{4}-\d{2}-\d{2}$/.test(fechaVal)) {
    return `${fechaVal}T23:59:59-06:00`;
  }
  const ultimoCaso = estadoApp.casosHistorial[estadoApp.casosHistorial.length - 1];
  return ultimoCaso?.recibido || new Date().toISOString();
}

function escaparHtml(valor) {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buscarVecinosBrote(plagaId, lat, lon, momentoIso = null, excluirId = null) {
  if (!plagaId || plagaId === "desconocida") return [];
  const todos = [...estadoApp.casosPrevios, ...estadoApp.casosHistorial];
  const isoEfectivo = momentoIso || obtenerMomentoReferenciaIso();
  const tRef = new Date(isoEfectivo).getTime();
  const vecinos = [];

  for (const c of todos) {
    if (excluirId && c.reporte_id === excluirId) continue;
    if (c.plaga !== plagaId) continue;
    const dist = haversineKm(Number(lat), Number(lon), Number(c.lat), Number(c.lon));
    if (dist <= 5.0) {
      if (c.recibido && !Number.isNaN(tRef)) {
        const diffDias = (tRef - new Date(c.recibido).getTime()) / 86400000;
        if (diffDias < 0 || diffDias > 7.0) continue;
      }
      vecinos.push({ ...c, distKm: dist });
    }
  }
  return vecinos;
}

function formatearFechaHora(iso) {
  if (!iso) return "--";
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-MX", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function nombreLegiblePlaga(plagaId) {
  if (!plagaId || plagaId === "desconocida") return "Plaga por identificar";
  return mapaPlagas.get(plagaId)?.nombre || plagaId.replace(/_/g, " ");
}

function colorHexSemaforo(sem) {
  switch ((sem || "").toLowerCase()) {
    case "rojo":
      return "#ef4444";
    case "naranja":
      return "#f97316";
    case "amarillo":
      return "#eab308";
    case "verde":
      return "#22c55e";
    default:
      return "#64748b";
  }
}

function mostrarToast(mensaje) {
  const cont = document.querySelector("#toast-container");
  if (!cont) return;
  const div = document.createElement("div");
  div.className = "toast-msg";
  div.textContent = mensaje;
  cont.appendChild(div);
  setTimeout(() => {
    div.style.opacity = "0";
    div.style.transform = "translateY(8px)";
    div.style.transition = "all 0.25s ease";
    setTimeout(() => div.remove(), 260);
  }, 3400);
}

function animarContador(el, valorFinal) {
  if (!el) return;
  const inicio = Number(el.textContent) || 0;
  const fin = Number(valorFinal) || 0;
  if (inicio === fin) {
    el.textContent = String(fin);
    return;
  }
  const duracion = 420;
  const t0 = performance.now();
  function paso(ahora) {
    const p = Math.min(1, (ahora - t0) / duracion);
    const ease = 1 - (1 - p) ** 3;
    el.textContent = String(Math.round(inicio + (fin - inicio) * ease));
    if (p < 1) requestAnimationFrame(paso);
  }
  requestAnimationFrame(paso);
}

// ============================================================================
// MAPA 1: MAPA TÁCTICO REGIONAL (VISTA TÉCNICOS / COORDINACIÓN)
// ============================================================================
const mapTecnico = L.map("mapa-tecnico", { preferCanvas: true }).setView([19.515, -98.875], 11);

const capaSateliteTec = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { attribution: "Tiles &copy; Esri" },
);
const capaEtiquetasTec = L.tileLayer(
  "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  { pane: "overlayPane", opacity: 0.85 },
);
capaSateliteTec.addTo(mapTecnico);
capaEtiquetasTec.addTo(mapTecnico);

const layerCasosTec = L.layerGroup().addTo(mapTecnico);
const layerBrotesTec = L.layerGroup().addTo(mapTecnico);
const layerTecnicosBases = L.layerGroup().addTo(mapTecnico);
const layerRutasTecnicos = L.layerGroup().addTo(mapTecnico);

// ============================================================================
// MAPA 2: MAPA SATELITAL DE PARCELA (VISTA AGRICULTOR)
// ============================================================================
const mapAgricultor = L.map("mapa").setView([19.5104, -98.8824], 15);
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { attribution: "Tiles &copy; Esri" },
).addTo(mapAgricultor);

const drawnItems = new L.FeatureGroup();
mapAgricultor.addLayer(drawnItems);
const layerVecinosAgr = L.layerGroup().addTo(mapAgricultor);

let poligonoParcela = null;
let circuloRadar5km = null;
let rectanguloAfectado = null;

const drawControl = new L.Control.Draw({
  draw: {
    polygon: false,
    polyline: false,
    circle: false,
    marker: false,
    circlemarker: false,
    rectangle: {
      shapeOptions: {
        color: "#ef4444",
        weight: 2,
        fillOpacity: 0.42,
      },
    },
  },
  edit: {
    featureGroup: drawnItems,
    edit: false,
  },
});
mapAgricultor.addControl(drawControl);

mapAgricultor.on(L.Draw.Event.CREATED, (e) => {
  drawnItems.clearLayers();
  rectanguloAfectado = e.layer;
  drawnItems.addLayer(rectanguloAfectado);
  calcularAreaAfectadaPorDibujo();
});

// ============================================================================
// CONMUTADOR DE VISTAS (TÉCNICO / AGRICULTOR / BITÁCORA)
// ============================================================================
function cambiarVista(nuevaVista) {
  estadoApp.vistaActual = nuevaVista;
  document.querySelectorAll(".role-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.vista === nuevaVista);
  });

  const vistas = {
    tecnico: document.querySelector("#vista-tecnico"),
    agricultor: document.querySelector("#vista-agricultor"),
    bitacora: document.querySelector("#vista-bitacora"),
  };

  Object.entries(vistas).forEach(([clave, el]) => {
    if (!el) return;
    if (clave === nuevaVista) {
      el.classList.remove("oculto");
      el.classList.add("vista-activa");
    } else {
      el.classList.add("oculto");
      el.classList.remove("vista-activa");
    }
  });

  // Reajustar tamaño del lienzo Leaflet tras mostrar la pestaña
  setTimeout(() => {
    if (nuevaVista === "tecnico") mapTecnico.invalidateSize();
    if (nuevaVista === "agricultor") mapAgricultor.invalidateSize();
  }, 100);
}

document.querySelectorAll(".role-btn").forEach((btn) => {
  btn.addEventListener("click", () => cambiarVista(btn.dataset.vista));
});

// ============================================================================
// RENDERIZADO DE KPIS GLOBALES
// ============================================================================
function renderizarKPIs() {
  const casos = estadoApp.casosHistorial;
  const urgentes = casos.filter((c) => c.semaforo === "rojo" || c.semaforo === "naranja").length;
  const brotes = casos.filter((c) => c.brote).length;
  const cuarentenarias = casos.filter((c) => mapaPlagas.get(c.plaga)?.cuarentenaria).length;

  animarContador(document.querySelector("#kpi-total-casos"), casos.length);
  animarContador(document.querySelector("#kpi-urgentes"), urgentes);
  animarContador(document.querySelector("#kpi-brotes-count"), brotes);
  animarContador(document.querySelector("#kpi-tecnicos-activos"), estadoApp.tecnicos.length);

  const elCuar = document.querySelector("#kpi-cuarentenarias");
  if (elCuar) elCuar.textContent = `${cuarentenarias} cuarentenaria${cuarentenarias === 1 ? "" : "s"}`;

  const elAvisos = document.querySelector("#kpi-avisos-total");
  if (elAvisos) elAvisos.textContent = `${estadoApp.avisos.length} avisos emitidos`;
}

// ============================================================================
// RENDERIZADO DE VISTA 1: CENTRO DE CONTROL TÉCNICO & COORDINACIÓN
// ============================================================================
function obtenerCasosFuenteTecnico() {
  const base = estadoApp.casosHistorial.map((c) => ({ ...c, origen: "nivel2" }));
  if (!estadoApp.incluirCasosPrevios) return base;
  const previos = estadoApp.casosPrevios.map((c) => ({ ...c, origen: "previo" }));
  return [...base, ...previos];
}

function filtrarCasosTecnico() {
  const fuente = obtenerCasosFuenteTecnico();

  // Actualizar contadores de semáforo sobre la fuente activa
  const conteos = { todos: fuente.length, rojo: 0, naranja: 0, amarillo: 0, verde: 0 };
  for (const c of fuente) {
    const s = (c.semaforo || "").toLowerCase();
    if (conteos[s] !== undefined) conteos[s] += 1;
  }
  Object.entries(conteos).forEach(([k, val]) => {
    const el = document.querySelector(`#count-sem-${k}`);
    if (el) el.textContent = String(val);
  });

  return fuente
    .filter((c) => {
      if (estadoApp.filtroSemaforo !== "todos" && c.semaforo !== estadoApp.filtroSemaforo) {
        return false;
      }
      if (estadoApp.filtroPlaga !== "todas" && c.plaga !== estadoApp.filtroPlaga) {
        return false;
      }
      if (estadoApp.filtroTecnico !== "todos" && c.tecnico_id !== estadoApp.filtroTecnico) {
        return false;
      }
      const rep = mapaReportes.get(c.reporte_id);
      const plagaObj = mapaPlagas.get(c.plaga);

      if (estadoApp.filtroCondicion === "brote" && !c.brote) return false;
      if (estadoApp.filtroCondicion === "cuarentenaria" && !plagaObj?.cuarentenaria) return false;
      if (estadoApp.filtroCondicion === "foto" && rep?.tipo !== "foto") return false;
      if (estadoApp.filtroCondicion === "voz" && rep?.tipo !== "voz") return false;
      if (estadoApp.filtroCondicion === "sin_tecnico" && c.tecnico_id) return false;

      if (estadoApp.filtroBusqueda.trim() !== "") {
        const q = estadoApp.filtroBusqueda.toLowerCase().trim();
        const parcelaObj = mapaParcelas.get(c.parcela_id);
        const tecObj = mapaTecnicos.get(c.tecnico_id);
        const texto = [
          c.reporte_id,
          c.parcela_id,
          parcelaObj?.nombre,
          parcelaObj?.municipio,
          parcelaObj?.cultivo,
          c.plaga,
          plagaObj?.nombre,
          c.tecnico_id,
          tecObj?.nombre,
          rep?.texto,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!texto.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      // Ordenar primero por prioridad descendente y luego por fecha más reciente
      if ((b.prioridad || 0) !== (a.prioridad || 0)) {
        return (b.prioridad || 0) - (a.prioridad || 0);
      }
      return String(b.recibido || "").localeCompare(String(a.recibido || ""));
    });
}

function renderizarEscuadronTecnicos() {
  const cont = document.querySelector("#lista-tecnicos-cards");
  const btnReset = document.querySelector("#btn-limpiar-tecnico");
  if (!cont) return;

  if (btnReset) {
    btnReset.classList.toggle("oculto", estadoApp.filtroTecnico === "todos");
  }

  // Contar cuántos casos de Nivel 2 tiene asignado cada técnico
  const conteoCasosPorTec = new Map();
  const brotesPorTec = new Map();
  for (const c of estadoApp.casosHistorial) {
    if (!c.tecnico_id) continue;
    conteoCasosPorTec.set(c.tecnico_id, (conteoCasosPorTec.get(c.tecnico_id) || 0) + 1);
    if (c.brote) brotesPorTec.set(c.tecnico_id, (brotesPorTec.get(c.tecnico_id) || 0) + 1);
  }

  cont.innerHTML = "";
  estadoApp.tecnicos.forEach((t, idx) => {
    const asignadosN2 = conteoCasosPorTec.get(t.id) || 0;
    const brotesN2 = brotesPorTec.get(t.id) || 0;
    const cargaActual = Number(t.carga) || 0;
    const tope = Number(t.tope) || 5;
    const pctCarga = Math.min(100, Math.round((cargaActual / tope) * 100));
    const colorBarra =
      cargaActual >= 4 ? "#ef4444" : cargaActual >= 2 ? "#f97316" : "#10b981";

    const card = document.createElement("div");
    card.className = `tec-card ${estadoApp.filtroTecnico === t.id ? "seleccionado" : ""}`;
    card.style.animationDelay = `${idx * 30}ms`;
    card.innerHTML = `
      <div class="tec-top">
        <span class="tec-id-badge">${t.id}</span>
        <span class="tec-esp-tag esp-${t.especialidad}">
          ${t.especialidad === "entomologia" ? "🪲 Entomología" : "🍄 Fitopatología"}
        </span>
      </div>
      <div>
        <div class="tec-nombre">${t.nombre}</div>
        <div class="tec-base">📍 Base: ${t.base}</div>
      </div>
      <div class="tec-carga-wrap">
        <div class="tec-carga-labels">
          <span>Carga activa: <strong>${cargaActual}/${tope}</strong></span>
          <span>Nivel 2: <strong>${asignadosN2} casos</strong> ${brotesN2 > 0 ? `(🔥${brotesN2})` : ""}</span>
        </div>
        <div class="tec-bar-bg">
          <div class="tec-bar-fill" style="width: ${pctCarga}%; background: ${colorBarra}"></div>
        </div>
      </div>
    `;
    card.addEventListener("click", () => {
      estadoApp.filtroTecnico = estadoApp.filtroTecnico === t.id ? "todos" : t.id;
      const selTec = document.querySelector("#filtro-tecnico-select");
      if (selTec) selTec.value = estadoApp.filtroTecnico;
      actualizarVistaTecnico();
      if (estadoApp.filtroTecnico !== "todos") {
        mapTecnico.flyTo([Number(t.lat), Number(t.lon)], 12, { duration: 0.7 });
      }
    });
    cont.appendChild(card);
  });
}

function renderizarMapaTecnico(casosFiltrados) {
  layerCasosTec.clearLayers();
  layerBrotesTec.clearLayers();
  layerTecnicosBases.clearLayers();
  layerRutasTecnicos.clearLayers();

  // 1. Dibujar bases de técnicos si el toggle está activo
  if (estadoApp.mostrarBasesTecnicos) {
    for (const t of estadoApp.tecnicos) {
      if (estadoApp.filtroTecnico !== "todos" && estadoApp.filtroTecnico !== t.id) continue;
      const iconTec = L.divIcon({
        className: "",
        html: `<div class="marker-tec-pin" title="${t.nombre} (${t.base})">👨‍🔬 ${t.id}</div>`,
        iconSize: [52, 22],
        iconAnchor: [26, 11],
      });
      const markerTec = L.marker([Number(t.lat), Number(t.lon)], { icon: iconTec });
      markerTec.bindPopup(`
        <div style="color:#0f172a; font-family:Inter,sans-serif; min-width:190px;">
          <strong>${t.id} · ${t.nombre}</strong><br/>
          <span>Especialidad: <b>${t.especialidad}</b></span><br/>
          <span>Base: ${t.base}</span><br/>
          <span>Carga en turno: ${t.carga}/${t.tope}</span>
        </div>
      `);
      markerTec.addTo(layerTecnicosBases);
    }
  }

  // 2. Dibujar cada caso filtrado, su círculo de brote (5 km) y su ruta al técnico
  for (const c of casosFiltrados) {
    const lat = Number(c.lat);
    const lon = Number(c.lon);
    if (!lat || !lon) continue;

    const color = colorHexSemaforo(c.semaforo);
    const parcela = mapaParcelas.get(c.parcela_id);
    const tec = mapaTecnicos.get(c.tecnico_id);

    // Círculo de 5 km para casos con brote
    if (c.brote && estadoApp.mostrarRadiosBrote) {
      L.circle([lat, lon], {
        radius: 5000,
        color: "#f97316",
        weight: 1.5,
        dashArray: "5, 5",
        fillColor: "#f97316",
        fillOpacity: 0.06,
      }).addTo(layerBrotesTec);
    }

    // Línea geodésica entre técnico y parcela
    if (
      estadoApp.mostrarBasesTecnicos &&
      tec &&
      (estadoApp.filtroTecnico !== "todos" || c.semaforo === "rojo" || c.brote)
    ) {
      L.polyline(
        [
          [Number(tec.lat), Number(tec.lon)],
          [lat, lon],
        ],
        {
          color: c.semaforo === "rojo" ? "#ef4444" : "#38bdf8",
          weight: estadoApp.filtroTecnico === tec.id ? 2.5 : 1.5,
          opacity: estadoApp.filtroTecnico === tec.id ? 0.85 : 0.45,
          dashArray: "4, 6",
        },
      ).addTo(layerRutasTecnicos);
    }

    const markerHtml = `
      <div class="custom-case-marker">
        ${c.brote || c.semaforo === "rojo" ? '<div class="marker-brote-ring"></div>' : ""}
        <div class="marker-core" style="background:${color};"></div>
      </div>
    `;
    const iconCaso = L.divIcon({
      className: "",
      html: markerHtml,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });

    const m = L.marker([lat, lon], { icon: iconCaso });
    m.on("click", () => abrirModalExpediente(c.reporte_id));
    m.bindTooltip(
      `<b>${c.reporte_id}</b> · ${parcela ? parcela.nombre : c.parcela_id} (${nombreLegiblePlaga(c.plaga)}) · <b>${c.prioridad} pts</b> ${c.brote ? "🔥 BROTE" : ""}`,
      { direction: "top" },
    );
    m.addTo(layerCasosTec);
  }
}

function renderizarTablaCasosNivel2(casosFiltrados) {
  const tbody = document.querySelector("#tbody-casos-nivel2");
  const contador = document.querySelector("#contador-casos-filtrados");
  if (!tbody) return;

  if (contador) {
    contador.textContent = `Mostrando ${casosFiltrados.length} caso${casosFiltrados.length === 1 ? "" : "s"} (${estadoApp.incluirCasosPrevios ? "Nivel 2 + Históricos" : "Nivel 2 en vivo"})`;
  }

  tbody.innerHTML = "";
  if (casosFiltrados.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:28px; color:#94a3b8;">No se encontraron casos con los filtros seleccionados.</td></tr>`;
    return;
  }

  for (const c of casosFiltrados) {
    const parcela = mapaParcelas.get(c.parcela_id);
    const plaga = mapaPlagas.get(c.plaga);
    const tec = mapaTecnicos.get(c.tecnico_id);
    const rep = mapaReportes.get(c.reporte_id);

    const distKm =
      tec && parcela
        ? haversineKm(Number(parcela.lat), Number(parcela.lon), Number(tec.lat), Number(tec.lon)).toFixed(1)
        : null;

    const iconoEvidencia =
      rep?.tipo === "foto"
        ? "📸 Fotografía"
        : rep?.tipo === "voz"
          ? "🎙️ Nota de Voz"
          : "📝 Mensaje Texto";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <span class="folio-cell">${c.reporte_id}</span>
        <span class="fecha-sub">${formatearFechaHora(c.recibido)}</span>
      </td>
      <td>
        <span class="parcela-strong">${c.parcela_id} · ${parcela ? parcela.nombre : "Parcela"}</span>
        <span class="fecha-sub">📍 ${parcela ? `${parcela.municipio} (${parcela.superficie_ha} ha)` : ""}</span>
      </td>
      <td>
        <strong style="text-transform:capitalize;">${parcela ? parcela.cultivo : c.cultivo || "--"}</strong>
        <span class="fecha-sub">Etapa: ${parcela ? parcela.etapa : "--"}</span>
      </td>
      <td>
        <strong style="color:${plaga?.cuarentenaria ? "#fca5a5" : "#f8fafc"};">
          ${nombreLegiblePlaga(c.plaga)}
        </strong>
        <span class="fecha-sub">
          ${plaga ? `${plaga.especialidad} · sev. ${plaga.severidad}` : "Sin clasificar"}
          ${plaga?.cuarentenaria ? " · ⚠️ CUARENTENARIA" : ""}
        </span>
      </td>
      <td>
        <span class="tag-sem tag-${c.semaforo}">
          <span class="dot dot-${c.semaforo}"></span>
          ${c.semaforo} · ${c.prioridad} pts
        </span>
        <div class="prio-mini-bar">
          <div class="prio-mini-fill" style="width:${c.prioridad}%; background:${colorHexSemaforo(c.semaforo)};"></div>
        </div>
      </td>
      <td>
        ${
          c.brote
            ? `<span class="badge-brote-activo">🔥 BROTE ACTIVO</span>`
            : `<span class="badge-brote-normal">Caso aislado</span>`
        }
      </td>
      <td>
        ${
          tec
            ? `<span class="parcela-strong">${tec.id} · ${tec.nombre}</span>
               <span class="fecha-sub">📍 ${tec.base} ${distKm ? `(${distKm} km)` : ""}</span>`
            : `<span class="badge-brote-normal">${c.plaga === "desconocida" ? "No requiere" : "⏳ En cola (carga tope)"}</span>`
        }
      </td>
      <td>
        <span style="font-size:12px; font-weight:600;">${iconoEvidencia}</span>
        ${rep?.texto ? `<span class="fecha-sub" title="${rep.texto.replace(/"/g, "&quot;")}">${rep.texto.slice(0, 42)}${rep.texto.length > 42 ? "…" : ""}</span>` : ""}
      </td>
      <td>
        <button type="button" class="btn-expediente" data-folio="${c.reporte_id}">
          🔍 Expediente
        </button>
      </td>
    `;

    tr.querySelector(".btn-expediente").addEventListener("click", () => {
      abrirModalExpediente(c.reporte_id);
    });
    tbody.appendChild(tr);
  }
}

function actualizarVistaTecnico() {
  const filtrados = filtrarCasosTecnico();
  renderizarEscuadronTecnicos();
  renderizarMapaTecnico(filtrados);
  renderizarTablaCasosNivel2(filtrados);
}

// ============================================================================
// MODAL DE EXPEDIENTE COMPLETO DEL CASO (MULTIMEDIA + DESGLOSE MATEMÁTICO)
// ============================================================================
function abrirModalExpediente(reporteId) {
  const todos = [...estadoApp.casosHistorial, ...estadoApp.casosPrevios];
  const caso = todos.find((c) => c.reporte_id === reporteId);
  if (!caso) return;

  const parcela = mapaParcelas.get(caso.parcela_id);
  const productor = parcela ? mapaProductores.get(parcela.productor_id) : null;
  const plaga = mapaPlagas.get(caso.plaga);
  const tec = mapaTecnicos.get(caso.tecnico_id);
  const rep = mapaReportes.get(caso.reporte_id);
  const vecinos = buscarVecinosBrote(caso.plaga, caso.lat, caso.lon, caso.recibido, caso.reporte_id);
  const avisosCaso = estadoApp.avisos.filter((a) => a.reporte_id === caso.reporte_id);

  const distKm =
    tec && parcela
      ? haversineKm(Number(parcela.lat), Number(parcela.lon), Number(tec.lat), Number(tec.lon)).toFixed(2)
      : "--";

  const modal = document.querySelector("#modal-expediente");
  const badge = document.querySelector("#modal-folio-badge");
  const titulo = document.querySelector("#modal-titulo");
  const cuerpo = document.querySelector("#modal-cuerpo");

  badge.textContent = `EXPEDIENTE OFICIAL · ${caso.reporte_id}`;
  titulo.textContent = `${parcela ? `${parcela.id} ${parcela.nombre} (${parcela.municipio})` : caso.parcela_id} — ${nombreLegiblePlaga(caso.plaga)}`;

  let bloqueMultimedia = "";
  if (rep?.foto_url) {
    const archivo = rep.foto_url.split("/").pop();
    bloqueMultimedia = `
      <div class="modal-box">
        <strong>📸 Evidencia Fotográfica Enviada por el Productor</strong>
        <img src="/api/media/${archivo}" alt="Evidencia ${caso.reporte_id}" class="evidencia-img" onerror="this.style.display='none'" />
      </div>
    `;
  } else if (rep?.audio_url) {
    const archivo = rep.audio_url.split("/").pop();
    bloqueMultimedia = `
      <div class="modal-box">
        <strong>🎙️ Nota de Voz Original del Productor (${rep.duracion_s || "--"} s)</strong>
        <audio controls src="/api/media/${archivo}" style="width:100%; margin-top:10px;"></audio>
      </div>
    `;
  }

  let bloqueMatematica = "";
  if (plaga && parcela) {
    let ptsSev = 0;
    let ptsSup = 0;
    let ptsEta = 0;
    if (plaga.cuarentenaria) {
      ptsSev = 50;
      ptsSup = 25;
      ptsEta = 25;
    } else {
      const mapaSev = { baja: 15, media: 25, alta: 40, critica: 50, crítica: 50 };
      ptsSev = mapaSev[(plaga.severidad || "").toLowerCase()] || 25;
      const cultivo = (parcela.cultivo || "").toLowerCase();
      const etapa = parcela.etapa || "";
      const criticas = plaga.etapas_criticas?.[cultivo] || [];
      const susceptibles = plaga.etapas_susceptibles?.[cultivo] || [];
      ptsEta = criticas.includes(etapa) ? 25 : susceptibles.includes(etapa) ? 15 : 5;
      ptsSup = Math.max(0, Math.min(25, (Number(caso.prioridad) || 0) - ptsSev - ptsEta));
    }

    bloqueMatematica = `
      <div class="modal-box">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <strong>📐 Desglose Matemático de Prioridad (Sección 7)</strong>
          <span class="kpi-chip">${plaga.cuarentenaria ? "⚠️ Cuarentenaria: 100 pts directo" : `${ptsSev} + ${ptsSup} + ${ptsEta} = ${caso.prioridad}/100 pts`}</span>
        </div>
        <div class="desglose-factores" style="margin-top:10px;">
          <div class="factor-row">
            <div class="factor-labels">
              <span>1. Factor Severidad (${plaga.severidad})</span>
              <strong>${ptsSev} / 50 pts</strong>
            </div>
            <div class="factor-bar-bg"><div class="factor-bar-fill" style="width:${(ptsSev / 50) * 100}%"></div></div>
          </div>
          <div class="factor-row">
            <div class="factor-labels">
              <span>2. Factor Superficie Dañada (${parcela.superficie_ha} ha totales)</span>
              <strong>${ptsSup} / 25 pts</strong>
            </div>
            <div class="factor-bar-bg"><div class="factor-bar-fill" style="width:${(ptsSup / 25) * 100}%"></div></div>
          </div>
          <div class="factor-row">
            <div class="factor-labels">
              <span>3. Factor Etapa Fenológica (${parcela.cultivo} · ${parcela.etapa})</span>
              <strong>${ptsEta} / 25 pts</strong>
            </div>
            <div class="factor-bar-bg"><div class="factor-bar-fill" style="width:${(ptsEta / 25) * 100}%"></div></div>
          </div>
        </div>
      </div>
    `;
  }

  cuerpo.innerHTML = `
    <div class="modal-grid-2">
      <div class="modal-box">
        <div class="sub-hint">CLASIFICACIÓN FITOSANITARIA NIVEL 2</div>
        <div style="margin-top:8px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <span class="tag-sem tag-${caso.semaforo}">Semáforo ${caso.semaforo.toUpperCase()} (${caso.prioridad}/100 pts)</span>
          ${caso.brote ? `<span class="badge-brote-activo">🔥 BROTE EPIDEMIOLÓGICO (${vecinos.length + 1} casos &le;5 km)</span>` : `<span class="kpi-chip">Sin brote activo (${vecinos.length + 1}/3 casos &le;5 km)</span>`}
        </div>
        <p style="margin:10px 0 0; font-size:13px; color:#cbd5e1;">
          <strong>Plaga:</strong> ${nombreLegiblePlaga(caso.plaga)} ${plaga?.nombre_cientifico ? `<em>(${plaga.nombre_cientifico})</em>` : ""}<br/>
          <strong>Especialidad:</strong> ${plaga?.especialidad || "N/A"} · <strong>Severidad:</strong> ${plaga?.severidad || "N/A"}<br/>
          <strong>Fecha de recepción:</strong> ${formatearFechaHora(caso.recibido)}
        </p>
      </div>

      <div class="modal-box">
        <div class="sub-hint">PARCELA, PRODUCTOR Y TÉCNICO ASIGNADO</div>
        <p style="margin:8px 0 0; font-size:13px; color:#cbd5e1; line-height:1.55;">
          <strong>Productor:</strong> ${productor ? `${productor.id} · ${productor.nombre}` : parcela?.productor_id || "--"}<br/>
          <strong>Parcela:</strong> ${parcela ? `${parcela.id} · ${parcela.nombre} (${parcela.superficie_ha} ha de ${parcela.cultivo}, etapa ${parcela.etapa})` : caso.parcela_id}<br/>
          <strong>Técnico Asignado:</strong> ${tec ? `${tec.id} · ${tec.nombre} (Base ${tec.base}, a ${distKm} km)` : "Sin técnico disponible en turno"}
        </p>
      </div>
    </div>

    ${bloqueMatematica}

    ${
      rep?.texto
        ? `<div class="modal-box">
             <strong>💬 Mensaje / Transcripción del Productor:</strong>
             <p style="margin:6px 0 0; font-size:13.5px; color:#f8fafc; font-style:italic;">"${escaparHtml(rep.texto)}"</p>
           </div>`
        : ""
    }

    ${bloqueMultimedia}

    <div class="modal-box">
      <strong>📡 Avisos Oficiales Emitidos para este Folio (${avisosCaso.length})</strong>
      ${
        avisosCaso.length === 0
          ? `<p class="sub-hint" style="margin-top:6px;">Caso procesado en lote inicial.</p>`
          : `<div style="display:flex; flex-direction:column; gap:8px; margin-top:10px;">
               ${avisosCaso
                 .map(
                   (a) => `
                 <div class="vecino-item">
                   <div>
                     <strong style="text-transform:uppercase; color:#38bdf8; font-size:11px;">[${escaparHtml(a.tipo)}]</strong>
                     <span>${escaparHtml(a.mensaje)}</span>
                   </div>
                   <span class="chip-dest">Para: ${(a.para || []).join(", ")}</span>
                 </div>`,
                 )
                 .join("")}
             </div>`
      }
    </div>

    <div style="display:flex; justify-content:flex-end; gap:10px;">
      <button type="button" id="btn-modal-ir-mapa" class="btn-secundario-accion">🎯 Enfocar Parcela en el Mapa Táctico</button>
    </div>
  `;

  cuerpo.querySelector("#btn-modal-ir-mapa")?.addEventListener("click", () => {
    modal.classList.add("oculto");
    cambiarVista("tecnico");
    mapTecnico.flyTo([Number(caso.lat), Number(caso.lon)], 14, { duration: 0.8 });
  });

  modal.classList.remove("oculto");
}

document.querySelector("#btn-cerrar-modal")?.addEventListener("click", () => {
  document.querySelector("#modal-expediente")?.classList.add("oculto");
});
document.querySelector("#modal-expediente")?.addEventListener("click", (e) => {
  if (e.target.id === "modal-expediente") {
    e.currentTarget.classList.add("oculto");
  }
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelector("#modal-expediente")?.classList.add("oculto");
  }
});

// ============================================================================
// VISTA 2: PORTAL DEL AGRICULTOR (PRODUCTORES, RADAR 5 KM Y SIMULADOR)
// ============================================================================
const selectProductorActivo = document.querySelector("#select-productor-activo");
const selectParcela = document.querySelector("#parcela");
const selectPlaga = document.querySelector("#plaga");
const inputCultivo = document.querySelector("#cultivo");
const inputEtapa = document.querySelector("#etapa");
const inputFecha = document.querySelector("#fecha");
const sliderPct = document.querySelector("#slider-pct");
const inputPct = document.querySelector("#pct_hidden");
const txtSuperficieTotal = document.querySelector("#superficie-total");
const txtHaAfectadas = document.querySelector("#ha-afectadas");
const txtPorcentaje = document.querySelector("#porcentaje-afectado");
const txtFraccion = document.querySelector("#fraccion-aprox");
const vistaSemaforo = document.querySelector("#vista-previa-semaforo");
const txtNombreSemaforo = document.querySelector("#nombre-semaforo");
const txtPuntosPrioridad = document.querySelector("#puntos-prioridad");
const txtTiempoVisita = document.querySelector("#tiempo-visita");

function poblarSelectoresCatalogo() {
  // 1. Selector de Productores en Portal Agricultor (priorizando los que tienen casos activos)
  const productoresConCaso = new Set();
  for (const c of estadoApp.casosHistorial) {
    const p = mapaParcelas.get(c.parcela_id);
    if (p?.productor_id) productoresConCaso.add(p.productor_id);
  }

  if (selectProductorActivo) {
    selectProductorActivo.innerHTML = "";
    const listaProd = [...estadoApp.productores].sort((a, b) => {
      const aCaso = productoresConCaso.has(a.id) ? 0 : 1;
      const bCaso = productoresConCaso.has(b.id) ? 0 : 1;
      if (aCaso !== bCaso) return aCaso - bCaso;
      return a.id.localeCompare(b.id);
    });
    for (const pr of listaProd) {
      const tieneAlerta = productoresConCaso.has(pr.id);
      const opt = document.createElement("option");
      opt.value = pr.id;
      opt.textContent = `${pr.id} · ${pr.nombre} (${pr.municipio}) ${tieneAlerta ? "⚠️ Con caso activo" : ""}`;
      selectProductorActivo.appendChild(opt);
    }
    selectProductorActivo.value = estadoApp.productorActualId;
  }

  // 2. Selector de Parcelas en Formulario Agricultor y Bitácora
  const selBitParcela = document.querySelector("#bit-parcela");
  if (selectParcela) selectParcela.innerHTML = "";
  if (selBitParcela) selBitParcela.innerHTML = "";

  // Ordenar parcelas poniendo primero las del productor en sesión
  const prodActual = mapaProductores.get(estadoApp.productorActualId);
  const parcelasProdSet = new Set(prodActual?.parcelas || []);

  const parcelasOrdenadas = [...estadoApp.parcelas].sort((a, b) => {
    const aMia = parcelasProdSet.has(a.id) ? 0 : 1;
    const bMia = parcelasProdSet.has(b.id) ? 0 : 1;
    if (aMia !== bMia) return aMia - bMia;
    return a.id.localeCompare(b.id);
  });

  for (const p of parcelasOrdenadas) {
    const etiqueta = `${parcelasProdSet.has(p.id) ? "⭐ " : ""}${p.id} - ${p.nombre} (${p.municipio} · ${p.cultivo}, ${p.superficie_ha} ha)`;
    if (selectParcela) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = etiqueta;
      selectParcela.appendChild(opt);
    }
    if (selBitParcela) {
      const opt2 = document.createElement("option");
      opt2.value = `${p.id} · ${p.nombre} (${p.municipio})`;
      opt2.dataset.cultivo = p.cultivo;
      opt2.textContent = `${p.id} - ${p.nombre} (${p.cultivo})`;
      selBitParcela.appendChild(opt2);
    }
  }

  // 3. Selector de las 10 Plagas Oficiales
  const filtroPlagaTec = document.querySelector("#filtro-plaga-tec");
  if (selectPlaga) {
    selectPlaga.innerHTML = '<option value="">-- Selecciona la Plaga Detectada --</option>';
  }
  if (filtroPlagaTec) {
    filtroPlagaTec.innerHTML = '<option value="todas">Todas las plagas (10)</option>';
  }

  for (const pl of estadoApp.plagas) {
    if (selectPlaga) {
      const opt = document.createElement("option");
      opt.value = pl.id;
      opt.textContent = `${pl.nombre} (${pl.severidad.toUpperCase()}${pl.cuarentenaria ? " · ⚠️ CUARENTENARIA" : ""})`;
      selectPlaga.appendChild(opt);
    }
    if (filtroPlagaTec) {
      const optF = document.createElement("option");
      optF.value = pl.id;
      optF.textContent = pl.nombre;
      filtroPlagaTec.appendChild(optF);
    }
  }

  // 4. Selector de Técnicos en filtro de coordinación
  const filtroTecSel = document.querySelector("#filtro-tecnico-select");
  if (filtroTecSel) {
    filtroTecSel.innerHTML = '<option value="todos">Todos los técnicos (T-01..T-12)</option>';
    for (const t of estadoApp.tecnicos) {
      const optT = document.createElement("option");
      optT.value = t.id;
      optT.textContent = `${t.id} · ${t.nombre} (${t.especialidad})`;
      filtroTecSel.appendChild(optT);
    }
  }
}

function seleccionarParcelaAgricultor(parcelaId) {
  const p = mapaParcelas.get(parcelaId) || estadoApp.parcelas[0];
  if (!p) return;
  estadoApp.parcelaActual = p;

  if (selectParcela && selectParcela.value !== p.id) {
    selectParcela.value = p.id;
  }
  if (p.productor_id && selectProductorActivo && selectProductorActivo.value !== p.productor_id) {
    estadoApp.productorActualId = p.productor_id;
    selectProductorActivo.value = p.productor_id;
  }

  inputCultivo.value = p.cultivo;
  inputEtapa.value = p.etapa;
  txtSuperficieTotal.textContent = `${p.superficie_ha} ha`;

  // Actualizar tarjeta de estado de la parcela del agricultor
  document.querySelector("#agr-parcela-municipio").textContent = `${p.municipio}, Edo. Méx.`;
  document.querySelector("#agr-parcela-titulo").textContent = `${p.id} · ${p.nombre}`;
  document.querySelector("#agr-spec-cultivo").textContent = p.cultivo;
  document.querySelector("#agr-spec-etapa").textContent = p.etapa;
  document.querySelector("#agr-spec-sup").textContent = `${p.superficie_ha} ha`;

  const casoActivo = estadoApp.casosHistorial.find((c) => c.parcela_id === p.id);
  const boxEstado = document.querySelector("#agr-estado-caso-actual");
  if (boxEstado) {
    if (casoActivo) {
      const tec = mapaTecnicos.get(casoActivo.tecnico_id);
      boxEstado.className = "agr-alerta-box estado-con-caso";
      boxEstado.innerHTML = `
        <strong>⚠️ Caso Activo (${casoActivo.reporte_id}):</strong> ${nombreLegiblePlaga(casoActivo.plaga)} ·
        Semáforo <b>${casoActivo.semaforo.toUpperCase()}</b> (${casoActivo.prioridad} pts).<br/>
        👨‍🔬 Atiende: <b>${tec ? `${tec.nombre} (${tec.id})` : "En asignación"}</b>
        ${casoActivo.brote ? " · 🔥 <b>Zona con Brote Activo</b>" : ""}
      `;
    } else {
      boxEstado.className = "agr-alerta-box estado-limpio";
      boxEstado.innerHTML = `
        ✅ <strong>Sin reportes críticos abiertos en esta parcela.</strong><br/>
        Puedes realizar un monitoreo preventivo o reportar síntomas abajo.
      `;
    }
  }

  // Radar de Vecindad (casos a <= 5 km de esta parcela en los últimos 7 días)
  const todosCasos = [...estadoApp.casosHistorial, ...estadoApp.casosPrevios];
  const tRefRadar = casoActivo?.recibido
    ? new Date(casoActivo.recibido).getTime()
    : new Date(obtenerMomentoReferenciaIso()).getTime();
  const casosCercanos = [];
  layerVecinosAgr.clearLayers();

  for (const c of todosCasos) {
    if (c.parcela_id === p.id || c.plaga === "desconocida") continue;
    const dist = haversineKm(Number(p.lat), Number(p.lon), Number(c.lat), Number(c.lon));
    if (dist <= 5.0) {
      if (c.recibido && !Number.isNaN(tRefRadar)) {
        const diffDias = (tRefRadar - new Date(c.recibido).getTime()) / 86400000;
        if (diffDias < -1.0 || diffDias > 7.0) continue;
      }
      casosCercanos.push({ ...c, distKm: dist });
      const colorV = colorHexSemaforo(c.semaforo);
      L.circleMarker([Number(c.lat), Number(c.lon)], {
        radius: 7,
        color: "#ffffff",
        weight: 1.5,
        fillColor: colorV,
        fillOpacity: 0.9,
      })
        .bindTooltip(
          `Vecino ${c.parcela_id}: ${nombreLegiblePlaga(c.plaga)} (${dist.toFixed(2)} km) · Semáforo ${c.semaforo}`,
        )
        .addTo(layerVecinosAgr);
    }
  }
  casosCercanos.sort((a, b) => a.distKm - b.distKm);

  const radarCount = document.querySelector("#agr-radar-count");
  const listaVecinos = document.querySelector("#agr-lista-vecinos");
  if (radarCount) radarCount.textContent = `${casosCercanos.length} caso${casosCercanos.length === 1 ? "" : "s"} a ≤ 5 km`;
  if (listaVecinos) {
    if (casosCercanos.length === 0) {
      listaVecinos.innerHTML = `<div class="vecino-item"><span>🌿 Sin alertas reportadas en un radio de 5 km.</span></div>`;
    } else {
      listaVecinos.innerHTML = casosCercanos
        .map(
          (v) => `
          <div class="vecino-item">
            <div>
              <strong>${v.parcela_id} · ${nombreLegiblePlaga(v.plaga)}</strong>
              <span class="fecha-sub">A ${v.distKm.toFixed(2)} km de tu parcela ${v.brote ? "· 🔥 Brote" : ""}</span>
            </div>
            <span class="tag-sem tag-${v.semaforo}">${v.semaforo}</span>
          </div>
        `,
        )
        .join("");
    }
  }

  // Avisos recibidos por este productor
  const misAvisos = estadoApp.avisos.filter(
    (a) =>
      (Array.isArray(a.para) && a.para.includes(p.productor_id)) ||
      (casoActivo && a.reporte_id === casoActivo.reporte_id),
  );
  const listaAvisosAgr = document.querySelector("#agr-lista-avisos");
  const countAvisosAgr = document.querySelector("#agr-avisos-count");
  if (countAvisosAgr) countAvisosAgr.textContent = `${misAvisos.length} notificación(es)`;
  if (listaAvisosAgr) {
    if (misAvisos.length === 0) {
      listaAvisosAgr.innerHTML = `<div class="vecino-item"><span>📭 No tienes avisos pendientes en este momento.</span></div>`;
    } else {
      listaAvisosAgr.innerHTML = misAvisos
        .map(
          (av) => `
          <div class="vecino-item">
            <div>
              <strong style="color:#38bdf8; text-transform:uppercase; font-size:10.5px;">[${av.tipo}]</strong>
              <span>${av.mensaje}</span>
            </div>
          </div>
        `,
        )
        .join("");
    }
  }

  // Centrar mapa del agricultor y dibujar polígono de su parcela + radio de 5 km
  mapAgricultor.setView([Number(p.lat), Number(p.lon)], 15);
  if (poligonoParcela) mapAgricultor.removeLayer(poligonoParcela);
  if (circuloRadar5km) mapAgricultor.removeLayer(circuloRadar5km);
  drawnItems.clearLayers();

  const ladoMetros = Math.sqrt(Number(p.superficie_ha) * 10000);
  const deltaLat = ladoMetros / 111320 / 2;
  const deltaLon = ladoMetros / (111320 * Math.cos((Number(p.lat) * Math.PI) / 180)) / 2;

  const bounds = [
    [Number(p.lat) - deltaLat, Number(p.lon) - deltaLon],
    [Number(p.lat) + deltaLat, Number(p.lon) + deltaLon],
  ];

  poligonoParcela = L.rectangle(bounds, {
    color: "#10b981",
    weight: 2.5,
    fillOpacity: 0.18,
    dashArray: "5, 5",
  }).addTo(mapAgricultor);

  poligonoParcela.bindTooltip(`Parcela ${p.id}: ${p.nombre} (${p.superficie_ha} ha)`, {
    permanent: true,
    direction: "top",
  });

  circuloRadar5km = L.circle([Number(p.lat), Number(p.lon)], {
    radius: 5000,
    color: "#38bdf8",
    weight: 1,
    dashArray: "4, 6",
    fillOpacity: 0.02,
  }).addTo(mapAgricultor);

  actualizarSimuladorAgricultor();
}

function describirFraccion(pct) {
  if (pct >= 90) return "Casi toda la parcela";
  if (pct >= 70 && pct <= 80) return "Tres cuartas partes (~75%)";
  if (pct >= 45 && pct <= 55) return "La mitad (~50%)";
  if (pct >= 30 && pct <= 36) return "Una tercera parte (~33%)";
  if (pct >= 22 && pct <= 28) return "Una cuarta parte (~25%)";
  if (pct >= 18 && pct <= 21) return "Una quinta parte (~20%)";
  if (pct <= 12) return "Foco inicial (~10%)";
  return `${pct}% de la superficie`;
}

function calcularAreaAfectadaPorDibujo() {
  if (!rectanguloAfectado || !estadoApp.parcelaActual) return;
  const bounds = rectanguloAfectado.getBounds();
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();

  const altoM = sw.distanceTo(L.latLng(ne.lat, sw.lng));
  const anchoM = sw.distanceTo(L.latLng(sw.lat, ne.lng));
  let haAfectadas = (altoM * anchoM) / 10000;
  const supTotal = Number(estadoApp.parcelaActual.superficie_ha) || 1;
  if (haAfectadas > supTotal) haAfectadas = supTotal;

  const pct = Math.max(1, Math.min(100, Math.round((haAfectadas / supTotal) * 100)));
  if (sliderPct) sliderPct.value = String(pct);
  inputPct.value = String(pct);
  actualizarSimuladorAgricultor();
}

function actualizarSimuladorAgricultor() {
  const p = estadoApp.parcelaActual;
  const plagaId = selectPlaga?.value || "";
  const plaga = mapaPlagas.get(plagaId) || null;
  estadoApp.plagaActual = plaga;

  const pct = Number(sliderPct?.value || inputPct?.value || 10);
  if (inputPct) inputPct.value = String(pct);
  const supTotal = Number(p?.superficie_ha) || 0;
  const ha = (supTotal * pct) / 100;

  if (txtPorcentaje) txtPorcentaje.textContent = `${pct}%`;
  if (txtHaAfectadas) txtHaAfectadas.textContent = `${ha.toFixed(2)} ha`;
  if (txtFraccion) txtFraccion.textContent = describirFraccion(pct);

  // Actualizar Ficha Guía de Síntomas de la Plaga
  const fichaGuia = document.querySelector("#ficha-plaga-guia");
  if (fichaGuia) {
    if (!plaga) {
      fichaGuia.classList.add("oculto");
    } else {
      fichaGuia.classList.remove("oculto");
      document.querySelector("#ficha-plaga-nombre").textContent = plaga.nombre;
      document.querySelector("#ficha-plaga-cientifico").textContent = plaga.nombre_cientifico || "";
      document.querySelector("#ficha-plaga-esp").textContent =
        plaga.especialidad === "entomologia" ? "🪲 Entomología" : "🍄 Fitopatología";
      const ul = document.querySelector("#ficha-plaga-sintomas");
      ul.innerHTML = (plaga.sintomas || []).map((s) => `<li>${s}</li>`).join("");
    }
  }

  if (!p || !plaga) {
    vistaSemaforo.className = "tarjeta-semaforo s-desconocido";
    txtNombreSemaforo.textContent = "PENDIENTE DE SELECCIÓN";
    txtPuntosPrioridad.textContent = "0";
    txtTiempoVisita.textContent = "--";
    document.querySelector("#pts-severidad").textContent = "0 / 50 pts";
    document.querySelector("#pts-superficie").textContent = "0 / 25 pts";
    document.querySelector("#pts-etapa").textContent = "0 / 25 pts";
    document.querySelector("#bar-severidad").style.width = "0%";
    document.querySelector("#bar-superficie").style.width = "0%";
    document.querySelector("#bar-etapa").style.width = "0%";
    document.querySelector("#sim-tec-nombre").textContent =
      "Selecciona una plaga para calcular técnico cercano";
    const bSim = document.querySelector("#badge-sim-brote");
    if (bSim) {
      bSim.className = "sim-brote-badge";
      bSim.textContent = "Sin brote zonal";
    }
    return;
  }

  const calc = calcularPrioridadSemaforoDesglosado(plaga, p, pct);
  vistaSemaforo.className = `tarjeta-semaforo s-${calc.semaforo}`;
  txtNombreSemaforo.textContent = calc.semaforo.toUpperCase();
  txtPuntosPrioridad.textContent = String(calc.prioridad);
  txtTiempoVisita.textContent = calc.tiempoVisita;

  document.querySelector("#pts-severidad").textContent = `${calc.ptsSeveridad} / 50 pts`;
  document.querySelector("#pts-superficie").textContent = `${calc.ptsSuperficie} / 25 pts`;
  document.querySelector("#pts-etapa").textContent = `${calc.ptsEtapa} / 25 pts`;

  document.querySelector("#bar-severidad").style.width = `${(calc.ptsSeveridad / 50) * 100}%`;
  document.querySelector("#bar-superficie").style.width = `${(calc.ptsSuperficie / 25) * 100}%`;
  document.querySelector("#bar-etapa").style.width = `${(calc.ptsEtapa / 25) * 100}%`;

  // Técnico óptimo
  const mejorTec = seleccionarTecnicoOptimo(plaga, p);
  const elTecNombre = document.querySelector("#sim-tec-nombre");
  if (elTecNombre) {
    if (mejorTec) {
      elTecNombre.textContent = `${mejorTec.tecnico.id} · ${mejorTec.tecnico.nombre} (Base ${mejorTec.tecnico.base}, a ${mejorTec.distKm.toFixed(2)} km · Carga ${mejorTec.carga}/5)`;
    } else {
      elTecNombre.textContent = "Todos los especialistas de esta área tienen carga llena (5/5)";
    }
  }

  // Verificar si este reporte activaría o pertenecería a un brote (vecinos >= 2 previos + 1 actual = 3)
  const vecinosMismaPlaga = buscarVecinosBrote(plaga.id, p.lat, p.lon);
  const detonaBrote = vecinosMismaPlaga.length + 1 >= 3;
  const bSim = document.querySelector("#badge-sim-brote");
  if (bSim) {
    if (detonaBrote) {
      bSim.className = "sim-brote-badge activo";
      bSim.textContent = `🔥 BROTE ACTIVO (${vecinosMismaPlaga.length + 1} casos ≤5 km)`;
    } else {
      bSim.className = "sim-brote-badge";
      bSim.textContent = `Normal (${vecinosMismaPlaga.length + 1}/3 casos ≤5 km)`;
    }
  }
}

// ============================================================================
// BITÁCORA (SUPABASE + SERVIDOR + TABLAS EN VIVO)
// ============================================================================
async function cargarBitacora() {
  let registros = [];

  // 1. Intentar leer desde el endpoint local/servidor `/api/bitacora`
  try {
    const res = await fetch("/api/bitacora");
    if (res.ok) {
      registros = await res.json();
    }
  } catch {
    // Usar fallback si se corre solo con vite dev
  }

  // 2. Si Supabase está configurado, consultar también `registros`
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("registros")
        .select("*")
        .order("fecha", { ascending: false })
        .limit(50);
      if (!error && Array.isArray(data) && data.length > 0) {
        registros = data;
      }
    } catch {
      // Continuar con registros del servidor
    }
  }

  if (registros.length === 0) {
    registros = estadoApp.casosHistorial.slice(-6).reverse().map((c) => {
      const p = mapaParcelas.get(c.parcela_id);
      return {
        fecha: (c.recibido || "").slice(0, 10) || "2026-10-20",
        parcela: p ? `${p.id} · ${p.nombre}` : c.parcela_id,
        cultivo: p ? p.cultivo : "maíz",
        actividad: `Reporte ${c.reporte_id}: ${nombreLegiblePlaga(c.plaga)}`,
        observaciones: `Prioridad ${c.prioridad}/100 · Técnico ${c.tecnico_id || "Pendiente"}`,
        semaforo: c.semaforo,
        prioridad: c.prioridad,
        tecnico_id: c.tecnico_id,
      };
    });
  }

  estadoApp.bitacora = registros;
  renderizarTablasBitacora();
}

function renderizarTablasBitacora() {
  const tbodyAgr = document.querySelector("#registros tbody");
  const tbodyBit = document.querySelector("#tbody-bitacora-general");

  if (tbodyAgr) {
    tbodyAgr.innerHTML = "";
    for (const r of estadoApp.bitacora.slice(0, 8)) {
      const sem = (r.semaforo || "amarillo").toLowerCase();
      const tecObj = r.tecnico_id ? mapaTecnicos.get(r.tecnico_id) : null;
      const pctTexto = r.pct !== undefined && r.pct !== null && r.pct !== "" ? `${Number(r.pct)}%` : "--";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escaparHtml(r.fecha || "--")}</td>
        <td><strong>${escaparHtml(r.parcela || "--")}</strong></td>
        <td style="text-transform:capitalize;">${escaparHtml(r.cultivo || "--")}</td>
        <td>${escaparHtml(r.actividad || r.plaga || "--")}</td>
        <td>${escaparHtml(pctTexto)}</td>
        <td>
          <span class="tag-sem tag-${escaparHtml(sem)}">
            ${escaparHtml(sem)} ${r.prioridad ? `(${Number(r.prioridad)} pts)` : ""}
          </span>
          ${
            r.tecnico_id
              ? `<span class="fecha-sub">👨‍🔬 ${escaparHtml(r.tecnico_id)}${tecObj ? ` · ${escaparHtml(tecObj.nombre)}` : ""}</span>`
              : ""
          }
        </td>
      `;
      tbodyAgr.appendChild(tr);
    }
  }

  if (tbodyBit) {
    tbodyBit.innerHTML = "";
    for (const r of estadoApp.bitacora) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escaparHtml(r.fecha || "--")}</td>
        <td><strong>${escaparHtml(r.parcela || "--")}</strong></td>
        <td style="text-transform:capitalize;">${escaparHtml(r.cultivo || "--")}</td>
        <td>${escaparHtml(r.actividad || "--")}</td>
        <td>${escaparHtml(r.observaciones || "")}</td>
      `;
      tbodyBit.appendChild(tr);
    }
  }
}

async function guardarEntradaBitacora(entrada) {
  // Guardar en servidor (/api/bitacora)
  try {
    await fetch("/api/bitacora", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entrada),
    });
  } catch {
    // Ignorar en modo estático puro
  }

  // Guardar en Supabase si está activo
  if (supabase) {
    try {
      await supabase.from("registros").insert({
        fecha: entrada.fecha,
        parcela: entrada.parcela,
        cultivo: entrada.cultivo,
        actividad: entrada.actividad,
        observaciones: entrada.observaciones,
      });
    } catch {
      // Ignorar error de RLS si aplica
    }
  }

  estadoApp.bitacora.unshift(entrada);
  renderizarTablasBitacora();
}

function renderizarFeedAvisosOficiales() {
  const cont = document.querySelector("#feed-avisos-oficiales");
  const filtroTipo = document.querySelector("#filtro-tipo-aviso")?.value || "todos";
  if (!cont) return;

  const avisosFiltrados = estadoApp.avisos.filter(
    (a) => filtroTipo === "todos" || a.tipo === filtroTipo,
  );

  cont.innerHTML = "";
  if (avisosFiltrados.length === 0) {
    cont.innerHTML = `<p class="sub-hint">No hay avisos de este tipo.</p>`;
    return;
  }

  for (const a of avisosFiltrados) {
    const div = document.createElement("div");
    div.className = `aviso-card aviso-${a.tipo}`;
    div.innerHTML = `
      <div class="aviso-head">
        <strong style="text-transform:uppercase; color:#7dd3fc;">
          ${a.tipo === "brote" ? "🔥 ALERTA DE BROTE" : a.tipo === "cuarentenaria" ? "⚠️ ALERTA CUARENTENARIA" : a.tipo === "asignacion" ? "👨‍🔬 ASIGNACIÓN TÉCNICA" : "🎫 ACUSE DE FOLIO"}
          · ${a.reporte_id || ""}
        </strong>
        <span class="fecha-sub">${formatearFechaHora(a.creado)}</span>
      </div>
      <p class="aviso-msg">${a.mensaje}</p>
      <div class="aviso-dest">
        ${(a.para || []).map((dest) => `<span class="chip-dest">📬 ${dest}</span>`).join("")}
      </div>
    `;
    cont.appendChild(div);
  }
}

// ============================================================================
// EVENT LISTENERS E INTERACCIÓN
// ============================================================================

// Píldoras de filtro de semáforo en Vista Técnico
document.querySelectorAll(".sem-pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".sem-pill").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    estadoApp.filtroSemaforo = btn.dataset.sem;
    actualizarVistaTecnico();
  });
});

// Controles de búsqueda y filtros en Vista Técnico
document.querySelector("#filtro-busqueda")?.addEventListener("input", (e) => {
  estadoApp.filtroBusqueda = e.target.value;
  actualizarVistaTecnico();
});
document.querySelector("#filtro-condicion")?.addEventListener("change", (e) => {
  estadoApp.filtroCondicion = e.target.value;
  actualizarVistaTecnico();
});
document.querySelector("#filtro-plaga-tec")?.addEventListener("change", (e) => {
  estadoApp.filtroPlaga = e.target.value;
  actualizarVistaTecnico();
});
document.querySelector("#filtro-tecnico-select")?.addEventListener("change", (e) => {
  estadoApp.filtroTecnico = e.target.value;
  actualizarVistaTecnico();
});
document.querySelector("#btn-limpiar-tecnico")?.addEventListener("click", () => {
  estadoApp.filtroTecnico = "todos";
  const sel = document.querySelector("#filtro-tecnico-select");
  if (sel) sel.value = "todos";
  actualizarVistaTecnico();
});

// Botones de capas en el Mapa Táctico
document.querySelector("#toggle-radios-brote")?.addEventListener("click", (e) => {
  estadoApp.mostrarRadiosBrote = !estadoApp.mostrarRadiosBrote;
  e.currentTarget.classList.toggle("active", estadoApp.mostrarRadiosBrote);
  actualizarVistaTecnico();
});
document.querySelector("#toggle-bases-tecnicos")?.addEventListener("click", (e) => {
  estadoApp.mostrarBasesTecnicos = !estadoApp.mostrarBasesTecnicos;
  e.currentTarget.classList.toggle("active", estadoApp.mostrarBasesTecnicos);
  actualizarVistaTecnico();
});
document.querySelector("#toggle-casos-previos")?.addEventListener("click", (e) => {
  estadoApp.incluirCasosPrevios = !estadoApp.incluirCasosPrevios;
  e.currentTarget.classList.toggle("active", estadoApp.incluirCasosPrevios);
  actualizarVistaTecnico();
});
document.querySelector("#btn-centrar-mapa-tec")?.addEventListener("click", () => {
  mapTecnico.flyTo([19.515, -98.875], 11, { duration: 0.7 });
});

// Eventos en Vista Agricultor
selectProductorActivo?.addEventListener("change", (e) => {
  estadoApp.productorActualId = e.target.value;
  poblarSelectoresCatalogo();
  const prod = mapaProductores.get(estadoApp.productorActualId);
  const primeraParcelaId = prod?.parcelas?.[0] || estadoApp.parcelas[0]?.id;
  if (primeraParcelaId) seleccionarParcelaAgricultor(primeraParcelaId);
});

selectParcela?.addEventListener("change", (e) => {
  seleccionarParcelaAgricultor(e.target.value);
});

selectPlaga?.addEventListener("change", () => {
  actualizarSimuladorAgricultor();
});

sliderPct?.addEventListener("input", () => {
  actualizarSimuladorAgricultor();
});

inputFecha?.addEventListener("change", () => {
  if (estadoApp.parcelaActual) {
    seleccionarParcelaAgricultor(estadoApp.parcelaActual.id);
  } else {
    actualizarSimuladorAgricultor();
  }
});

// Envío del Formulario de Reporte del Agricultor
document.querySelector("#registro")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = estadoApp.parcelaActual;
  const pl = estadoApp.plagaActual;
  if (!p || !pl) return;

  const pct = Number(sliderPct?.value || 10);
  const calc = calcularPrioridadSemaforoDesglosado(pl, p, pct);
  const mejorTec = seleccionarTecnicoOptimo(pl, p);
  const obs = document.querySelector("#observaciones")?.value || "";
  const folioNuevo = `R-${2065 + Math.floor(Math.random() * 30)}`;

  const nuevaEntrada = {
    fecha: inputFecha?.value || new Date().toLocaleDateString("en-CA"),
    parcela: `${p.id} · ${p.nombre} (${p.municipio})`,
    cultivo: p.cultivo,
    actividad: `Alerta ${folioNuevo}: ${pl.nombre} (${pct}% daño)`,
    observaciones: `${obs ? `${obs} · ` : ""}Semáforo ${calc.semaforo.toUpperCase()} (${calc.prioridad} pts) · Técnico: ${mejorTec ? `${mejorTec.tecnico.id} ${mejorTec.tecnico.nombre}` : "En turno"}`,
    pct,
    semaforo: calc.semaforo,
    prioridad: calc.prioridad,
    tecnico_id: mejorTec?.tecnico.id || null,
  };

  await guardarEntradaBitacora(nuevaEntrada);

  // También agregarlo en memoria a los casos activos para que se vea reflejado al instante
  const vecinos = buscarVecinosBrote(pl.id, p.lat, p.lon);
  estadoApp.casosHistorial.unshift({
    reporte_id: folioNuevo,
    recibido: new Date().toISOString(),
    parcela_id: p.id,
    plaga: pl.id,
    lat: p.lat,
    lon: p.lon,
    semaforo: calc.semaforo,
    prioridad: calc.prioridad,
    tecnico_id: mejorTec?.tecnico.id || null,
    brote: vecinos.length + 1 >= 3,
  });

  renderizarKPIs();
  actualizarVistaTecnico();
  seleccionarParcelaAgricultor(p.id);

  const estadoTxt = document.querySelector("#estado");
  if (estadoTxt) {
    estadoTxt.textContent = `✅ Folio ${folioNuevo} emitido: Semáforo ${calc.semaforo.toUpperCase()} (${calc.prioridad} pts) · Asignado a ${mejorTec ? mejorTec.tecnico.nombre : "Coordinación"}.`;
  }
  mostrarToast(`🚀 Alerta ${folioNuevo} registrada (${calc.semaforo.toUpperCase()} · ${calc.prioridad} pts)`);
  const obsEl = document.querySelector("#observaciones");
  if (obsEl) obsEl.value = "";
});

// Formulario directo de Bitácora General (Vista 3)
document.querySelector("#bit-parcela")?.addEventListener("change", (e) => {
  const opt = e.target.selectedOptions?.[0];
  const inputBitCultivo = document.querySelector("#bit-cultivo");
  if (opt?.dataset?.cultivo && inputBitCultivo) {
    inputBitCultivo.value = opt.dataset.cultivo;
  }
});

document.querySelector("#form-bitacora-directa")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const datos = Object.fromEntries(new FormData(form));
  await guardarEntradaBitacora({
    fecha: datos.fecha,
    parcela: datos.parcela,
    cultivo: datos.cultivo,
    actividad: datos.actividad,
    observaciones: datos.observaciones,
    semaforo: "verde",
    prioridad: 25,
  });
  form.observaciones.value = "";
  const bitEstado = document.querySelector("#bit-estado");
  if (bitEstado) bitEstado.textContent = "✅ Registro guardado en la Bitácora.";
  mostrarToast("📓 Actividad guardada en la Bitácora de Parcela");
});

document.querySelector("#filtro-tipo-aviso")?.addEventListener("change", () => {
  renderizarFeedAvisosOficiales();
});

// Exportar Bitácora a CSV
document.querySelector("#btn-exportar-csv")?.addEventListener("click", () => {
  const encabezados = ["Fecha", "Parcela", "Cultivo", "Actividad", "Observaciones"];
  const filas = estadoApp.bitacora.map((r) =>
    [r.fecha, r.parcela, r.cultivo, r.actividad, r.observaciones]
      .map((v) => `"${String(v || "").replace(/"/g, '""')}"`)
      .join(","),
  );
  const csv = [encabezados.join(","), ...filas].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bitacora_alerta_plaga_${new Date().toLocaleDateString("en-CA")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  mostrarToast("⬇️ Archivo CSV descargado");
});

// ============================================================================
// SINCRONIZACIÓN EN VIVO CON EL SERVIDOR (/api/datos)
// ============================================================================
async function sincronizarDatosEnVivo(mostrarNotificacion = false) {
  const icono = document.querySelector("#icono-sync");
  if (icono) icono.classList.add("spinning");
  try {
    const res = await fetch("/api/datos");
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.plagas) && data.plagas.length > 0) estadoApp.plagas = data.plagas;
      if (Array.isArray(data.parcelas) && data.parcelas.length > 0) estadoApp.parcelas = data.parcelas;
      if (Array.isArray(data.tecnicos) && data.tecnicos.length > 0) estadoApp.tecnicos = data.tecnicos;
      if (Array.isArray(data.productores) && data.productores.length > 0) estadoApp.productores = data.productores;
      if (Array.isArray(data.reportes) && data.reportes.length > 0) estadoApp.reportes = data.reportes;
      if (Array.isArray(data.avisos) && data.avisos.length > 0) estadoApp.avisos = data.avisos;
      if (Array.isArray(data.casos_previos) && data.casos_previos.length > 0) estadoApp.casosPrevios = data.casos_previos;
      if (Array.isArray(data.casos_historial) && data.casos_historial.length > 0) {
        const porId = new Map();
        for (const c of estadoApp.casosHistorial) {
          if (c?.reporte_id) porId.set(c.reporte_id, c);
        }
        for (const c of data.casos_historial) {
          if (c?.reporte_id) porId.set(c.reporte_id, c);
        }
        estadoApp.casosHistorial = Array.from(porId.values());
      }
      reconstruirIndices();
      renderizarKPIs();
      actualizarVistaTecnico();
      if (estadoApp.parcelaActual) {
        seleccionarParcelaAgricultor(estadoApp.parcelaActual.id);
      }
      renderizarFeedAvisosOficiales();
      renderizarTablasBitacora();
      if (mostrarNotificacion) {
        mostrarToast(`🔄 Sincronizado: ${estadoApp.casosHistorial.length} casos Nivel 2 activos`);
      }
    }
  } catch {
    // En desarrollo estático usa datosSemilla sin fallar
  } finally {
    if (icono) setTimeout(() => icono.classList.remove("spinning"), 400);
  }
}

document.querySelector("#btn-refrescar")?.addEventListener("click", () => {
  sincronizarDatosEnVivo(true);
});

// ============================================================================
// INICIALIZACIÓN
// ============================================================================
function iniciarPanel() {
  const hoy = new Date().toLocaleDateString("en-CA");
  if (inputFecha) inputFecha.value = hoy;
  const bitFecha = document.querySelector("#bit-fecha");
  if (bitFecha) bitFecha.value = hoy;

  poblarSelectoresCatalogo();
  renderizarKPIs();
  actualizarVistaTecnico();
  renderizarFeedAvisosOficiales();

  // Seleccionar una parcela inicial con caso interesante o la primera del productor
  seleccionarParcelaAgricultor("P-001");
  if (selectPlaga && estadoApp.plagas.length > 0) {
    selectPlaga.value = "gusano_cogollero";
    actualizarSimuladorAgricultor();
  }

  const bitCultivo = document.querySelector("#bit-cultivo");
  if (bitCultivo) bitCultivo.value = "maíz";

  cargarBitacora();
  sincronizarDatosEnVivo(false);
}

iniciarPanel();
