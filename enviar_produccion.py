import urllib.request
import urllib.parse
import json
import time
import sys

from interprete import interpretar_mensaje_texto, transcribir_audio
from clasificador import calcular_prioridad_y_semaforo, seleccionar_tecnico

import os

AQUI = os.path.dirname(os.path.abspath(__file__))
env_vars = {}
env_path = os.path.join(AQUI, ".env")
if os.path.exists(env_path):
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"): continue
            k, _, v = line.partition("=")
            env_vars[k.strip()] = v.strip().strip("'\"")

API_BASE = env_vars.get("API_REPORTES") or env_vars.get("API_HACKATHON")
TOKEN = env_vars.get("TOKEN") or env_vars.get("TOKEN_EQUIPO")
API_KEY = env_vars.get("API_OPEN_ROUTER")

def api_get(endpoint):
    req = urllib.request.Request(f"{API_BASE}{endpoint}", headers={"X-Equipo-Token": TOKEN})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())

def api_post(endpoint, data):
    payload = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE}{endpoint}",
        data=payload,
        headers={"X-Equipo-Token": TOKEN, "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())

def descargar_media(url_relativa):
    if not url_relativa:
        return None
    url = f"{API_BASE}{url_relativa}"
    req = urllib.request.Request(url, headers={"X-Equipo-Token": TOKEN})
    with urllib.request.urlopen(req) as resp:
        return resp.read()

def enviar_casos_produccion(limite=None):
    print("=== INICIANDO PROCESO DE REGISTRO EN PRODUCCIÓN (/casos) ===")
    plagas_list = api_get("/plagas")
    parcelas_list = api_get("/parcelas")
    plagas_dict = {p["id"]: p for p in plagas_list}
    parcelas_dict = {p["id"]: p for p in parcelas_list}

    reportes = api_get("/reportes")
    print(f"Total reportes en la API: {len(reportes)}")

    if limite:
        reportes = reportes[:limite]

    exitosos = 0
    omitidos = 0
    errores = 0

    for idx, rep in enumerate(reportes, 1):
        rep_id = rep["id"]
        tipo = rep.get("tipo")
        texto = rep.get("texto")
        audio_url = rep.get("audio_url")
        foto_url = rep.get("foto_url")
        momento = rep["recibido"]
        parcela_id = rep.get("parcela_id")

        parcela_info = parcelas_dict.get(parcela_id) if parcela_id else None
        cultivo = parcela_info.get("cultivo") if parcela_info else None

        print(f"\n[{idx}/{len(reportes)}] Procesando {rep_id} (Tipo: {tipo})...")

        try:
            foto_bytes = None
            if tipo == "foto" and foto_url:
                foto_bytes = descargar_media(foto_url)
            elif tipo == "voz" and audio_url:
                audio_bytes = descargar_media(audio_url)
                texto = transcribir_audio(audio_bytes, API_KEY)
                print(f"  Voz transcrita: \"{texto}\"")

            decision_ia = interpretar_mensaje_texto(
                texto=texto,
                cultivo_parcela=cultivo,
                api_key=API_KEY,
                foto_bytes=foto_bytes
            )

            es_plaga = decision_ia.get("es_plaga", False)
            es_seguimiento = decision_ia.get("es_seguimiento", False)
            plaga_id = decision_ia.get("plaga")
            pct = decision_ia.get("pct", 10)

            if not es_plaga:
                payload = {"reporte_id": rep_id, "es_plaga": False}
            elif es_seguimiento or plaga_id == "desconocida" or not parcela_info:
                payload = {
                    "reporte_id": rep_id,
                    "es_plaga": True,
                    "plaga": plaga_id or "desconocida"
                }
            else:
                plaga_info = plagas_dict.get(plaga_id)
                if not plaga_info:
                    payload = {
                        "reporte_id": rep_id,
                        "es_plaga": True,
                        "plaga": "desconocida"
                    }
                else:
                    prioridad, semaforo = calcular_prioridad_y_semaforo(plaga_info, parcela_info, pct)

                    momento_enc = urllib.parse.quote(momento)
                    tecnicos_momento = api_get(f"/tecnicos?momento={momento_enc}")
                    tecnico_id = seleccionar_tecnico(tecnicos_momento, plaga_info, parcela_info)

                    payload = {
                        "reporte_id": rep_id,
                        "es_plaga": True,
                        "plaga": plaga_id,
                        "semaforo": semaforo,
                        "tecnico_id": tecnico_id,
                        "prioridad": prioridad
                    }

            # 1. Validar primero
            val_res = api_post("/casos/validar", payload)
            if not val_res.get("ok"):
                print(f"  ⚠️ Formato inválido para {rep_id}:", val_res)
                errores += 1
                continue

            if val_res.get("ya_registrado_antes"):
                print(f"  ℹ️ {rep_id} ya estaba registrado previamente. Omitiendo.")
                omitidos += 1
                continue

            # 2. Registrar en producción
            reg_res = api_post("/casos", payload)
            print(f"  ✅ Registrado en POST /casos:")
            print(f"     Payload: {json.dumps(payload)}")
            print(f"     Respuesta API: {json.dumps(reg_res)}")
            exitosos += 1

            # Pausa breve para cuidar rate limit
            time.sleep(0.5)

        except Exception as e:
            print(f"  ❌ Error procesando {rep_id}: {e}")
            errores += 1

    print("\n================ RESUMEN DEL ENVÍO ================")
    print(f"Registrados con éxito: {exitosos}")
    print(f"Ya estaban registrados: {omitidos}")
    print(f"Errores: {errores}")

    # Consultar puntaje actualizado
    time.sleep(2)
    info_equipo = api_get("/equipo")["avance"]
    print("\n--- ESTADO ACTUAL DEL EQUIPO ---")
    print(f"Puntos: {info_equipo['puntos']} / {info_equipo['maximo_posible']}")
    print(f"Aciertos totales: {info_equipo['aciertos_total']}")
    print(f"Errores totales: {info_equipo['errores_total']}")
    print(f"Porcentaje de acierto: {info_equipo['porcentaje']}%")
    print(f"Lugar en la tabla: {info_equipo['lugar']}")

if __name__ == "__main__":
    limite = int(sys.argv[1]) if len(sys.argv) > 1 else None
    enviar_casos_produccion(limite)
