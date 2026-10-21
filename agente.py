"""
Agente continuo de «Alerta Plaga».

Cada INTERVALO segundos consulta GET /reportes, interpreta con IA los mensajes que
todavía no se registraron (texto, voz y foto), calcula semáforo y técnico con las reglas
deterministas de clasificador.py y registra el resultado con POST /casos.

Se procesan varios reportes en paralelo para mantener baja la latencia.

Uso:
    python agente.py            # ciclo continuo (lo que corre en el servidor)
    python agente.py --prueba   # una sola pasada, solo POST /casos/validar (no registra nada)

Configuración (variables de entorno o archivo .env junto a este script):
    API_REPORTES  o API_HACKATHON   URL base de la API
    TOKEN         o TOKEN_EQUIPO    token del equipo
    API_OPEN_ROUTER                 llave de OpenRouter
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from clasificador import calcular_prioridad_y_semaforo, seleccionar_tecnico, calcular_brote
from interprete import interpretar_mensaje_texto, transcribir_audio

INTERVALO = 20      # segundos entre consultas a /reportes
HILOS = 6           # reportes procesados en paralelo
MAX_INTENTOS = 4    # intentos por reporte antes de darlo por fallido
TIMEOUT_PREGUNTA_S = 300  # segundos a esperar respuesta del productor antes de registrar como desconocido
AQUI = os.path.dirname(os.path.abspath(__file__))
RUTA_HISTORIAL = os.path.join(AQUI, "casos_historial.json")
HISTORIAL_LOCK = threading.Lock()


def log(*partes):
    print(f"[{datetime.now().strftime('%H:%M:%S')}]", *partes, flush=True)


def cargar_env():
    env = {}
    ruta = os.path.join(AQUI, ".env")
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
        valor = os.environ.get(n) or _ENV.get(n)
        if valor:
            return valor
    return None


API_BASE = cfg("API_REPORTES", "API_HACKATHON")
TOKEN = cfg("TOKEN", "TOKEN_EQUIPO")
API_KEY = cfg("API_OPEN_ROUTER")


def api(metodo, ruta, datos=None, timeout=30):
    cuerpo = json.dumps(datos).encode("utf-8") if datos is not None else None
    req = urllib.request.Request(
        API_BASE + ruta,
        data=cuerpo,
        method=metodo,
        headers={"X-Equipo-Token": TOKEN, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} en {metodo} {ruta}: {e.read().decode('utf-8', 'replace')[:300]}")


def descargar(url_relativa):
    with urllib.request.urlopen(API_BASE + url_relativa, timeout=30) as r:
        return r.read()


def cargar_catalogos():
    plagas = {p["id"]: p for p in api("GET", "/plagas")}
    parcelas = {p["id"]: p for p in api("GET", "/parcelas")}
    return plagas, parcelas


def cargar_historial_base():
    """Carga los casos previos de la API + casos_historial.json local (deduplicados por reporte_id)."""
    por_id = {}
    try:
        for c in api("GET", "/casos-previos"):
            rid = c.get("reporte_id") or c.get("id")
            if rid:
                por_id[rid] = {
                    "reporte_id": rid,
                    "parcela_id": c["parcela_id"],
                    "lat": c["lat"],
                    "lon": c["lon"],
                    "plaga": c["plaga"],
                    "recibido": c["recibido"],
                }
    except Exception as e:
        log(f"Aviso: no se pudo cargar /casos-previos: {e}")

    if os.path.exists(RUTA_HISTORIAL):
        try:
            with open(RUTA_HISTORIAL, encoding="utf-8") as f:
                for c in json.load(f):
                    rid = c.get("reporte_id")
                    if rid:
                        por_id[rid] = c
        except Exception as e:
            log(f"Aviso: no se pudo leer {RUTA_HISTORIAL}: {e}")
    return por_id


def guardar_caso_historial(historial_por_id, caso):
    """Guarda un caso nuevo en memoria y en casos_historial.json de forma segura entre hilos."""
    with HISTORIAL_LOCK:
        historial_por_id[caso["reporte_id"]] = caso
        try:
            # Persistir todos los casos nuevos (R-2xxx) en casos_historial.json
            nuevos = [
                c for rid, c in sorted(historial_por_id.items())
                if str(rid).startswith("R-2")
            ]
            with open(RUTA_HISTORIAL, "w", encoding="utf-8") as f:
                json.dump(nuevos, f, ensure_ascii=False, indent=2)
        except Exception as e:
            log(f"Aviso: no se pudo guardar {RUTA_HISTORIAL}: {e}")


def ya_registrado(rep_id):
    """Pregunta a la API (sin gastar IA) si el reporte ya tiene resultado."""
    res = api("POST", "/casos/validar", {"reporte_id": rep_id, "es_plaga": False})
    return bool(res.get("ya_registrado_antes"))


def enviar_pregunta(rep_id, texto):
    """Envía una pregunta al productor sobre un reporte que carece de datos."""
    try:
        res = api("POST", "/preguntas", {"reporte_id": rep_id, "texto": texto})
        log(f"Pregunta enviada para {rep_id}: \"{texto}\" -> {res.get('mensaje')}")
        return True
    except Exception as e:
        log(f"Error enviando pregunta para {rep_id}: {e}")
        return False


def armar_payload(rep, plagas, parcelas, respuestas_map=None, historial_por_id=None):
    """Interpreta el reporte y devuelve el cuerpo para POST /casos."""
    rep_id = rep["id"]
    parcela_id = rep.get("parcela_id")

    # Si hay una respuesta del productor para este reporte, integrar su texto
    texto_adicional = ""
    if respuestas_map and rep_id in respuestas_map:
        rep_resp = respuestas_map[rep_id]
        texto_adicional = f"\nRespuesta posterior del productor: \"{rep_resp.get('texto') or ''}\""
        if not parcela_id and rep_resp.get("parcela_id"):
            parcela_id = rep_resp["parcela_id"]

    parcela = parcelas.get(parcela_id or "")
    cultivo = parcela["cultivo"] if parcela else None
    texto = (rep.get("texto") or "") + texto_adicional
    if not texto.strip():
        texto = None
    foto = None

    if rep.get("tipo") == "voz" and rep.get("audio_url"):
        texto = transcribir_audio(descargar(rep["audio_url"]), API_KEY)
        if texto_adicional:
            texto += texto_adicional
    elif rep.get("tipo") == "foto" and rep.get("foto_url"):
        foto = descargar(rep["foto_url"])

    ia = interpretar_mensaje_texto(texto=texto, cultivo_parcela=cultivo, api_key=API_KEY, foto_bytes=foto)

    if not ia.get("es_plaga"):
        return {"reporte_id": rep_id, "es_plaga": False}, ia

    plaga_id = ia.get("plaga") or "desconocida"
    plaga = plagas.get(plaga_id)

    # Si falta información clave (parcela desconocida o plaga desconocida en reporte nuevo),
    # señalizar 'necesita_aclaracion' para enviar pregunta antes de registrar
    necesita_pregunta = (
        not ia.get("es_seguimiento")
        and (parcela is None or plaga_id == "desconocida")
    )
    ia["necesita_pregunta"] = necesita_pregunta

    # Seguimiento, plaga no identificada o parcela desconocida: no abre caso (sin semáforo ni técnico).
    if ia.get("es_seguimiento") or plaga is None or parcela is None:
        return {"reporte_id": rep_id, "es_plaga": True, "plaga": plaga_id if plaga else "desconocida"}, ia

    pct = ia.get("pct")
    prioridad, semaforo = calcular_prioridad_y_semaforo(plaga, parcela, 10 if pct is None else pct)
    momento = urllib.parse.quote(rep["recibido"])
    tecnico = seleccionar_tecnico(api("GET", f"/tecnicos?momento={momento}"), plaga, parcela)
    with HISTORIAL_LOCK:
        casos_previos = [
            c for rid, c in (historial_por_id or {}).items()
            if rid != rep_id
        ]
    brote = calcular_brote(casos_previos, plaga_id, parcela["lat"], parcela["lon"], rep["recibido"])
    ia["parcela_resuelta"] = parcela
    return {
        "reporte_id": rep_id,
        "es_plaga": True,
        "plaga": plaga_id,
        "semaforo": semaforo,
        "tecnico_id": tecnico,
        "brote": brote,
        "prioridad": prioridad,
    }, ia


def atender(rep, plagas, parcelas, prueba, preguntas_activas, respuestas_map, historial_por_id):
    """Procesa un reporte. Devuelve (estado, detalle): 'ok', 'omitido', 'esperando_respuesta' o lanza excepción."""
    rep_id = rep["id"]
    if ya_registrado(rep_id):
        preguntas_activas.pop(rep_id, None)
        return "omitido", None

    # Si ya hay una pregunta activa para este reporte y aún no hay respuesta, verificar timeout
    ahora = time.time()
    if rep_id in preguntas_activas and rep_id not in respuestas_map:
        t_pregunta = preguntas_activas[rep_id]
        if ahora - t_pregunta < TIMEOUT_PREGUNTA_S:
            return "esperando_respuesta", None
        else:
            log(f"{rep_id}: Se agotó el tiempo de espera ({TIMEOUT_PREGUNTA_S}s) de respuesta del productor. Registrando...")

    payload, ia = armar_payload(rep, plagas, parcelas, respuestas_map, historial_por_id)

    # Si necesita aclaración y todavía no le hemos preguntado ni respondido:
    if ia.get("necesita_pregunta") and rep_id not in preguntas_activas and rep_id not in respuestas_map:
        pregunta_txt = "¿Podría indicarnos en cuál de sus parcelas está el problema o qué síntomas observa con más detalle?"
        if not rep.get("parcela_id"):
            pregunta_txt = "¿En cuál de sus parcelas se ubica este cultivo afectado?"
        elif ia.get("plaga") == "desconocida":
            pregunta_txt = "¿Qué síntomas específicos observa en las hojas, cogollo, fruto o raíz?"

        enviado = enviar_pregunta(rep_id, pregunta_txt)
        if enviado:
            preguntas_activas[rep_id] = ahora
            return "esperando_respuesta", None

    if prueba:
        res = api("POST", "/casos/validar", payload)
        return "ok", {"payload": payload, "api": res, "razon": ia.get("razon")}
    res = api("POST", "/casos", payload)
    preguntas_activas.pop(rep_id, None)

    # Si abrió un caso nuevo (tiene semáforo y parcela resuelta), guardarlo en el historial para futuros brotes
    parcela_res = ia.get("parcela_resuelta")
    if payload.get("es_plaga") and "semaforo" in payload and parcela_res:
        guardar_caso_historial(historial_por_id, {
            "reporte_id": rep_id,
            "parcela_id": parcela_res["id"],
            "lat": parcela_res["lat"],
            "lon": parcela_res["lon"],
            "plaga": payload["plaga"],
            "recibido": rep["recibido"],
        })

    return "ok", {"payload": payload, "api": res, "razon": ia.get("razon")}


def ciclo(plagas, parcelas, hechos, fallos, prueba, preguntas_activas, historial_por_id):
    reportes = api("GET", "/reportes")

    # Mapear respuestas de productores asociadas a reportes previos
    respuestas_map = {}
    for r in reportes:
        ref = r.get("respuesta_a")
        if ref:
            respuestas_map[ref] = r

    pendientes = sorted(
        [
            r for r in reportes
            if r["id"] not in hechos and not r.get("respuesta_a") and fallos.get(r["id"], 0) < MAX_INTENTOS
        ],
        key=lambda r: (r.get("recibido") or "", r["id"]),
    )
    if not pendientes:
        return 0

    # Los reportes nuevos pueden traer parcelas que aún no conocemos.
    if any(r.get("parcela_id") and r["parcela_id"] not in parcelas for r in pendientes):
        nuevas_plagas, nuevas_parcelas = cargar_catalogos()
        plagas.update(nuevas_plagas)
        parcelas.update(nuevas_parcelas)

    log(f"{len(pendientes)} reporte(s) en seguimiento")
    t0 = time.time()
    procesados = 0
    with ThreadPoolExecutor(max_workers=HILOS) as ex:
        futuros = {
            ex.submit(atender, r, plagas, parcelas, prueba, preguntas_activas, respuestas_map, historial_por_id): r
            for r in pendientes
        }
        for fut, rep in futuros.items():
            rep_id = rep["id"]
            try:
                estado, det = fut.result()
            except Exception as e:  # red, IA o API: se reintenta en el siguiente ciclo
                fallos[rep_id] = fallos.get(rep_id, 0) + 1
                log(f"{rep_id} ({rep.get('tipo')}) ERROR intento {fallos[rep_id]}/{MAX_INTENTOS}: {e}")
                continue

            if estado == "omitido":
                hechos.add(rep_id)
                log(f"{rep_id} ya estaba registrado")
            elif estado == "esperando_respuesta":
                # Sigue pendiente de respuesta del productor
                pass
            else:
                hechos.add(rep_id)
                procesados += 1
                log(f"{rep_id} ({rep.get('tipo')}) -> {json.dumps(det['payload'], ensure_ascii=False)} | API: {json.dumps(det['api'], ensure_ascii=False)}")
    log(f"ciclo terminado en {time.time() - t0:.1f}s")
    return procesados


def resumen():
    try:
        av = api("GET", "/equipo")["avance"]
        log(f"AVANCE: {av['puntos']} pts | enviados {av['enviados']}/{av['publicados']} | "
            f"aciertos {av['aciertos_total']} errores {av['errores_total']} | "
            f"latencia mediana {av['latencia_mediana_min']} min | lugar {av['lugar']}")
    except Exception as e:
        log(f"No se pudo leer el avance: {e}")


def main():
    prueba = "--prueba" in sys.argv
    faltan = [n for n, v in (("API_REPORTES/API_HACKATHON", API_BASE), ("TOKEN/TOKEN_EQUIPO", TOKEN),
                             ("API_OPEN_ROUTER", API_KEY)) if not v]
    if faltan:
        log("Faltan variables de configuración:", ", ".join(faltan), "- esperando (revisa ~/agente/.env)")
        while True:
            time.sleep(60)

    log(f"Agente iniciado ({'PRUEBA: solo validar' if prueba else 'REGISTRANDO en producción'}), "
        f"intervalo {INTERVALO}s, {HILOS} hilos")
    plagas, parcelas = cargar_catalogos()
    historial_por_id = cargar_historial_base()
    log(f"Historial cargado con {len(historial_por_id)} casos base para cálculo de brotes")
    hechos, fallos = set(), {}
    preguntas_activas = {}

    if prueba:
        ciclo(plagas, parcelas, hechos, fallos, prueba=True, preguntas_activas=preguntas_activas, historial_por_id=historial_por_id)
        return

    while True:
        try:
            if ciclo(plagas, parcelas, hechos, fallos, prueba=False, preguntas_activas=preguntas_activas, historial_por_id=historial_por_id):
                resumen()
        except Exception as e:
            log(f"Error en el ciclo (se reintenta): {e}")
        time.sleep(INTERVALO)


if __name__ == "__main__":
    main()
