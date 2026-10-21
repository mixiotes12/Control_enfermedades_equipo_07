import json
import urllib.request
import base64
import re

CATALOGO_PLAGAS = """
1. ID: "gusano_cogollero" (Maíz). Nombres locales: gusano, gusano del cogollo, cogollero, gusano soldado. Síntomas: hojas perforadas/raspadas como ventana, excremento como aserrín en cogollo, larvas verde/café con Y invertida en cabeza.
2. ID: "roya_frijol" (Frijol). Nombres locales: chahuixtle, roya, polvillo. Síntomas: pústulas café rojizo en envés, polvo color óxido que mancha dedos, hojas amarillas que caen.
3. ID: "pulgon" (Avena, trigo, maíz, haba). Nombres locales: pulgón, piojillo, piojo. Síntomas: colonias de insectos chicos verdes/negros, mielecilla pegajosa, hojas enrolladas, fumagina negra.
4. ID: "gallina_ciega" (Maíz, frijol, avena, haba). Nombres locales: gallina ciega, nixticuil, gusano blanco. Síntomas: plantas marchitas fáciles de arrancar, raíces comidas, larvas blancas en forma de C en suelo, plantas acamadas.
5. ID: "tizon_tardio" (Papa, jitomate). Nombres locales: tizón, hielo, quemazón, chahuixtle de la papa. Síntomas: manchas café oscuro con borde amarillo, moho blanco con humedad, follaje quemado, tallos negros y olor a podrido.
6. ID: "mosquita_blanca" (Jitomate, frijol). Nombres locales: mosquita blanca, mosquilla, palomilla blanca. Síntomas: nubes de insectos blancos al mover planta, huevecillos/ninfas en envés, hojas amarillas/pegajosas, hojas enchinadas.
7. ID: "chapulin" (Maíz, frijol, haba, avena). Nombres locales: chapulín, chapulines, saltamontes. Síntomas: chapulines en bordos/orillas, hojas comidas desde el borde, plantas defoliadas.
8. ID: "mancha_chocolate" (Haba). Nombres locales: mancha de chocolate, chocolate, manchita café. Síntomas: manchas redondas café rojizo en hojas/tallos que se juntan y ennegrecen, caída de flores.
9. ID: "hlb" (Limón). Nombres locales: dragón amarillo, enverdecimiento de los cítricos, HLB. Síntomas: moteado amarillo asimétrico en hojas, frutos chicos/deformes, ramas amarillas, psílidos en brotes.
10. ID: "gorgojo_khapra" (Grano almacenado). Nombres locales: gorgojo khapra, gusanito peludo del grano. Síntomas: larvas peludas café claro en grano almacenado, pellejos en costales, granos huecos y polvo.
"""

SYSTEM_PROMPT = f"""Eres un clasificador experto de sanidad vegetal de la Junta Local de Texcoco.
Analizas mensajes enviados por agricultores (texto, audio transcrito o fotos con descripción) y decides:

1. "es_plaga": true para cualquier reporte sobre plagas o enfermedades en cultivos, INCLUYENDO seguimientos de casos previos ("¿ya vienen a revisar lo de ayer?", "sigue igual", "¿qué pasó con mi reporte?").
   false ÚNICAMENTE si son mensajes de trámites de fertilizante, horarios de oficina, agradecimientos, saludos aislados, bromas o temas ajenos a la sanidad vegetal.
2. "es_seguimiento": true si el mensaje se refiere a una visita o reporte anterior ("¿vienen hoy?", "sigue igual", "¿qué pasó con mi visita?", "lo de ayer").
   false si describe un caso nuevo o si no es plaga.
3. "plaga": El id exacto de la plaga del catálogo:
{CATALOGO_PLAGAS}
   - Si es un seguimiento que no menciona la plaga, o si los síntomas no coinciden con ninguna del catálogo, usa "desconocida". NUNCA inventes nombres.
   - Si es_plaga es false, usa null.
4. "pct": Porcentaje de parcela afectada (0 a 100).
   - Extraer de frases: "la mitad" -> 50, "un cuarto" o "una de cuatro" -> 25, "tres cuartas partes" -> 75, "toda la parcela" -> 100, "como el 30%" -> 30.
   - Si no lo menciona o no se deduce, devuelve 10 (valor por defecto según las reglas).
   - Si es_plaga es false, usa null.

IMPORTANTE: Responde ÚNICAMENTE un objeto JSON válido con estas claves:
{{"es_plaga": bool, "es_seguimiento": bool, "plaga": str|null, "pct": int|null, "razon": str}}
"""

def transcribir_audio(audio_bytes, api_key):
    """
    Usa el modelo omni para transcribir notas de voz (.ogg) directamente en la nube.
    """
    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")
    payload = {
        "model": "qwen/qwen3.8-omni-flash",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Transcribe textualmente lo que se dice en este audio en español, sin agregar introducciones ni explicaciones:"},
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": audio_b64,
                            "format": "ogg"
                        }
                    }
                ]
            }
        ]
    }
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        return res["choices"][0]["message"]["content"].strip()

def interpretar_mensaje_texto(texto, cultivo_parcela=None, api_key=None, foto_bytes=None):
    """
    Interpreta un reporte vía texto o con imagen adjunta usando GPT-4o-mini con visión.
    """
    if not api_key:
        raise ValueError("Se requiere API_OPEN_ROUTER")

    user_text = f"Mensaje del productor: \"{texto or 'Foto adjunta'}\""
    if cultivo_parcela:
        user_text += f"\nCultivo de la parcela: {cultivo_parcela}"

    user_content = [{"type": "text", "text": user_text}]

    # Si hay foto adjunta, se envía en base64 para análisis visual
    if foto_bytes:
        img_b64 = base64.b64encode(foto_bytes).decode("utf-8")
        user_content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}
        })

    payload = {
        "model": "openai/gpt-4o-mini",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content}
        ],
        "temperature": 0.0,
        "response_format": {"type": "json_object"}
    }

    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
    )

    with urllib.request.urlopen(req, timeout=30) as resp:
        res_data = json.loads(resp.read().decode("utf-8"))
        content = res_data["choices"][0]["message"]["content"]
        parsed = json.loads(content)

        # Regla Oficial Sección 6 y 9: Si es seguimiento y no trae plaga, 'desconocida' es correcto.
        if parsed.get("es_seguimiento") and (not parsed.get("plaga") or parsed.get("plaga") == "null"):
            parsed["plaga"] = "desconocida"

        return parsed
