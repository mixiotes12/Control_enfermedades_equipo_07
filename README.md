# Bitácora de parcela

Plantilla del curso-taller “Git, servidores y agentes de IA”, Departamento de Ingeniería Mecánica Agrícola, Universidad Autónoma Chapingo, del 19 al 23 de octubre de 2026.

## Propósito

Es una aplicación web mínima para registrar las actividades de una parcela: fecha, parcela, cultivo, actividad y observaciones. Cada equipo la usa para recorrer el flujo de un proyecto real:

- trabajar sobre su propio fork, con commits de todos los integrantes;
- conectar la aplicación a una base de datos PostgreSQL en Supabase;
- pedir a un agente de IA que cree la tabla mediante el MCP de Supabase y revisar el SQL que propone;
- publicar la aplicación en el servidor del curso.

En el hackathon, la aplicación y su base de datos se reutilizan para registrar y mostrar los casos.

## Qué incluye

- El formulario y la lista de registros.
- El código que guarda y consulta los registros en Supabase.
- Un diseño básico en tonos grises.
- Un servidor para publicar la versión construida.

| Archivo | Contenido |
|---|---|
| `index.html` | Formulario y lista de registros. |
| `src/main.js` | Conexión con Supabase; guardar y consultar registros. |
| `src/style.css` | Estilos de la aplicación. |
| `server.js` | Servidor de la versión construida, para `pnpm start`. |
| `vite.config.js` | Configuración de Vite; define qué variables de `.env` llegan al navegador. |
| `.env.example` | Nombres de las variables, sin valores. |
| `equipos.md` | Lista de equipos del curso. |

## Registro de equipos

El archivo `equipos.md` es la lista de equipos del curso y el primer ejercicio con pull requests:

1. Haz fork de este repositorio y clona tu fork: `git clone https://github.com/<tu-usuario>/form-DIMA-2026.git`.
2. Crea una rama con tu nombre: `git switch -c agrega-<tu-nombre>`.
3. Agrega tu nombre debajo del nombre de tu equipo, escrito en mayúsculas. Si el equipo todavía no aparece, agrégalo al final:

   ```text
   ## NOMBRE DEL EQUIPO
   - Nombre Apellido
   ```

4. Haz commit, sube la rama a tu fork con `git push -u origin agrega-<tu-nombre>` y abre en GitHub el pull request hacia `IT-Green-GA/form-DIMA-2026`.

Después del merge, el equipo sigue trabajando en la Bitácora sobre su fork.

## Qué le hace falta

La plantilla no funciona por sí sola. Para que guarde y muestre registros faltan tres cosas:

1. **La tabla `registros`.** Todavía no existe; la crea tu agente de IA en tu proyecto de Supabase. Debe tener estas columnas:

   | Columna | Tipo | Obligatoria | Ejemplo |
   |---|---|---|---|
   | `id` | número, automático | sí | 1 |
   | `fecha` | fecha | sí | 2026-10-19 |
   | `parcela` | texto | sí | P-077 El Cerrito |
   | `cultivo` | texto | sí | Maíz |
   | `actividad` | texto | sí | Observación |
   | `observaciones` | texto | no | Aserrín en el cogollo |
   | `creado` | fecha y hora, automática | sí | 2026-10-19 17:52 |

2. **Las llaves del proyecto.** La URL y la llave publicable de Supabase van en `.env`.
3. **Permisos de lectura y escritura.** Si la tabla tiene RLS (Row Level Security) activado sin políticas, la aplicación no puede guardar ni consultar. El detalle del error aparece en la consola del navegador; en ese caso, pide al agente que agregue políticas de lectura e inserción.

Después, cada equipo la completa a su manera:

- **Su diseño**, en `src/style.css`.
- **Funciones propias**, por ejemplo: el nombre del equipo en el encabezado, editar o borrar registros, o filtrar por parcela o por cultivo.
- **Los casos del hackathon**: nuevas tablas y vistas para registrarlos y mostrarlos.

## Requisitos

- Node.js 20.19 o posterior.
- pnpm. Si no lo tienes: `npm install -g pnpm`.
- Una cuenta de Supabase.
- Un agente de programación conectado al MCP de Supabase.

## Puesta en marcha

1. Usa el fork y el clon del registro de equipos y regresa a la rama principal: `git switch main`.
2. Instala las dependencias:

   ```bash
   pnpm install
   ```

3. Crea un proyecto en Supabase.
4. Pide a tu agente: “Crea en Supabase una tabla registros para la bitácora: fecha, parcela, cultivo, actividad y observaciones”. Revisa el SQL antes de aceptarlo.
5. Copia la plantilla de variables y escribe la URL y la llave publicable del proyecto. Las encuentras en Project Settings, en Supabase.

   ```bash
   cp .env.example .env
   ```

6. Inicia la aplicación y abre http://localhost:5173:

   ```bash
   pnpm dev
   ```

7. Guarda un registro y verifica que aparece en la lista.
8. Haz commit y push a tu fork.

## Publicación en el servidor

```bash
pnpm build   # genera la versión construida en la carpeta dist
pnpm start   # la publica en el puerto 3000
```

Si cambias `.env`, vuelve a ejecutar `pnpm build`: los valores se integran al construir la aplicación.

## Módulo de Clasificación y Reglas del Hackathon

El proyecto incluye el motor de reglas determinista (`clasificador.py`) para el **Nivel 2 del Hackathon «Alerta Plaga»**:

- **Cálculo de Prioridad (0 a 100):** Severidad + Superficie afectada + Etapa fenológica (o 100 directo para plagas cuarentenarias).
- **Semáforo:** Asignación automática de nivel de atención (Verde, Amarillo, Naranja, Rojo).
- **Asignación de Técnicos:** Selección por especialidad (`entomologia` / `fitopatologia`), filtro de carga (< 5) a la hora del reporte y distancia geodésica mínima (Haversine con $R = 6371\text{ km}$).
- **Validación Oficial:** El script `validar_clasificador.py` comprueba las reglas contra los 40 casos de `GET /casos-previos` de la API de la junta, verificando 100% de coincidencia antes de registrar en producción.

```bash
# Ejecutar validación de los 40 casos oficiales
python3 validar_clasificador.py
```

## Módulo de Interpretación con Inteligencia Artificial (`interprete.py`)

Procesa lenguaje natural con el modelo multimodal vía OpenRouter:
- **Detección de Reporte:** Clasifica `es_plaga` (distingue trámites, dudas y saludos de reportes fitosanitarios).
- **Mapeo al Catálogo Oficial:** Asigna el ID exacto de entre las 10 plagas o `"desconocida"` sin alucinaciones.
- **Detección de Seguimientos:** Identifica casos en curso sin abrir reportes duplicados (`es_seguimiento`).
- **Extracción de Superficie Afectada:** Traduce expresiones coloquiales ("tres cuartas partes", "la mitad", "una de cada cuatro matas") a porcentaje numérico exacto (default 10%).

## Llaves

- `.env` contiene las llaves y no se sube al repositorio; está en `.gitignore`.
- Solo `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY` llegan al navegador. La llave publicable está hecha para usarse ahí.
- La llave secreta del proyecto nunca debe ir en esta aplicación.
