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
// MAPA 2: MAPA SATELITAL DE PARCELA (VISTA AGRICULTOR - FIJO Y CENTRADO)
// ============================================================================
const mapAgricultor = L.map("mapa", {
  attributionControl: false,
  zoomControl: true,
}).setView([19.5104, -98.8824], 16);

// Capa satelital de alta resolución (Esri World Imagery)
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 18, attribution: "Esri Satellite" },
).addTo(mapAgricultor);

// Capa de referencias geográficas y caminos (alto contraste)
L.tileLayer(
  "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 18, opacity: 0.75 },
).addTo(mapAgricultor);

let poligonoParcela = null;
let marcadorDanio = null;
let circuloDanio = null;
let puntoDanioActual = null;
let pctDanioActual = 10;


// ============================================================================
// CONMUTADOR DE VISTAS Y ENRUTAMIENTO SPA (LANDING / TÉCNICO / AGRICULTOR / BITÁCORA)
// ============================================================================
function resolverVistaDesdeUrl() {
  const path = window.location.pathname.toLowerCase();
  const hash = window.location.hash.toLowerCase();
  const sesion = cargarSesion();

  if (path.includes("agricultor") || hash.includes("agricultor")) {
    if (!sesion || sesion.rol !== "agricultor") {
      const prod = mapaProductores.get("PR-101");
      const sesionDefault = {
        rol: "agricultor",
        id: "PR-101",
        nombre: prod?.nombre || "Fidel Jiménez",
        municipio: prod?.municipio || "Texcoco",
      };
      guardarSesion(sesionDefault);
      aplicarSesion(sesionDefault);
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

  // Reajustar tamaño del lienzo Leaflet tras mostrar la pestaña
  setTimeout(() => {
    if (nuevaVista === "tecnico" && mapTecnico) mapTecnico.invalidateSize();
    if (nuevaVista === "agricultor" && mapAgricultor) mapAgricultor.invalidateSize();
  }, 120);
}

window.addEventListener("popstate", () => {
  const vista = resolverVistaDesdeUrl();
  cambiarVista(vista, false);
});

// Brand/Logo vuelve al inicio si no hay sesión
document.querySelector("#brand-home")?.addEventListener("click", () => {
  const sesion = cargarSesion();
  if (!sesion) {
    cambiarVista("landing");
  }
});

// Subnavegación exclusiva del Coordinador (Centro de Mando <-> Bitácora)
document.querySelector("#btn-subnav-mando")?.addEventListener("click", () => cambiarVista("tecnico"));
document.querySelector("#btn-subnav-bitacora")?.addEventListener("click", () => cambiarVista("bitacora"));

// ============================================================================
// GESTIÓN DE SESIONES Y AUTENTICACIÓN (PORTAL AGRICULTOR & CENTRO DE MANDO)
// ============================================================================
function guardarSesion(sesion) {
  try {
    localStorage.setItem("alerta_plaga_sesion", JSON.stringify(sesion));
  } catch {}
  actualizarBadgeSesion(sesion);
}

function cargarSesion() {
  try {
    const raw = localStorage.getItem("alerta_plaga_sesion");
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
    const tecId = sesion.id || "todos";
    estadoApp.filtroTecnico = tecId;
    const selTec = document.querySelector("#filtro-tecnico");
    if (selTec) selTec.value = tecId;
    filtrarCasosTecnico();
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
}

function abrirModalAuthCoordinador() {
  document.querySelector("#modal-auth-coordinador")?.classList.remove("oculto");
}

function cerrarModalAuthCoordinador() {
  document.querySelector("#modal-auth-coordinador")?.classList.add("oculto");
}

function inicializarEventosAuth() {
  // Botones de acceso en Landing Page
  document.querySelector("#btn-entrar-agricultor")?.addEventListener("click", abrirModalAuthAgricultor);
  document.querySelector("#btn-entrar-coordinador")?.addEventListener("click", abrirModalAuthCoordinador);

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

  // Confirmar acceso Agricultor
  document.querySelector("#btn-confirmar-auth-agri")?.addEventListener("click", () => {
    const select = document.querySelector("#select-auth-productor");
    const pid = select?.value || "PR-101";
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
  });

  // Confirmar acceso Coordinador
  const confirmarAuthCoord = () => {
    const pin = (document.querySelector("#input-auth-pin")?.value || "").trim().toLowerCase();
    const tecId = document.querySelector("#select-auth-tecnico")?.value || "todos";

    // Validar PIN de acceso (preconfigurado 2026 o clave oficial de equipo)
    if (pin && pin !== "2026" && pin !== "amaranto-cebada-44" && pin !== "admin") {
      mostrarToast("⚠️ Clave/PIN incorrecto. Usa el PIN de demostración: 2026");
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

  // Botón Salir / Cerrar Sesión en badge
  document.querySelector("#btn-cerrar-sesion")?.addEventListener("click", () => {
    try {
      localStorage.removeItem("alerta_plaga_sesion");
    } catch {}
    actualizarBadgeSesion(null);
    document.querySelector("#nav-coordinador")?.classList.add("oculto");
    cambiarVista("landing");
    mostrarToast("🚪 Sesión cerrada correctamente");
  });
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

  const activaId = estadoApp.parcelaActual?.id || parcelasIds[0];

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

  if (casoActivo && p) {
    const tec = mapaTecnicos.get(casoActivo.tecnico_id);
    const tiempoVisita = casoActivo.prioridad >= 85 ? "menos de 24 horas" : casoActivo.prioridad >= 70 ? "menos de 48 horas" : "menos de 72 horas";
    box.innerHTML = `
      <div class="visita-card visita-activa">
        <div class="visita-icon">📅</div>
        <div class="visita-content">
          <div class="visita-top">
            <span class="badge-visita-urgente">VISITA TÉCNICA PROGRAMADA · FOLIO ${casoActivo.reporte_id}</span>
            <span class="visita-tiempo">⏱️ Tiempo estimado: ${tiempoVisita}</span>
          </div>
          <h4>${nombreLegiblePlaga(casoActivo.plaga)} en cultivo de ${p.cultivo} · Semáforo ${casoActivo.semaforo.toUpperCase()} (${casoActivo.prioridad} pts)</h4>
          <p>
            Atención prioritaria asignada a <strong>${tec ? `${tec.nombre} (${tec.especialidad} · Base ${tec.base})` : "Técnico especialista de la Junta Local"}</strong>.
            ${casoActivo.brote ? " · ⚠️ <b>Alerta de Brote Zonal activa</b>." : ""}
            Favor de mantener libre acceso al predio.
          </p>
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

// R2: Marcador táctil de daño y círculo proporcional de área afectada
function actualizarMarcadorDanio(coords, pct) {
  pctDanioActual = Math.max(1, Math.min(100, Number(pct) || 10));
  const p = estadoApp.parcelaActual;
  const supTotal = Number(p?.superficie_ha) || 1;
  const haDanadas = (supTotal * pctDanioActual) / 100;

  // Actualizar indicadores visuales
  const metricsTxt = document.querySelector("#mapa-metrics-txt");
  if (metricsTxt) {
    metricsTxt.innerHTML = `Área afectada: <strong>${pctDanioActual}%</strong> (~${haDanadas.toFixed(2)} ha de ${supTotal} ha)`;
  }

  const slider = document.querySelector("#mapa-slider-pct");
  if (slider && Number(slider.value) !== pctDanioActual) {
    slider.value = String(pctDanioActual);
  }

  const sliderVal = document.querySelector("#mapa-slider-val");
  if (sliderVal) {
    sliderVal.textContent = `${pctDanioActual}%`;
  }

  // Actualizar chips rápidos activos
  document.querySelectorAll(".btn-danio-chip").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.pct) === pctDanioActual);
  });

  if (!coords || !mapAgricultor) return;

  // Actualizar o crear marcador visual de afección
  if (marcadorDanio) {
    marcadorDanio.setLatLng(coords);
  } else {
    const pinIcon = L.divIcon({
      className: "danio-pin-wrapper",
      html: `
        <div class="danio-pin-core">
          <span class="danio-pin-pulse"></span>
          <span class="danio-pin-dot">⚠️</span>
        </div>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    marcadorDanio = L.marker(coords, { icon: pinIcon }).addTo(mapAgricultor);
  }

  // Radio del círculo en metros basado en hectáreas afectadas
  const radioMetros = Math.max(15, Math.round(Math.sqrt((haDanadas * 10000) / Math.PI)));

  if (circuloDanio) {
    circuloDanio.setLatLng(coords);
    circuloDanio.setRadius(radioMetros);
  } else {
    circuloDanio = L.circle(coords, {
      radius: radioMetros,
      color: "#ef4444",
      weight: 2,
      dashArray: "4, 4",
      fillColor: "#f87171",
      fillOpacity: 0.38,
    }).addTo(mapAgricultor);
  }
}

// R2 y R3: Selección de Parcela fija y centrada con bloqueo en perímetro
function seleccionarParcelaAgricultor(parcelaId) {
  const p = mapaParcelas.get(parcelaId) || estadoApp.parcelas[0];
  if (!p) return;
  estadoApp.parcelaActual = p;

  // Actualizar selector de pestañas del productor
  document.querySelectorAll(".parcela-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.parcela === p.id);
  });

  // Actualizar badge en la cabecera del chat
  const chatBadge = document.querySelector("#chat-parcela-badge");
  if (chatBadge) {
    chatBadge.textContent = `🌱 Parcela ${p.id} · ${p.nombre} (${p.cultivo})`;
  }

  // Actualizar tarjeta de visita
  actualizarBannerVisitaParcela(p.id);

  // R2: Centrado y fijación estricta en las coordenadas de la parcela
  const ladoMetros = Math.sqrt(Number(p.superficie_ha) * 10000);
  const deltaLat = ladoMetros / 111320 / 2;
  const deltaLon = ladoMetros / (111320 * Math.cos((Number(p.lat) * Math.PI) / 180)) / 2;

  const bounds = [
    [Number(p.lat) - deltaLat, Number(p.lon) - deltaLon],
    [Number(p.lat) + deltaLat, Number(p.lon) + deltaLon],
  ];

  mapAgricultor.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });

  // Bloquear navegación fuera de la parcela
  const maxBounds = L.latLngBounds(bounds).pad(1.2);
  mapAgricultor.setMaxBounds(maxBounds);
  mapAgricultor.setMinZoom(14);
  mapAgricultor.setMaxZoom(18);

  // Polígono estético de la parcela con brillo esmeralda
  if (poligonoParcela) mapAgricultor.removeLayer(poligonoParcela);
  poligonoParcela = L.rectangle(bounds, {
    color: "#10b981",
    weight: 3,
    fillColor: "#059669",
    fillOpacity: 0.22,
  }).addTo(mapAgricultor);

  poligonoParcela.bindTooltip(`🌱 Parcela ${p.id}: ${p.nombre} (${p.superficie_ha} ha · ${p.cultivo})`, {
    permanent: true,
    direction: "top",
    className: "parcela-tooltip-label",
  });

  poligonoParcela.on("click", (e) => {
    puntoDanioActual = [e.latlng.lat, e.latlng.lng];
    actualizarMarcadorDanio(puntoDanioActual, pctDanioActual);
    mostrarToast(`📍 Foco de afección marcado en la parcela (${pctDanioActual}%)`);
  });

  // Colocar o centrar foco de daño en la parcela
  puntoDanioActual = [Number(p.lat), Number(p.lon)];
  actualizarMarcadorDanio(puntoDanioActual, pctDanioActual);

  // Inicializar o refrescar chat conversacional para esta parcela
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
      regex: /hlb|dragon|amarillo|enverdecim|motead|fruto.*deforme|asimetr/i,
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

  for (const r of reglasPlagas) {
    if (r.regex.test(textoNorm)) {
      reglaDetectada = r;
      plagaDetectada = mapaPlagas.get(r.id);
      sintomaEncontrado = true;
      break;
    }
  }

  const esSeguimiento = pideSeguimiento && !sintomaEncontrado;

  // Fallback según cultivo de la parcela si no se especificó síntoma directo
  if (!plagaDetectada && p) {
    const cultivoP = (p.cultivo || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
    } else {
      plagaDetectada = estadoApp.plagas[0] || null;
      reglaDetectada = reglasPlagas[0];
    }
  }

  const calc = calcularPrioridadSemaforoDesglosado(plagaDetectada, p, pct);
  const mejorTec = seleccionarTecnicoOptimo(plagaDetectada, p);
  const vecinosBrote = plagaDetectada && p ? buscarVecinosBrote(plagaDetectada.id, p.lat, p.lon) : [];
  const detonaBrote = vecinosBrote.length + 1 >= 3;

  return {
    esSeguimiento,
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
      ${htmlMedia}
      ${htmlCard}
      ${htmlChips}
      <span class="chat-time">${escaparHtml(m.tiempo || "")}</span>
    </div>
  `;

  // Listener para los chips de sugerencia rápida
  div.querySelectorAll(".quick-chip-btn").forEach((chip) => {
    chip.addEventListener("click", () => {
      const txtInput = document.querySelector("#chat-input-texto");
      if (txtInput) {
        txtInput.value = chip.textContent.replace(/^[^\wáéíóúÁÉÍÓÚ¿?]+/, "").trim();
        txtInput.focus();
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
  const fotoUrl = fotoAdjuntaActual?.dataUrl || null;
  const audioUrl = audioAdjuntoActual?.url || null;

  // 1. Mensaje del usuario
  const msgUser = {
    remitente: "usuario",
    texto: escaparHtml(textoMensaje || (tieneFoto ? "📸 Adjunto fotografía de evidencia" : tieneAudio ? "🎙️ Nota de voz de evidencia" : "Reporte fitosanitario")),
    fotoUrl,
    audioUrl,
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

    if (diag.esSeguimiento) {
      const casoActivo = estadoApp.casosHistorial.find((c) => c.parcela_id === p.id);
      const tec = casoActivo ? mapaTecnicos.get(casoActivo.tecnico_id) : diag.tecnico;
      textoRespuesta = `He consultado el estado de tu reporte en sistema. Tu parcela <strong>${escaparHtml(p.id)}</strong> tiene programada la inspección con el <strong>${tec ? `${tec.nombre} (${tec.especialidad})` : "técnico de campo"}</strong>. Si notas un incremento en la zona dañada o nuevos síntomas, mantén el área delimitada en el mapa satelital.`;
    } else {
      textoRespuesta = `✅ <strong>Hemos recibido y canalizado tu reporte con éxito.</strong> El motor de sanidad vegetal ha procesado tus síntomas y evidencia.`;
      reporteCard = {
        folio: folioNuevo,
        semaforo: diag.calc.semaforo,
        diagnostico: `${diag.plaga.nombre} (${diag.regla.descripcion})`,
        prioridad: diag.calc.prioridad,
        pct: diag.pct,
        tecnico: diag.tecnico ? `${diag.tecnico.nombre} (${diag.tecnico.especialidad} · Base ${diag.tecnico.base})` : "Coordinación Fitosanitaria",
        tiempoVisita: diag.calc.tiempoVisita,
        brote: diag.brote,
        consejo: diag.regla.consejo,
      };

      // Guardar en bitácora oficial
      const nuevaEntrada = {
        fecha: new Date().toLocaleDateString("en-CA"),
        parcela: `${p.id} · ${p.nombre} (${p.municipio})`,
        cultivo: p.cultivo,
        actividad: `Reporte ${folioNuevo}: ${diag.plaga.nombre} (${diag.pct}% daño)`,
        observaciones: `${textoMensaje ? `${textoMensaje} · ` : ""}Semáforo ${diag.calc.semaforo.toUpperCase()} (${diag.calc.prioridad} pts) · Técnico: ${diag.tecnico ? `${diag.tecnico.id} ${diag.tecnico.nombre}` : "En turno"}${tieneFoto ? " · [Con Foto]" : ""}${tieneAudio ? " · [Con Nota de Voz]" : ""}`,
        pct: diag.pct,
        semaforo: diag.calc.semaforo,
        prioridad: diag.calc.prioridad,
        tecnico_id: diag.tecnico?.id || null,
      };
      await guardarEntradaBitacora(nuevaEntrada);

      // Agregar a casosHistorial en memoria
      estadoApp.casosHistorial.unshift({
        reporte_id: folioNuevo,
        recibido: new Date().toISOString(),
        parcela_id: p.id,
        plaga: diag.plaga.id,
        lat: p.lat,
        lon: p.lon,
        semaforo: diag.calc.semaforo,
        prioridad: diag.calc.prioridad,
        tecnico_id: diag.tecnico?.id || null,
        brote: diag.brote,
      });

      renderizarKPIs();
      actualizarVistaTecnico();
      actualizarBannerVisitaParcela(p.id);
    }

    const msgBot = {
      remitente: "bot",
      texto: textoRespuesta,
      reporteCard,
      tiempo: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    msgs.push(msgBot);
    chatHistorialParcelas.set(p.id, msgs);
    feed.appendChild(crearElementoMensaje(msgBot));
    feed.scrollTop = feed.scrollHeight;

    mostrarToast(`🚀 Reporte ${folioNuevo} emitido exitosamente`);
  }, 850);
}

function limpiarAdjuntosChat() {
  fotoAdjuntaActual = null;
  audioAdjuntoActual = null;

  const bar = document.querySelector("#chat-adjuntos-bar");
  const pFoto = document.querySelector("#adjunto-foto-preview");
  const pAudio = document.querySelector("#adjunto-audio-preview");
  const fileInput = document.querySelector("#chat-file-input");

  if (pFoto) pFoto.classList.add("oculto");
  if (pAudio) pAudio.classList.add("oculto");
  if (bar) bar.classList.add("oculto");
  if (fileInput) fileInput.value = "";
}

function inicializarEventosPortalAgricultor() {
  // Toque / Clic en el mapa satelital para ubicar el foco de daño
  mapAgricultor.on("click", (e) => {
    puntoDanioActual = [e.latlng.lat, e.latlng.lng];
    actualizarMarcadorDanio(puntoDanioActual, pctDanioActual);
    mostrarToast(`📍 Foco de afección marcado en la parcela (${pctDanioActual}%)`);
  });

  // 1. Selector de Daño: Chips rápidos
  document.querySelectorAll(".btn-danio-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pct = Number(btn.dataset.pct);
      if (pct) {
        pctDanioActual = pct;
        actualizarMarcadorDanio(puntoDanioActual, pctDanioActual);
      }
    });
  });

  // Slider de daño fino
  const slider = document.querySelector("#mapa-slider-pct");
  slider?.addEventListener("input", (e) => {
    pctDanioActual = Number(e.target.value) || 10;
    actualizarMarcadorDanio(puntoDanioActual, pctDanioActual);
  });

  // Botón centrar / restablecer daño
  document.querySelector("#btn-limpiar-danio")?.addEventListener("click", () => {
    if (estadoApp.parcelaActual) {
      puntoDanioActual = [Number(estadoApp.parcelaActual.lat), Number(estadoApp.parcelaActual.lon)];
      pctDanioActual = 10;
      actualizarMarcadorDanio(puntoDanioActual, pctDanioActual);
      mostrarToast("↺ Foco de daño centrado en la parcela (10%)");
    }
  });

  // 2. Adjuntar Fotografía
  const fileInput = document.querySelector("#chat-file-input");
  document.querySelector("#btn-adjuntar-foto")?.addEventListener("click", () => {
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
    if (!audioAdjuntoActual) {
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

  const detenerGrabacion = () => {
    if (grabacionTimer) clearInterval(grabacionTimer);
    bannerGrabando?.classList.add("oculto");
    grabacionActiva = false;

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch {}
    } else {
      // Simulación de audio si no hubo MediaRecorder activo
      finalizarCapturaAudio(null, grabacionSegundos || 4);
    }
  };

  const finalizarCapturaAudio = (blob, durSegundos) => {
    const url = blob ? URL.createObjectURL(blob) : generarAudioTono();
    const durTxt = `0:0${durSegundos || 4} s`;
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

    grabacionActiva = true;
    grabacionSegundos = 0;
    if (timerEl) timerEl.textContent = "0:00";
    bannerGrabando?.classList.remove("oculto");

    grabacionTimer = setInterval(() => {
      grabacionSegundos++;
      if (timerEl) timerEl.textContent = `0:${grabacionSegundos < 10 ? `0${grabacionSegundos}` : grabacionSegundos}`;
    }, 1000);

    // Intentar grabación con MediaRecorder del navegador
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunks.push(e.data);
        };
        mediaRecorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          const blob = new Blob(audioChunks, { type: "audio/ogg; codecs=opus" });
          finalizarCapturaAudio(blob, grabacionSegundos || 1);
        };
        mediaRecorder.start();
        return;
      } catch {
        // En caso de que no tenga micrófono disponible o permisos denegados, corre simulación
      }
    }
  });

  btnDetenerAudio?.addEventListener("click", detenerGrabacion);

  btnCancelarAudio?.addEventListener("click", () => {
    if (grabacionTimer) clearInterval(grabacionTimer);
    bannerGrabando?.classList.add("oculto");
    grabacionActiva = false;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch {}
    }
    mostrarToast("Grabación de audio cancelada");
  });

  document.querySelector("#btn-remover-audio")?.addEventListener("click", () => {
    audioAdjuntoActual = null;
    document.querySelector("#adjunto-audio-preview")?.classList.add("oculto");
    if (!fotoAdjuntaActual) {
      document.querySelector("#chat-adjuntos-bar")?.classList.add("oculto");
    }
  });

  // 4. Envío del Formulario de Chat
  const chatForm = document.querySelector("#chat-form");
  const chatInput = document.querySelector("#chat-input-texto");

  chatForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const texto = chatInput?.value?.trim() || "";
    if (!texto && !fotoAdjuntaActual && !audioAdjuntoActual) {
      mostrarToast("⚠️ Escribe un mensaje o adjunta una foto/nota de voz");
      return;
    }
    if (chatInput) chatInput.value = "";
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
  a.download = `bitacora_alerta_plaga_${new Date().toLocaleDateString("en-CA")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  mostrarToast("⬇️ Archivo CSV descargado");
});

// ============================================================================
// SINCRONIZACIÓN EN VIVO CON EL SERVIDOR (/api/datos)
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
    if (pill) setTimeout(() => pill.classList.remove("syncing"), 600);
  }
}

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

  // Seleccionar una parcela inicial por defecto
  seleccionarParcelaAgricultor("P-001");

  const bitCultivo = document.querySelector("#bit-cultivo");
  if (bitCultivo) bitCultivo.value = "maíz";

  cargarBitacora();

  // Restaurar sesión persistida si existe
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

iniciarPanel();
