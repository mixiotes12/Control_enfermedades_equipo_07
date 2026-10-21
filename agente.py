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
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from clasificador import calcular_prioridad_y_semaforo, seleccionar_tecnico
from interprete import interpretar_mensaje_texto, transcribir_audio

INTERVALO = 20      # segundos entre consultas a /reportes
HILOS = 6           # reportes procesados en paralelo
MAX_INTENTOS = 4    # intentos por reporte antes de darlo por fallido
AQUI = os.path.dirname(os.path.abspath(__file__))


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


def ya_registrado(rep_id):
    """Pregunta a la API (sin gastar IA) si el reporte ya tiene resultado."""
    res = api("POST", "/casos/validar", {"reporte_id": rep_id, "es_plaga": False})
    return bool(res.get("ya_registrado_antes"))


def armar_payload(rep, plagas, parcelas):
    """Interpreta el reporte y devuelve el cuerpo para POST /casos."""
    rep_id = rep["id"]
    parcela = parcelas.get(rep.get("parcela_id") or "")
    cultivo = parcela["cultivo"] if parcela else None
    texto = rep.get("texto")
    foto = None

    if rep.get("tipo") == "voz" and rep.get("audio_url"):
        texto = transcribir_audio(descargar(rep["audio_url"]), API_KEY)
    elif rep.get("tipo") == "foto" and rep.get("foto_url"):
        foto = descargar(rep["foto_url"])

    ia = interpretar_mensaje_texto(texto=texto, cultivo_parcela=cultivo, api_key=API_KEY, foto_bytes=foto)

    if not ia.get("es_plaga"):
        return {"reporte_id": rep_id, "es_plaga": False}, ia

    plaga_id = ia.get("plaga") or "desconocida"
    plaga = plagas.get(plaga_id)

    # Seguimiento, plaga no identificada o parcela desconocida: no abre caso (sin semáforo ni técnico).
    if ia.get("es_seguimiento") or plaga is None or parcela is None:
        return {"reporte_id": rep_id, "es_plaga": True, "plaga": plaga_id if plaga else "desconocida"}, ia

    pct = ia.get("pct")
    prioridad, semaforo = calcular_prioridad_y_semaforo(plaga, parcela, 10 if pct is None else pct)
    momento = urllib.parse.quote(rep["recibido"])
    tecnico = seleccionar_tecnico(api("GET", f"/tecnicos?momento={momento}"), plaga, parcela)
    return {
        "reporte_id": rep_id,
        "es_plaga": True,
        "plaga": plaga_id,
        "semaforo": semaforo,
        "tecnico_id": tecnico,
        "prioridad": prioridad,
    }, ia


def atender(rep, plagas, parcelas, prueba):
    """Procesa un reporte. Devuelve (estado, detalle): 'ok', 'omitido' o lanza excepción."""
    rep_id = rep["id"]
    if ya_registrado(rep_id):
        return "omitido", None
    payload, ia = armar_payload(rep, plagas, parcelas)
    if prueba:
        res = api("POST", "/casos/validar", payload)
        return "ok", {"payload": payload, "api": res, "razon": ia.get("razon")}
    res = api("POST", "/casos", payload)
    return "ok", {"payload": payload, "api": res, "razon": ia.get("razon")}


def ciclo(plagas, parcelas, hechos, fallos, prueba):
    reportes = api("GET", "/reportes")
    pendientes = [
        r for r in reportes
        if r["id"] not in hechos and not r.get("respuesta_a") and fallos.get(r["id"], 0) < MAX_INTENTOS
    ]
    if not pendientes:
        return 0

    # Los reportes nuevos pueden traer parcelas que aún no conocemos.
    if any(r.get("parcela_id") and r["parcela_id"] not in parcelas for r in pendientes):
        nuevas_plagas, nuevas_parcelas = cargar_catalogos()
        plagas.update(nuevas_plagas)
        parcelas.update(nuevas_parcelas)

    log(f"{len(pendientes)} reporte(s) pendiente(s)")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=HILOS) as ex:
        futuros = {ex.submit(atender, r, plagas, parcelas, prueba): r for r in pendientes}
        for fut, rep in futuros.items():
            rep_id = rep["id"]
            try:
                estado, det = fut.result()
            except Exception as e:  # red, IA o API: se reintenta en el siguiente ciclo
                fallos[rep_id] = fallos.get(rep_id, 0) + 1
                log(f"{rep_id} ({rep.get('tipo')}) ERROR intento {fallos[rep_id]}/{MAX_INTENTOS}: {e}")
                continue
            hechos.add(rep_id)
            if estado == "omitido":
                log(f"{rep_id} ya estaba registrado")
            else:
                log(f"{rep_id} ({rep.get('tipo')}) -> {json.dumps(det['payload'], ensure_ascii=False)} | API: {json.dumps(det['api'], ensure_ascii=False)}")
    log(f"ciclo terminado en {time.time() - t0:.1f}s")
    return len(pendientes)


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
    hechos, fallos = set(), {}

    if prueba:
        ciclo(plagas, parcelas, hechos, fallos, prueba=True)
        return

    while True:
        try:
            if ciclo(plagas, parcelas, hechos, fallos, prueba=False):
                resumen()
        except Exception as e:
            log(f"Error en el ciclo (se reintenta): {e}")
        time.sleep(INTERVALO)


if __name__ == "__main__":
    main()
