# @alisio/plugin-scribe

![Scribe](https://gustavogutierrez.github.io/alisio-plugins/covers/scribe.svg)

> English: [README.md](./README.md). Ambos README deben actualizarse en conjunto.

Estudio de redacción científica para Alisio: varios documentos LaTeX, propuestas generadas por un
agente que revisas antes de que se conviertan en revisiones, adjuntos, historial de revisiones y
compilación de PDF sin conexión con un motor TeX incluido. No inicia otro servidor, no abre una
ventana del navegador ni pide credenciales de proveedores.

## Requisitos

- Node `>=22.16`.
- **Alisio 0.11.6 o posterior** para el estudio completo. La API de apps de plugins (`api.apps`)
  llegó en 0.11.5, y 0.11.6 permite que las acciones del estudio pidan aprobación como el chat:
  redactar necesita `write` y compilar un PDF necesita `process`. Alisio muestra el aviso habitual
  (permitir una vez, permitir en la sesión, denegar); una sesión denegada o de solo lectura hace que
  el estudio indique qué permiso falta.
- En hosts anteriores (sin `api.apps`), Scribe se carga igualmente: registra la herramienta
  `scribe_documents`, la vista de solo lectura `documents`, los agentes/skills y el comando `help`, y
  omite el estudio. Como los documentos solo se crean desde el estudio, la herramienta y la vista
  quedan vacías allí y `help` indica que el estudio no está disponible.

## Instalación

```bash
alisio install npm:@alisio/plugin-scribe
```

Abre un proyecto de confianza y selecciona **Scribe · Writing / Scribe · Redacción** en el grupo
**Aplicaciones**, encima de **Proyectos**. El panel de proyectos sigue disponible; **Volver al
chat** recupera la conversación.

## Cómo se integra

- `api.apps.register` aporta un paquete HTML autocontenido (`dist/embedded.html`, generado desde
  `web/`) y manejadores de acciones declarados de lectura, escritura y proceso.
- El host lo monta en un iframe aislado (origen opaco, sin formularios, sin red). Su único script en
  línea lleva el nonce del host; PDF.js muestra las vistas previas con un worker `blob:`, sin eval ni
  WASM, a partir de los bytes que devuelve una acción.
- El marco acepta solo el primer puerto `alisio.app.connect` de `window.parent` y envía por él cada
  acción al servidor autenticado de Alisio, nunca directamente a los proveedores. Mantiene menos de 8
  peticiones en curso y pausa el sondeo mientras está oculto. Cuando el host responde `not_found`, el
  estudio vuelve a comprobarlo una vez tras una breve espera; solo si la app sigue sin estar (por
  ejemplo, tras desactivar el plugin) muestra un estado de no disponible, con un botón
  **Reintentar** y una nueva comprobación cada vez que el estudio vuelve a mostrarse.
- El trabajo largo (borradores del agente y compilaciones de PDF) devuelve un trabajo de inmediato y
  el estudio lo consulta, así que ninguna acción ocupa el límite de 30 segundos por petición del
  host.
- El host controla cada acción según su efecto con los permisos existentes de la sesión, sin aviso:
  las acciones que modifican, incluida la cancelación de trabajos, necesitan permiso de escritura y
  las compilaciones de PDF también necesitan permiso de proceso.
- El idioma de Alisio controla todas las etiquetas de la interfaz (inglés/español); el estudio no
  tiene selector de idioma propio. El idioma del manuscrito es independiente.
- El backend usa las sesiones de Alisio, la configuración de modelos, los permisos de herramientas y
  las rutas privadas de estado.

## Funciones

Varios documentos; puntos de partida de física, matemáticas e informática; selección de modelo;
propuestas LaTeX generadas por un agente; revisión explícita con aplicar/descartar; edición manual de
LaTeX/BibTeX; comprobación de conflictos de revisión; historial y restauración; adjuntos; búsqueda y
archivo de documentos; importación/exportación de proyectos JSON; importación de `.tex`; exportación
de las fuentes en ZIP; trabajos de compilación de PDF, cancelación y descargas; mensajes ES/EN.

## Configuración

Define `pluginOverrides["alisio.scribe"].options` en la configuración de Alisio:

| Opción | Significado |
|---|---|
| `locale` | `"es"` o `"en"`; idioma predeterminado que se informa al estudio. |
| `allowedTools` | Nombres explícitos de herramientas efectivas existentes disponibles para el agente hijo; vacío por defecto. |

Las herramientas de otros plugins pasan por el ejecutor de agentes existente; este plugin no importa
otros plugins ni omite sus controles de efecto. Las sesiones hijas deniegan los permisos de escritura
y proceso; una lista de permitidos nunca concede privilegios que su sesión padre no tenga.

## Compilación de PDF

Scribe usa Tectonic 0.16.9. No se necesita Docker ni TeX del sistema.

- **Linux x64:** el paquete incluye la compilación estática (musl) oficial en
  `compiler/linux-x64/tectonic`, así que compila en cualquier Linux x86_64, glibc o musl (incluidos
  Ubuntu 22.04 y Debian 12). Si falta ese archivo, Scribe recurre al binario de `node-tectonic`, que
  necesita glibc 2.39 o posterior; en sistemas más antiguos las compilaciones de PDF fallan entonces
  con un error de compilación.
- **Windows x64, Linux arm64 y macOS x64/arm64:** el binario de plataforma de `node-tectonic` 1.1.0,
  que se instala automáticamente (en Linux arm64 ya es una compilación estática). No omitas las
  dependencias opcionales al instalar.

El paquete contiene un archivo TeX comprimido sin conexión de 106 MB (`compiler/bundle.zip`): un
subconjunto de TeX Live 2023 con LaTeX (recomendado y extra), inglés, español, portugués, francés y
alemán, matemáticas y ciencias (incluidos `siunitx` y paquetes de algoritmos), gráficos (`tikz`,
`pgfplots`), bibliografías (`biblatex` con el backend BibTeX, `natbib`), fuentes recomendadas y
soporte de fuentes de XeTeX. Para no superar el límite de tamaño de paquete de npm omite las copias
Type1 de las fuentes que XeTeX lee como OpenType (cm-super, Libertine, TeX Gyre), las métricas AFM,
los datos de MetaPost y algunos paquetes recreativos con muchas imágenes (consulta
`scripts/tex-bundle-excludes.txt`). La primera compilación crea la caché del formato LaTeX; las
siguientes la reutilizan. Las compilaciones nunca descargan paquetes ni envían el contenido de los
documentos a ninguna parte. Antes de compilar, Scribe comprueba las clases, los paquetes y los
idiomas de babel del documento contra `compiler/bundle-manifest.json` e indica lo que falte. No se
admiten paquetes fuera de la instantánea, `biber` ni plantillas solo para LuaLaTeX. El archivo lo
genera el script de mantenimiento `scripts/vendor-tex-bundle.py`; los usuarios finales nunca lo
ejecutan.

Tectonic se ejecuta con `--untrusted`, un directorio temporal privado, un entorno mínimo con lista de
permitidos (solo variables de ruta, inicio, temporales, idioma y caché), un tiempo límite de 180
segundos, tamaños de registro y de PDF acotados, y cancelación. Es un proceso nativo bajo el permiso
de proceso de Alisio, no un entorno aislado del sistema operativo. PDF.js se incluye para las vistas
previas en el editor. Consulta `THIRD_PARTY_NOTICES.md` y el directorio `LICENSES` del archivo para
las licencias de TeX y de las fuentes.

## Persistencia y límites

Almacenamiento JSON atómico (y escritura atómica de PDF) por espacio de trabajo, con una cola de
escritura dentro del proceso. Ejecuta un único proceso host por directorio de estado de Scribe. Un
documento guardado que no se puede leer se omite (con un aviso del proceso) en lugar de romper la
lista de documentos. Los trabajos se guardan y se marcan como interrumpidos tras un reinicio; nunca se
repiten. La idempotencia cubre solo los reintentos dentro del proceso en ejecución.

Los mismos límites se aplican al editar y al importar, así que todo proyecto exportado se puede
importar:

| Límite | Valor |
|---|---|
| Un adjunto | 25 MiB |
| Todos los adjuntos de un documento | 100 MiB, como máximo 200 archivos |
| Revisiones conservadas | 200 (las más antiguas se eliminan al añadir una nueva) |
| Fuente LaTeX / bibliografía | 400.000 / 100.000 caracteres por revisión |
| Archivo de proyecto elegido en el estudio | 256 MiB |

Los adjuntos binarios no se procesan con OCR ni se envían al modelo. Las referencias requieren
verificación humana.

## Desarrollo

```bash
pnpm --filter @alisio/plugin-scribe build
pnpm --filter @alisio/plugin-scribe typecheck
pnpm --filter @alisio/plugin-scribe test
```

Las pruebas se ejecutan con Vitest sobre `src`, incluidas pruebas jsdom de la interfaz del estudio y
de su handshake, y una comprobación de que la página generada cumple la CSP del marco. La prueba de
PDF con el motor real se omite cuando no hay ningún binario de Tectonic que pueda ejecutarse en la
máquina actual.

Los dos archivos incluidos están ignorados por git (demasiado grandes para el repositorio) y deben
existir antes de empaquetar:

```bash
cd packages/plugin-scribe
# 1. A portable TeX Live 2023 subset in a scratch directory (no root access, nothing system-wide).
TL=/absolute/scratch/tl2023
REPO=https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2023/tlnet-final
curl -fLO $REPO/install-tl-unx.tar.gz && tar xzf install-tl-unx.tar.gz
sed "s|@TEXDIR@|$TL|g" scripts/texlive-2023.profile > "$TL.profile"
perl install-tl-*/install-tl --no-interaction --profile "$TL.profile" --repository $REPO
# 2. The flat bundle and its manifest (also takes the generated font maps and language.dat).
python3 scripts/vendor-tex-bundle.py $TL/texmf-dist
# 3. The static Tectonic binary for linux-x64.
node scripts/vendor-tectonic.mjs       # compiler/linux-x64/tectonic, checksum-verified download
```

`vendor-tex-bundle.py` omite lo que Tectonic nunca lee (listado en
`scripts/tex-bundle-excludes.txt`) y falla si dos archivos distintos fueran a compartir nombre en el
archivo plano. `compiler/bundle-manifest.json` es pequeño y se incluye en el repositorio;
`compiler/bundle.zip` no.

`vendor-tectonic.mjs` descarga el recurso de la versión oficial fijada, verifica los resúmenes SHA-256
del tarball y del binario y escribe el binario de forma atómica; `--from <tar.gz>` usa una copia local
en su lugar. `scripts/verify-host-integration.mjs <alisio-checkout>` ejercita el plugin dentro de un
Alisio compilado localmente que incluye la API de apps de plugins.

## Licencia

MIT
