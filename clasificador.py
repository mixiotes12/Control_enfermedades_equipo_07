import math
from decimal import Decimal, ROUND_HALF_UP

def redondear_comercial(val):
    """
    Redondeo comercial estándar (0.5 sube).
    Ejemplo: 14.06 -> 14; 14.5 -> 15.
    """
    d = Decimal(str(val))
    return int(d.quantize(Decimal('1'), rounding=ROUND_HALF_UP))

def haversine_km(lat1, lon1, lat2, lon2):
    """
    Fórmula de Haversine con radio de la Tierra R = 6371 km.
    Retorna la distancia en kilómetros.
    """
    R = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2.0)**2 + \
        math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def calcular_prioridad_y_semaforo(plaga_info, parcela_info, pct):
    """
    Calcula la prioridad (0 a 100) y el semáforo con las fórmulas oficiales (Sección 7).
    """
    # 1. Si la plaga es cuarentenaria, prioridad es 100 y semáforo es rojo directo
    if plaga_info.get("cuarentenaria", False):
        return 100, "rojo"

    # Factor Severidad (baja 15 · media 25 · alta 40 · crítica 50)
    mapa_severidad = {
        "baja": 15,
        "media": 25,
        "alta": 40,
        "critica": 50,
        "crítica": 50
    }
    puntos_severidad = mapa_severidad.get(plaga_info.get("severidad", "").lower(), 25)

    # Factor Superficie
    # ha afectadas = superficie_ha * pct / 100
    # puntos = min(25, redondear(ha afectadas / 4 * 25))
    superficie_ha = float(parcela_info.get("superficie_ha", 0))
    porcentaje = float(pct if pct is not None else 10)
    ha_afectadas = (superficie_ha * porcentaje) / 100.0

    calc_sup = (ha_afectadas / 4.0) * 25.0
    puntos_superficie = min(25, redondear_comercial(calc_sup))

    # Factor Etapa
    # crítica para esa plaga en ese cultivo 25 · susceptible 15 · otra 5
    cultivo = parcela_info.get("cultivo", "").lower()
    etapa = parcela_info.get("etapa", "")

    etapas_criticas = plaga_info.get("etapas_criticas", {}).get(cultivo, [])
    etapas_susceptibles = plaga_info.get("etapas_susceptibles", {}).get(cultivo, [])

    if etapa in etapas_criticas:
        puntos_etapa = 25
    elif etapa in etapas_susceptibles:
        puntos_etapa = 15
    else:
        puntos_etapa = 5

    prioridad = puntos_severidad + puntos_superficie + puntos_etapa

    # Semáforo según prioridad
    if prioridad >= 85:
        semaforo = "rojo"
    elif prioridad >= 70:
        semaforo = "naranja"
    elif prioridad >= 40:
        semaforo = "amarillo"
    else:
        semaforo = "verde"

    return prioridad, semaforo

def seleccionar_tecnico(tecnicos_disponibles, plaga_info, parcela_info):
    """
    Selecciona al técnico adecuado según las reglas oficiales (Sección 8):
    1. Misma especialidad que la plaga.
    2. Carga < 5.
    3. Más cercano por distancia Haversine.
    4. Desempates: menor carga y luego menor id.
    5. Si nadie cumple: None.
    """
    especialidad_requerida = plaga_info.get("especialidad", "").lower()
    lat_p = float(parcela_info["lat"])
    lon_p = float(parcela_info["lon"])

    candidatos = []
    for t in tecnicos_disponibles:
        # Filtro 1: Especialidad
        if t.get("especialidad", "").lower() != especialidad_requerida:
            continue
        # Filtro 2: Carga < 5
        carga = t.get("carga", 0)
        if carga >= 5:
            continue

        # Distancia en metros (al metro para desempates)
        dist_km = haversine_km(lat_p, lon_p, float(t["lat"]), float(t["lon"]))
        dist_metros = redondear_comercial(dist_km * 1000)

        candidatos.append({
            "id": t["id"],
            "dist_metros": dist_metros,
            "carga": carga
        })

    if not candidatos:
        return None

    # Ordenar por:
    # 1. Menor distancia en metros
    # 2. Menor carga
    # 3. Menor id alfabéticamente
    candidatos.sort(key=lambda x: (x["dist_metros"], x["carga"], x["id"]))

    return candidatos[0]["id"]
