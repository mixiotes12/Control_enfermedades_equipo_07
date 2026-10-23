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
  vistaActual: "landing", // "landing" | "tecnico" | "agricultor" | "bitacora"
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

  // Selección en Vista Agricultor (aislada por pestaña/sesión)
  productorActualId: null,
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

const layerParcelasTec = L.layerGroup().addTo(mapTecnico);
const layerCasosTec = L.layerGroup().addTo(mapTecnico);
const layerBrotesTec = L.layerGroup().addTo(mapTecnico);
const layerTecnicosBases = L.layerGroup().addTo(mapTecnico);
const layerRutasTecnicos = L.layerGroup().addTo(mapTecnico);

// ============================================================================
// CROQUIS SATELITAL DE PARCELA (VISTA AGRICULTOR - LIENZO FOCALIZADO)
// ============================================================================
const focosDanioPorParcela = new Map(); // parcelaId -> Array<{ id, x, y, r }>
let focoSeleccionadoId = null;
let croquisAdjuntoActual = null;
let pctDanioActual = 10;
let haDanadasActual = 0.55;
let arrastrandoFoco = null;
let mapAgricultor = null;
let poligonoParcela = null;
let marcadorDanio = null;
let circuloDanio = null;
let puntoDanioActual = null;
const puntosDanioPorParcela = new Map();
const pctDanioPorParcela = new Map();

function limitarPuntoAParcela(lat, lon, parcela) {
  if (!parcela) return [Number(lat), Number(lon)];
  const ladoMetros = Math.sqrt(Number(parcela.superficie_ha) * 10000);
  const deltaLat = ladoMetros / 111320 / 2;
  const deltaLon = ladoMetros / (111320 * Math.cos((Number(parcela.lat) * Math.PI) / 180)) / 2;

  const latMin = Number(parcela.lat) - deltaLat;
  const latMax = Number(parcela.lat) + deltaLat;
  const lonMin = Number(parcela.lon) - deltaLon;
  const lonMax = Number(parcela.lon) + deltaLon;

  const latClamped = Math.max(latMin, Math.min(latMax, Number(lat)));
  const lonClamped = Math.max(lonMin, Math.min(lonMax, Number(lon)));
  return [latClamped, lonClamped];
}



// ============================================================================
// CONMUTADOR DE VISTAS Y ENRUTAMIENTO SPA (LANDING / TÉCNICO / AGRICULTOR / BITÁCORA)
// ============================================================================
function resolverVistaDesdeUrl() {
  const path = window.location.pathname.toLowerCase();
  const hash = window.location.hash.toLowerCase();
  const sesion = cargarSesion();

  if (path.includes("agricultor") || hash.includes("agricultor")) {
    if (!sesion || sesion.rol !== "agricultor") {
      setTimeout(() => abrirModalAuthAgricultor(), 150);
      return "landing";
    }
    return "agricultor";
  }

  if (
    path.includes("coordinador") ||
    path.includes("tecnico") ||
    hash.includes("coordinador") ||
    hash.includes("tecnico")
  ) {
    if (!sesion || (sesion.rol !== "coordinador" && sesion.rol !== "tecnico")) {
      setTimeout(() => abrirModalAuthCoordinador(), 150);
      return "landing";
    }
    return "tecnico";
  }

  if (path.includes("bitacora") || hash.includes("bitacora")) {
    if (!sesion || (sesion.rol !== "coordinador" && sesion.rol !== "tecnico")) {
      setTimeout(() => abrirModalAuthCoordinador(), 150);
      return "landing";
    }
    return "bitacora";
  }

  return "landing";
}

function cambiarVista(nuevaVista, actualizarHistorial = true) {
  // R1: Si se navega o regresa a landing, terminar y destruir la sesión activa de inmediato
  if (nuevaVista === "landing") {
    const sesion = cargarSesion();
    if (sesion) {
      cerrarSesionUsuario(false);
    }
  }

  estadoApp.vistaActual = nuevaVista;

  const vistas = {
    landing: document.querySelector("#vista-landing"),
    tecnico: document.querySelector("#vista-tecnico"),
    agricultor: document.querySelector("#vista-agricultor"),
    bitacora: document.querySelector("#vista-bitacora"),
  };

  // Control de navegación interna de coordinación en cabecera
  const navCoord = document.querySelector("#nav-coordinador");
  if (navCoord) {
    const sesion = cargarSesion();
    const esCoord = sesion && (sesion.rol === "coordinador" || sesion.rol === "tecnico");
    if (esCoord && (nuevaVista === "tecnico" || nuevaVista === "bitacora")) {
      navCoord.classList.remove("oculto");
      document.querySelector("#btn-subnav-mando")?.classList.toggle("active", nuevaVista === "tecnico");
      document.querySelector("#btn-subnav-bitacora")?.classList.toggle("active", nuevaVista === "bitacora");
    } else {
      navCoord.classList.add("oculto");
    }
  }

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

  if (actualizarHistorial) {
    const rutas = {
      landing: "/",
      tecnico: "/coordinador",
      agricultor: "/agricultor",
      bitacora: "/bitacora",
    };
    const destino = rutas[nuevaVista] || "/";
    if (window.location.pathname !== destino) {
      history.pushState({ vista: nuevaVista }, "", destino);
    }
  }

  // Desplazamiento suave al tope
  window.scrollTo({ top: 0, behavior: "smooth" });

  // Reajustar tamaño del lienzo del mapa técnico o croquis de parcela
  setTimeout(() => {
    if (nuevaVista === "tecnico" && mapTecnico) mapTecnico.invalidateSize();
    if (nuevaVista === "agricultor" && estadoApp.parcelaActual) {
      renderizarCroquisParcela(estadoApp.parcelaActual);
    }
  }, 120);

  setTimeout(() => {
    if (nuevaVista === "agricultor" && estadoApp.parcelaActual) {
      renderizarCroquisParcela(estadoApp.parcelaActual);
    }
  }, 380);
}

// Al dar a regresar hacia atrás en el navegador (popstate), destruir sesión si sale del módulo
window.addEventListener("popstate", () => {
  const vista = resolverVistaDesdeUrl();
  cambiarVista(vista, false);
});

// Brand/Logo vuelve a la pantalla de inicio (Landing) y termina la sesión activa
document.querySelector("#brand-home")?.addEventListener("click", () => {
  cerrarSesionUsuario(true);
});

// Subnavegación exclusiva del Coordinador (Centro de Mando <-> Bitácora)
document.querySelector("#btn-subnav-mando")?.addEventListener("click", () => cambiarVista("tecnico"));
document.querySelector("#btn-subnav-bitacora")?.addEventListener("click", () => cambiarVista("bitacora"));

// ============================================================================
// GESTIÓN DE SESIONES Y AUTENTICACIÓN (PORTAL AGRICULTOR & CENTRO DE MANDO)
// ============================================================================
function guardarSesion(sesion) {
  try {
    sessionStorage.setItem("itgreen_sesion", JSON.stringify(sesion));
    sessionStorage.removeItem("alerta_plaga_sesion");
    // Limpieza estricta de localStorage para evitar que la sesión persista tras salir o entre pestañas
    localStorage.removeItem("itgreen_sesion");
    localStorage.removeItem("alerta_plaga_sesion");
  } catch {}
  actualizarBadgeSesion(sesion);
}

function cargarSesion() {
  try {
    const raw = sessionStorage.getItem("itgreen_sesion") || sessionStorage.getItem("alerta_plaga_sesion");
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function actualizarBadgeSesion(sesion) {
  const badge = document.querySelector("#usuario-sesion-badge");
  const icono = document.querySelector("#sesion-icono");
  const nombre = document.querySelector("#sesion-nombre");
  const rol = document.querySelector("#sesion-rol");

  if (!badge) return;

  if (!sesion) {
    badge.classList.add("oculto");
    return;
  }

  badge.classList.remove("oculto");
  if (sesion.rol === "agricultor") {
    badge.classList.remove("coordinador");
    if (icono) icono.textContent = "👨‍🌾";
    if (nombre) nombre.textContent = sesion.nombre || "Productor";
    if (rol) rol.textContent = `Productor · ${sesion.id}`;
  } else {
    badge.classList.add("coordinador");
    if (icono) icono.textContent = "🔬";
    if (nombre) nombre.textContent = sesion.nombre || "Coordinador";
    if (rol) rol.textContent = sesion.id === "todos" ? "Coordinación General" : `Técnico · ${sesion.id}`;
  }
}

function aplicarSesion(sesion) {
  if (!sesion) return;
  actualizarBadgeSesion(sesion);
  if (sesion.rol === "agricultor" && sesion.id) {
    estadoApp.productorActualId = sesion.id;
    const prod = mapaProductores.get(sesion.id);
    const nombreProd = sesion.nombre || prod?.nombre || `Productor ${sesion.id}`;
    const munProd = prod?.municipio || sesion.municipio || "Texcoco, Edo. Méx.";

    const elNombre = document.querySelector("#agr-productor-nombre");
    const elId = document.querySelector("#agr-productor-id");
    if (elNombre) elNombre.textContent = nombreProd;
    if (elId) elId.textContent = `Clave: ${sesion.id} · ${munProd}`;

    renderizarPestanasParcelasProductor(sesion.id);

    const primeraParcela = prod?.parcelas?.[0] || estadoApp.parcelas[0]?.id;
    if (primeraParcela) seleccionarParcelaAgricultor(primeraParcela);
  } else if (sesion.rol === "coordinador" || sesion.rol === "tecnico") {
    const tecId = sesion.rol === "tecnico" ? (sesion.id || "T-01") : (sesion.id || "todos");
    estadoApp.filtroTecnico = tecId;
    const selTec = document.querySelector("#filtro-tecnico-select");
    const btnReset = document.querySelector("#btn-limpiar-tecnico");
    if (selTec) {
      selTec.value = tecId;
      selTec.disabled = sesion.rol === "tecnico";
    }
    if (btnReset && sesion.rol === "tecnico") {
      btnReset.classList.add("oculto");
      btnReset.style.display = "none";
    }
    actualizarVistaTecnico();
    if (tecId !== "todos") {
      const t = mapaTecnicos.get(tecId);
      if (t) mapTecnico.flyTo([Number(t.lat), Number(t.lon)], 12, { duration: 0.7 });
    }
  }
}

function poblarModalAuthAgricultor() {
  const select = document.querySelector("#select-auth-productor");
  if (!select || !estadoApp.productores.length) return;
  select.innerHTML = "";
  const ordenados = [...estadoApp.productores].sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true })
  );
  for (const pr of ordenados) {
    const opt = document.createElement("option");
    opt.value = pr.id;
    const cantParcelas = pr.parcelas ? pr.parcelas.length : 0;
    opt.textContent = `${pr.id} · ${pr.nombre} (${pr.municipio} · ${cantParcelas} parcela${cantParcelas === 1 ? "" : "s"})`;
    select.appendChild(opt);
  }
  if (estadoApp.productorActualId) {
    select.value = estadoApp.productorActualId;
  }
}

function abrirModalAuthAgricultor() {
  poblarModalAuthAgricultor();
  document.querySelector("#modal-auth-agricultor")?.classList.remove("oculto");
}

function cerrarModalAuthAgricultor() {
  document.querySelector("#modal-auth-agricultor")?.classList.add("oculto");
  const sesion = cargarSesion();
  if (!sesion && estadoApp.vistaActual === "agricultor") {
    cambiarVista("landing");
  }
}

function abrirModalAuthCoordinador() {
  document.querySelector("#modal-auth-coordinador")?.classList.remove("oculto");
}

function cerrarModalAuthCoordinador() {
  document.querySelector("#modal-auth-coordinador")?.classList.add("oculto");
}

function cerrarSesionUsuario(mostrarAviso = true) {
  try {
    sessionStorage.removeItem("itgreen_sesion");
    sessionStorage.removeItem("alerta_plaga_sesion");
    localStorage.removeItem("itgreen_sesion");
    localStorage.removeItem("alerta_plaga_sesion");
  } catch {}
  estadoApp.filtroTecnico = "todos";
  const selTec = document.querySelector("#filtro-tecnico-select");
  if (selTec) {
    selTec.disabled = false;
    selTec.value = "todos";
  }
  const btnReset = document.querySelector("#btn-limpiar-tecnico");
  if (btnReset) {
    btnReset.style.display = "";
    btnReset.classList.add("oculto");
  }
  chatHistorialParcelas.clear();
  puntosDanioPorParcela.clear();
  pctDanioPorParcela.clear();
  focosDanioPorParcela.clear();
  focoSeleccionadoId = null;
  croquisAdjuntoActual = null;
  estadoApp.productorActualId = null;
  estadoApp.parcelaActual = null;
  puntoDanioActual = null;
  pctDanioActual = 10;
  haDanadasActual = 0.55;

  // Limpiar capas del mapa del agricultor si existieran
  if (marcadorDanio && mapAgricultor) {
    try { mapAgricultor.removeLayer(marcadorDanio); } catch {}
    marcadorDanio = null;
  }
  if (circuloDanio && mapAgricultor) {
    try { mapAgricultor.removeLayer(circuloDanio); } catch {}
    circuloDanio = null;
  }
  if (poligonoParcela && mapAgricultor) {
    try { mapAgricultor.removeLayer(poligonoParcela); } catch {}
    poligonoParcela = null;
  }

  // Limpiar adjuntos y grabación en curso si existía
  limpiarAdjuntosChat();
  if (grabacionActiva) {
    grabacionCancelada = true;
    if (grabacionTimer) clearInterval(grabacionTimer);
    grabacionActiva = false;
    document.querySelector("#chat-grabando-banner")?.classList.add("oculto");
  }

  const feed = document.querySelector("#chat-mensajes");
  if (feed) feed.innerHTML = "";
  const tabs = document.querySelector("#agr-parcelas-tabs");
  if (tabs) tabs.innerHTML = "";
  const statusBox = document.querySelector("#agr-visita-status");
  if (statusBox) statusBox.innerHTML = "";

  const chatBadge = document.querySelector("#chat-parcela-badge");
  if (chatBadge) chatBadge.textContent = "🌱 Sin parcela seleccionada";

  actualizarBadgeSesion(null);
  document.querySelector("#nav-coordinador")?.classList.add("oculto");
  if (estadoApp.vistaActual !== "landing") {
    cambiarVista("landing", false);
  }
  if (mostrarAviso) {
    mostrarToast("🚪 Sesión cerrada correctamente");
  }
}

function inicializarEventosAuth() {
  // Botones y tarjetas de acceso en Landing Page
  const navegarOAutenticarAgri = () => {
    const sesion = cargarSesion();
    if (sesion && sesion.rol === "agricultor") {
      cambiarVista("agricultor");
    } else {
      abrirModalAuthAgricultor();
    }
  };

  const navegarOAutenticarCoord = () => {
    const sesion = cargarSesion();
    if (sesion && (sesion.rol === "coordinador" || sesion.rol === "tecnico")) {
      cambiarVista("tecnico");
    } else {
      abrirModalAuthCoordinador();
    }
  };

  document.querySelector("#btn-entrar-agricultor")?.addEventListener("click", navegarOAutenticarAgri);
  document.querySelector("#card-acceso-agricultor")?.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    navegarOAutenticarAgri();
  });

  document.querySelector("#btn-entrar-coordinador")?.addEventListener("click", navegarOAutenticarCoord);
  document.querySelector("#card-acceso-coordinador")?.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    navegarOAutenticarCoord();
  });

  // Cerrar modales
  document.querySelector("#btn-cerrar-auth-agri")?.addEventListener("click", cerrarModalAuthAgricultor);
  document.querySelector("#btn-cerrar-auth-coord")?.addEventListener("click", cerrarModalAuthCoordinador);

  // Cierre al hacer click en el backdrop
  document.querySelector("#modal-auth-agricultor")?.addEventListener("click", (e) => {
    if (e.target.id === "modal-auth-agricultor") cerrarModalAuthAgricultor();
  });
  document.querySelector("#modal-auth-coordinador")?.addEventListener("click", (e) => {
    if (e.target.id === "modal-auth-coordinador") cerrarModalAuthCoordinador();
  });

  // Chips demo de agricultor
  document.querySelectorAll(".chip-demo").forEach((chip) => {
    chip.addEventListener("click", () => {
      const pid = chip.dataset.pid;
      const select = document.querySelector("#select-auth-productor");
      if (select && pid) select.value = pid;
    });
  });

  // Confirmar acceso Agricultor con autenticación estricta por PIN fitosanitario
  const confirmarAuthAgri = () => {
    const select = document.querySelector("#select-auth-productor");
    const pinInput = document.querySelector("#input-auth-pin-agri");
    const pin = (pinInput?.value || "").trim().toLowerCase();
    const pid = select?.value || (estadoApp.productores[0]?.id || "PR-101");
    const numId = pid.replace(/\D/g, ""); // "101"

    // Validar PIN fitosanitario de acceso
    const pinValido =
      pin === "1234" ||
      pin === "2026" ||
      pin === "campo" ||
      pin === "chapingo" ||
      pin === "admin" ||
      pin === numId ||
      pin === `0${numId}` ||
      pin === pid.toLowerCase();

    if (!pinValido) {
      mostrarToast("⚠️ PIN de productor incorrecto. Usa el PIN oficial: 1234");
      return;
    }

    const prod = mapaProductores.get(pid);
    const sesion = {
      rol: "agricultor",
      id: pid,
      nombre: prod?.nombre || `Productor ${pid}`,
      municipio: prod?.municipio || "Texcoco",
    };
    guardarSesion(sesion);
    aplicarSesion(sesion);
    cerrarModalAuthAgricultor();
    cambiarVista("agricultor");
    mostrarToast(`🌾 Sesión iniciada: ${sesion.nombre} (${pid})`);
  };

  document.querySelector("#btn-confirmar-auth-agri")?.addEventListener("click", confirmarAuthAgri);
  document.querySelector("#form-auth-agri")?.addEventListener("submit", (e) => {
    e.preventDefault();
    confirmarAuthAgri();
  });

  // Confirmar acceso Coordinador
  const confirmarAuthCoord = () => {
    const pin = (document.querySelector("#input-auth-pin")?.value || "").trim().toLowerCase();
    const tecId = document.querySelector("#select-auth-tecnico")?.value || "todos";

    // Validar PIN de acceso (preconfigurado 2026 o clave oficial de equipo)
    if (pin && pin !== "2026" && pin !== "amaranto-cebada-44" && pin !== "admin") {
      mostrarToast("⚠️ Clave/PIN incorrecto. Usa la clave oficial: 2026");
      return;
    }

    let nombreRol = "Coordinador General";
    if (tecId !== "todos") {
      const tec = mapaTecnicos.get(tecId);
      nombreRol = tec ? tec.nombre : tecId;
    }

    const sesion = {
      rol: tecId === "todos" ? "coordinador" : "tecnico",
      id: tecId,
      nombre: nombreRol,
    };
    guardarSesion(sesion);
    aplicarSesion(sesion);
    cerrarModalAuthCoordinador();
    cambiarVista("tecnico");
    mostrarToast(`🔬 Acceso autorizado: ${nombreRol}`);
  };

  document.querySelector("#btn-confirmar-auth-coord")?.addEventListener("click", confirmarAuthCoord);
  document.querySelector("#form-auth-coord")?.addEventListener("submit", (e) => {
    e.preventDefault();
    confirmarAuthCoord();
  });

  // Botón Salir / Cerrar Sesión en badge superior y en tarjeta de agricultor
  document.querySelector("#btn-cerrar-sesion")?.addEventListener("click", cerrarSesionUsuario);
  document.querySelector("#btn-cerrar-sesion-agri")?.addEventListener("click", cerrarSesionUsuario);
}

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

  // KPIs de la Landing Page
  animarContador(document.querySelector("#land-kpi-casos"), casos.length);
  animarContador(document.querySelector("#land-kpi-productores"), estadoApp.productores.length);
  animarContador(document.querySelector("#land-kpi-parcelas"), estadoApp.parcelas.length);
  animarContador(document.querySelector("#land-kpi-tecnicos"), estadoApp.tecnicos.length);
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

  const sesion = cargarSesion();
  const esTecnico = sesion && sesion.rol === "tecnico";

  if (btnReset) {
    if (esTecnico) {
      btnReset.classList.add("oculto");
      btnReset.style.display = "none";
    } else {
      btnReset.style.display = "";
      btnReset.classList.toggle("oculto", estadoApp.filtroTecnico === "todos");
    }
  }

  // Contar cuántos casos tiene asignado cada técnico
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
          <span>Casos asignados: <strong>${asignadosN2}</strong> ${brotesN2 > 0 ? `(🔥${brotesN2})` : ""}</span>
        </div>
        <div class="tec-bar-bg">
          <div class="tec-bar-fill" style="width: ${pctCarga}%; background: ${colorBarra}"></div>
        </div>
      </div>
    `;
    card.addEventListener("click", () => {
      if (esTecnico) {
        if (estadoApp.filtroTecnico !== t.id) {
          mostrarToast(`🔒 Acceso restringido: Vista fijada exclusivamente a tu perfil (${sesion.id})`);
        }
        return;
      }
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

function obtenerTecnicoMasCercano(lat, lon) {
  let minDist = Infinity;
  let bestTecId = "T-01";
  for (const t of estadoApp.tecnicos) {
    const d = haversineKm(Number(lat), Number(lon), Number(t.lat), Number(t.lon));
    if (d < minDist) {
      minDist = d;
      bestTecId = t.id;
    }
  }
  return bestTecId;
}

function obtenerParcelasVisibles() {
  if (!estadoApp.filtroTecnico || estadoApp.filtroTecnico === "todos") {
    // Coordinador General: Red íntegra de 264 parcelas
    return estadoApp.parcelas;
  }
  const tId = estadoApp.filtroTecnico;
  // 1. Parcelas con casos activos o históricos vinculados a este técnico
  const parcelasConCasos = new Set();
  const todosLosCasos = [...estadoApp.casosHistorial, ...estadoApp.casosPrevios];
  for (const c of todosLosCasos) {
    if (c.tecnico_id === tId && c.parcela_id) {
      parcelasConCasos.add(c.parcela_id);
    }
  }
  // 2. Parcelas dentro de la jurisdicción geográfica de su base
  return estadoApp.parcelas.filter((p) => {
    if (parcelasConCasos.has(p.id)) return true;
    return obtenerTecnicoMasCercano(p.lat, p.lon) === tId;
  });
}

function renderizarMapaTecnico(casosFiltrados) {
  layerParcelasTec.clearLayers();
  layerCasosTec.clearLayers();
  layerBrotesTec.clearLayers();
  layerTecnicosBases.clearLayers();
  layerRutasTecnicos.clearLayers();

  // 0. Dibujar huellas poligonales de parcelas según el técnico activo (aislamiento R3) o red completa
  const parcelasVisibles = obtenerParcelasVisibles();
  for (const p of parcelasVisibles) {
    const latP = Number(p.lat);
    const lonP = Number(p.lon);
    if (!latP || !lonP) continue;

    const supHa = Number(p.superficie_ha) || 5;
    const ladoMetros = Math.sqrt(supHa * 10000);
    const deltaLat = ladoMetros / 111320 / 2;
    const deltaLon = ladoMetros / (111320 * Math.cos((latP * Math.PI) / 180)) / 2;
    const bounds = [
      [latP - deltaLat, lonP - deltaLon],
      [latP + deltaLat, lonP + deltaLon],
    ];
    const tieneCaso = casosFiltrados.some((c) => c.parcela_id === p.id);
    const rect = L.rectangle(bounds, {
      color: tieneCaso ? "#ef4444" : "#10b981",
      weight: tieneCaso ? 2 : 1.2,
      fillColor: tieneCaso ? "#ef4444" : "#00c067",
      fillOpacity: tieneCaso ? 0.28 : 0.12,
    });
    rect.bindTooltip(
      `<b>${p.id} · ${p.nombre}</b><br/>${p.municipio} · ${p.cultivo} (${supHa} ha)${tieneCaso ? "<br/><span style='color:#ef4444; font-weight:700;'>⚠️ Caso activo</span>" : ""}`,
      { direction: "top" }
    );
    if (tieneCaso) {
      const casoP = casosFiltrados.find((c) => c.parcela_id === p.id);
      if (casoP) {
        rect.on("click", () => abrirModalExpediente(casoP.reporte_id));
      }
    }
    rect.addTo(layerParcelasTec);
  }

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
    if (estadoApp.filtroTecnico !== "todos") {
      const tec = mapaTecnicos.get(estadoApp.filtroTecnico);
      const parcelasVis = obtenerParcelasVisibles();
      contador.textContent = `Técnico ${estadoApp.filtroTecnico} (${tec?.nombre || ""}) · ${casosFiltrados.length} caso${casosFiltrados.length === 1 ? "" : "s"} activos · ${parcelasVis.length} parcelas asignadas`;
    } else {
      contador.textContent = `Mostrando ${casosFiltrados.length} caso${casosFiltrados.length === 1 ? "" : "s"} · 264 parcelas bajo cobertura (Red Completa)`;
    }
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
  const sesion = cargarSesion();
  const esTecnicoIndiv =
    (sesion && sesion.rol === "tecnico") ||
    (estadoApp.filtroTecnico && estadoApp.filtroTecnico !== "todos");

  const cardEscuadron = document.querySelector(".card-escuadron-tecnico");
  const topGrid = document.querySelector(".tecnico-top-grid");

  if (cardEscuadron) {
    if (esTecnicoIndiv) {
      cardEscuadron.classList.add("oculto");
      cardEscuadron.style.display = "none";
    } else {
      cardEscuadron.classList.remove("oculto");
      cardEscuadron.style.display = "";
    }
  }
  if (topGrid) {
    if (esTecnicoIndiv) {
      topGrid.classList.add("tecnico-top-grid-solo");
    } else {
      topGrid.classList.remove("tecnico-top-grid-solo");
    }
  }

  const filtrados = filtrarCasosTecnico();
  if (!esTecnicoIndiv) {
    renderizarEscuadronTecnicos();
  }
  renderizarMapaTecnico(filtrados);
  renderizarTablaCasosNivel2(filtrados);

  if (mapTecnico) {
    setTimeout(() => {
      mapTecnico.invalidateSize();
    }, 60);
  }
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
        <div class="sub-hint">CLASIFICACIÓN FITOSANITARIA OFICIAL · IT GREEN</div>
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
// VISTA 2: PORTAL DEL AGRICULTOR (ASISTENTE CONVERSACIONAL Y MAPA DE PARCELA)
// ============================================================================
const chatHistorialParcelas = new Map(); // key = parcelaId -> array de mensajes
let fotoAdjuntaActual = null;
let audioAdjuntoActual = null;
let grabacionActiva = false;
let mediaRecorder = null;
let audioChunks = [];
let grabacionTimer = null;
let grabacionSegundos = 0;

function poblarSelectoresCatalogo() {
  // Selector de Parcelas en Bitácora General (Vista 3)
  const selBitParcela = document.querySelector("#bit-parcela");
  if (selBitParcela) {
    selBitParcela.innerHTML = "";
    for (const p of estadoApp.parcelas) {
      const opt2 = document.createElement("option");
      opt2.value = `${p.id} · ${p.nombre} (${p.municipio})`;
      opt2.dataset.cultivo = p.cultivo;
      opt2.textContent = `${p.id} - ${p.nombre} (${p.cultivo})`;
      selBitParcela.appendChild(opt2);
    }
  }

  // Selector de las 10 Plagas Oficiales (Filtro del Centro de Mando Técnico)
  const filtroPlagaTec = document.querySelector("#filtro-plaga-tec");
  if (filtroPlagaTec) {
    filtroPlagaTec.innerHTML = '<option value="todas">Todas las plagas (10)</option>';
    for (const pl of estadoApp.plagas) {
      const optF = document.createElement("option");
      optF.value = pl.id;
      optF.textContent = pl.nombre;
      filtroPlagaTec.appendChild(optF);
    }
  }

  // Selector de Técnicos en filtro de coordinación
  const filtroTecSel = document.querySelector("#filtro-tecnico-select");
  if (filtroTecSel) {
    filtroTecSel.innerHTML = '<option value="todos">Todos los técnicos (T-01..T-12)</option>';
    for (const t of estadoApp.tecnicos) {
      const optT = document.createElement("option");
      optT.value = t.id;
      optT.textContent = `${t.id} · ${t.nombre} (${t.especialidad})`;
      filtroTecSel.appendChild(optT);
    }
    const sesion = cargarSesion();
    if (sesion && sesion.rol === "tecnico") {
      filtroTecSel.value = sesion.id;
      filtroTecSel.disabled = true;
    }
  }
}

// R3: Aislamiento total de las parcelas del productor autenticado
function renderizarPestanasParcelasProductor(productorId) {
  const cont = document.querySelector("#agr-parcelas-tabs");
  if (!cont) return;
  cont.innerHTML = "";

  const prod = mapaProductores.get(productorId);
  const parcelasIds = prod?.parcelas || [];

  if (parcelasIds.length === 0) {
    cont.innerHTML = '<span class="sub-hint">No hay parcelas registradas para este productor.</span>';
    return;
  }

  const activaId = parcelasIds.includes(estadoApp.parcelaActual?.id)
    ? estadoApp.parcelaActual.id
    : parcelasIds[0];

  parcelasIds.forEach((pId) => {
    const p = mapaParcelas.get(pId);
    if (!p) return;
    const esActiva = p.id === activaId;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `parcela-tab ${esActiva ? "active" : ""}`;
    btn.dataset.parcela = p.id;
    btn.innerHTML = `
      <span class="tab-icon">🌱</span>
      <span class="tab-info">
        <strong>${p.id} · ${p.nombre}</strong>
        <small>${p.cultivo} · ${p.superficie_ha} ha · Etapa ${p.etapa}</small>
      </span>
    `;
    btn.addEventListener("click", () => {
      seleccionarParcelaAgricultor(p.id);
    });
    cont.appendChild(btn);
  });
}

// R3: Solo mostrar si hay visita técnica agendada o aviso crítico directo
function actualizarBannerVisitaParcela(parcelaId) {
  const box = document.querySelector("#agr-visita-status");
  if (!box) return;

  const casoActivo = estadoApp.casosHistorial.find((c) => c.parcela_id === parcelaId);
  const p = mapaParcelas.get(parcelaId);

  // Buscar avisos oficiales críticos para esta parcela o su productor
  const prodId = estadoApp.productorActualId;
  const avisoDeParcela = estadoApp.avisos.find((a) => {
    const esCritico = a.tipo === "brote" || a.tipo === "cuarentenaria";
    return esCritico && a.mensaje?.includes(parcelaId);
  });
  const avisoCritico = avisoDeParcela || estadoApp.avisos.find((a) => {
    const esCritico = a.tipo === "brote" || a.tipo === "cuarentenaria";
    const esDeProductor = Array.isArray(a.para) && prodId && a.para.includes(prodId);
    return esCritico && esDeProductor;
  });

  if (casoActivo && p) {
    const tec = mapaTecnicos.get(casoActivo.tecnico_id);
    const prioridadNum = Number(casoActivo.prioridad) || 50;
    const tiempoVisita = prioridadNum >= 85 ? "menos de 24 horas" : prioridadNum >= 70 ? "menos de 48 horas" : "menos de 72 horas";
    const sem = (casoActivo.semaforo || "amarillo").toUpperCase();
    box.innerHTML = `
      <div class="visita-card visita-activa">
        <div class="visita-icon">📅</div>
        <div class="visita-content">
          <div class="visita-top">
            <span class="badge-visita-urgente">VISITA TÉCNICA PROGRAMADA · FOLIO ${escaparHtml(casoActivo.reporte_id || "")}</span>
            <span class="visita-tiempo">⏱️ Tiempo estimado: ${tiempoVisita}</span>
          </div>
          <h4>${escaparHtml(nombreLegiblePlaga(casoActivo.plaga))} en cultivo de ${escaparHtml(p.cultivo)} · Semáforo ${sem} (${prioridadNum} pts)</h4>
          <p>
            Atención prioritaria asignada a <strong>${tec ? `${escaparHtml(tec.nombre)} (${escaparHtml(tec.especialidad)} · Base ${escaparHtml(tec.base)})` : "Especialista técnico de zona"}</strong>.
            ${casoActivo.brote ? " · ⚠️ <b>Alerta de Brote Zonal activa</b>." : ""}
            Favor de mantener libre acceso al predio.
          </p>
          ${avisoCritico ? `<div style="margin-top:10px; padding:8px 12px; background:#7f1d1d; border-left:4px solid #ef4444; border-radius:6px; font-size:12.5px; color:#ffffff; font-weight:600;"><strong style="color:#fef08a;">📢 Aviso Oficial Directo:</strong> ${escaparHtml(avisoCritico.mensaje)}</div>` : ""}
        </div>
      </div>
    `;
  } else if (avisoCritico && p) {
    box.innerHTML = `
      <div class="visita-card visita-activa visita-aviso-critico">
        <div class="visita-icon" style="font-size:30px;">🚨</div>
        <div class="visita-content">
          <div class="visita-top">
            <span class="badge-aviso-critico-zona"><span style="color:#fef08a;">⚠️</span> AVISO FITOSANITARIO CRÍTICO EN ZONA</span>
          </div>
          <h4 style="color:#ffffff; font-weight:800; font-size:16px; margin:4px 0 6px;">Alerta Sanitaria en la cercanía de Parcela ${escaparHtml(p.id)}</h4>
          <p style="color:#fee2e2; font-size:13.5px; line-height:1.5; font-weight:500;">${escaparHtml(avisoCritico.mensaje)}</p>
        </div>
      </div>
    `;
  } else {
    box.innerHTML = `
      <div class="visita-card visita-limpia">
        <div class="visita-icon">✅</div>
        <div class="visita-content">
          <div class="visita-top">
            <span class="badge-visita-ok">ESTADO SANITARIO MONITOREADO</span>
          </div>
          <h4>Sin reportes críticos abiertos en esta parcela</h4>
          <p>Tu cultivo se encuentra protegido. Si observas hojas mordidas, manchas o presencia de larvas, descríbelo en el chat o envía una foto/audio abajo.</p>
        </div>
      </div>
    `;
  }
}

// ============================================================================
// CROQUIS SATELITAL DE PARCELA & CÁLCULO DE ÁREAS AFECTADAS
// ============================================================================
function obtenerFocosParcela(parcelaId) {
  if (!focosDanioPorParcela.has(parcelaId)) {
    // Foco inicial centrado representativo (~10% de daño estándar)
    const focos = [
      {
        id: `foco-${Date.now()}-1`,
        x: 300,
        y: 190,
        r: 35,
      },
    ];
    focosDanioPorParcela.set(parcelaId, focos);
  }
  return focosDanioPorParcela.get(parcelaId);
}

function calcularAreaDanioParcela(p, focos) {
  const supTotalHa = Number(p?.superficie_ha) || 1.0;
  if (!focos || focos.length === 0) {
    return {
      supTotalHa,
      haDanadas: 0,
      pctDanio: 0,
    };
  }

  // Rectángulo de cultivo en SVG: 540 x 330 px (origen x=30, y=25)
  // Cálculo de la UNIÓN booleana exacta de círculos para no duplicar áreas solapadas
  const W = 540;
  const H = 330;
  const minX = 30;
  const minY = 25;
  const step = 3; // Rejilla de alta precisión (180 x 110 = 19,800 celdas)
  let puntosAdentro = 0;
  let puntosTotales = 0;

  // Pre-calcular radios al cuadrado
  const focosR2 = focos.map((f) => ({
    x: f.x,
    y: f.y,
    r2: f.r * f.r,
  }));

  for (let y = minY; y < minY + H; y += step) {
    for (let x = minX; x < minX + W; x += step) {
      puntosTotales++;
      for (let i = 0; i < focosR2.length; i++) {
        const dx = x - focosR2[i].x;
        const dy = y - focosR2[i].y;
        if (dx * dx + dy * dy <= focosR2[i].r2) {
          puntosAdentro++;
          break; // Unión exacta: si cae en cualquier círculo, cuenta una sola vez
        }
      }
    }
  }

  const fraccionUnion = puntosTotales > 0 ? Math.min(1.0, puntosAdentro / puntosTotales) : 0;
  const haDanadas = Math.min(supTotalHa, supTotalHa * fraccionUnion);
  const pctDanio = Math.min(100, Math.max(1, Math.round(fraccionUnion * 100)));

  return {
    supTotalHa,
    haDanadas,
    pctDanio,
  };
}

function actualizarMetricasCroquis() {
  const p = estadoApp.parcelaActual;
  if (!p) return;

  const focos = obtenerFocosParcela(p.id);
  const calc = calcularAreaDanioParcela(p, focos);

  pctDanioActual = calc.pctDanio;
  haDanadasActual = calc.haDanadas;
  pctDanioPorParcela.set(p.id, pctDanioActual);

  const calcHaEl = document.querySelector("#croquis-calc-ha");
  const calcPctEl = document.querySelector("#croquis-calc-pct");
  const calcTotalEl = document.querySelector("#croquis-calc-total");
  const metricsTxtEl = document.querySelector("#croquis-metrics-txt");

  if (calcHaEl) calcHaEl.textContent = `${calc.haDanadas.toFixed(2)} ha`;
  if (calcPctEl) calcPctEl.textContent = `${calc.pctDanio}%`;
  if (calcTotalEl) calcTotalEl.textContent = `de ${calc.supTotalHa.toFixed(2)} ha`;
  if (metricsTxtEl) {
    metricsTxtEl.innerHTML = `Focos: <strong>${focos.length}</strong> · Daño: <strong>${calc.pctDanio}%</strong> (~${calc.haDanadas.toFixed(2)} ha)`;
  }

  const btnEliminar = document.querySelector("#btn-eliminar-foco");
  const sliderRadio = document.querySelector("#croquis-radio-slider");
  const sliderVal = document.querySelector("#croquis-radio-val");

  if (focoSeleccionadoId) {
    const fSel = focos.find((f) => f.id === focoSeleccionadoId);
    if (fSel) {
      if (btnEliminar) btnEliminar.disabled = false;
      if (sliderRadio && Number(sliderRadio.value) !== fSel.r) sliderRadio.value = String(fSel.r);
      const radioMetros = Math.max(5, Math.round((fSel.r / 540) * Math.sqrt(calc.supTotalHa * 10000)));
      if (sliderVal) sliderVal.textContent = `~${radioMetros} m`;
    } else {
      if (btnEliminar) btnEliminar.disabled = true;
    }
  } else {
    if (btnEliminar) btnEliminar.disabled = true;
  }
}


function obtenerUrlSateliteParcela(p) {
  if (!p || p.lat === undefined || p.lon === undefined) {
    return "/croquis-satelite-ortofoto.jpg";
  }
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (isNaN(lat) || isNaN(lon)) {
    return "/croquis-satelite-ortofoto.jpg";
  }
  const ha = Math.max(0.5, Number(p.superficie_ha) || 2.0);
  const ladoMetros = Math.max(220, Math.sqrt(ha * 10000) * 1.35);
  const deltaLat = (ladoMetros / 111320) / 2;
  const deltaLon = (ladoMetros / (111320 * Math.cos((lat * Math.PI) / 180))) / 2;

  const minLon = (lon - deltaLon).toFixed(6);
  const minLat = (lat - deltaLat).toFixed(6);
  const maxLon = (lon + deltaLon).toFixed(6);
  const maxLat = (lat + deltaLat).toFixed(6);

  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${minLon},${minLat},${maxLon},${maxLat}&bboxSR=4326&imageSR=4326&size=600,380&format=jpg&f=image`;
}

function renderizarCroquisParcela(p) {
  if (!p) return;
  const svgGroup = document.querySelector("#croquis-focos-group");
  if (!svgGroup) return;

  const badgeId = document.querySelector("#croquis-badge-id");
  const badgeCultivo = document.querySelector("#croquis-badge-cultivo");
  const badgeDims = document.querySelector("#croquis-badge-dims");

  const supHa = Number(p.superficie_ha) || 1.0;
  const ladoMetros = Math.round(Math.sqrt(supHa * 10000));

  if (badgeId) badgeId.textContent = `Parcela ${p.id} · ${p.nombre}`;
  if (badgeCultivo) badgeCultivo.textContent = `🌱 ${p.cultivo || "Cultivo"}`;
  if (badgeDims) badgeDims.textContent = `${supHa.toFixed(2)} ha · ~${ladoMetros} m × ${ladoMetros} m`;

  // Actualizar imagen satelital fotorrealista específica a las coordenadas exactas de la parcela
  const imgSatelite = document.querySelector("#croquis-satelite-img");
  if (imgSatelite) {
    const urlSatelite = obtenerUrlSateliteParcela(p);
    imgSatelite.setAttribute("href", urlSatelite);
    imgSatelite.setAttributeNS("http://www.w3.org/1999/xlink", "href", urlSatelite);
  }

  // Actualizar escala métrica según la dimensión real del predio
  const metrosEscala = Math.max(15, Math.round((90 / 540) * Math.max(180, ladoMetros)));
  const escalaText = document.querySelector("#croquis-escala text");
  if (escalaText) {
    escalaText.textContent = `${metrosEscala} metros`;
  }

  const focos = obtenerFocosParcela(p.id);

  if (!focoSeleccionadoId && focos.length > 0) {
    focoSeleccionadoId = focos[0].id;
  }

  svgGroup.innerHTML = "";

  focos.forEach((f, idx) => {
    const esSeleccionado = f.id === focoSeleccionadoId;
    const gFoco = document.createElementNS("http://www.w3.org/2000/svg", "g");
    gFoco.setAttribute("data-foco-id", f.id);
    gFoco.style.cursor = "move";

    // Círculo interactivo de foco de daño
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(f.x));
    circle.setAttribute("cy", String(f.y));
    circle.setAttribute("r", String(f.r));
    circle.setAttribute("fill", "rgba(239, 68, 68, 0.42)");
    circle.setAttribute("stroke", esSeleccionado ? "#ffffff" : "#ef4444");
    circle.setAttribute("stroke-width", esSeleccionado ? "3" : "2");
    if (esSeleccionado) {
      circle.setAttribute("stroke-dasharray", "5 3");
    }
    circle.setAttribute("class", `foco-circulo-svg ${esSeleccionado ? "seleccionado" : ""}`);

    // Pin central del foco
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(f.x));
    dot.setAttribute("cy", String(f.y));
    dot.setAttribute("r", "5");
    dot.setAttribute("fill", esSeleccionado ? "#fef08a" : "#f87171");
    dot.setAttribute("stroke", "#ffffff");
    dot.setAttribute("stroke-width", "1.5");
    dot.setAttribute("class", "foco-centro-dot");

    // Etiqueta del foco con área calculada individual
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(f.x));
    text.setAttribute("y", String(Math.max(40, f.y - f.r - 6)));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "foco-label-text");
    const areaIndividualHa = (Math.PI * Math.pow(f.r, 2) / (540 * 330)) * supHa;
    text.textContent = `Foco ${idx + 1}: ${areaIndividualHa.toFixed(2)} ha`;

    gFoco.appendChild(circle);
    gFoco.appendChild(dot);
    gFoco.appendChild(text);

    gFoco.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      focoSeleccionadoId = f.id;
      renderizarCroquisParcela(p);
      iniciarArrastreFoco(e, f, p);
    });

    svgGroup.appendChild(gFoco);
  });

  actualizarMetricasCroquis();
}

function iniciarArrastreFoco(e, foco, p) {
  try {
    e.preventDefault?.();
    e.stopPropagation?.();
  } catch (_) {}

  const targetEl = e.currentTarget || e.target;
  const pointerId = e.pointerId;
  if (targetEl && typeof targetEl.setPointerCapture === "function") {
    try {
      targetEl.setPointerCapture(pointerId);
    } catch (_) {}
  }

  arrastrandoFoco = {
    foco,
    p,
    startClientX: e.clientX,
    startClientY: e.clientY,
    origX: foco.x,
    origY: foco.y,
    pointerId,
    targetEl,
  };

  const svg = document.querySelector("#croquis-svg");
  if (!svg) return;

  const onPointerMove = (ev) => {
    if (!arrastrandoFoco) return;
    try {
      ev.preventDefault?.();
    } catch (_) {}
    const rect = svg.getBoundingClientRect();
    const scaleX = 600 / rect.width;
    const scaleY = 380 / rect.height;

    const dx = (ev.clientX - arrastrandoFoco.startClientX) * scaleX;
    const dy = (ev.clientY - arrastrandoFoco.startClientY) * scaleY;

    const r = arrastrandoFoco.foco.r;
    const nuevoX = Math.max(30 + r, Math.min(570 - r, arrastrandoFoco.origX + dx));
    const nuevoY = Math.max(25 + r, Math.min(355 - r, arrastrandoFoco.origY + dy));

    arrastrandoFoco.foco.x = Math.round(nuevoX);
    arrastrandoFoco.foco.y = Math.round(nuevoY);

    renderizarCroquisParcela(arrastrandoFoco.p);
  };

  const onPointerUp = () => {
    if (targetEl && typeof targetEl.releasePointerCapture === "function") {
      try {
        targetEl.releasePointerCapture(pointerId);
      } catch (_) {}
    }
    arrastrandoFoco = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  };

  window.addEventListener("pointermove", onPointerMove, { passive: false });
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

function agregarFocoCroquis() {
  const p = estadoApp.parcelaActual;
  if (!p) return;
  const focos = obtenerFocosParcela(p.id);

  const offset = (focos.length * 48) % 190;
  const nuevoX = Math.min(510, Math.max(90, 240 + offset));
  const nuevoY = Math.min(300, Math.max(75, 160 + (offset % 110)));

  const nuevoFoco = {
    id: `foco-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    x: nuevoX,
    y: nuevoY,
    r: 32,
  };

  focos.push(nuevoFoco);
  focoSeleccionadoId = nuevoFoco.id;
  renderizarCroquisParcela(p);
  mostrarToast(`➕ Foco de daño #${focos.length} agregado al croquis`);
}

function eliminarFocoCroquis() {
  const p = estadoApp.parcelaActual;
  if (!p || !focoSeleccionadoId) return;
  const focos = obtenerFocosParcela(p.id);
  const idx = focos.findIndex((f) => f.id === focoSeleccionadoId);
  if (idx !== -1) {
    focos.splice(idx, 1);
    focoSeleccionadoId = focos.length > 0 ? focos[focos.length - 1].id : null;
    renderizarCroquisParcela(p);
    mostrarToast("🗑️ Foco de daño eliminado del croquis");
  }
}

function limpiarFocosCroquis() {
  const p = estadoApp.parcelaActual;
  if (!p) return;
  focosDanioPorParcela.set(p.id, [
    {
      id: `foco-${Date.now()}-1`,
      x: 300,
      y: 190,
      r: 35,
    },
  ]);
  focoSeleccionadoId = focosDanioPorParcela.get(p.id)[0].id;
  renderizarCroquisParcela(p);
  mostrarToast("↺ Croquis restablecido a un foco de referencia (10%)");
}

function adjuntarCroquisAlReporte() {
  const p = estadoApp.parcelaActual;
  if (!p) {
    mostrarToast("⚠️ Selecciona una parcela antes de adjuntar el croquis");
    return;
  }
  const focos = obtenerFocosParcela(p.id);
  if (focos.length === 0) {
    agregarFocoCroquis();
  }

  const calc = calcularAreaDanioParcela(p, focos);

  croquisAdjuntoActual = {
    parcelaId: p.id,
    nombreParcela: p.nombre,
    cultivo: p.cultivo,
    numFocos: focos.length,
    haTotal: calc.supTotalHa,
    haDanio: calc.haDanadas,
    pctDanio: calc.pctDanio,
  };

  const chipCroquis = document.querySelector("#adjunto-croquis-preview");
  const descCroquis = document.querySelector("#adjunto-croquis-desc");
  const barAdjuntos = document.querySelector("#chat-adjuntos-bar");

  if (descCroquis) {
    descCroquis.textContent = `${focos.length} foco(s) · ${calc.haDanadas.toFixed(2)} ha (${calc.pctDanio}%)`;
  }
  if (chipCroquis) chipCroquis.classList.remove("oculto");
  if (barAdjuntos) barAdjuntos.classList.remove("oculto");

  const chatInput = document.querySelector("#chat-input-texto");
  if (chatInput) {
    const textoPrevio = chatInput.value.trim();
    const resumenCroquis = `📍 [Croquis Fitosanitario: ${focos.length} foco(s) de afección, ${calc.haDanadas.toFixed(2)} ha dañadas (${calc.pctDanio}% de la parcela ${p.id})]`;
    if (!textoPrevio) {
      chatInput.value = `Observo anomalías en el cultivo. ${resumenCroquis} `;
    } else if (!textoPrevio.includes("Croquis Fitosanitario")) {
      chatInput.value = `${textoPrevio}\n${resumenCroquis}`;
    }
    chatInput.focus();
  }

  mostrarToast(`📐 Croquis de parcela ${p.id} (${calc.pctDanio}% de daño) adjuntado al reporte`);
}

// Selección de Parcela fija y renderizado de su croquis satelital
function seleccionarParcelaAgricultor(parcelaId) {
  const p = mapaParcelas.get(parcelaId) || estadoApp.parcelas[0];
  if (!p) return;
  estadoApp.parcelaActual = p;

  document.querySelectorAll(".parcela-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.parcela === p.id);
  });

  const chatBadge = document.querySelector("#chat-parcela-badge");
  if (chatBadge) {
    chatBadge.textContent = `🌱 Parcela ${p.id} · ${p.nombre} (${p.cultivo})`;
  }

  actualizarBannerVisitaParcela(p.id);
  renderizarCroquisParcela(p);
  iniciarChatParaParcela(p);
}


// R1: Clasificador Inteligente de Síntomas del Asistente
function diagnosticarReporteConversacional(mensajeTexto, tieneFoto, tieneAudio, pctManual) {
  const p = estadoApp.parcelaActual;
  const textoNorm = (mensajeTexto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Detectar si pregunta por seguimiento o visita previa
  const pideSeguimiento = /(^|[^\wáéíóúñ])(cuando|a que hora|ya vienen|lo de ayer|seguimiento|vienen hoy|que paso con|mandaron al tecnico|estatus|visita)\b/i.test(textoNorm);

  // Extraer porcentaje si viene en el texto ("la mitad", "20%", etc.)
  let pct = pctManual || 10;
  if (/toda la parcela|todo el predio|al 100/i.test(textoNorm)) pct = 100;
  else if (/tres cuartas partes|75\s*%/i.test(textoNorm)) pct = 75;
  else if (/dos terceras partes|66\s*%|67\s*%/i.test(textoNorm)) pct = 67;
  else if (/la mitad|medio campo|50\s*%/i.test(textoNorm)) pct = 50;
  else if (/una tercera parte|un tercio|33\s*%/i.test(textoNorm)) pct = 33;
  else if (/una cuarta parte|un cuarto|25\s*%/i.test(textoNorm)) pct = 25;
  else if (/una quinta parte|un quinto|20\s*%/i.test(textoNorm)) pct = 20;
  else if (/una decima parte|un decimo|10\s*%/i.test(textoNorm)) pct = 10;
  else {
    const matchPct = textoNorm.match(/(\d{1,3})\s*%/);
    if (matchPct) {
      const num = parseInt(matchPct[1], 10);
      if (num >= 1 && num <= 100) pct = num;
    }
  }

  // Reglas de diagnóstico empático para las 10 plagas oficiales
  const reglasPlagas = [
    {
      id: "gusano_cogollero",
      nombre: "Gusano cogollero",
      cultivos: ["maiz", "maíz"],
      regex: /cogoll|gusano|soldado|frugiperda|aserrin|hoja.*perforad|perforacion|mordid|comid.*hoja|cogollero|larva.*verde/i,
      consejo: "Revisa el cogollo de plantas contiguas y evita aplicaciones químicas indiscriminadas que dañen a insectos benéficos.",
      descripcion: "Se aprecian síntomas característicos de perforación y raspado en hojas jóvenes con probable presencia de larvas en el cogollo.",
    },
    {
      id: "roya_frijol",
      nombre: "Roya del frijol",
      cultivos: ["frijol"],
      regex: /roya|chahuixtle|polvillo|pustula|oxido|mancha.*cafe|amarill.*hoja/i,
      consejo: "Evita el riego por aspersión tardío para reducir la humedad foliar que favorece la dispersión de esporas.",
      descripcion: "Presencia de pústulas y polvillo rojizo-anaranjado característico del hongo de la roya.",
    },
    {
      id: "pulgon",
      nombre: "Pulgón",
      cultivos: ["avena", "trigo", "maiz", "maíz", "haba"],
      regex: /pulgon|pioj|mielec|fumagina|hoja.*enroll|negrilla|colonia/i,
      consejo: "Monitorea presencia de catarinas o crisopas que son controladores biológicos naturales del pulgón.",
      descripcion: "Colonias de pequeños insectos chupadores que segregan mielecilla y provocan enrollamiento de hojas.",
    },
    {
      id: "gallina_ciega",
      nombre: "Gallina ciega",
      cultivos: ["maiz", "maíz", "frijol", "avena", "haba"],
      regex: /gallina|ciega|nixticuil|gusano.*blanco|raiz.*comid|marchit|acamad|suelo/i,
      consejo: "Realiza muestreo en suelo excavando 20 cm cerca de plantas marchitas para verificar densidad larvaria.",
      descripcion: "Daño en el sistema radicular provocado por larvas subterráneas ('nixticuil'), provocando acame o marchitez.",
    },
    {
      id: "tizon_tardio",
      nombre: "Tizón tardío",
      cultivos: ["papa", "jitomate"],
      regex: /tizon|hielo|quemaz|mancha.*negra|tallo.*negro|pudric|olor.*podrid/i,
      consejo: "Aísla las plantas más afectadas y no manipules el cultivo cuando esté mojado por el rocío.",
      descripcion: "Quemazón severa con manchas acuosas y tallos ennegrecidos por patógeno fúngico.",
    },
    {
      id: "mosquita_blanca",
      nombre: "Mosquita blanca",
      cultivos: ["jitomate", "frijol"],
      regex: /mosquit.*blanca|mosquilla|palomill|mosca.*blanca|nube.*blanca|enchinad/i,
      consejo: "Coloca trampas amarillas pegajosas en las orillas para monitorear la densidad de vuelo.",
      descripcion: "Enjambres de diminutas moscas blancas transmisoras de virosis que succionan savia del envés.",
    },
    {
      id: "chapulin",
      nombre: "Chapulín",
      cultivos: ["maiz", "maíz", "frijol", "haba", "avena"],
      regex: /chapulin|saltamont|langosta|bordo|orilla|defoliad/i,
      consejo: "Revisa orillas, bordos y caminos aledaños donde suelen concentrarse antes de avanzar al centro de la parcela.",
      descripcion: "Defoliación rápida desde los bordes de la parcela provocada por saltamontes voraces.",
    },
    {
      id: "mancha_chocolate",
      nombre: "Mancha de chocolate",
      cultivos: ["haba"],
      regex: /chocolate|mancha.*chocolate|mancha.*redonda|caida.*flor|botrytis/i,
      consejo: "Promueve la aireación entre surcos y evita encharcamientos.",
      descripcion: "Manchas necróticas de color chocolate rojizo en follaje y tallos con riesgo de aborto floral.",
    },
    {
      id: "hlb",
      nombre: "HLB (Dragón Amarillo)",
      cultivos: ["limon", "limón", "citricos", "cítricos"],
      regex: /hlb|huanglongbing|dragon.*amarill|enverdecim.*citric|fruto.*deforme.*citric/i,
      consejo: "¡Alerta Cuarentenaria! No traslades varetas ni material vegetativo fuera del predio.",
      descripcion: "Sintomatología coincidente con HLB/Dragón Amarillo, plaga bajo estricta vigilancia cuarentenaria oficial.",
    },
    {
      id: "gorgojo_khapra",
      nombre: "Gorgojo Khapra",
      cultivos: ["almacen", "grano", "semilla", "maiz", "maíz"],
      regex: /khapra|gorgojo|costal|almacen|grano.*hueco|peludo/i,
      consejo: "¡Alerta Cuarentenaria! Mantén sellada la bodega y no distribuyas grano hasta la revisión oficial.",
      descripcion: "Presencia de plaga de grano almacenado bajo alerta fitosanitaria prioritaria.",
    },
  ];

  let plagaDetectada = null;
  let reglaDetectada = null;
  let sintomaEncontrado = false;

  const cultivoP = (p?.cultivo || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // 1. Priorizar reglas compatibles con el cultivo de la parcela
  const reglasCompatibles = reglasPlagas.filter((r) =>
    r.cultivos.some((c) => cultivoP.includes(c))
  );
  const otrasReglas = reglasPlagas.filter((r) =>
    !r.cultivos.some((c) => cultivoP.includes(c))
  );

  for (const r of reglasCompatibles) {
    if (r.regex.test(textoNorm)) {
      reglaDetectada = r;
      plagaDetectada = mapaPlagas.get(r.id);
      sintomaEncontrado = true;
      break;
    }
  }

  if (!sintomaEncontrado) {
    for (const r of otrasReglas) {
      if (r.regex.test(textoNorm)) {
        reglaDetectada = r;
        plagaDetectada = mapaPlagas.get(r.id);
        sintomaEncontrado = true;
        break;
      }
    }
  }

  // Detección de intenciones conversacionales
  const esAgradecimiento = /(^|[^\wáéíóúñ])(muchas gracias|gracias|todo claro|perfecto|enterado|ok|vale|de acuerdo|muy amable|mil gracias)\b/i.test(textoNorm) && !sintomaEncontrado;
  const esSeguimiento = pideSeguimiento && !sintomaEncontrado && !esAgradecimiento;
  const esSaludo = /(^|[^\wáéíóúñ])(hola|buenos dias|buenas tardes|buenas noches|que tal|saludos|buen dia)\b/i.test(textoNorm) && !sintomaEncontrado && !esAgradecimiento && !esSeguimiento;
  const esAyuda = /(^|[^\wáéíóúñ])(como funciona|que hago|ayuda|para que sirve|instrucciones|como uso|que puedo hacer)\b/i.test(textoNorm) && !sintomaEncontrado;
  const esMapaGuia = /(^|[^\wáéíóúñ])(reubicar|mapa|mover foco|marcar foco|como marco|como ubico|ajustar foco|foco de dano)\b/i.test(textoNorm) && !sintomaEncontrado;
  const esBuenEstado = /(^|[^\wáéíóúñ])(todo bien|sin plaga|plantas sanas|sin novedad|no hay plaga|todo en orden|no hay dano|sano|sanas)\b/i.test(textoNorm) && !sintomaEncontrado;

  // Un reporte técnico es válido SI Y SOLO SI hay síntomas descritos o evidencia multimodal adjunta
  const esReporteValido = sintomaEncontrado || Boolean(tieneFoto) || Boolean(tieneAudio);

  // Fallback según cultivo de la parcela si es reporte válido (por foto o audio) sin síntoma textual
  if (!plagaDetectada && esReporteValido && p) {
    if (cultivoP.includes("maiz")) {
      plagaDetectada = mapaPlagas.get("gusano_cogollero");
      reglaDetectada = reglasPlagas[0];
    } else if (cultivoP.includes("frijol")) {
      plagaDetectada = mapaPlagas.get("roya_frijol");
      reglaDetectada = reglasPlagas[1];
    } else if (cultivoP.includes("papa") || cultivoP.includes("jitomate")) {
      plagaDetectada = mapaPlagas.get("tizon_tardio");
      reglaDetectada = reglasPlagas[4];
    } else if (cultivoP.includes("haba")) {
      plagaDetectada = mapaPlagas.get("mancha_chocolate");
      reglaDetectada = reglasPlagas[7];
    } else if (cultivoP.includes("limon") || cultivoP.includes("citric")) {
      plagaDetectada = mapaPlagas.get("hlb");
      reglaDetectada = reglasPlagas[8];
    } else if (cultivoP.includes("avena") || cultivoP.includes("trigo") || cultivoP.includes("cebada")) {
      plagaDetectada = mapaPlagas.get("pulgon");
      reglaDetectada = reglasPlagas[2];
    } else {
      plagaDetectada = estadoApp.plagas[0] || null;
      reglaDetectada = reglasPlagas[0];
    }
  }

  const calc = plagaDetectada ? calcularPrioridadSemaforoDesglosado(plagaDetectada, p, pct) : null;
  const mejorTec = plagaDetectada ? seleccionarTecnicoOptimo(plagaDetectada, p) : null;
  const vecinosBrote = plagaDetectada && p ? buscarVecinosBrote(plagaDetectada.id, p.lat, p.lon) : [];
  const detonaBrote = vecinosBrote.length + 1 >= 3;

  return {
    esReporteValido,
    esAgradecimiento,
    esSeguimiento,
    esSaludo,
    esAyuda,
    esMapaGuia,
    esBuenEstado,
    plaga: plagaDetectada,
    regla: reglaDetectada,
    pct,
    calc,
    tecnico: mejorTec?.tecnico || null,
    distKm: mejorTec?.distKm || null,
    brote: detonaBrote,
    vecinosBroteCount: vecinosBrote.length + 1,
  };
}

// R1: Mensajería del Chat Multimodal
function iniciarChatParaParcela(parcela) {
  const feed = document.querySelector("#chat-mensajes");
  if (!feed) return;

  const sesion = cargarSesion();
  const nombreProd = sesion?.nombre || "productor";

  // Si ya hay mensajes para esta parcela, renderizarlos
  const msgs = chatHistorialParcelas.get(parcela.id) || [];
  if (msgs.length > 0) {
    feed.innerHTML = "";
    msgs.forEach((m) => feed.appendChild(crearElementoMensaje(m)));
    feed.scrollTop = feed.scrollHeight;
    return;
  }

  // Mensaje inicial de bienvenida empático del Asistente
  feed.innerHTML = "";
  const msgBienvenida = {
    remitente: "bot",
    texto: `¡Hola, ${escaparHtml(nombreProd)}! 👋 Soy tu Asistente Fitosanitario de Sanidad Vegetal. Estoy monitoreando tu cultivo de <strong>${escaparHtml(parcela.cultivo)}</strong> en la parcela <strong>${escaparHtml(parcela.id)}</strong>.<br/><br/>¿Qué daño o síntoma observas en tus plantas? Puedes escribirme con tus propias palabras, tomar una foto de la hoja o mandarme una nota de voz con el micrófono.`,
    chips: [
      "🐛 Hojas comidas con gusano en cogollo",
      "🍂 Manchas de polvo anaranjado en hojas",
      "🌱 Planta marchita y raíces comidas",
      "🦗 Chapulines comiendo en la orilla",
      "📅 ¿Cuándo viene el técnico a revisar?",
    ],
    tiempo: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };

  msgs.push(msgBienvenida);
  chatHistorialParcelas.set(parcela.id, msgs);
  feed.appendChild(crearElementoMensaje(msgBienvenida));
  feed.scrollTop = feed.scrollHeight;
}

function crearElementoMensaje(m) {
  const div = document.createElement("div");
  div.className = `chat-msg ${m.remitente === "usuario" ? "chat-msg-user" : "chat-msg-bot"}`;

  let htmlCroquis = "";
  if (m.croquis) {
    htmlCroquis = `
      <div class="chat-croquis-badge">
        <span class="croquis-badge-icon">📐</span>
        <div>
          <strong>Croquis Fitosanitario Adjunto</strong>
          <div>${m.croquis.numFocos} foco(s) de daño delimitado(s) · ${Number(m.croquis.haDanio).toFixed(2)} ha (${m.croquis.pctDanio}% de la parcela ${escaparHtml(m.croquis.parcelaId)})</div>
        </div>
      </div>
    `;
  }

  let htmlMedia = "";
  if (m.fotoUrl) {
    htmlMedia += `
      <div class="chat-media-preview-bubble">
        <img src="${m.fotoUrl}" alt="Evidencia de daño" />
      </div>
    `;
  }
  if (m.audioUrl) {
    htmlMedia += `
      <div style="margin-top:8px;">
        <audio controls src="${m.audioUrl}" style="max-width:100%; height:34px;"></audio>
      </div>
    `;
  }

  let htmlChips = "";
  if (Array.isArray(m.chips) && m.chips.length > 0) {
    htmlChips = `
      <div class="chat-quick-chips">
        ${m.chips.map((c) => `<button type="button" class="quick-chip-btn">${escaparHtml(c)}</button>`).join("")}
      </div>
    `;
  }

  let htmlCard = "";
  if (m.reporteCard) {
    const rc = m.reporteCard;
    htmlCard = `
      <div class="chat-reporte-card">
        <div class="chat-reporte-head">
          <span>📋 Folio Asignado: ${escaparHtml(rc.folio)}</span>
          <span class="tag-sem tag-${escaparHtml(rc.semaforo)}">${escaparHtml(rc.semaforo.toUpperCase())}</span>
        </div>
        <div class="chat-reporte-item">
          <strong>Diagnóstico Asistido:</strong>
          <span>${escaparHtml(rc.diagnostico)}</span>
        </div>
        <div class="chat-reporte-item">
          <strong>Prioridad de Atención:</strong>
          <span>${rc.prioridad}/100 pts · Área dañada marcada: <b>${rc.pct}%</b></span>
        </div>
        <div class="chat-reporte-item">
          <strong>Visita Técnica Programada:</strong>
          <span>👨‍🔬 <b>${escaparHtml(rc.tecnico)}</b> · Plazo estimado: <b>${escaparHtml(rc.tiempoVisita)}</b></span>
        </div>
        ${rc.brote ? `<div class="chat-reporte-item" style="color:#fdba74;"><strong>🔥 Alerta Epidemiológica:</strong> Brote activo zonal detectado a &le;5 km.</div>` : ""}
        <div class="chat-reporte-item" style="font-size:11.5px; color:#a7f3d0; margin-top:2px;">
          <strong>Recomendación Inmediata:</strong>
          <span>${escaparHtml(rc.consejo)}</span>
        </div>
      </div>
    `;
  }

  div.innerHTML = `
    <div class="chat-msg-avatar">${m.remitente === "usuario" ? "👨‍🌾" : "🌱"}</div>
    <div class="chat-bubble">
      <div>${m.texto}</div>
      ${htmlCroquis}
      ${htmlMedia}
      ${htmlCard}
      ${htmlChips}
      <span class="chat-time">${escaparHtml(m.tiempo || "")}</span>
    </div>
  `;

  // Listener para los chips de sugerencia rápida
  div.querySelectorAll(".quick-chip-btn").forEach((chip) => {
    chip.addEventListener("click", () => {
      const chipRaw = chip.textContent.trim();
      const chipNorm = chipRaw.toLowerCase();
      const txtInput = document.querySelector("#chat-input-texto");

      // Chip de foto: abrir de inmediato el selector/cámara
      if (chipNorm.includes("foto") || chipNorm.includes("fotografía")) {
        const fileInput = document.querySelector("#chat-file-input");
        if (fileInput) {
          fileInput.value = "";
          fileInput.click();
        }
        return;
      }

      // Chip de mapa: scroll suave al lienzo satelital y toast guía
      if (chipNorm.includes("mapa") || chipNorm.includes("reubicar")) {
        const mapEl = document.querySelector("#mapa");
        if (mapEl) {
          mapEl.scrollIntoView({ behavior: "smooth", block: "center" });
          mostrarToast("📍 Toca directamente sobre tu parcela en el mapa para marcar el foco del daño");
        }
        return;
      }

      if (txtInput) {
        txtInput.value = chipRaw.replace(/^[^\wáéíóúÁÉÍÓÚ¿?]+/, "").trim();
        txtInput.style.height = "auto";
        txtInput.style.height = `${Math.min(120, txtInput.scrollHeight)}px`;
        txtInput.dispatchEvent(new Event("input"));
        txtInput.focus();
      }
    });
  });

  // Listener para ampliar fotos de evidencia en nueva ventana de forma segura (sin bloqueo por data-url en Chromium)
  div.querySelectorAll(".chat-media-preview-bubble img").forEach((img) => {
    img.addEventListener("click", () => {
      const w = window.open("", "_blank");
      if (w) {
        w.document.title = "Evidencia Fotográfica - IT green";
        w.document.body.style.margin = "0";
        w.document.body.style.backgroundColor = "#0b1320";
        w.document.body.style.display = "flex";
        w.document.body.style.alignItems = "center";
        w.document.body.style.justifyContent = "center";
        w.document.body.style.minHeight = "100vh";
        const im = w.document.createElement("img");
        im.src = img.src;
        im.style.maxWidth = "96%";
        im.style.maxHeight = "96vh";
        im.style.objectFit = "contain";
        im.style.borderRadius = "8px";
        im.style.boxShadow = "0 8px 30px rgba(0,0,0,0.8)";
        w.document.body.appendChild(im);
      }
    });
  });

  return div;
}

async function procesarEnvioChat(textoMensaje) {
  const p = estadoApp.parcelaActual;
  if (!p) return;

  const feed = document.querySelector("#chat-mensajes");
  const ahora = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const tieneFoto = Boolean(fotoAdjuntaActual);
  const tieneAudio = Boolean(audioAdjuntoActual);
  const tieneCroquis = Boolean(croquisAdjuntoActual);
  const fotoUrl = fotoAdjuntaActual?.dataUrl || null;
  const audioUrl = audioAdjuntoActual?.url || null;
  const croquisData = croquisAdjuntoActual ? { ...croquisAdjuntoActual } : null;

  // 1. Mensaje del usuario
  const msgUser = {
    remitente: "usuario",
    texto: escaparHtml(
      textoMensaje ||
        (tieneFoto
          ? "📸 Adjunto fotografía de evidencia"
          : tieneAudio
          ? "🎙️ Nota de voz de evidencia"
          : tieneCroquis
          ? "📐 Croquis de áreas afectadas"
          : "Reporte fitosanitario")
    ),
    fotoUrl,
    audioUrl,
    croquis: croquisData,
    tiempo: ahora,
  };

  const msgs = chatHistorialParcelas.get(p.id) || [];
  msgs.push(msgUser);
  chatHistorialParcelas.set(p.id, msgs);
  feed.appendChild(crearElementoMensaje(msgUser));
  feed.scrollTop = feed.scrollHeight;

  // Limpiar adjuntos del estado actual
  limpiarAdjuntosChat();

  // Mostrar indicador de typing del asistente
  const typingEl = document.querySelector("#chat-typing");
  if (typingEl) typingEl.classList.remove("oculto");
  feed.scrollTop = feed.scrollHeight;

  // Pausa suave de análisis asistido (800ms)
  setTimeout(async () => {
    if (typingEl) typingEl.classList.add("oculto");

    const diag = diagnosticarReporteConversacional(textoMensaje, tieneFoto, tieneAudio, pctDanioActual);
    const folioNuevo = `R-${2065 + Math.floor(Math.random() * 30)}`;

    let textoRespuesta = "";
    let reporteCard = null;

    if (diag.esReporteValido) {
      const plagaObj = diag.plaga || { id: "plaga_campo", nombre: "Afección fitosanitaria" };
      const reglaObj = diag.regla || {
        descripcion: "Monitoreo preventivo de síntomas foliares",
        consejo: "Mantén vigilancia sobre el cultivo y reporta cualquier evolución o cambio en los síntomas.",
      };
      const semaforoVal = diag.calc?.semaforo || "amarillo";
      const prioridadVal = diag.calc?.prioridad || 50;
      const tiempoVisitaVal = diag.calc?.tiempoVisita || "menos de 48 horas";

      textoRespuesta = croquisData
        ? `✅ <strong>Hemos recibido y canalizado tu reporte con éxito.</strong> El motor de sanidad vegetal integró el croquis satelital (${croquisData.numFocos} foco(s) de daño con ${croquisData.pctDanio}% de afectación) y procesó la evidencia.`
        : `✅ <strong>Hemos recibido y canalizado tu reporte con éxito.</strong> El motor de sanidad vegetal ha procesado tus síntomas y evidencia.`;

      reporteCard = {
        folio: folioNuevo,
        semaforo: semaforoVal,
        diagnostico: `${plagaObj.nombre} (${reglaObj.descripcion})`,
        prioridad: prioridadVal,
        pct: diag.pct,
        tecnico: diag.tecnico ? `${diag.tecnico.nombre} (${diag.tecnico.especialidad} · Base ${diag.tecnico.base})` : "Coordinación Fitosanitaria",
        tiempoVisita: tiempoVisitaVal,
        brote: diag.brote,
        consejo: reglaObj.consejo,
      };

      // Guardar en bitácora oficial
      const nuevaEntrada = {
        fecha: new Date().toLocaleDateString("en-CA"),
        parcela: `${p.id} · ${p.nombre} (${p.municipio})`,
        cultivo: p.cultivo,
        actividad: `Reporte ${folioNuevo}: ${plagaObj.nombre} (${diag.pct}% daño)`,
        observaciones: `${textoMensaje ? `${textoMensaje} · ` : ""}Semáforo ${semaforoVal.toUpperCase()} (${prioridadVal} pts) · Técnico: ${diag.tecnico ? `${diag.tecnico.id} ${diag.tecnico.nombre}` : "En turno"}${tieneFoto ? " · [Con Foto]" : ""}${tieneAudio ? " · [Con Nota de Voz]" : ""}${croquisData ? ` · [Croquis: ${croquisData.numFocos} focos / ${croquisData.pctDanio}% daño (${croquisData.haDanio.toFixed(2)} ha)]` : ""}`,
        pct: diag.pct,
        semaforo: semaforoVal,
        prioridad: prioridadVal,
        tecnico_id: diag.tecnico?.id || null,
      };
      await guardarEntradaBitacora(nuevaEntrada);

      // Usar coordenadas precisas del foco marcado por el agricultor
      const coordsFoco = puntoDanioActual ? puntoDanioActual : [Number(p.lat), Number(p.lon)];

      // Agregar a casosHistorial en memoria
      estadoApp.casosHistorial.unshift({
        reporte_id: folioNuevo,
        recibido: new Date().toISOString(),
        parcela_id: p.id,
        plaga: plagaObj.id,
        lat: coordsFoco[0],
        lon: coordsFoco[1],
        semaforo: semaforoVal,
        prioridad: prioridadVal,
        tecnico_id: diag.tecnico?.id || null,
        brote: diag.brote,
      });

      // Registrar aviso oficial en buzón
      estadoApp.avisos.unshift({
        id: Date.now(),
        equipo_id: "equipo07",
        reporte_id: folioNuevo,
        tipo: diag.brote ? "brote" : "folio",
        para: [...(estadoApp.productorActualId ? [estadoApp.productorActualId] : []), "coordinador"],
        mensaje: `Reporte ${folioNuevo} registrado en parcela ${p.id} (${plagaObj.nombre}, semáforo ${semaforoVal}). Prioridad: ${prioridadVal} pts.`,
        creado: new Date().toISOString(),
      });

      renderizarKPIs();
      actualizarVistaTecnico();
      actualizarBannerVisitaParcela(p.id);
      renderizarFeedAvisosOficiales();

      mostrarToast(`🚀 Reporte ${folioNuevo} emitido exitosamente`);
    } else if (diag.esAgradecimiento) {
      textoRespuesta = `¡Con mucho gusto! 🌱 Estamos para respaldarte a ti y a tu cultivo. Si notas cualquier cambio o síntoma nuevo en tus plantas, aquí estoy disponible las 24 horas. ¡Que tengas una excelente jornada en el campo! 🌾`;
    } else if (diag.esSeguimiento) {
      const casoActivo = estadoApp.casosHistorial.find((c) => c.parcela_id === p.id);
      if (casoActivo) {
        const tec = mapaTecnicos.get(casoActivo.tecnico_id);
        const prioridadNum = Number(casoActivo.prioridad) || 50;
        const tiempoVisita = prioridadNum >= 85 ? "menos de 24 horas" : prioridadNum >= 70 ? "menos de 48 horas" : "menos de 72 horas";
        textoRespuesta = `He consultado el estado de tu reporte <strong>${escaparHtml(casoActivo.reporte_id)}</strong>. Tu parcela <strong>${escaparHtml(p.id)}</strong> tiene programada la inspección con el <strong>${tec ? `${escaparHtml(tec.nombre)} (${escaparHtml(tec.especialidad)})` : "técnico de campo"}</strong> con plazo estimado de <strong>${tiempoVisita}</strong>. Si notas un incremento en la zona dañada o nuevos síntomas, mantén el área delimitada en el mapa satelital.`;
      } else {
        textoRespuesta = `He consultado los registros oficiales y tu parcela <strong>${escaparHtml(p.id)}</strong> se encuentra actualmente con estatus fitosanitario monitoreado y sin visitas técnicas pendientes. Si notas hojas perforadas, manchas o presencia de plagas, descríbelo aquí o envíame una foto/audio para programar una inspección de inmediato.`;
      }
      mostrarToast("ℹ️ Información de seguimiento actualizada");
    } else if (diag.esSaludo) {
      const sesion = cargarSesion();
      const nombreProd = sesion?.nombre || "productor";
      textoRespuesta = `¡Hola, don ${escaparHtml(nombreProd)}! 👋 ¿Cómo va el trabajo en el campo? Estoy atento para respaldarte en tu parcela <strong>${escaparHtml(p.id)}</strong> (${escaparHtml(p.cultivo)}). Si ves hojas mordidas, manchas o algún daño, cuéntamelo aquí o mándame una foto con 📷 o una nota de voz con 🎙️.`;
    } else if (diag.esAyuda) {
      textoRespuesta = `Es muy fácil reportar una afección en tu parcela: 🌾<br/><br/>
1. <strong>Describe el problema:</strong> Escribe lo que observas (ej. hojas comidas o manchas), o usa el botón 📷 para foto o 🎙️ para audio.<br/>
2. <strong>Ubica el daño:</strong> Toca tu parcela en el mapa satelital a la derecha para señalar el foco y ajusta el porcentaje estimado.<br/>
3. <strong>Atención oficial:</strong> Recibirás folio oficial y se programará la visita del técnico especialista de tu zona.`;
    } else if (diag.esMapaGuia) {
      textoRespuesta = `📍 <strong>Delimitación en Mapa Satelital:</strong><br/>
Para marcar la zona afectada, simplemente haz clic o toca sobre la superficie verde de tu parcela en el mapa satelital a la derecha. El pin de advertencia y el círculo rojo delimitarán el foco. También puedes ajustar el porcentaje con los botones rápidos (10%, 25%, 50%, 100%) o el deslizador.`;
    } else if (diag.esBuenEstado) {
      textoRespuesta = `¡Excelente noticia! 🌱 Nos alegra saber que tu cultivo de <strong>${escaparHtml(p.cultivo)}</strong> se encuentra sano y sin novedad. Mantén la vigilancia y avísame de inmediato si notas algún síntoma sospechoso.`;
    } else {
      textoRespuesta = `Para brindarte un diagnóstico fitosanitario certero y programar la visita técnica correspondiente en tu cultivo de <strong>${escaparHtml(p.cultivo)}</strong>, por favor descríbeme qué daño o insectos ves (ej. gusanos, polvillo, marchitez), o bien tómale una foto a la hoja con 📷 o mándame una nota de voz con 🎙️.`;
    }

    const followUpChips = diag.esReporteValido
      ? [
          "📅 ¿Cuándo viene el técnico a revisar?",
          "📸 Enviar otra foto de evidencia",
          "📍 Reubicar foco de daño en mapa",
          "✅ Todo claro, muchas gracias",
        ]
      : [
          "🐛 Hojas comidas con gusano en cogollo",
          "🍂 Manchas de polvo anaranjado en hojas",
          "🌱 Planta marchita y raíces comidas",
          "📸 Enviar foto de evidencia",
          "📍 Reubicar foco de daño en mapa",
        ];

    const msgBot = {
      remitente: "bot",
      texto: textoRespuesta,
      reporteCard,
      chips: followUpChips,
      tiempo: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    msgs.push(msgBot);
    chatHistorialParcelas.set(p.id, msgs);
    feed.appendChild(crearElementoMensaje(msgBot));
    feed.scrollTop = feed.scrollHeight;
  }, 850);
}

function limpiarAdjuntosChat() {
  fotoAdjuntaActual = null;
  audioAdjuntoActual = null;
  croquisAdjuntoActual = null;

  const audioPlayer = document.querySelector("#adjunto-audio-player");
  if (audioPlayer) {
    try {
      audioPlayer.pause();
      audioPlayer.removeAttribute("src");
      audioPlayer.load();
    } catch {}
  }

  const bar = document.querySelector("#chat-adjuntos-bar");
  const pFoto = document.querySelector("#adjunto-foto-preview");
  const pAudio = document.querySelector("#adjunto-audio-preview");
  const pCroquis = document.querySelector("#adjunto-croquis-preview");
  const fileInput = document.querySelector("#chat-file-input");

  if (pFoto) pFoto.classList.add("oculto");
  if (pAudio) pAudio.classList.add("oculto");
  if (pCroquis) pCroquis.classList.add("oculto");
  if (bar) bar.classList.add("oculto");
  if (fileInput) fileInput.value = "";
}

function inicializarEventosPortalAgricultor() {
  // 1. Clic interactivo en el lienzo del croquis SVG para insertar nuevo foco
  const croquisSvg = document.querySelector("#croquis-svg");
  const croquisWrapper = document.querySelector(".croquis-canvas-wrapper");

  // Bloqueo estricto contra desplazamiento vertical / rebote de página en touchmove
  const prevenirScrollCroquis = (e) => {
    e.preventDefault();
  };
  croquisSvg?.addEventListener("touchmove", prevenirScrollCroquis, { passive: false });
  croquisWrapper?.addEventListener("touchmove", prevenirScrollCroquis, { passive: false });

  croquisSvg?.addEventListener("click", (e) => {
    if (
      e.target.id === "croquis-parcela-rect" ||
      e.target.id === "croquis-satelite-img" ||
      e.target.id === "croquis-svg" ||
      e.target.tagName === "svg" ||
      e.target.tagName === "rect" ||
      e.target.tagName === "image"
    ) {
      const p = estadoApp.parcelaActual;
      if (!p) return;
      const rect = croquisSvg.getBoundingClientRect();
      const scaleX = 600 / rect.width;
      const scaleY = 380 / rect.height;
      const clickX = Math.round((e.clientX - rect.left) * scaleX);
      const clickY = Math.round((e.clientY - rect.top) * scaleY);

      // Clamping dentro del área visible de la parcela
      const clampedX = Math.max(70, Math.min(530, clickX));
      const clampedY = Math.max(60, Math.min(320, clickY));

      const focos = obtenerFocosParcela(p.id);
      const nuevoFoco = {
        id: `foco-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        x: clampedX,
        y: clampedY,
        r: 32,
      };
      focos.push(nuevoFoco);
      focoSeleccionadoId = nuevoFoco.id;
      renderizarCroquisParcela(p);
      mostrarToast(`📍 Foco de afección colocado en el croquis`);
    }
  });

  // Botones de acción del Croquis
  document.querySelector("#btn-agregar-foco")?.addEventListener("click", agregarFocoCroquis);
  document.querySelector("#btn-eliminar-foco")?.addEventListener("click", eliminarFocoCroquis);
  document.querySelector("#btn-limpiar-focos")?.addEventListener("click", limpiarFocosCroquis);

  // Slider de radio del foco activo
  const sliderRadio = document.querySelector("#croquis-radio-slider");
  sliderRadio?.addEventListener("input", (e) => {
    const p = estadoApp.parcelaActual;
    if (!p || !focoSeleccionadoId) return;
    const focos = obtenerFocosParcela(p.id);
    const fSel = focos.find((f) => f.id === focoSeleccionadoId);
    if (fSel) {
      fSel.r = Number(e.target.value) || 30;
      renderizarCroquisParcela(p);
    }
  });

  // Botones para adjuntar croquis al reporte (desde la barra del chat y desde el panel del croquis)
  document.querySelector("#btn-adjuntar-croquis")?.addEventListener("click", adjuntarCroquisAlReporte);
  document.querySelector("#btn-adjuntar-croquis-directo")?.addEventListener("click", adjuntarCroquisAlReporte);

  // Botón para desvincular croquis del reporte
  document.querySelector("#btn-remover-croquis")?.addEventListener("click", () => {
    croquisAdjuntoActual = null;
    document.querySelector("#adjunto-croquis-preview")?.classList.add("oculto");
    if (!fotoAdjuntaActual && !audioAdjuntoActual) {
      document.querySelector("#chat-adjuntos-bar")?.classList.add("oculto");
    }
    mostrarToast("Croquis desvinculado del reporte");
  });

  // 2. Adjuntar Fotografía
  const fileInput = document.querySelector("#chat-file-input");
  document.querySelector("#btn-adjuntar-foto")?.addEventListener("click", () => {
    if (fileInput) fileInput.value = "";
    fileInput?.click();
  });

  fileInput?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      fotoAdjuntaActual = {
        dataUrl: ev.target.result,
        nombre: file.name,
      };

      const bar = document.querySelector("#chat-adjuntos-bar");
      const pFoto = document.querySelector("#adjunto-foto-preview");
      const img = document.querySelector("#adjunto-foto-img");
      const lbl = document.querySelector("#adjunto-foto-name");

      if (img) img.src = ev.target.result;
      if (lbl) lbl.textContent = file.name;
      if (pFoto) pFoto.classList.remove("oculto");
      if (bar) bar.classList.remove("oculto");
      mostrarToast("📸 Fotografía adjunta al reporte");
    };
    reader.readAsDataURL(file);
  });

  document.querySelector("#btn-remover-foto")?.addEventListener("click", () => {
    fotoAdjuntaActual = null;
    document.querySelector("#adjunto-foto-preview")?.classList.add("oculto");
    if (!audioAdjuntoActual && !croquisAdjuntoActual) {
      document.querySelector("#chat-adjuntos-bar")?.classList.add("oculto");
    }
    if (fileInput) fileInput.value = "";
  });

  // 3. Grabación y simulación de nota de voz (Audio)
  const btnGrabar = document.querySelector("#btn-grabar-audio");
  const bannerGrabando = document.querySelector("#chat-grabando-banner");
  const timerEl = document.querySelector("#chat-rec-timer");
  const btnDetenerAudio = document.querySelector("#btn-detener-audio");
  const btnCancelarAudio = document.querySelector("#btn-cancelar-audio");

  let grabacionCancelada = false;

  const formatearDuracion = (segundos) => {
    const s = Math.max(1, Number(segundos) || 1);
    const m = Math.floor(s / 60);
    const resto = s % 60;
    return `${m}:${resto < 10 ? `0${resto}` : resto} s`;
  };

  const detenerGrabacion = () => {
    if (grabacionTimer) clearInterval(grabacionTimer);
    bannerGrabando?.classList.add("oculto");
    grabacionActiva = false;

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch {}
    } else if (!grabacionCancelada) {
      // Simulación de audio si no hubo MediaRecorder activo
      finalizarCapturaAudio(null, grabacionSegundos || 4);
    }
  };

  const finalizarCapturaAudio = (blob, durSegundos) => {
    if (grabacionCancelada) return;
    const url = blob ? URL.createObjectURL(blob) : generarAudioTono();
    const durTxt = formatearDuracion(durSegundos || 4);
    audioAdjuntoActual = { url, duracion: durTxt };

    const bar = document.querySelector("#chat-adjuntos-bar");
    const pAudio = document.querySelector("#adjunto-audio-preview");
    const audioPlayer = document.querySelector("#adjunto-audio-player");
    const durLbl = document.querySelector("#adjunto-audio-dur");

    if (audioPlayer) audioPlayer.src = url;
    if (durLbl) durLbl.textContent = durTxt;
    if (pAudio) pAudio.classList.remove("oculto");
    if (bar) bar.classList.remove("oculto");
    mostrarToast("🎙️ Nota de voz lista para enviar");
  };

  btnGrabar?.addEventListener("click", async () => {
    if (grabacionActiva) {
      detenerGrabacion();
      return;
    }

    grabacionCancelada = false;
    grabacionActiva = true;
    grabacionSegundos = 0;
    if (timerEl) timerEl.textContent = "0:00";
    bannerGrabando?.classList.remove("oculto");

    grabacionTimer = setInterval(() => {
      grabacionSegundos++;
      const m = Math.floor(grabacionSegundos / 60);
      const s = grabacionSegundos % 60;
      if (timerEl) timerEl.textContent = `${m}:${s < 10 ? `0${s}` : s}`;
    }, 1000);

    // Intentar grabación con MediaRecorder del navegador
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];

        let mimeType = "";
        if (typeof MediaRecorder.isTypeSupported === "function") {
          if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
            mimeType = "audio/webm;codecs=opus";
          } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
            mimeType = "audio/mp4";
          } else if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) {
            mimeType = "audio/ogg;codecs=opus";
          }
        }

        mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };
        mediaRecorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          if (grabacionCancelada) {
            audioChunks = [];
            return;
          }
          const blobType = mediaRecorder.mimeType || mimeType || "audio/webm";
          const blob = new Blob(audioChunks, { type: blobType });
          finalizarCapturaAudio(blob, grabacionSegundos || 1);
        };
        mediaRecorder.start();
        return;
      } catch {
        mostrarToast("🎙️ Micrófono no disponible o sin permisos. Modo simulación de audio activo.");
      }
    } else {
      mostrarToast("🎙️ Dispositivo sin soporte de grabación directa. Simulación de nota de voz activa.");
    }
  });

  btnDetenerAudio?.addEventListener("click", () => {
    grabacionCancelada = false;
    detenerGrabacion();
  });

  btnCancelarAudio?.addEventListener("click", () => {
    grabacionCancelada = true;
    if (grabacionTimer) clearInterval(grabacionTimer);
    bannerGrabando?.classList.add("oculto");
    grabacionActiva = false;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch {}
    }
    audioChunks = [];
    mostrarToast("Grabación de audio cancelada");
  });

  document.querySelector("#btn-remover-audio")?.addEventListener("click", () => {
    const audioPlayer = document.querySelector("#adjunto-audio-player");
    if (audioPlayer) {
      try {
        audioPlayer.pause();
        audioPlayer.removeAttribute("src");
        audioPlayer.load();
      } catch {}
    }
    audioAdjuntoActual = null;
    document.querySelector("#adjunto-audio-preview")?.classList.add("oculto");
    if (!fotoAdjuntaActual && !croquisAdjuntoActual) {
      document.querySelector("#chat-adjuntos-bar")?.classList.add("oculto");
    }
  });

  // 4. Envío del Formulario de Chat
  const chatForm = document.querySelector("#chat-form");
  const chatInput = document.querySelector("#chat-input-texto");

  // Auto-ajuste de altura del textarea al escribir
  chatInput?.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = `${Math.min(120, chatInput.scrollHeight)}px`;
  });

  chatForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (grabacionActiva) {
      mostrarToast("⚠️ Detén la grabación de audio (⏹️ Listo) antes de enviar");
      return;
    }
    const texto = chatInput?.value?.trim() || "";
    if (!texto && !fotoAdjuntaActual && !audioAdjuntoActual) {
      mostrarToast("⚠️ Escribe un mensaje o adjunta una foto/nota de voz");
      return;
    }
    if (chatInput) {
      chatInput.value = "";
      chatInput.style.height = "auto";
    }
    procesarEnvioChat(texto);
  });

  chatInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      chatForm?.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });
}

function generarAudioTono() {
  try {
    const sampleRate = 8000;
    const duration = 2;
    const numSamples = sampleRate * duration;
    const buffer = new ArrayBuffer(44 + numSamples);
    const view = new DataView(buffer);

    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + numSamples, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeString(36, "data");
    view.setUint32(40, numSamples, true);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const sample = Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t * 1.5);
      view.setUint8(44 + i, Math.floor((sample + 1) * 127.5));
    }

    const blob = new Blob([buffer], { type: "audio/wav" });
    return URL.createObjectURL(blob);
  } catch {
    return "";
  }
}


// ============================================================================
// BITÁCORA (SUPABASE + SERVIDOR + TABLAS FITOSANITARIAS)
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

function guardarEnColaOffline(entrada) {
  try {
    const raw = localStorage.getItem("itgreen_offline_cola") || localStorage.getItem("alerta_plaga_offline_cola");
    const cola = raw ? JSON.parse(raw) : [];
    cola.push(entrada);
    localStorage.setItem("itgreen_offline_cola", JSON.stringify(cola));
    localStorage.removeItem("alerta_plaga_offline_cola");
  } catch {}
}

async function sincronizarColaOffline() {
  try {
    const raw = localStorage.getItem("itgreen_offline_cola") || localStorage.getItem("alerta_plaga_offline_cola");
    if (!raw) return;
    const cola = JSON.parse(raw);
    if (!Array.isArray(cola) || cola.length === 0) return;

    const pendientes = [];
    for (const item of cola) {
      try {
        const res = await fetch("/api/bitacora", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        });
        if (!res.ok) pendientes.push(item);
      } catch {
        pendientes.push(item);
      }
    }

    if (pendientes.length === 0) {
      localStorage.removeItem("itgreen_offline_cola");
      localStorage.removeItem("alerta_plaga_offline_cola");
      mostrarToast("📶 Reportes guardados sin conexión sincronizados con éxito");
    } else {
      localStorage.setItem("itgreen_offline_cola", JSON.stringify(pendientes));
      localStorage.removeItem("alerta_plaga_offline_cola");
    }
  } catch {}
}

async function guardarEntradaBitacora(entrada) {
  // Guardar en servidor (/api/bitacora)
  let servidorOk = false;
  try {
    const res = await fetch("/api/bitacora", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entrada),
    });
    if (res.ok) servidorOk = true;
  } catch {
    servidorOk = false;
  }

  if (!servidorOk) {
    guardarEnColaOffline(entrada);
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
  const sesion = cargarSesion();
  if (sesion && sesion.rol === "tecnico") {
    e.target.value = sesion.id;
    return;
  }
  estadoApp.filtroTecnico = e.target.value;
  actualizarVistaTecnico();
});
document.querySelector("#btn-limpiar-tecnico")?.addEventListener("click", () => {
  const sesion = cargarSesion();
  if (sesion && sesion.rol === "tecnico") {
    return;
  }
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

// Eventos del Portal del Agricultor (Chat Multimodal & Marcado Satelital de Daño)
inicializarEventosPortalAgricultor();

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
  a.download = `bitacora_itgreen_${new Date().toLocaleDateString("en-CA")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  mostrarToast("⬇️ Archivo CSV descargado");
});

// ============================================================================
// SINCRONIZACIÓN AUTOMÁTICA CON EL SERVIDOR (/api/datos)
// ============================================================================
async function sincronizarDatosEnVivo(mostrarNotificacion = false) {
  const pill = document.querySelector("#indicador-en-vivo");
  if (pill) pill.classList.add("syncing");
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
        actualizarBannerVisitaParcela(estadoApp.parcelaActual.id);
      }
      renderizarFeedAvisosOficiales();
      renderizarTablasBitacora();
      if (mostrarNotificacion) {
        mostrarToast(`🔄 Sincronizado: ${estadoApp.casosHistorial.length} casos fitosanitarios activos`);
      }
    }
    await sincronizarColaOffline();
  } catch {
    // En desarrollo estático usa datosSemilla sin fallar
  } finally {
    if (pill) setTimeout(() => pill.classList.remove("syncing"), 600);
  }
}

// Escuchar evento online para sincronizar cola offline de inmediato
window.addEventListener("online", () => {
  sincronizarColaOffline();
});

// Clic opcional en la pastilla para forzar refresco manual
document.querySelector("#indicador-en-vivo")?.addEventListener("click", () => {
  sincronizarDatosEnVivo(true);
});

// ============================================================================
// INICIALIZACIÓN
function iniciarPanel() {
  const hoy = new Date().toLocaleDateString("en-CA");
  const bitFecha = document.querySelector("#bit-fecha");
  if (bitFecha) bitFecha.value = hoy;

  poblarSelectoresCatalogo();
  renderizarKPIs();
  actualizarVistaTecnico();
  renderizarFeedAvisosOficiales();
  poblarModalAuthAgricultor();
  inicializarEventosAuth();

  const bitCultivo = document.querySelector("#bit-cultivo");
  if (bitCultivo) bitCultivo.value = "maíz";

  cargarBitacora();

  // Purga defensiva inicial de cualquier residuo previo en localStorage
  try {
    localStorage.removeItem("itgreen_sesion");
    localStorage.removeItem("alerta_plaga_sesion");
  } catch {}

  // Restaurar sesión de la pestaña actual (sessionStorage) si existe
  const sesionGuardada = cargarSesion();
  if (sesionGuardada) {
    aplicarSesion(sesionGuardada);
  }

  // Determinar la vista inicial según la URL (o Landing por defecto)
  const vistaInicial = resolverVistaDesdeUrl();
  cambiarVista(vistaInicial, false);

  sincronizarDatosEnVivo(false);

  // Sincronización automática periódica en segundo plano cada 10 segundos
  setInterval(() => {
    sincronizarDatosEnVivo(false);
  }, 10000);
}

// Redimensionamiento responsivo de lienzos Leaflet
let debouncedResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(debouncedResizeTimer);
  debouncedResizeTimer = setTimeout(() => {
    if (mapTecnico) mapTecnico.invalidateSize();
    if (estadoApp.parcelaActual && estadoApp.vistaActual === "agricultor") {
      renderizarCroquisParcela(estadoApp.parcelaActual);
    }
  }, 160);
});

iniciarPanel();
