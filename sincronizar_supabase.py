"""
Sincronizador de datos con Supabase (PostgREST API v1).

Verifica qué tablas existen en el proyecto de Supabase configurado en `.env`
(`registros`, `casos`, `avisos`) y sincroniza:
  1. `casos`: Los 40 casos previos + todos los casos de `casos_historial.json`
  2. `registros`: Los registros de la Bitácora de Parcela (`bitacora_servidor.json` + casos relevantes)
  3. `avisos`: Los avisos emitidos en la API oficial (`GET /avisos` / `datos_semilla.json`)

Uso:
    python3 sincronizar_supabase.py
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

AQUI = os.path.dirname(os.path.abspath(__file__))
RUTA_SEMILLA = os.path.join(AQUI, "src", "datos_semilla.json")
RUTA_HISTORIAL = os.path.join(AQUI, "casos_historial.json")
RUTA_BITACORA = os.path.join(AQUI, "bitacora_servidor.json")


def cargar_env():
    env = {}
    for ruta in (os.path.join(AQUI, "..", "agente", ".env"), os.path.join(AQUI, ".env")):
        if os.path.exists(ruta):
            with open(ruta, encoding="utf-8") as f:
                for linea in f:
                    linea = linea.strip()
                    if not linea or linea.startswith("#") or "=" not in linea:
                        continue
                    k, _, v = linea.partition("=")
                    env[k.strip()] = v.strip().strip("'\"")
    return env


_ENV = cargar_env()


def cfg(*nombres):
    for n in nombres:
        val = os.environ.get(n) or _ENV.get(n)
        if val:
            return val
    return None


SUPABASE_URL = (cfg("SUPABASE_URL") or "").rstrip("/")
SUPABASE_KEY = cfg("SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY")
API_BASE = (cfg("API_REPORTES", "API_HACKATHON") or "https://itg.tailf75570.ts.net").rstrip("/")
TOKEN = cfg("TOKEN", "TOKEN_EQUIPO")


def headers_supabase(key=None, prefer=None):
    llave = key or SUPABASE_KEY
    h = {
        "apikey": llave,
        "Content-Type": "application/json",
    }
    # Si la llave es un JWT tradicional (eyJ...), agregar también Authorization: Bearer
    if llave and llave.startswith("eyJ"):
        h["Authorization"] = f"Bearer {llave}"
    if prefer:
        h["Prefer"] = prefer
    return h


def sb_request(metodo, ruta, datos=None, prefer=None, timeout=20):
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Faltan SUPABASE_URL o SUPABASE_SECRET_KEY/SUPABASE_PUBLISHABLE_KEY en .env")
    url = f"{SUPABASE_URL}/rest/v1{ruta}"
    cuerpo = json.dumps(datos, ensure_ascii=False).encode("utf-8") if datos is not None else None
    req = urllib.request.Request(
        url,
        data=cuerpo,
        method=metodo,
        headers=headers_supabase(prefer=prefer),
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace").strip()
        return json.loads(raw) if raw else None


def verificar_tablas_existentes():
    """Consulta el esquema OpenAPI de PostgREST y verifica cada tabla individualmente."""
    tablas_openapi = []
    try:
        spec = sb_request("GET", "/")
        if isinstance(spec, dict):
            defs = list((spec.get("definitions") or {}).keys())
            paths = [p.lstrip("/") for p in (spec.get("paths") or {}).keys() if p != "/" and not p.startswith("/rpc/")]
            tablas_openapi = sorted(set(defs + paths))
    except Exception as e:
        print(f"Aviso al consultar esquema raíz OpenAPI: {e}")

    estado_tablas = {}
    for tabla in ("registros", "casos", "avisos"):
        try:
            sb_request("GET", f"/{tabla}?select=*&limit=1")
            estado_tablas[tabla] = True
        except urllib.error.HTTPError as e:
            cuerpo = e.read().decode("utf-8", "replace")
            if e.code == 404 or "PGRST205" in cuerpo:
                estado_tablas[tabla] = False
            else:
                print(f"Aviso en tabla '{tabla}' (HTTP {e.code}): {cuerpo[:200]}")
                estado_tablas[tabla] = False
        except Exception as e:
            print(f"Error verificando tabla '{tabla}': {e}")
            estado_tablas[tabla] = False

    return tablas_openapi, estado_tablas


def cargar_datos_locales_y_remotos():
    semilla = {}
    if os.path.exists(RUTA_SEMILLA):
        with open(RUTA_SEMILLA, encoding="utf-8") as f:
            semilla = json.load(f)

    historial = list(semilla.get("casos_historial") or [])
    if os.path.exists(RUTA_HISTORIAL):
        try:
            with open(RUTA_HISTORIAL, encoding="utf-8") as f:
                por_id = {c["reporte_id"]: c for c in historial if c.get("reporte_id")}
                for c in json.load(f):
                    if c.get("reporte_id"):
                        por_id[c["reporte_id"]] = c
                historial = list(por_id.values())
        except Exception as e:
            print(f"Aviso leyendo casos_historial.json: {e}")

    avisos = list(semilla.get("avisos") or [])
    if API_BASE and TOKEN:
        try:
            req = urllib.request.Request(
                f"{API_BASE}/avisos",
                headers={"X-Equipo-Token": TOKEN},
            )
            with urllib.request.urlopen(req, timeout=8) as r:
                remotos = json.loads(r.read().decode("utf-8"))
                if isinstance(remotos, list) and remotos:
                    por_id = {str(a.get("id")): a for a in avisos if a.get("id")}
                    for a in remotos:
                        if a.get("id"):
                            por_id[str(a["id"])] = a
                    avisos = list(por_id.values())
        except Exception:
            pass

    return semilla, historial, avisos


def sincronizar_casos(semilla, historial):
    parcelas_map = {p["id"]: p for p in (semilla.get("parcelas") or []) if p.get("id")}
    filas = []

    for c in semilla.get("casos_previos") or []:
        rid = c.get("reporte_id") or c.get("id")
        if not rid:
            continue
        parc = parcelas_map.get(c.get("parcela_id"), {})
        filas.append({
            "reporte_id": rid,
            "recibido": c.get("recibido"),
            "parcela_id": c.get("parcela_id"),
            "productor_id": c.get("productor_id") or parc.get("productor_id"),
            "cultivo": c.get("cultivo") or parc.get("cultivo"),
            "plaga": c.get("plaga") or "desconocida",
            "semaforo": c.get("semaforo"),
            "prioridad": c.get("prioridad"),
            "tecnico_id": c.get("tecnico_id"),
            "brote": bool(c.get("brote")),
            "lat": c.get("lat") if c.get("lat") is not None else parc.get("lat"),
            "lon": c.get("lon") if c.get("lon") is not None else parc.get("lon"),
            "pct": c.get("pct"),
            "es_plaga": True,
            "origen": "previo",
        })

    for c in historial:
        rid = c.get("reporte_id")
        if not rid:
            continue
        parc = parcelas_map.get(c.get("parcela_id"), {})
        filas.append({
            "reporte_id": rid,
            "recibido": c.get("recibido"),
            "parcela_id": c.get("parcela_id"),
            "productor_id": c.get("productor_id") or parc.get("productor_id"),
            "cultivo": c.get("cultivo") or parc.get("cultivo"),
            "plaga": c.get("plaga") or "desconocida",
            "semaforo": c.get("semaforo"),
            "prioridad": c.get("prioridad"),
            "tecnico_id": c.get("tecnico_id"),
            "brote": bool(c.get("brote")),
            "lat": c.get("lat") if c.get("lat") is not None else parc.get("lat"),
            "lon": c.get("lon") if c.get("lon") is not None else parc.get("lon"),
            "pct": c.get("pct"),
            "es_plaga": True,
            "origen": "agente",
        })

    # Deduplicar por reporte_id conservando el último
    dedup = list({f["reporte_id"]: f for f in filas}.values())
    if not dedup:
        return 0

    sb_request(
        "POST",
        "/casos?on_conflict=reporte_id",
        datos=dedup,
        prefer="resolution=merge-duplicates,return=minimal",
    )
    return len(dedup)


def sincronizar_registros(semilla, historial):
    parcelas_map = {p["id"]: p for p in (semilla.get("parcelas") or []) if p.get("id")}
    plagas_map = {p["id"]: p["nombre"] for p in (semilla.get("plagas") or []) if p.get("id")}

    existentes = sb_request("GET", "/registros?select=fecha,parcela,actividad&limit=500") or []
    claves_existentes = {
        (str(r.get("fecha") or ""), str(r.get("parcela") or ""), str(r.get("actividad") or ""))
        for r in existentes
    }

    candidatos = []
    if os.path.exists(RUTA_BITACORA):
        try:
            with open(RUTA_BITACORA, encoding="utf-8") as f:
                for b in json.load(f):
                    candidatos.append({
                        "fecha": (b.get("fecha") or "2026-10-20")[:10],
                        "parcela": b.get("parcela") or "Sin parcela",
                        "cultivo": b.get("cultivo") or "maíz",
                        "actividad": b.get("actividad") or "Observación fitosanitaria",
                        "observaciones": b.get("observaciones") or "",
                        "pct": b.get("pct"),
                        "semaforo": b.get("semaforo") or "amarillo",
                        "prioridad": b.get("prioridad") or 0,
                        "tecnico_id": b.get("tecnico_id"),
                    })
        except Exception:
            pass

    # Agregar casos destacados de Nivel 2 como entradas de bitácora si no están ya
    for c in sorted(historial, key=lambda x: x.get("recibido") or "", reverse=True)[:25]:
        rid = c.get("reporte_id")
        parc = parcelas_map.get(c.get("parcela_id"), {})
        nombre_parc = f"{c.get('parcela_id')} · {parc.get('nombre', '')} ({parc.get('municipio', '')})" if parc else str(c.get("parcela_id") or "Sin parcela")
        nombre_plaga = plagas_map.get(c.get("plaga"), c.get("plaga") or "Plaga")
        sem = (c.get("semaforo") or "amarillo").upper()
        actividad = f"Reporte {rid}: {nombre_plaga} (Semáforo {sem})"
        obs = (
            f"Prioridad {c.get('prioridad', 0)}/100 · "
            f"Técnico asignado: {c.get('tecnico_id') or 'Sin disponibilidad'}"
            + (" · ¡BROTE ACTIVO EN ZONA!" if c.get("brote") else "")
        )
        candidatos.append({
            "fecha": (c.get("recibido") or "2026-10-20")[:10],
            "parcela": nombre_parc,
            "cultivo": parc.get("cultivo") or "maíz",
            "actividad": actividad,
            "observaciones": obs,
            "pct": c.get("pct"),
            "semaforo": c.get("semaforo") or "amarillo",
            "prioridad": c.get("prioridad") or 0,
            "tecnico_id": c.get("tecnico_id"),
        })

    nuevos = []
    for cand in candidatos:
        clave = (cand["fecha"], cand["parcela"], cand["actividad"])
        if clave not in claves_existentes:
            claves_existentes.add(clave)
            nuevos.append(cand)

    if not nuevos:
        return 0

    try:
        sb_request("POST", "/registros", datos=nuevos, prefer="return=minimal")
    except urllib.error.HTTPError as e:
        # Fallback automático si la tabla `registros` fue creada solo con las 5 columnas básicas
        cuerpo = e.read().decode("utf-8", "replace")
        if e.code == 400 or "PGRST204" in cuerpo:
            basicos = [
                {
                    "fecha": r["fecha"],
                    "parcela": r["parcela"],
                    "cultivo": r["cultivo"],
                    "actividad": r["actividad"],
                    "observaciones": r["observaciones"],
                }
                for r in nuevos
            ]
            sb_request("POST", "/registros", datos=basicos, prefer="return=minimal")
        else:
            raise
    return len(nuevos)


def sincronizar_avisos(avisos):
    if not avisos:
        return 0
    filas = []
    for idx, a in enumerate(avisos, start=1):
        aid = str(a.get("id") or f"AV-{idx:04d}")
        para_val = a.get("para")
        if isinstance(para_val, str):
            para_val = [para_val]
        elif not isinstance(para_val, list):
            para_val = []
        filas.append({
            "id": aid,
            "reporte_id": a.get("reporte_id"),
            "equipo_id": str(a.get("equipo_id") or "7"),
            "tipo": a.get("tipo") or "folio",
            "para": para_val,
            "mensaje": a.get("mensaje") or "",
            "creado": a.get("creado"),
        })
    dedup = list({f["id"]: f for f in filas}.values())
    sb_request(
        "POST",
        "/avisos?on_conflict=id",
        datos=dedup,
        prefer="resolution=merge-duplicates,return=minimal",
    )
    return len(dedup)


def main():
    print(f"Conectando a Supabase: {SUPABASE_URL}")
    tablas_openapi, estado = verificar_tablas_existentes()
    print(f"Tablas expuestas en OpenAPI (/rest/v1/): {tablas_openapi or 'ninguna'}")
    for t, ok in estado.items():
        print(f"  - Tabla public.{t}: {'EXISTE' if ok else 'NO EXISTE AÚN'}")

    if not any(estado.values()):
        print("\n[!] Ninguna de las tablas ('registros', 'casos', 'avisos') existe todavía en Supabase.")
        print("    Por favor ejecuta el archivo `supabase_schema.sql` en el SQL Editor de tu proyecto:")
        print("    https://supabase.com/dashboard/project/zqmjoieotxiivzrrkpkf/sql/new")
        print("    y vuelve a correr: python3 sincronizar_supabase.py")
        return 0

    semilla, historial, avisos = cargar_datos_locales_y_remotos()

    if estado.get("casos"):
        n_casos = sincronizar_casos(semilla, historial)
        print(f"[OK] Sincronizados {n_casos} casos en public.casos")

    if estado.get("registros"):
        n_reg = sincronizar_registros(semilla, historial)
        print(f"[OK] Insertados {n_reg} registros nuevos en public.registros")

    if estado.get("avisos"):
        n_av = sincronizar_avisos(avisos)
        print(f"[OK] Sincronizados {n_av} avisos en public.avisos")

    return 0


if __name__ == "__main__":
    sys.exit(main())
