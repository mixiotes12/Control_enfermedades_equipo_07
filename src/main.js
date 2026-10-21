import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw";
import "leaflet-draw/dist/leaflet.draw.css";
import "./style.css";

// Fix para los iconos de Leaflet en Vite/Webpack
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// Variables y Estado
let parcelas = [];
let plagas = [];
let parcelaActual = null;
let plagaActual = null;
let poligonoParcela = null;
let rectanguloAfectado = null;

// Elementos DOM
const selectParcela = document.querySelector("#parcela");
const selectPlaga = document.querySelector("#plaga");
const inputCultivo = document.querySelector("#cultivo");
const inputEtapa = document.querySelector("#etapa");
const inputFecha = document.querySelector("#fecha");
const inputObservaciones = document.querySelector("#observaciones");
const inputPct = document.querySelector("#pct_hidden");
const txtSuperficieTotal = document.querySelector("#superficie-total");
const txtHaAfectadas = document.querySelector("#ha-afectadas");
const txtPorcentaje = document.querySelector("#porcentaje-afectado");
const vistaSemaforo = document.querySelector("#vista-previa-semaforo");
const txtNombreSemaforo = document.querySelector("#nombre-semaforo");
const txtPuntosPrioridad = document.querySelector("#puntos-prioridad");
const txtTiempoVisita = document.querySelector("#tiempo-visita");
const tablaRegistrosBody = document.querySelector("#registros tbody");
const formulario = document.querySelector("#registro");

// Inicializar Mapa centrado en el Valle de Texcoco
const map = L.map("mapa").setView([19.5104, -98.8824], 14);
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  attribution: "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community"
}).addTo(map);

// Capa de Dibujo para el área afectada
const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

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
        fillOpacity: 0.4
      }
    }
  },
  edit: {
    featureGroup: drawnItems,
    edit: false
  }
});
map.addControl(drawControl);

// Manejar Dibujo del Cuadro sobre el Mapa
map.on(L.Draw.Event.CREATED, function (e) {
  drawnItems.clearLayers();
  rectanguloAfectado = e.layer;
  drawnItems.addLayer(rectanguloAfectado);

  calcularAreaAfectada();
});

// Cargar Datos de Parcelas y Plagas de la API
async function cargarCatalogos() {
  try {
    // Parcela muestra inicial de Texcoco
    const resParcelas = await fetch("/api/parcelas").catch(() => null);
    if (resParcelas && resParcelas.ok) {
      parcelas = await resParcelas.json();
    } else {
      // Catálogo inicial con datos oficiales de Chapingo/Texcoco
      parcelas = [
        { id: "P-001", nombre: "Tlacotepec", cultivo: "maíz", superficie_ha: 5.5, etapa: "V8", lat: 19.51046, lon: -98.88248 },
        { id: "P-077", nombre: "El Cerrito", cultivo: "maíz", superficie_ha: 4.5, etapa: "V8", lat: 19.5112, lon: -98.8817 },
        { id: "P-012", nombre: "La Loma", cultivo: "frijol", superficie_ha: 3.2, etapa: "R2", lat: 19.4950, lon: -98.8650 },
        { id: "P-031", nombre: "San Diego", cultivo: "avena", superficie_ha: 6.0, etapa: "amacollamiento", lat: 19.5250, lon: -98.8920 }
      ];
    }

    // Poblar Selector de Parcelas
    selectParcela.innerHTML = '<option value="">-- Selecciona tu Parcela --</option>';
    parcelas.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.id} - ${p.nombre} (${p.cultivo}, ${p.superficie_ha} ha)`;
      selectParcela.appendChild(opt);
    });

    // Catálogo de 10 plagas oficiales
    plagas = [
      { id: "gusano_cogollero", nombre: "Gusano cogollero", severidad: "alta", cuarentenaria: false, etapas_criticas: { "maíz": ["V4","V6","V8","V10"] }, etapas_susceptibles: { "maíz": ["V2","V12","VT"] } },
      { id: "pulgón", nombre: "Pulgón", severidad: "media", cuarentenaria: false, etapas_criticas: { "avena": ["amacollamiento","embuche"] }, etapas_susceptibles: { "avena": ["emergencia","llenado"] } },
      { id: "roya", nombre: "Roya", severidad: "alta", cuarentenaria: false, etapas_criticas: {}, etapas_susceptibles: {} },
      { id: "barrenador", nombre: "Barrenador del tallo", severidad: "alta", cuarentenaria: false, etapas_criticas: {}, etapas_susceptibles: {} },
      { id: "palomilla_dorso_diamante", nombre: "Palomilla dorso de diamante", severidad: "critica", cuarentenaria: false, etapas_criticas: {}, etapas_susceptibles: {} },
      { id: "carbón_de_la_espiga", nombre: "Carbón de la espiga", severidad: "media", cuarentenaria: false, etapas_criticas: {}, etapas_susceptibles: {} },
      { id: "mosquita_blanca", nombre: "Mosquita blanca", severidad: "media", cuarentenaria: false, etapas_criticas: {}, etapas_susceptibles: {} },
      { id: "picudo", nombre: "Picudo", severidad: "critica", cuarentenaria: true, etapas_criticas: {}, etapas_susceptibles: {} }
    ];

    selectPlaga.innerHTML = '<option value="">-- Selecciona la Plaga --</option>';
    plagas.forEach(pl => {
      const opt = document.createElement("option");
      opt.value = pl.id;
      opt.textContent = `${pl.nombre} (${pl.severidad.toUpperCase()}${pl.cuarentenaria ? " · CUARENTENARIA" : ""})`;
      selectPlaga.appendChild(opt);
    });

    // Cargar primera parcela por defecto
    if (parcelas.length > 0) {
      selectParcela.value = parcelas[0].id;
      seleccionarParcela(parcelas[0].id);
    }
  } catch (err) {
    console.error("Error cargando catálogos:", err);
  }
}

// Actualizar Parcela en Mapa
function seleccionarParcela(id) {
  parcelaActual = parcelas.find(p => p.id === id);
  if (!parcelaActual) return;

  inputCultivo.value = parcelaActual.cultivo;
  inputEtapa.value = parcelaActual.etapa;
  txtSuperficieTotal.textContent = `${parcelaActual.superficie_ha} ha`;

  // Mover mapa a las coordenadas de la parcela
  map.setView([parcelaActual.lat, parcelaActual.lon], 16);

  // Dibujar aproximación geométrica de la parcela (cuadrilátero referencial de su superficie)
  if (poligonoParcela) map.removeLayer(poligonoParcela);
  drawnItems.clearLayers();

  // Calcular delta aproximado en grados para la superficie en ha (1 ha = 10,000 m2)
  const ladoMetros = Math.sqrt(parcelaActual.superficie_ha * 10000);
  const deltaLat = (ladoMetros / 111320) / 2;
  const deltaLon = (ladoMetros / (111320 * Math.cos(parcelaActual.lat * Math.PI / 180))) / 2;

  const bounds = [
    [parcelaActual.lat - deltaLat, parcelaActual.lon - deltaLon],
    [parcelaActual.lat + deltaLat, parcelaActual.lon + deltaLon]
  ];

  poligonoParcela = L.rectangle(bounds, {
    color: "#10b981",
    weight: 2,
    fillOpacity: 0.15,
    dashArray: "4"
  }).addTo(map);

  poligonoParcela.bindTooltip(`Parcela ${parcelaActual.id}: ${parcelaActual.nombre}`, { permanent: true, direction: "top" });

  actualizarCalculo();
}

// Calcular Área Afectada a partir del Rectángulo Dibujado
function calcularAreaAfectada() {
  if (!rectanguloAfectado || !parcelaActual) return;

  const bounds = rectanguloAfectado.getBounds();
  const northEast = bounds.getNorthEast();
  const southWest = bounds.getSouthWest();

  // Cálculo geodésico de dimensiones en metros
  const altoM = southWest.distanceTo(L.latLng(northEast.lat, southWest.lng));
  const anchoM = southWest.distanceTo(L.latLng(southWest.lat, northEast.lng));
  const areaM2 = altoM * anchoM;
  let haAfectadas = areaM2 / 10000;

  // Límite a la superficie total de la parcela
  if (haAfectadas > parcelaActual.superficie_ha) haAfectadas = parcelaActual.superficie_ha;

  const porcentaje = Math.min(100, Math.round((haAfectadas / parcelaActual.superficie_ha) * 100));

  txtHaAfectadas.textContent = `${haAfectadas.toFixed(2)} ha`;
  txtPorcentaje.textContent = `${porcentaje}%`;
  inputPct.value = porcentaje;

  actualizarCalculo();
}

// Fórmulas Oficiales del Hackathon (Sección 7)
function actualizarCalculo() {
  const plagaId = selectPlaga.value;
  plagaActual = plagas.find(p => p.id === plagaId);

  if (!parcelaActual || !plagaActual) {
    vistaSemaforo.className = "tarjeta-semaforo s-desconocido";
    txtNombreSemaforo.textContent = "Pendiente de selección";
    txtPuntosPrioridad.textContent = "0";
    txtTiempoVisita.textContent = "--";
    return;
  }

  // 1. Caso Cuarentenaria: Prioridad 100 y Rojo directo
  if (plagaActual.cuarentenaria) {
    aplicarSemaforo("rojo", 100, "24 horas (Cuarentenaria Urgente)");
    return;
  }

  // Factor Severidad (baja 15 · media 25 · alta 40 · crítica 50)
  const mapaSeveridad = { baja: 15, media: 25, alta: 40, critica: 50 };
  const puntosSeveridad = mapaSeveridad[plagaActual.severidad] || 25;

  // Factor Superficie (ha afectadas = superficie_ha * pct / 100; min(25, round(ha / 4 * 25)))
  const pct = parseFloat(inputPct.value) || 10;
  const haAfectadas = (parcelaActual.superficie_ha * pct) / 100;
  const puntosSuperficie = Math.min(25, Math.round((haAfectadas / 4) * 25));

  // Factor Etapa (crítica: 25 · susceptible: 15 · otra: 5)
  let puntosEtapa = 5;
  const cultivo = parcelaActual.cultivo;
  const etapa = parcelaActual.etapa;

  if (plagaActual.etapas_criticas && plagaActual.etapas_criticas[cultivo]?.includes(etapa)) {
    puntosEtapa = 25;
  } else if (plagaActual.etapas_susceptibles && plagaActual.etapas_susceptibles[cultivo]?.includes(etapa)) {
    puntosEtapa = 15;
  }

  const prioridad = puntosSeveridad + puntosSuperficie + puntosEtapa;

  // Determinar Semáforo
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

  aplicarSemaforo(semaforo, prioridad, tiempoVisita);
}

function aplicarSemaforo(color, prioridad, tiempo) {
  vistaSemaforo.className = `tarjeta-semaforo s-${color}`;
  txtNombreSemaforo.textContent = color.toUpperCase();
  txtPuntosPrioridad.textContent = prioridad;
  txtTiempoVisita.textContent = tiempo;
}

// Enviar Reporte
formulario.addEventListener("submit", (e) => {
  e.preventDefault();
  const estado = document.querySelector("#estado");
  estado.textContent = "Registrando reporte...";

  const nuevoRegistro = {
    fecha: inputFecha.value,
    parcela: parcelaActual ? `${parcelaActual.id} - ${parcelaActual.nombre}` : "Desconocida",
    cultivo: inputCultivo.value,
    plaga: plagaActual ? plagaActual.nombre : "Sin definir",
    pct: inputPct.value,
    semaforo: txtNombreSemaforo.textContent.toLowerCase(),
    prioridad: txtPuntosPrioridad.textContent
  };

  setTimeout(() => {
    // Agregar a la tabla en vivo
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${nuevoRegistro.fecha}</td>
      <td>${nuevoRegistro.parcela}</td>
      <td>${nuevoRegistro.cultivo}</td>
      <td>${nuevoRegistro.plaga}</td>
      <td>${nuevoRegistro.pct}%</td>
      <td><span class="tag-sem tag-${nuevoRegistro.semaforo}">${nuevoRegistro.semaforo} (${nuevoRegistro.prioridad} pts)</span></td>
    `;
    if (tablaRegistrosBody.querySelector("td[colspan]")) {
      tablaRegistrosBody.innerHTML = "";
    }
    tablaRegistrosBody.prepend(tr);

    estado.textContent = "¡Alerta registrada y procesada por el motor de reglas!";
    formulario.querySelector("#observaciones").value = "";
  }, 400);
});

// Event Listeners
selectParcela.addEventListener("change", (e) => seleccionarParcela(e.target.value));
selectPlaga.addEventListener("change", actualizarCalculo);

// Inicializar fecha
inputFecha.value = new Date().toLocaleDateString("en-CA");
cargarCatalogos();
