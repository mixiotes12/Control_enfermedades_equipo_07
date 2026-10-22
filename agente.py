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

from clasificador import (
    calcular_prioridad_y_semaforo,
    seleccionar_tecnico,
    calcular_brote,
    haversine_km,
)
from interprete import interpretar_mensaje_texto, transcribir_audio

INTERVALO = 8       # segundos entre consultas a /reportes
HILOS = 6           # reportes procesados en paralelo
MAX_INTENTOS = 4    # intentos por reporte antes de darlo por fallido
TIMEOUT_PREGUNTA_S = 300  # segundos a esperar respuesta del productor antes de registrar como desconocido
AQUI = os.path.dirname(os.path.abspath(__file__))
RUTA_HISTORIAL = os.path.join(AQUI, "casos_historial.json")
RUTA_HISTORIAL_BACKUP = os.path.expanduser("~/casos_historial_backup.json")
RUTA_PREGUNTAS = os.path.join(AQUI, "preguntas_activas.json")
HISTORIAL_LOCK = threading.RLock()
PREGUNTAS_LOCK = threading.RLock()


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
TELEGRAM_TOKEN = cfg("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = cfg("TELEGRAM_CHAT_ID")
_TELEGRAM_OFFSET = 0
_CASOS_PENDIENTES_TELEGRAM = []  # Cola de alertas pendientes si el coordinador aún no envía /start


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

    for ruta_h in (RUTA_HISTORIAL, RUTA_HISTORIAL_BACKUP):
        if os.path.exists(ruta_h):
            try:
                with open(ruta_h, encoding="utf-8") as f:
                    for c in json.load(f):
                        rid = c.get("reporte_id")
                        if rid:
                            por_id[rid] = c
            except Exception as e:
                log(f"Aviso: no se pudo leer {ruta_h}: {e}")
    return por_id


def guardar_caso_historial(historial_por_id, caso, persistir=True):
    """Guarda un caso nuevo en memoria y en casos_historial.json de forma segura entre hilos."""
    with HISTORIAL_LOCK:
        historial_por_id[caso["reporte_id"]] = caso
        if not persistir:
            return
        nuevos = [
            c for rid, c in sorted(historial_por_id.items())
            if str(rid).startswith("R-2")
        ]
        for ruta_h in (RUTA_HISTORIAL, RUTA_HISTORIAL_BACKUP):
            try:
                with open(ruta_h, "w", encoding="utf-8") as f:
                    json.dump(nuevos, f, ensure_ascii=False, indent=2)
            except Exception as e:
                log(f"Aviso: no se pudo guardar {ruta_h}: {e}")


def cargar_preguntas_activas():
    """Carga el registro de preguntas activas desde preguntas_activas.json."""
    if os.path.exists(RUTA_PREGUNTAS):
        try:
            with open(RUTA_PREGUNTAS, encoding="utf-8") as f:
                datos = json.load(f)
                if isinstance(datos, dict):
                    return {str(k): float(v) for k, v in datos.items()}
        except Exception as e:
            log(f"Aviso: no se pudo leer {RUTA_PREGUNTAS}: {e}")
    return {}


def guardar_preguntas_activas(preguntas_activas):
    """Persiste preguntas_activas en preguntas_activas.json de forma segura entre hilos."""
    with PREGUNTAS_LOCK:
        try:
            with open(RUTA_PREGUNTAS, "w", encoding="utf-8") as f:
                json.dump(preguntas_activas, f, ensure_ascii=False, indent=2)
        except Exception as e:
            log(f"Aviso: no se pudo guardar {RUTA_PREGUNTAS}: {e}")


def ya_registrado(rep_id):
    """Pregunta a la API (sin gastar IA) si el reporte ya tiene resultado."""
    res = api("POST", "/casos/validar", {"reporte_id": rep_id, "es_plaga": False})
    return bool(res.get("ya_registrado_antes"))


def enviar_pregunta(rep_id, texto):
    """Envía una pregunta al productor sobre un reporte que carece de datos.
    Devuelve 'enviada', 'ya_enviada' o 'error'."""
    try:
        res = api("POST", "/preguntas", {"reporte_id": rep_id, "texto": texto})
        log(f"Pregunta enviada para {rep_id}: \"{texto}\" -> {res.get('mensaje')}")
        return "enviada"
    except Exception as e:
        msg = str(e).lower()
        log(f"Error enviando pregunta para {rep_id}: {e}")
        if (
            "http 400" in msg
            or "http 409" in msg
            or "ya" in msg
            or "pregunta" in msg
            or "existe" in msg
            or "duplicad" in msg
        ):
            return "ya_enviada"
        return "error"


def tg_api(metodo, datos=None, timeout=4):
    """Llama a la API de Telegram Bot con timeout corto y reintento sin parse_mode en HTTP 400."""
    if not TELEGRAM_TOKEN:
        return None
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/{metodo}"
    cuerpo = json.dumps(datos).encode("utf-8") if datos is not None else None
    req = urllib.request.Request(url, data=cuerpo, method="POST" if datos else "GET",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 400 and metodo == "sendMessage" and isinstance(datos, dict) and "parse_mode" in datos:
            datos_plano = {k: v for k, v in datos.items() if k != "parse_mode"}
            cuerpo_plano = json.dumps(datos_plano).encode("utf-8")
            req_plano = urllib.request.Request(url, data=cuerpo_plano, method="POST",
                                               headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req_plano, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        raise


def guardar_chat_id(chat_id):
    global TELEGRAM_CHAT_ID
    TELEGRAM_CHAT_ID = str(chat_id)
    ruta = os.path.join(AQUI, ".env")
    try:
        lineas = []
        if os.path.exists(ruta):
            with open(ruta, encoding="utf-8") as f:
                lineas = [l for l in f if not l.strip().startswith("TELEGRAM_CHAT_ID=")]
        lineas.append(f"TELEGRAM_CHAT_ID={TELEGRAM_CHAT_ID}\n")
        with open(ruta, "w", encoding="utf-8") as f:
            f.writelines(lineas)
        log(f"TELEGRAM_CHAT_ID={TELEGRAM_CHAT_ID} guardado en .env")
    except Exception as e:
        log(f"Aviso guardando TELEGRAM_CHAT_ID: {e}")


def enviar_alerta_telegram(alerta):
    """Envía al coordinador por Telegram una alerta de caso rojo, naranja o con brote."""
    if not TELEGRAM_TOKEN:
        return False
    if not TELEGRAM_CHAT_ID:
        _CASOS_PENDIENTES_TELEGRAM.append(alerta)
        return False

    icono_sem = {"rojo": "🔴 ROJO", "naranja": "🟠 NARANJA", "amarillo": "🟡 AMARILLO", "verde": "🟢 VERDE"}.get(
        alerta["semaforo"], alerta["semaforo"]
    )
    txt_brote = "⚠️ *¡SÍ HAY BROTE EN LA ZONA!* (≥3 casos en ≤5 km / 7 días)\n" if alerta["brote"] else ""
    texto = (
        f"🚨 *ALERTA FITOSANITARIA — {alerta['reporte_id']}*\n"
        f"{txt_brote}"
        f"• *Semáforo:* {icono_sem} (Prioridad: {alerta.get('prioridad', '-')}/100)\n"
        f"• *Plaga:* `{alerta['plaga']}`\n"
        f"• *Parcela:* `{alerta['parcela_id']}` ({alerta.get('cultivo', '')}, {alerta.get('hectareas', '')} ha)\n"
        f"• *Productor:* `{alerta.get('productor_id', '-')}`\n"
        f"• *Técnico asignado:* `{alerta.get('tecnico_id') or 'Sin disponibilidad'}`"
    )
    teclado = {
        "inline_keyboard": [[
            {"text": "✅ Aprobar asignación", "callback_data": f"aprobar|{alerta['reporte_id']}|{alerta.get('productor_id','')}|{alerta.get('tecnico_id','')}"},
            {"text": "🔄 Cambiar técnico", "callback_data": f"cambiar|{alerta['reporte_id']}|{alerta.get('productor_id','')}|{alerta.get('tecnico_id','')}"},
        ]]
    }
    try:
        tg_api("sendMessage", {
            "chat_id": TELEGRAM_CHAT_ID,
            "text": texto,
            "parse_mode": "Markdown",
            "reply_markup": teclado,
        })
        log(f"Alerta Telegram enviada para {alerta['reporte_id']}")
        return True
    except Exception as e:
        log(f"Error enviando Telegram para {alerta['reporte_id']}: {e}")
        return False


def procesar_telegram_updates():
    """Descubre automáticamente el chat_id del coordinador y atiende botones Aprobar / Cambiar técnico."""
    global _TELEGRAM_OFFSET
    if not TELEGRAM_TOKEN:
        return
    try:
        res = tg_api("getUpdates", {"offset": _TELEGRAM_OFFSET, "timeout": 1})
        if not res or not res.get("ok"):
            return
        for upd in res.get("result", []):
            _TELEGRAM_OFFSET = upd["update_id"] + 1
            msg = upd.get("message") or upd.get("edited_message")
            if msg and msg.get("chat", {}).get("id"):
                cid = str(msg["chat"]["id"])
                if not TELEGRAM_CHAT_ID:
                    guardar_chat_id(cid)
                    tg_api("sendMessage", {
                        "chat_id": cid,
                        "text": "✅ *Bot de Alerta Plaga (Equipo 07 - MISA) vinculado.*\nRecibirás aquí los casos rojos, naranjas y brotes con botones de aprobación.",
                        "parse_mode": "Markdown",
                    })
                    while _CASOS_PENDIENTES_TELEGRAM:
                        enviar_alerta_telegram(_CASOS_PENDIENTES_TELEGRAM.pop(0))

            cb = upd.get("callback_query")
            if cb:
                cid = str(cb["message"]["chat"]["id"])
                if not TELEGRAM_CHAT_ID:
                    guardar_chat_id(cid)
                datos = (cb.get("data") or "").split("|")
                accion = datos[0] if datos else ""
                rep_id = datos[1] if len(datos) > 1 else ""
                prod_id = datos[2] if len(datos) > 2 else ""
                tec_id = datos[3] if len(datos) > 3 else ""
                if accion == "aprobar" and rep_id:
                    tg_api("answerCallbackQuery", {"callback_query_id": cb["id"], "text": f"Caso {rep_id} aprobado"})
                    tg_api("sendMessage", {
                        "chat_id": cid,
                        "text": f"✅ *Caso {rep_id} aprobado por el coordinador.* Folio confirmado a `{prod_id}` y orden enviada a `{tec_id}`.",
                        "parse_mode": "Markdown",
                    })
                elif accion == "cambiar" and rep_id:
                    alt_tec = "T-02" if tec_id != "T-02" else "T-01"
                    try:
                        api("POST", "/avisos", {
                            "reporte_id": rep_id,
                            "tipo": "asignacion",
                            "para": alt_tec,
                            "mensaje": f"Reasignación por el coordinador para atender el caso {rep_id}.",
                        })
                    except Exception:
                        pass
                    tg_api("answerCallbackQuery", {"callback_query_id": cb["id"], "text": f"Reasignado a {alt_tec}"})
                    tg_api("sendMessage", {
                        "chat_id": cid,
                        "text": f"🔄 *Caso {rep_id} reasignado a `{alt_tec}`* por indicación del coordinador.",
                        "parse_mode": "Markdown",
                    })
    except Exception as e:
        log(f"Aviso en procesar_telegram_updates: {e}")


def emitir_avisos_caso(rep, payload, plaga, parcela, parcelas):
    """Registra los avisos en POST /avisos (folio, asignación, cuarentenaria, brote a vecinos) y alerta por Telegram."""
    rep_id = payload["reporte_id"]
    prod_id = rep.get("productor_id") or parcela.get("productor_id")
    tec_id = payload.get("tecnico_id")
    semaforo = payload.get("semaforo")
    brote = bool(payload.get("brote"))
    plaga_id = payload.get("plaga")

    # 1. Aviso de folio al productor
    if prod_id:
        try:
            api("POST", "/avisos", {
                "reporte_id": rep_id,
                "tipo": "folio",
                "para": prod_id,
                "mensaje": f"Su reporte {rep_id} en parcela {parcela['id']} ({plaga_id}, semáforo {semaforo}) fue registrado. Técnico asignado: {tec_id or 'en asignación'}.",
            })
        except Exception as e:
            log(f"Aviso folio {rep_id}: {e}")

    # 2. Aviso de asignación al técnico
    if tec_id:
        try:
            api("POST", "/avisos", {
                "reporte_id": rep_id,
                "tipo": "asignacion",
                "para": tec_id,
                "mensaje": f"Asignación de caso {rep_id}: plaga {plaga_id} en parcela {parcela['id']} ({parcela.get('cultivo')}), semáforo {semaforo}.",
            })
        except Exception as e:
            log(f"Aviso asignacion {rep_id}: {e}")

    # 3. Plaga cuarentenaria -> aviso inmediato a sanidad_vegetal
    if plaga and plaga.get("cuarentenaria"):
        try:
            api("POST", "/avisos", {
                "reporte_id": rep_id,
                "tipo": "cuarentenaria",
                "para": "sanidad_vegetal",
                "mensaje": f"ALERTA CUARENTENARIA en reporte {rep_id}: {plaga_id} detectada en parcela {parcela['id']} ({parcela.get('cultivo')}).",
            })
        except Exception as e:
            log(f"Aviso cuarentenaria {rep_id}: {e}")

    # 4. Brote -> aviso al coordinador y a productores vecinos (< 5 km, mismo cultivo, sin contar al que reportó)
    if brote:
        vecinos = set()
        for p_vec in parcelas.values():
            p_prod = p_vec.get("productor_id")
            if not p_prod or p_prod == prod_id:
                continue
            if p_vec.get("cultivo") == parcela.get("cultivo"):
                dist = haversine_km(parcela["lat"], parcela["lon"], p_vec["lat"], p_vec["lon"])
                if dist <= 5.0:
                    vecinos.add(p_prod)
        destinatarios = sorted(vecinos) + ["coordinador"]
        try:
            api("POST", "/avisos", {
                "reporte_id": rep_id,
                "tipo": "brote",
                "para": destinatarios,
                "mensaje": f"Alerta de brote de {plaga_id} en zona de {parcela['id']} ({parcela.get('cultivo')}). Se recomienda revisar cultivos vecinos a menos de 5 km.",
            })
        except Exception as e:
            log(f"Aviso brote {rep_id}: {e}")

    # 5. Si es rojo, naranja o tiene brote -> avisar al coordinador por Telegram
    if semaforo in ("rojo", "naranja") or brote:
        enviar_alerta_telegram({
            "reporte_id": rep_id,
            "semaforo": semaforo,
            "prioridad": payload.get("prioridad"),
            "plaga": plaga_id,
            "parcela_id": parcela["id"],
            "cultivo": parcela.get("cultivo"),
            "hectareas": parcela.get("superficie_ha") or parcela.get("hectareas"),
            "productor_id": prod_id,
            "tecnico_id": tec_id,
            "brote": brote,
        })


def armar_payload(rep, plagas, parcelas, respuestas_map=None, historial_por_id=None):
    """Interpreta el reporte y devuelve el cuerpo para POST /casos."""
    rep_id = rep["id"]
    parcela_id = rep.get("parcela_id")

    # Si hay una respuesta del productor para este reporte, integrar su texto (o transcripción de voz)
    texto_adicional = ""
    foto = None
    if respuestas_map and rep_id in respuestas_map:
        rep_resp = respuestas_map[rep_id]
        resp_txt = (rep_resp.get("texto") or "").strip()
        if not resp_txt and rep_resp.get("audio_url"):
            resp_txt = (transcribir_audio(descargar(rep_resp["audio_url"]), API_KEY) or "").strip()
        if resp_txt:
            texto_adicional = f"\nRespuesta posterior del productor: \"{resp_txt}\""
        if not parcela_id and rep_resp.get("parcela_id"):
            parcela_id = rep_resp["parcela_id"]
        if rep_resp.get("foto_url") and not rep.get("foto_url"):
            foto = descargar(rep_resp["foto_url"])

    parcela = parcelas.get(parcela_id or "")
    cultivo = parcela["cultivo"] if parcela else None

    # Verificar si esta parcela ya tiene un reporte o caso previo registrado en el historial
    tiene_caso_activo = False
    with HISTORIAL_LOCK:
        for c in (historial_por_id or {}).values():
            if c.get("parcela_id") == parcela_id and c.get("reporte_id") != rep_id:
                tiene_caso_activo = True
                break

    texto = (rep.get("texto") or "") + texto_adicional
    if not texto.strip():
        texto = None

    if rep.get("tipo") == "voz" and rep.get("audio_url"):
        texto = transcribir_audio(descargar(rep["audio_url"]), API_KEY)
        if texto_adicional:
            texto += texto_adicional
    elif rep.get("tipo") == "foto" and rep.get("foto_url"):
        foto = descargar(rep["foto_url"])

    contexto_parcela = {"cultivo": cultivo, "caso_previo_activo": tiene_caso_activo}
    ia = interpretar_mensaje_texto(texto=texto, cultivo_parcela=contexto_parcela, api_key=API_KEY, foto_bytes=foto)

    if not ia.get("es_plaga"):
        return {"reporte_id": rep_id, "es_plaga": False}, ia

    # En seguimientos oficiales (Sección 6 y 9), NO se abre un caso nuevo: plaga DEBE ser 'desconocida'
    if ia.get("es_seguimiento"):
        ia["plaga"] = "desconocida"
        return {"reporte_id": rep_id, "es_plaga": True, "plaga": "desconocida"}, ia

    plaga_id = ia.get("plaga") or "desconocida"
    plaga = plagas.get(plaga_id)
    if plaga is None:
        plaga_id = "desconocida"
        ia["plaga"] = "desconocida"

    # Si falta información clave (parcela desconocida o plaga desconocida en reporte nuevo),
    # señalizar 'necesita_pregunta' para enviar pregunta antes de registrar
    necesita_pregunta = (
        not ia.get("es_seguimiento")
        and (parcela is None or plaga_id == "desconocida")
    )
    ia["necesita_pregunta"] = necesita_pregunta

    # Plaga no identificada o parcela desconocida: no abre caso (sin semáforo ni técnico).
    if plaga is None or parcela is None:
        return {"reporte_id": rep_id, "es_plaga": True, "plaga": "desconocida"}, ia

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


def preparar_reporte(rep, plagas, parcelas, preguntas_activas, respuestas_map, historial_por_id):
    """Fase paralela: verifica si ya está registrado, si espera respuesta o interpreta con IA."""
    rep_id = rep["id"]
    if ya_registrado(rep_id):
        return "omitido", None, None

    ahora = time.time()
    with PREGUNTAS_LOCK:
        t_pregunta = preguntas_activas.get(rep_id)
    if t_pregunta is not None and rep_id not in respuestas_map:
        if ahora - t_pregunta < TIMEOUT_PREGUNTA_S:
            return "esperando_respuesta", None, None
        else:
            log(f"{rep_id}: Se agotó el tiempo de espera ({TIMEOUT_PREGUNTA_S}s) de respuesta del productor. Registrando...")

    payload, ia = armar_payload(rep, plagas, parcelas, respuestas_map, historial_por_id)
    return "listo", payload, ia


def finalizar_atencion(rep, prep, plagas, parcelas, prueba, preguntas_activas, respuestas_map, historial_por_id):
    """Fase secuencial/atómica: envía pregunta o calcula brote + POST /casos + historial en orden cronológico."""
    rep_id = rep["id"]
    estado_prep, payload, ia = prep

    if estado_prep == "omitido":
        with PREGUNTAS_LOCK:
            if rep_id in preguntas_activas:
                preguntas_activas.pop(rep_id, None)
                guardar_preguntas_activas(preguntas_activas)
        return "omitido", None

    if estado_prep == "esperando_respuesta":
        return "esperando_respuesta", None

    ahora = time.time()
    with PREGUNTAS_LOCK:
        ya_preguntado = rep_id in preguntas_activas

    # Si necesita aclaración y todavía no le hemos preguntado ni respondido:
    if not prueba and ia.get("necesita_pregunta") and not ya_preguntado and rep_id not in respuestas_map:
        falta_parcela = not rep.get("parcela_id") or parcelas.get(rep.get("parcela_id") or "") is None
        falta_plaga = (ia.get("plaga") or "desconocida") == "desconocida"
        if falta_parcela and falta_plaga:
            pregunta_txt = "¿En cuál de sus parcelas se ubica el cultivo afectado y qué síntomas específicos observa en las hojas, cogollo, fruto o raíz?"
        elif falta_parcela:
            pregunta_txt = "¿En cuál de sus parcelas se ubica este cultivo afectado?"
        else:
            pregunta_txt = "¿Qué síntomas específicos observa en las hojas, cogollo, fruto o raíz?"

        estado_preg = enviar_pregunta(rep_id, pregunta_txt)
        if estado_preg in ("enviada", "ya_enviada"):
            with PREGUNTAS_LOCK:
                preguntas_activas[rep_id] = ahora
                guardar_preguntas_activas(preguntas_activas)
            return "esperando_respuesta", None

    parcela_res = ia.get("parcela_resuelta")
    abre_caso = bool(payload.get("es_plaga") and "semaforo" in payload and parcela_res)

    # Cálculo de brote + POST /casos + registro en historial_por_id de forma atómica y secuencial
    with HISTORIAL_LOCK:
        if abre_caso:
            casos_previos = [
                c for rid, c in (historial_por_id or {}).items()
                if rid != rep_id
            ]
            payload["brote"] = calcular_brote(
                casos_previos,
                payload["plaga"],
                parcela_res["lat"],
                parcela_res["lon"],
                rep["recibido"],
            )

        if prueba:
            res = api("POST", "/casos/validar", payload)
            if abre_caso:
                guardar_caso_historial(historial_por_id, {
                    "reporte_id": rep_id,
                    "parcela_id": parcela_res["id"],
                    "lat": parcela_res["lat"],
                    "lon": parcela_res["lon"],
                    "plaga": payload["plaga"],
                    "recibido": rep["recibido"],
                    "semaforo": payload.get("semaforo"),
                    "prioridad": payload.get("prioridad"),
                    "tecnico_id": payload.get("tecnico_id"),
                    "brote": payload.get("brote"),
                }, persistir=False)
            return "ok", {"payload": payload, "api": res, "razon": ia.get("razon")}

        res = api("POST", "/casos", payload)
        if abre_caso:
            guardar_caso_historial(historial_por_id, {
                "reporte_id": rep_id,
                "parcela_id": parcela_res["id"],
                "lat": parcela_res["lat"],
                "lon": parcela_res["lon"],
                "plaga": payload["plaga"],
                "recibido": rep["recibido"],
                "semaforo": payload.get("semaforo"),
                "prioridad": payload.get("prioridad"),
                "tecnico_id": payload.get("tecnico_id"),
                "brote": payload.get("brote"),
            }, persistir=True)

    with PREGUNTAS_LOCK:
        if rep_id in preguntas_activas:
            preguntas_activas.pop(rep_id, None)
            guardar_preguntas_activas(preguntas_activas)

    if abre_caso:
        emitir_avisos_caso(rep, payload, plagas.get(payload["plaga"]), parcela_res, parcelas)

    return "ok", {"payload": payload, "api": res, "razon": ia.get("razon")}


def atender(rep, plagas, parcelas, prueba, preguntas_activas, respuestas_map, historial_por_id):
    """Procesa un reporte completo. Devuelve (estado, detalle): 'ok', 'omitido', 'esperando_respuesta' o lanza excepción."""
    prep = preparar_reporte(rep, plagas, parcelas, preguntas_activas, respuestas_map, historial_por_id)
    return finalizar_atencion(rep, prep, plagas, parcelas, prueba, preguntas_activas, respuestas_map, historial_por_id)


def ciclo(plagas, parcelas, hechos, fallos, prueba, preguntas_activas, historial_por_id):
    reportes = api("GET", "/reportes")

    # Mapear respuestas de productores asociadas a reportes previos (en orden cronológico)
    respuestas_map = {}
    for r in sorted(reportes, key=lambda x: (x.get("recibido") or "", x["id"])):
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
        if not prueba:
            procesar_telegram_updates()
        return 0

    # Los reportes nuevos o las respuestas de productores pueden traer parcelas que aún no conocemos.
    if any(
        r.get("parcela_id") and r["parcela_id"] not in parcelas
        for r in list(pendientes) + list(respuestas_map.values())
    ):
        nuevas_plagas, nuevas_parcelas = cargar_catalogos()
        plagas.update(nuevas_plagas)
        parcelas.update(nuevas_parcelas)

    log(f"{len(pendientes)} reporte(s) en seguimiento")
    t0 = time.time()
    procesados = 0
    with ThreadPoolExecutor(max_workers=HILOS) as ex:
        # 1. Fase paralela: verificar registro e interpretar con IA concurrentemente
        futuros = {
            r["id"]: ex.submit(preparar_reporte, r, plagas, parcelas, preguntas_activas, respuestas_map, historial_por_id)
            for r in pendientes
        }
        # 2. Fase secuencial en orden cronológico (recibido, id): calcular brote + POST /casos + actualizar historial
        for rep in pendientes:
            rep_id = rep["id"]
            fut = futuros[rep_id]
            try:
                prep = fut.result()
                estado, det = finalizar_atencion(
                    rep, prep, plagas, parcelas, prueba, preguntas_activas, respuestas_map, historial_por_id
                )
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
    if not prueba:
        procesar_telegram_updates()
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
    if TELEGRAM_TOKEN and not TELEGRAM_CHAT_ID:
        for rid, c in sorted(historial_por_id.items()):
            if str(rid).startswith("R-2") and (c.get("semaforo") in ("rojo", "naranja") or c.get("brote")):
                parc = parcelas.get(c.get("parcela_id"), {})
                _CASOS_PENDIENTES_TELEGRAM.append({
                    "reporte_id": rid,
                    "semaforo": c.get("semaforo"),
                    "prioridad": c.get("prioridad"),
                    "plaga": c.get("plaga"),
                    "parcela_id": c.get("parcela_id"),
                    "cultivo": parc.get("cultivo"),
                    "hectareas": parc.get("superficie_ha"),
                    "productor_id": parc.get("productor_id"),
                    "tecnico_id": c.get("tecnico_id"),
                    "brote": bool(c.get("brote")),
                })
        log(f"Telegram listo (@CoordinadorAlertasBot): {len(_CASOS_PENDIENTES_TELEGRAM)} alertas en cola esperando /start del coordinador")
    hechos, fallos = set(), {}
    preguntas_activas = cargar_preguntas_activas()
    if preguntas_activas:
        log(f"Preguntas activas recuperadas: {len(preguntas_activas)}")

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
