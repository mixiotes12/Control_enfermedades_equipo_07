import urllib.request
import urllib.parse
import json
import sys
from clasificador import calcular_prioridad_y_semaforo, seleccionar_tecnico, calcular_brote

import os

# Leer variables de entorno locales
env_vars = {}
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"): continue
            k, _, v = line.partition("=")
            env_vars[k.strip()] = v.strip().strip("'\"")

API_BASE = env_vars.get("API_REPORTES")
TOKEN = env_vars.get("TOKEN")

def get_api(endpoint):
    url = f"{API_BASE}{endpoint}"
    req = urllib.request.Request(url, headers={"X-Equipo-Token": TOKEN})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())

def probar_clasificador():
    print(f"--- INICIANDO VALIDACIÓN CON CASOS PREVIOS ({API_BASE}) ---")
    
    print("1. Descargando catálogos de la API...")
    plagas_list = get_api("/plagas")
    parcelas_list = get_api("/parcelas")
    casos_previos = get_api("/casos-previos")

    plagas_dict = {p["id"]: p for p in plagas_list}
    parcelas_dict = {p["id"]: p for p in parcelas_list}

    print(f"Total casos a validar: {len(casos_previos)}")

    aciertos_prioridad = 0
    aciertos_semaforo = 0
    aciertos_tecnico = 0
    aciertos_brote = 0
    errores = []

    for idx, caso in enumerate(casos_previos):
        reporte_id = caso["reporte_id"]
        plaga_id = caso["plaga"]
        parcela_id = caso["parcela_id"]
        pct = caso.get("pct")
        momento = caso["recibido"]

        esperado_prio = caso["prioridad"]
        esperado_sem = caso["semaforo"]
        esperado_tec = caso["tecnico_id"]
        esperado_brote = caso["brote"]

        plaga_info = plagas_dict.get(plaga_id)
        parcela_info = parcelas_dict.get(parcela_id)

        if not plaga_info or not parcela_info:
            print(f"Error: Datos faltantes para caso {reporte_id}")
            continue

        # 1. Calcular Prioridad y Semáforo
        calculado_prio, calculado_sem = calcular_prioridad_y_semaforo(plaga_info, parcela_info, pct)

        # 2. Consultar técnicos disponibles en ese momento
        momento_encoded = urllib.parse.quote(momento)
        tecnicos_momento = get_api(f"/tecnicos?momento={momento_encoded}")
        calculado_tec = seleccionar_tecnico(tecnicos_momento, plaga_info, parcela_info)

        # 3. Calcular Brote (contra los casos anteriores a este en casos_previos)
        calculado_brote = calcular_brote(
            casos_previos[:idx],
            plaga_id,
            parcela_info["lat"],
            parcela_info["lon"],
            momento
        )

        # Comparar resultados
        prio_ok = (calculado_prio == esperado_prio)
        sem_ok = (calculado_sem == esperado_sem)
        tec_ok = (calculado_tec == esperado_tec)
        brote_ok = (calculado_brote == esperado_brote)

        if prio_ok: aciertos_prioridad += 1
        if sem_ok: aciertos_semaforo += 1
        if tec_ok: aciertos_tecnico += 1
        if brote_ok: aciertos_brote += 1

        if not (prio_ok and sem_ok and tec_ok and brote_ok):
            errores.append({
                "reporte_id": reporte_id,
                "prio": f"Obtenido: {calculado_prio} vs Esperado: {esperado_prio}",
                "sem": f"Obtenido: {calculado_sem} vs Esperado: {esperado_sem}",
                "tec": f"Obtenido: {calculado_tec} vs Esperado: {esperado_tec}",
                "brote": f"Obtenido: {calculado_brote} vs Esperado: {esperado_brote}"
            })

    total = len(casos_previos)
    print("\n--- RESULTADOS DE LA VALIDACIÓN ---")
    print(f"Prioridad: {aciertos_prioridad}/{total} aciertos ({(aciertos_prioridad/total)*100:.1f}%)")
    print(f"Semáforo:  {aciertos_semaforo}/{total} aciertos ({(aciertos_semaforo/total)*100:.1f}%)")
    print(f"Técnico:   {aciertos_tecnico}/{total} aciertos ({(aciertos_tecnico/total)*100:.1f}%)")
    print(f"Brote:     {aciertos_brote}/{total} aciertos ({(aciertos_brote/total)*100:.1f}%)")

    if errores:
        print("\nDetalle de discrepancias:")
        for e in errores:
            print(e)
    else:
        print("\n🎉 ¡PRECISIÓN PERFECTA! 100% de coincidencias en prioridad, semáforo, técnico y brote.")

if __name__ == "__main__":
    probar_clasificador()
