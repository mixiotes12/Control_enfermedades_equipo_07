import json
import urllib.request
import base64
import re

# Menciones a SU reporte/visita previa: seguimiento aunque el modelo lo haya descartado.
SEGUIMIENTO_RE = re.compile(
    r"\b(mi|mis)\s+(reporte|reportes|aviso|avisos|visita)\b|\blo de ayer\b|\bsigue igual\b",
    re.IGNORECASE,
)

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

1. "es_plaga": true para cualquier reporte sobre plagas o enfermedades en cultivos, INCLUYENDO seguimientos de casos previos: cualquier mensaje que se refiera a un reporte o visita que el productor ya hizo ("¿ya vienen a revisar lo de ayer?", "sigue igual", "¿qué pasó con mi reporte?", "nomás para confirmar que les llegó mi reporte", "¿ya mandaron al técnico?").
   false ÚNICAMENTE si son mensajes de trámites de fertilizante, horarios de oficina, pedidos o paquetes ajenos (postales, etc.), pláticas, agradecimientos o saludos aislados SIN referencia a un reporte, bromas o temas ajenos a la sanidad vegetal.
   Preguntar o avisar sobre SU reporte, aviso o visita ("confirmar que les llegó mi reporte", "¿ya mandaron al técnico?", "¿vienen hoy?") es un seguimiento: es_plaga=true, es_seguimiento=true, plaga="desconocida", aunque no describa síntomas.
   En cambio, algo que "llegó" SIN relación con su reporte (postales, paquetes, apoyos, fertilizante) NO es reporte.
   Si el productor dice que su cultivo "amaneció mal", está enfermo, dañado o raro aunque NO sepa qué tiene ("no sé qué tiene"), ES un reporte: es_plaga=true con plaga="desconocida". Nunca lo descartes como no-plaga por ser vago.
2. "es_seguimiento": true ÚNICAMENTE si el mensaje NO describe síntomas nuevos y solo pregunta por un reporte previo ("¿ya vienen a revisar lo de ayer?", "¿cuándo van a venir a ver el gusano?", "sigue igual que ayer").
   false si el mensaje describe los síntomas por primera vez, detalla daños o pide auxilio con un reporte nuevo (frases de cortesía como "quedo pendiente" o "espero su ayuda" al final NO son seguimientos).
3. "plaga": El id exacto de la plaga del catálogo:
{CATALOGO_PLAGAS}
   - Si es un seguimiento que no menciona la plaga, o si los síntomas no coinciden con ninguna del catálogo, usa "desconocida". NUNCA inventes nombres.
   - Si es_plaga es false, usa null.
4. "pct": Porcentaje de parcela afectada (0 a 100).
   - Extraer de frases: "la mitad" -> 50, "un cuarto" o "una de cada cuatro" -> 25, "tres cuartas partes" -> 75, "una quinta parte" o "una de cada cinco" -> 20, "una décima parte" o "una de cada diez" -> 10, "una tercera parte" -> 33, "dos terceras partes" -> 67, "toda la parcela" -> 100, "como el 30%" -> 30. Convierte la fracción exacta, sin redondear a otra.
   - Si no lo menciona o no se deduce, devuelve 10 (valor por defecto según las reglas).
   - Si es_plaga es false, usa null.

5. "confianza": "alta", "media" o "baja" sobre la plaga elegida. Usa "baja" si los síntomas o la imagen no permiten distinguirla con claridad.

FOTOS: si viene una imagen, identifica lo que SE VE en ella (qué insecto, qué tipo de daño o mancha). La imagen manda sobre el cultivo de la parcela: el cultivo es solo contexto y NO debe llevarte a elegir una plaga que no se ve en la foto. Si en la foto hay un insecto, nómbralo por su aspecto (p. ej. un saltamontes verde es "chapulin").

IMPORTANTE: Responde ÚNICAMENTE un objeto JSON válido con estas claves:
{{"es_plaga": bool, "es_seguimiento": bool, "plaga": str|null, "pct": int|null, "confianza": str, "razon": str}}
"""

def transcribir_audio(audio_bytes, api_key):
    """
    Usa el modelo omni para transcribir notas de voz (.ogg) directamente en la nube.
    """
    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")
    payload = {
        "model": "qwen/qwen3.8-omni-flash",
        "temperature": 0.0,
        "seed": 7,
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

    # Las fotos requieren un modelo de visión más fuerte; texto y voz transcrita van con el mini (más rápido).
    modelo = "openai/gpt-4o" if foto_bytes else "openai/gpt-4o-mini"

    payload = {
        "model": modelo,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content}
        ],
        "temperature": 0.0,
        "seed": 7,
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

        # Red de seguridad en código: si el mensaje habla de SU reporte/visita, es un seguimiento
        # aunque el modelo lo haya descartado (caso inestable observado en la práctica).
        if not parsed.get("es_plaga") and texto and SEGUIMIENTO_RE.search(texto):
            parsed.update({"es_plaga": True, "es_seguimiento": True, "plaga": "desconocida", "pct": 10})

        # Regla Oficial Sección 6 y 9: Si es seguimiento y no trae plaga, 'desconocida' es correcto.
        if parsed.get("es_seguimiento") and (not parsed.get("plaga") or parsed.get("plaga") == "null"):
            parsed["plaga"] = "desconocida"

        # Con baja confianza es mejor "desconocida" (0 puntos) que arriesgar plaga, semáforo y técnico (hasta -3).
        if parsed.get("es_plaga") and parsed.get("confianza") == "baja" and parsed.get("plaga") not in (None, "desconocida"):
            parsed["plaga"] = "desconocida"

        return parsed
