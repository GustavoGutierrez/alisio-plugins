---
title: "Frontsmith"
description: "Runs a gated frontend engineering workflow with specialist agents, deterministic rule packs, architecture, accessibility and token checks, and a reproducible visual-fidelity pipeline."
pageClass: "plugin-detail"
---

<PluginDetail slug="frontsmith" />

![Frontsmith](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/cover.webp)

> English: [README.md](https://github.com/GustavoGutierrez/alisio-plugins/blob/HEAD/packages/plugin-frontsmith/README.md). Ambos README deben actualizarse en conjunto.

Frontsmith convierte una sesión de Alisio en un flujo de ingeniería frontend con compuertas. Los
agentes especialistas hacen el trabajo de criterio y de creación; el código determinista decide todo
lo que el código puede decidir: paquetes de reglas, límites de arquitectura, verificaciones de
accesibilidad y de tokens, presupuestos de rendimiento y un proceso reproducible de fidelidad visual.
Los agentes nunca aprueban su propio trabajo, y una herramienta ausente se informa como bloqueada,
nunca como aprobada.

## Estado

**Versión preliminar (0.2.0).** Todo lo que se describe está implementado y cubierto por pruebas
sin conexión, con dobles guionizados para las sesiones hijas. Lo que **todavía no** se ha ejercitado
contra un host Alisio real:

- las sesiones hijas reales (la asignación de modelo por agente, los perfiles de los agentes, los
  trabajos en segundo plano que sobreviven a su comando en la TUI y los límites de tiempo de los
  comandos en un navegador o en un cliente remoto);
- el coordinador conversacional en un host real: qué herramientas se ofrecen al modelo (por ahora el
  host ignora las listas de herramientas declaradas de un agente principal), los diálogos del plugin
  lanzados desde una llamada a herramienta, el aviso de finalización encolado para el siguiente
  turno y las verificaciones largas dentro de una ejecución del coordinador;
- las imágenes compuestas en línea en terminales, el panel a través de un cliente web remoto y cómo
  muestra el Dock los artefactos en Markdown;
- si un modelo con visión puede leer las capturas de fidelidad (sin uno, `fs-fidelity-reviewer`
  trabaja a partir del informe numérico).

La sonda con navegador real se ejecutó una vez con Playwright y Chromium en Linux; se omite en las
máquinas que no proveen Playwright. Los agentes personalizados están **planificados, no entregados**:
véase «Limitaciones».

## Por qué mejora la calidad del frontend

![Decisiones de diseño, el mecanismo detrás de cada una y el resultado de calidad que protegen](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/quality-decisions.svg)

Cada decisión de diseño se vincula con un mecanismo y con el resultado que protege, de modo que un
resultado se puede explicar en lugar de esperarlo.

## Requisitos

- Node.js 22.16 o superior y `@alisio/sdk` 0.3 a 0.6.
- `git` en el `PATH`. Opcionales, resueltos desde su proyecto: `playwright` (con un navegador
  Chromium) para el proceso de fidelidad y `axe-core` para las verificaciones de accesibilidad en
  ejecución.
- No requiere credenciales ni acceso de red propio.

## Instalación

```sh
alisio install npm:@alisio/plugin-frontsmith
```

## Inicio rápido

1. `/frontsmith:init` crea `.frontsmith/config.json` y la entrada de gitignore para la evidencia
   local.
2. `/frontsmith:doctor` comprueba git, Node, los comandos del proyecto, Playwright, axe-core, los
   paquetes y los modelos.
3. `/frontsmith:new login-form --level L1 -- Add an accessible login form` crea una funcionalidad.
   Sin `--level`, una sesión interactiva lo pregunta; una ejecución sin interfaz necesita el
   indicador.
4. `/frontsmith:next login-form` ejecuta la siguiente unidad. Las fases de planificación se ejecutan
   en línea; construcción, validación y revisión inician un trabajo en segundo plano (use
   `--foreground` para ejecutarlas dentro del comando).
5. Cuando una unidad espera a una persona, la salida indica el comando exacto, por ejemplo
   `/frontsmith:approve login-form spec`. Las aprobaciones nunca se asumen: una sesión interactiva
   pregunta y una sin interfaz imprime el comando.
6. `/frontsmith:status login-form` muestra en cualquier momento la fase, las compuertas, las tareas y
   el siguiente comando.

Para trabajar en conversación, seleccione el agente `frontsmith:fs-coordinator` (véase «Coordinador
conversacional»). Para partir de una especificación escrita, añada `--from-spec docs/login.md`
(véase «Partir de un archivo de especificación»).

## Metodología

![Fases desde la recepción hasta el archivo, con compuertas, aprobaciones humanas y los ciclos acotados](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/methodology-flow.svg)

Una funcionalidad avanza por fases (`intake`, `context`, `specify`, `ui-contract`, `tokens`, `plan`,
`test-design`, `build`, `validate`, `review`, `accept`, `archive`). Cada fase termina en una compuerta
cuyo informe se escribe en `docs/frontsmith//reports/`. Las compuertas fallidas devuelven el
trabajo en ciclos acotados: como máximo 2 rebotes por tarea, 3 rondas de reparación y 2 remediaciones,
todo configurable. La fase `tokens` solo se ejecuta cuando el contrato de UI necesita tokens nuevos.

## Agentes

![Los doce agentes entregan sobres al coordinador, que escribe los artefactos que leen los agentes siguientes](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/agent-roster.svg)

Los agentes devuelven sobres JSON estrictos que el código valida; el código, no el agente, escribe
los artefactos y cambia de fase. El revisor nunca ve la narración del implementador.

| Agente | Función | Nivel por defecto |
| --- | --- | --- |
| `fs-coordinator` | Guía a una persona por una funcionalidad en el chat llamando a las herramientas `fs_*`; nunca decide una compuerta ni registra por sí mismo una decisión humana | standard |
| `fs-specifier` | Convierte una intención en una especificación verificable con estados y preguntas abiertas | reasoning |
| `fs-ui-contractor` | Convierte la especificación y los diseños en un contrato de UI ejecutable | reasoning |
| `fs-tokensmith` | Elige roles, nombres y pares de contraste de los tokens, nunca valores de color | standard |
| `fs-architect` | Plan mínimo: componentes, capas, estado, contratos, decisiones y contratos de tarea | reasoning |
| `fs-test-engineer` | Asocia cada criterio de aceptación con una prueba; escribe pruebas de verificación en modo build | standard |
| `fs-implementer` | Implementa una tarea de UI, con prueba primero cuando corresponde | standard |
| `fs-data-engineer` | Implementa una tarea de la capa de datos: clientes, almacenes, consultas y simulaciones | standard |
| `fs-a11y-auditor` | Interpreta los informes de accesibilidad y el comportamiento de teclado y foco | standard |
| `fs-fidelity-reviewer` | Clasifica los elementos a revisar del informe de fidelidad y ordena las reparaciones | standard |
| `fs-reviewer` | Intenta refutar de forma independiente que el cambio esté listo | reasoning |
| `fs-archivist` | Escribe la retrospectiva y propone reglas candidatas | fast |

Los archivos de agentes y habilidades se incluyen en el paquete (`.agents/agents`, `.agents/skills`,
16 habilidades) y se usan tanto para el catálogo del host como para las instrucciones de cada sesión
hija.

## Quién decide qué

![Flujo de decisión de una verificación: el código decide PASS o FAIL, los agentes solo clasifican los elementos a revisar](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/who-decides.svg)

El código decide lo que el código puede medir. Los agentes clasifican las señales heurísticas
(`REVIEW`) y pueden marcar una variación como aceptable, pero no pueden revertir un `FAIL`. Una
herramienta requerida que falta produce `BLOCKED`, que permanece visible hasta que una persona lo
resuelve o lo exime.

## Coordinador conversacional

Seleccione el agente `frontsmith:fs-coordinator` (`/agent:frontsmith:fs-coordinator` o Shift+Tab) y
converse. Lee el estado con `fs_status` y luego llama a `fs_feature_new`, `fs_next`, `fs_answer` y
`fs_approval_request` en el orden correcto, explicando cada resultado. El código sigue ejecutando
cada unidad y cada compuerta; el coordinador solo las secuencia.

- **Toda decisión humana sigue siendo humana.** El nivel de una funcionalidad nueva, la respuesta a
  una pregunta abierta y una aprobación se registran solo después de que la persona hace clic en un
  diálogo que construye y muestra el plugin (o escribe el comando). El modelo nunca rellena esos
  diálogos. El texto que retransmite en nombre de usted, como una respuesta con sus palabras, se le
  muestra tal cual y solo se registra si elige Registrar. Una sesión que no puede preguntar recibe el
  comando exacto y no se registra nada.
- **Aprobaciones.** `fs_approval_request` abre el mismo diálogo que `/frontsmith:approve`, solo para
  la aprobación que la funcionalidad debe en ese momento. Las aprobaciones de `config` (volver a fijar
  los archivos protegidos) son exclusivas del comando.
- **El trabajo largo se ejecuta como trabajos en segundo plano.** Toda unidad que ejecuta un agente
  hijo se inicia como trabajo. Al terminar se encola para el siguiente turno un aviso breve (escrito
  por el código, sin texto de agentes) y el coordinador espera a que usted diga que continúe. Nunca
  consulta en bucle.
- **Se detiene en las compuertas.** `fs_next` regresa sin ejecutar nada mientras haya una pregunta,
  una aprobación o una funcionalidad cerrada esperando. Se ejecutan como máximo tres unidades por
  turno.
- **Pie.** Cada respuesta termina con `Feature, Phase, Gate, Next`, tomados del estado.

Límite conocido: el host aún no respeta las listas de herramientas permitidas y denegadas que el
archivo del agente declara para un agente principal, así que `readOnly: false` también le expone las
herramientas integradas de escritura, shell y delegación. Las listas se conservan en el archivo para
cuando lo haga; hoy la protección son el cuerpo del agente, las aprobaciones por llamada del host, el
hash de los archivos protegidos y los diálogos del plugin. La solicitud al host está documentada en
la especificación (sección 5.2). Los agentes personalizados no forman parte de esta versión.

## Partir de un archivo de especificación

`/frontsmith:new  --level L1|L2|L3 --from-spec ` (o `fromSpec` en `fs_feature_new`)
crea una funcionalidad a partir de un documento que ya tiene. `-- ` pasa a ser opcional; sin
él, la intención es el título del archivo.

- El archivo debe estar dentro del espacio de trabajo, terminar en `.md`, `.markdown` o `.json` y
  pesar como máximo 128 KiB en UTF-8. Se rechazan `.git`, `.alisio`, las rutas absolutas y los
  enlaces que salgan del espacio de trabajo. Una ruta con espacios requiere la forma de herramienta.
  L0 no admite una especificación (no tiene fase de especificación).
- El archivo se copia a `docs/frontsmith//source-spec.md` (o `.json`) y se calcula su hash;
  editar luego el original no cambia la ejecución. La copia está protegida: si cambia, las unidades
  que la usan quedan en `BLOCKED`.
- El Markdown pasa a `fs-specifier`, que lo normaliza en el sobre de especificación: nada se descarta
  en silencio, las afirmaciones de implementación pasan a ser supuestos, y las ambigüedades,
  contradicciones y pendientes (TBD) pasan a ser preguntas abiertas que bloquean la compuerta G1
  hasta que usted las responda.
- Un archivo `.json` que ya es un sobre de especificación válido omite solo la ejecución del
  especificador. La compuerta G1 sigue ejecutándose y la aprobación de la especificación sigue
  aplicando desde L1. No se puede combinar con L0.

## Niveles de rigor

| Nivel | Para | Fases | Aprobaciones humanas |
| --- | --- | --- | --- |
| L0 trivial | Un error tipográfico, un texto o un ajuste local | intake, context, build, validate, review | ninguna |
| L1 funcionalidad pequeña | Un cambio acotado | agrega specify y un plan de tareas | especificación |
| L2 funcionalidad de producto | Una funcionalidad normal | todas las fases | especificación, contrato de UI, plan, aceptación |
| L3 alto riesgo | Seguridad, privacidad o impacto amplio | como L2, dos revisiones, un registro de decisión y un riesgo de seguridad o privacidad | L2 más una conformidad de revisión |

Los modos son `build` (por defecto), `replicate`, `refine` y `redesign`; `replicate` requiere al
menos un archivo de referencia en el contrato de UI.

## Comandos

Todos los comandos son `/frontsmith:` y devuelven una línea de uso cuando un argumento es
incorrecto.

| Comando | Argumentos | Propósito |
| --- | --- | --- |
| `init` | | Crear la configuración del proyecto y la entrada de gitignore |
| `doctor` | | Comprobar lo que necesita una ejecución |
| `new` | ` [--level L0-L3] [--mode ...] [--from-spec ] -- ` | Crear una funcionalidad, opcionalmente desde un archivo de especificación |
| `status` | `[feature]` | Mostrar una funcionalidad o listarlas |
| `next` | ` [--foreground]` | Ejecutar la siguiente unidad |
| `answer` | `  -- ` | Responder una pregunta abierta |
| `approve` | ` spec\|ui-contract\|plan\|acceptance\|config\|review-signoff\|dependency ` | Registrar una aprobación humana |
| `reject` | ` spec\|ui-contract\|plan\|acceptance -- ` | Devolver los comentarios a la fase que produjo el artefacto |
| `waive` | `   --until  -- ` | Eximir una regla en ciertas rutas hasta una fecha |
| `verify-manual` | `  -- ` | Registrar evidencia manual de un criterio |
| `stop` | `` | Cancelar el trabajo en curso |
| `resume` | `` | Volver a ejecutar una unidad interrumpida |
| `check` | `  [--task T-001]` | Ejecutar una compuerta de forma puntual |
| `rules` | `list [pack] \| explain  \| test  \| promote ` | Consultar y gestionar reglas |
| `arch` | `init [preset] \| check` | Configuración de arquitectura |
| `tokens` | `check \| generate --family ` | Verificar tokens o generar una paleta |
| `fidelity` | `run  [cases] \| calibrate ` | Ejecución y calibración de fidelidad visual |
| `baseline` | `approve  [caseId] \| list ` | Aprobar capturas revisadas como líneas base |
| `budget` | `check \| baseline` | Presupuestos de rendimiento |
| `models` | `[check \| set \| unset \| reset \| pick \| explain]` | Configuración de modelos por agente |
| `dashboard` | `[feature]` | Imprimir la URL del panel de revisión local |

## Herramientas

| Herramienta | Efecto | Propósito |
| --- | --- | --- |
| `fs_status` | lectura | Fase, compuertas, tareas y siguiente comando, o la lista de funcionalidades; con una funcionalidad añade una vista JSON para el coordinador |
| `fs_feature_new` | escritura | Crear una funcionalidad (opcionalmente desde un archivo de especificación); la persona elige el nivel en un diálogo |
| `fs_answer` | escritura | Retransmitir una respuesta; se registra solo tras la confirmación de la persona en un diálogo |
| `fs_approval_request` | escritura | Abrir el diálogo aprobar/rechazar de la aprobación que corresponde en ese momento (nunca `config`) |
| `fs_next` | proceso | Avanzar una unidad: se detiene en las compuertas humanas; las unidades con agentes hijos inician trabajos en segundo plano |
| `fs_detect_stack` | lectura | Gestor de paquetes, framework, estilos y pruebas, con evidencia |
| `fs_inventory` | lectura | Componentes, hooks, almacenes y tokens de diseño |
| `fs_rules_list` | lectura | Reglas activas, con su trazado de resolución |
| `fs_rules_check` | lectura | Ejecutar los paquetes de reglas sobre el espacio de trabajo |
| `fs_architecture_check` | lectura | Verificar las importaciones contra `.frontsmith/architecture.json` |
| `fs_tokens_check` | lectura | Verificar tokens, temas y pares de contraste requeridos |
| `fs_contrast` | lectura | Contraste WCAG 2.2 de pares de colores |
| `fs_palette_generate` | lectura | Paleta determinista a partir del catálogo curado |
| `fs_models` | lectura | El modelo y la capa de origen de cada agente |
| `fs_gate_run` | proceso | Ejecutar una compuerta y devolver su informe |
| `fs_phase_run` | proceso | Ejecutar la siguiente unidad en el bucle del agente, con progreso |
| `fs_budget_check` | proceso | Verificar presupuestos, con compilación previa opcional |
| `fs_fidelity_run` | proceso | Medir y comparar la funcionalidad renderizada |
| `fs_a11y_run` | proceso | Verificaciones de accesibilidad en ejecución (axe-core) |

## Configuración

`.frontsmith/config.json` es opcional salvo por `schemaVersion`; las claves desconocidas se rechazan
con un diagnóstico que indica el puntero JSON. En `schemas/` se incluye un esquema JSON para los
editores.

```json
{
  "schemaVersion": 1,
  "paths": {
    "artifacts": "docs/frontsmith",
    "sourceRoots": ["src"],
    "themeOutput": "src/styles/frontsmith-tokens.css",
    "tokenFiles": ["src/styles/**/*.css"]
  },
  "defaults": { "level": "L2", "mode": "build" },
  "commands": {
    "typecheck": ["pnpm", "typecheck"],
    "lint": ["pnpm", "lint"],
    "test": ["pnpm", "test"],
    "testRelated": ["pnpm", "vitest", "related", "--run", "{files}"],
    "build": ["pnpm", "build"]
  },
  "accessibility": { "target": "AA" },
  "fidelity": {
    "baseUrl": "http://127.0.0.1:5173",
    "serve": {
      "command": ["pnpm", "dev", "--port", "5173", "--strictPort"],
      "readyUrl": "http://127.0.0.1:5173/",
      "timeoutMs": 60000
    }
  },
  "limits": { "maxBounces": 2, "maxRepairRounds": 3, "maxRemediations": 2 },
  "dashboard": { "enabled": true }
}
```

Los comandos son arreglos argv, nunca cadenas de shell. Los comandos que faltan se infieren de los
scripts de `package.json` y se informan con su origen. `defaults.level` solo preselecciona la opción
interactiva; un `new` sin interfaz sigue necesitando `--level`. Los archivos de `.frontsmith/` están
protegidos: una sesión hija que los modifique genera un bloqueo hasta que una persona ejecute
`/frontsmith:approve  config`.

## Configuración de modelos

![Resolución de modelos: se revisan cuatro capas en orden antes de aplicar el nivel por defecto del agente](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/model-resolution.svg)

Cada agente tiene un nivel (`reasoning`, `standard`, `fast`) y cada nivel vale `inherit` por defecto,
lo que usa el modelo de su sesión. El plugin no puede conocer sus proveedores, por lo que asignar
modelos le corresponde a usted. Se aplican cinco capas, de mayor a menor prioridad: una sustitución en
tiempo de ejecución (`/frontsmith:models set`), un bloque delimitado en el `AGENTS.md` del proyecto,
la clave `models` de `.frontsmith/config.json`, las opciones del plugin en el host y el valor por
defecto. El esfuerzo de razonamiento no forma parte del contrato de sesiones hijas del host, por lo
que solo se asignan modelos.

````markdown
```frontsmith-models
tier.reasoning = openrouter/anthropic/claude-opus-4.1
tier.standard  = inherit
tier.fast      = openrouter/google/gemini-2.5-flash
agent.fs-reviewer    = @reasoning
agent.fs-implementer = openai/gpt-5-codex
```
````

`/frontsmith:models` muestra el modelo efectivo y la capa que lo produjo para cada agente,
`/frontsmith:models check` valida cada selector con el host y una capa inválida falla de forma
cerrada con un diagnóstico que la nombra.

## Paquetes de reglas

![Los paquetes se activan por stack y nivel, se combinan por precedencia, se validan y luego se evalúan](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/rule-packs.svg)

Las reglas son datos: paquetes JSON evaluados por un conjunto cerrado de 20 motores. Se incluyen
quince paquetes con 130 reglas (91 deterministas y 39 orientativas): accesibilidad, arquitectura,
componentes, CSS, Tailwind, tokens, rendimiento, pruebas, gobernanza, heurísticas de diseño y los
paquetes de framework para React, Next.js, Vue, Svelte y Angular. Un proyecto agrega paquetes en
`.frontsmith/packs//pack.json`, extiende o reemplaza reglas incluidas con una justificación y
silencia una regla menor en una línea:

```css
/* frontsmith-disable-next-line FS-TOK-002 -- legacy spacing scale kept until the redesign */
```

Las reglas de severidad bloqueante o mayor no se pueden silenciar; una exención humana
(`/frontsmith:waive`) con fecha de vencimiento las cubre. `alisio-frontsmith check` y
`/frontsmith:rules list|explain|test|promote` permiten consultarlas.

## Presets de arquitectura

`/frontsmith:arch init [preset]` escribe `.frontsmith/architecture.json` a partir de uno de cuatro
presets: `feature-sliced`, `hexagonal`, `layered` o `atomic`. La verificación informa direcciones de
capa prohibidas, importaciones entre segmentos, importaciones que eluden una API pública, ciclos
(cada uno se informa una vez con sus miembros), violaciones de rol y archivos sin asignar, y resuelve
las rutas de `tsconfig` y los `imports` del paquete. Un catálogo de 18 patrones está disponible para
el arquitecto, cada uno verificado por reglas incluidas cuando es posible.

## Fidelidad visual

![El ciclo de fidelidad: medir, comparar regiones, reparar hasta tres rondas y luego aceptar o fallar](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/fidelity-loop.svg)

El proceso renderiza la funcionalidad real en Chromium en las ventanas del contrato de UI y mide los
elementos renderizados contra el contrato; luego compara regiones con líneas base aprobadas por una
persona. Informa defectos locales que una única puntuación global ocultaría. Las líneas base las
aprueba una persona (`/frontsmith:baseline approve`, nunca durante la aceptación) y solo son válidas
para la versión de navegador y el sistema operativo registrados. `/frontsmith:fidelity calibrate`
repite capturas sin cambios e inyecta defectos conocidos para derivar umbrales; mientras una región no
esté calibrada su resultado es `REVIEW`, nunca `PASS`. Sin Playwright, navegador, línea base u
oráculo calibrado, la verificación queda `BLOCKED`.

## Estado y reanudación

![Estados de una funcionalidad: fases con aprobaciones humanas, más los estados bloqueado e interrumpido](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/feature-states.svg)

El estado vive en `docs/frontsmith//` y `.frontsmith/`; las escrituras son atómicas y solo se
ejecuta un trabajo por funcionalidad a la vez. Tras reiniciar el host, un intento que estaba en
ejecución pasa a `interrupted` y `/frontsmith:resume ` vuelve a ejecutar esa unidad desde su
inicio. El estado escrito por una versión más nueva de Frontsmith es de solo lectura.

## TUI y web

Los comandos devuelven Markdown con encabezados, listas, tablas y enlaces; las herramientas devuelven
primero un resumen de texto, luego el bloque principal de esa herramienta y después la imagen
principal. Las aprobaciones humanas se preguntan mediante la interfaz de preguntas del host con la
opción recomendada marcada y, cuando nadie puede responder, la salida muestra el comando exacto que
se debe ejecutar. La TUI también muestra la fase y el trabajo en curso en su pie.

`/frontsmith:dashboard [feature]` inicia un panel de revisión en `127.0.0.1` con un tablero de
compuertas, las composiciones de fidelidad (referencia, resultado y diferencia lado a lado), las
reglas activas y botones para aprobar, rechazar y fijar líneas base. Usa un token aleatorio por
ejecución que se intercambia por una cookie, verifica los encabezados `Host` y `Origin`, aplica una
Content-Security-Policy estricta y exige el token en un encabezado para cada cambio. Es opcional
(`dashboard.enabled`) y solo es accesible desde la máquina que ejecuta Alisio; desde un cliente web
remoto use las vistas previas del Dock y las imágenes de las herramientas.

## CLI e integración continua

`alisio-frontsmith` ejecuta la parte determinista sin una sesión: `detect`, `check`, `arch`,
`tokens`, `contrast`, `palette`, `models`, `gate`, `fidelity`, `budget` y `doctor`. Las compuertas que
necesitan agentes informan esas verificaciones como omitidas. Códigos de salida: `0` PASS, `1` FAIL,
`2` error de uso o de entorno, `3` BLOCKED, `4` solo REVIEW; `--json` imprime el informe legible por
máquina.

```sh
npx alisio-frontsmith check . --json
npx alisio-frontsmith gate login-form G7 . --json
```

## Arquitectura

![Interfaz, aplicación, dominio e infraestructura; las dependencias apuntan hacia adentro](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/architecture.svg)

Los comandos, las herramientas, la CLI y el panel son capas finas sobre una única fachada de
servicios, de modo que no pueden divergir. Las dependencias apuntan hacia adentro: el dominio no
importa nada de Node ni del host, y el paquete ejecuta su propio verificador de arquitectura sobre sus
fuentes en una prueba.

## Seguridad

- Los identificadores se validan y las rutas se contienen dentro del espacio de trabajo; se rechazan
  los escapes mediante enlaces simbólicos.
- No se usa shell en ningún lugar: los comandos del proyecto son arreglos argv con tiempos límite,
  topes de salida y entorno depurado, y nunca se ejecutan mientras un archivo protegido esté alterado.
- La salida de las sesiones hijas no es confiable: sobres estrictos, topes de tamaño, claves
  desconocidas rechazadas, nunca se ejecuta ni se muestra como HTML.
- La sonda del navegador solo visita el `baseUrl` de loopback configurado y bloquea otros orígenes a
  menos que el contrato los enumere. La evidencia permanece en `.alisio/frontsmith/`, que git ignora.
- El panel se enlaza solo a loopback y protege cada solicitud como se describió antes.

## Limitaciones

- Versión preliminar: véase «Estado» para lo que solo se verificó con dobles.
- Las listas de herramientas declaradas del coordinador aún no las respeta el host para agentes
  principales (véase «Coordinador conversacional»).
- Los agentes personalizados están planificados, no entregados. La clave `agents.custom` se acepta
  para que las asignaciones de modelo ya puedan nombrar un agente, pero en esta versión no se carga
  ni se ejecuta ningún agente personalizado.
- El JavaScript con anotaciones de Flow no se analiza; los archivos que no se pueden analizar se
  informan para revisión y se omiten.
- Las verificaciones de número de líneas del proceso de fidelidad son aproximadas y resultan en
  `REVIEW`.
- Las líneas base no son portables entre versiones de navegador ni sistemas operativos.

## Licencia

MIT
