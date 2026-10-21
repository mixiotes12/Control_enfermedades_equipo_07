import urllib.request
import urllib.parse
import json
import sys

from interprete import interpretar_mensaje_texto, transcribir_audio
from clasificador import calcular_prioridad_y_semaforo, seleccionar_tecnico

env_vars = {}
with open("/home/missa/Desktop/form-DIMA-2026/.env") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"): continue
        k, _, v = line.partition("=")
        env_vars[k.strip()] = v.strip().strip("'\"")

API_BASE = env_vars.get("API_REPORTES")
TOKEN = env_vars.get("TOKEN")
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
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        return resp.read()

def procesar_reporte_completo(rep, plagas_dict, parcelas_dict, solo_validar=True):
    rep_id = rep["id"]
    tipo = rep.get("tipo")
    texto = rep.get("texto")
    audio_url = rep.get("audio_url")
    foto_url = rep.get("foto_url")
    momento = rep["recibido"]
    parcela_id = rep.get("parcela_id")

    parcela_info = parcelas_dict.get(parcela_id) if parcela_id else None
    cultivo = parcela_info.get("cultivo") if parcela_info else None

    # 1. Resolver entrada según la modalidad
    foto_bytes = None
    if tipo == "foto" and foto_url:
        foto_bytes = descargar_media(foto_url)
    elif tipo == "voz" and audio_url:
        audio_bytes = descargar_media(audio_url)
        print(f"Transcribiendo audio de {rep_id}...")
        texto = transcribir_audio(audio_bytes, API_KEY)
        print(f"Transcripción obtenida: \"{texto}\"")

    # 2. Interpretar con IA multimodal
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

    # 3. Reglas matemáticas deterministas
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

    endpoint = "/casos/validar" if solo_validar else "/casos"
    res = api_post(endpoint, payload)
    return {
        "payload": payload,
        "api_res": res,
        "razon_ia": decision_ia.get("razon"),
        "texto_interpretado": texto
    }

def main():
    print("Cargando catálogos de la API...")
    plagas_list = api_get("/plagas")
    parcelas_list = api_get("/parcelas")
    plagas_dict = {p["id"]: p for p in plagas_list}
    parcelas_dict = {p["id"]: p for p in parcelas_list}

    reportes = api_get("/reportes")
    print(f"Total reportes en la API: {len(reportes)}")

    # Tomar 1 reporte con foto y 1 reporte con voz de los datos reales de la API
    reporte_foto = next((r for r in reportes if r.get("tipo") == "foto"), None)
    reporte_voz = next((r for r in reportes if r.get("tipo") == "voz"), None)

    casos_a_probar = [reporte_foto, reporte_voz]

    print("\n================ PROBANDO MULTIMODALIDAD (FOTO Y VOZ) CON /casos/validar ================")
    for rep in casos_a_probar:
        if not rep: continue
        rep_id = rep["id"]
        tipo = rep["tipo"]
        print(f"\n>>> Probando Reporte {rep_id} (Tipo: {tipo.upper()}) <<<")
        res = procesar_reporte_completo(rep, plagas_dict, parcelas_dict, solo_validar=True)
        print("Texto interpretado/transcrito:", res["texto_interpretado"])
        print("Payload armado:", json.dumps(res["payload"], indent=2))
        print("Respuesta API /casos/validar:", json.dumps(res["api_res"], indent=2))
        print("Razón de la IA:", res["razon_ia"])

if __name__ == "__main__":
    main()
