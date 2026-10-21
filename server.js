// Sirve la versión construida de la aplicación (carpeta dist) y endpoints de API en vivo con `pnpm start`.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUERTO = Number(process.env.PORT) || 3000;
const RAIZ = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(RAIZ, "dist");
const RUTA_SEMILLA = join(RAIZ, "src", "datos_semilla.json");
const RUTA_BITACORA = join(RAIZ, "bitacora_servidor.json");

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ogg": "audio/ogg",
  ".ico": "image/x-icon",
};

function cargarEnvArchivo(ruta) {
  const vars = {};
  if (!existsSync(ruta)) return vars;
  try {
    const contenido = readFileSync(ruta, "utf-8");
    for (const linea of contenido.split("\n")) {
      const limpia = linea.trim();
      if (!limpia || limpia.startsWith("#") || !limpia.includes("=")) continue;
      const idx = limpia.indexOf("=");
      const k = limpia.slice(0, idx).trim();
      const v = limpia.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      vars[k] = v;
    }
  } catch {
    // Ignorar errores de lectura de .env
  }
  return vars;
}

const envLocal = {
  ...cargarEnvArchivo(join(RAIZ, "..", "agente", ".env")),
  ...cargarEnvArchivo(join(RAIZ, ".env")),
};

const API_BASE =
  process.env.API_REPORTES ||
  process.env.API_HACKATHON ||
  envLocal.API_REPORTES ||
  envLocal.API_HACKATHON ||
  "https://itg.tailf75570.ts.net";

const TOKEN =
  process.env.TOKEN ||
  process.env.TOKEN_EQUIPO ||
  envLocal.TOKEN ||
  envLocal.TOKEN_EQUIPO ||
  "";

let datosSemilla = {
  plagas: [],
  parcelas: [],
  tecnicos: [],
  productores: [],
  reportes: [],
  avisos: [],
  casos_previos: [],
  casos_historial: [],
};

if (existsSync(RUTA_SEMILLA)) {
  try {
    datosSemilla = JSON.parse(readFileSync(RUTA_SEMILLA, "utf-8"));
  } catch (e) {
    console.error("Error leyendo datos_semilla.json:", e.message);
  }
}

let cacheRemoto = {
  timestamp: 0,
  tecnicos: null,
  reportes: null,
  avisos: null,
};

async function consultarApiHackathon(ruta, timeoutMs = 4500) {
  if (!API_BASE || !TOKEN) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${ruta}`, {
      headers: { "X-Equipo-Token": TOKEN },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function leerCasosHistorialEnVivo() {
  const porId = new Map();
  for (const c of datosSemilla.casos_historial || []) {
    if (c && c.reporte_id) porId.set(c.reporte_id, c);
  }
  const rutasPosibles = [
    join(RAIZ, "casos_historial.json"),
    join(RAIZ, "..", "agente", "casos_historial.json"),
  ];
  for (const r of rutasPosibles) {
    if (!existsSync(r)) continue;
    try {
      const txt = await readFile(r, "utf-8");
      const lista = JSON.parse(txt);
      if (Array.isArray(lista)) {
        for (const c of lista) {
          if (c && c.reporte_id) porId.set(c.reporte_id, c);
        }
      }
    } catch {
      // Ignorar si se está escribiendo en ese instante
    }
  }
  return Array.from(porId.values());
}

const BITACORA_INICIAL = [
  {
    id: 1,
    fecha: "2026-10-20",
    parcela: "P-259 · San Juan (Amecameca)",
    cultivo: "maíz",
    actividad: "Inspección de emergencia (Semáforo ROJO · 90 pts)",
    observaciones: "Reporte R-2059: Infestación severa de gusano cogollero en V6. Asignado a Ing. Jorge Bautista (T-06).",
    pct: 100,
    semaforo: "rojo",
    prioridad: 90,
    tecnico_id: "T-06",
    creado: "2026-10-20T20:25:00-06:00",
  },
  {
    id: 2,
    fecha: "2026-10-20",
    parcela: "P-094 · El Llano (Chiconcuac)",
    cultivo: "maíz",
    actividad: "Cerco epidemiológico por BROTE activo (Semáforo NARANJA · 70 pts)",
    observaciones: "Reporte R-2055: Brote confirmado de gusano cogollero a <= 5 km. Atiende Ing. Laura Méndez (T-03).",
    pct: 20,
    semaforo: "naranja",
    prioridad: 70,
    tecnico_id: "T-03",
    creado: "2026-10-20T17:48:00-06:00",
  },
  {
    id: 3,
    fecha: "2026-10-20",
    parcela: "P-014 · San Mateo (Texcoco)",
    cultivo: "cítricos",
    actividad: "Cuarentena fitosanitaria inmediata (Semáforo ROJO · 100 pts)",
    observaciones: "Reporte R-2037: Detección de HLB (Dragón amarillo). Notificado a Sanidad Vegetal y T-05.",
    pct: 15,
    semaforo: "rojo",
    prioridad: 100,
    tecnico_id: "T-05",
    creado: "2026-10-20T11:22:00-06:00",
  },
  {
    id: 4,
    fecha: "2026-10-20",
    parcela: "P-030 · Santa Úrsula (Texcoco)",
    cultivo: "maíz",
    actividad: "Monitoreo de brote regional de Chapulín",
    observaciones: "Reporte R-2050: 3+ casos cercanos en los últimos 7 días. Avisos preventivos enviados a productores vecinos.",
    pct: 25,
    semaforo: "amarillo",
    prioridad: 64,
    tecnico_id: "T-02",
    creado: "2026-10-20T15:35:00-06:00",
  },
  {
    id: 5,
    fecha: "2026-10-19",
    parcela: "P-001 · Tlacotepec (Texcoco)",
    cultivo: "maíz",
    actividad: "Muestreo preventivo de follaje y trampas de feromonas",
    observaciones: "Parcela de Fidel Jiménez (PR-101) en etapa V10. Sin presencia de larvas en cogollo.",
    pct: 5,
    semaforo: "verde",
    prioridad: 20,
    tecnico_id: "T-02",
    creado: "2026-10-19T18:00:00-06:00",
  },
];

async function leerBitacora() {
  if (!existsSync(RUTA_BITACORA)) {
    await writeFile(RUTA_BITACORA, JSON.stringify(BITACORA_INICIAL, null, 2), "utf-8");
    return BITACORA_INICIAL;
  }
  try {
    const txt = await readFile(RUTA_BITACORA, "utf-8");
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed : BITACORA_INICIAL;
  } catch {
    return BITACORA_INICIAL;
  }
}

function leerCuerpoJson(solicitud) {
  return new Promise((resolve, reject) => {
    let cuerpo = "";
    solicitud.on("data", (chunk) => {
      cuerpo += chunk;
      if (cuerpo.length > 1e6) solicitud.destroy();
    });
    solicitud.on("end", () => {
      try {
        resolve(cuerpo ? JSON.parse(cuerpo) : {});
      } catch (e) {
        reject(e);
      }
    });
    solicitud.on("error", reject);
  });
}

function responderJson(respuesta, codigo, datos) {
  const payload = JSON.stringify(datos);
  respuesta.writeHead(codigo, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  respuesta.end(payload);
}

createServer(async (solicitud, respuesta) => {
  const urlObj = new URL(solicitud.url, "http://localhost");
  const pathname = urlObj.pathname;

  // Endpoint 1: Datos integrales en vivo para el panel de Agricultores y Técnicos
  if (pathname === "/api/datos" && solicitud.method === "GET") {
    const ahora = Date.now();
    if (ahora - cacheRemoto.timestamp > 15000) {
      cacheRemoto.timestamp = ahora;
      const [tec, rep, avi] = await Promise.all([
        consultarApiHackathon("/tecnicos"),
        consultarApiHackathon("/reportes"),
        consultarApiHackathon("/avisos"),
      ]);
      if (Array.isArray(tec)) cacheRemoto.tecnicos = tec;
      if (Array.isArray(rep)) cacheRemoto.reportes = rep;
      if (Array.isArray(avi)) cacheRemoto.avisos = avi;
    }

    const casosHistorial = await leerCasosHistorialEnVivo();
    return responderJson(respuesta, 200, {
      plagas: datosSemilla.plagas || [],
      parcelas: datosSemilla.parcelas || [],
      productores: datosSemilla.productores || [],
      casos_previos: datosSemilla.casos_previos || [],
      tecnicos: cacheRemoto.tecnicos || datosSemilla.tecnicos || [],
      reportes: cacheRemoto.reportes || datosSemilla.reportes || [],
      avisos: cacheRemoto.avisos || datosSemilla.avisos || [],
      casos_historial: casosHistorial,
      actualizado: new Date().toISOString(),
    });
  }

  // Endpoint 2: Bitácora de Parcela (GET y POST)
  if (pathname === "/api/bitacora") {
    if (solicitud.method === "GET") {
      const registros = await leerBitacora();
      return responderJson(respuesta, 200, registros);
    }
    if (solicitud.method === "POST") {
      try {
        const body = await leerCuerpoJson(solicitud);
        const registros = await leerBitacora();
        const nuevo = {
          id: Date.now(),
          fecha: body.fecha || new Date().toLocaleDateString("en-CA"),
          parcela: String(body.parcela || "Sin parcela").slice(0, 140),
          cultivo: String(body.cultivo || "maíz").slice(0, 80),
          actividad: String(body.actividad || "Observación fitosanitaria").slice(0, 200),
          observaciones: String(body.observaciones || "").slice(0, 600),
          pct: body.pct !== undefined && body.pct !== null ? Number(body.pct) : null,
          semaforo: body.semaforo || "amarillo",
          prioridad: Number(body.prioridad) || 0,
          tecnico_id: body.tecnico_id || null,
          creado: new Date().toISOString(),
        };
        registros.unshift(nuevo);
        await writeFile(RUTA_BITACORA, JSON.stringify(registros.slice(0, 200), null, 2), "utf-8");
        return responderJson(respuesta, 201, nuevo);
      } catch {
        return responderJson(respuesta, 400, { error: "Datos inválidos" });
      }
    }
  }

  // Endpoint 3: Proxy seguro de archivos multimedia de reportes (/api/media/R-XXXX.jpg o .ogg)
  if (pathname.startsWith("/api/media/") && solicitud.method === "GET") {
    const archivoMedia = pathname.replace("/api/media/", "").replace(/[^a-zA-Z0-9._-]/g, "");
    if (!archivoMedia || !API_BASE) {
      respuesta.writeHead(404);
      return respuesta.end("Media no disponible");
    }
    try {
      const resMedia = await fetch(`${API_BASE}/media/${archivoMedia}`, {
        headers: TOKEN ? { "X-Equipo-Token": TOKEN } : {},
      });
      if (!resMedia.ok) {
        respuesta.writeHead(resMedia.status);
        return respuesta.end("No encontrado");
      }
      const buffer = Buffer.from(await resMedia.arrayBuffer());
      const contentType = resMedia.headers.get("content-type") || TIPOS[extname(archivoMedia)] || "application/octet-stream";
      respuesta.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      });
      return respuesta.end(buffer);
    } catch {
      respuesta.writeHead(502);
      return respuesta.end("Error descargando media");
    }
  }

  // Archivos estáticos de dist/ y soporte SPA para rutas (/agricultor, /coordinador, /bitacora)
  const ruta = normalize(decodeURIComponent(pathname));
  const archivo = join(DIST, ruta === "/" ? "index.html" : ruta);
  try {
    const contenido = await readFile(archivo);
    respuesta.writeHead(200, { "Content-Type": TIPOS[extname(archivo)] ?? "application/octet-stream" });
    respuesta.end(contenido);
  } catch {
    // Si es una ruta de navegación web (SPA), servir index.html
    if (!pathname.includes(".") || pathname.endsWith(".html")) {
      try {
        const contenidoIndex = await readFile(join(DIST, "index.html"));
        respuesta.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return respuesta.end(contenidoIndex);
      } catch {}
    }
    respuesta.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    respuesta.end("No encontrado.");
  }
}).listen(PUERTO, "0.0.0.0", () => {
  console.log(`Listening on http://0.0.0.0:${PUERTO}`);
});
