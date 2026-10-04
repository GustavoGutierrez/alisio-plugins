# Ejemplo: trabajo de grado en español (Colombia) sobre agentes de IA para licitaciones

Guía práctica para usar `@alisio/plugin-thesis` en un trabajo de grado escrito en español para una
universidad colombiana. Tema: **creación de agentes de inteligencia artificial como arnés para la
preparación de propuestas de licitación pública en Colombia y de los documentos profesionales que
las acompañan**.

Las respuestas sugeridas son un punto de partida; ajústelas a lo que exija su programa.

## 1. Preparar el entorno

```bash
alisio install npm:@alisio/plugin-thesis@0.1.0
mkdir tesis-licitaciones-ia && cd tesis-licitaciones-ia
git init
```

Dentro de Alisio, en esa carpeta:

```
/thesis:doctor     # revisa los motores disponibles (Typst, Chrome)
/thesis:setup      # instala Typst 0.15.1 verificado, solo si doctor no lo encuentra
```

## 2. Entrevista inicial

```
/thesis:init --lang es-CO
```

| Pregunta | Respuesta sugerida |
|---|---|
| Idioma | Español (`es-CO`) |
| Tipo de trabajo | Trabajo de grado de pregrado (o tesis de maestría, según su caso) |
| País | Colombia |
| Resumen en segundo idioma | Sí, inglés |
| Institución | Su universidad, facultad y programa |
| Estilo de citas | "Que lo decida la política" o el que exija su programa. ICONTEC está disponible como estilo provisional y el plugin lo advierte. |
| Dominio | Ingeniería / Ciencias de la computación |
| Enfoque | `design_science`: el arnés de agentes es un artefacto que se diseña, construye y evalúa |
| Título | Propio, o "Proponer tres títulos a partir del tema" |
| Paleta / papel / tipografía | Okabe-Ito, Carta, Serif |

Texto sugerido para la pregunta de **tema y problema**:

> La preparación de propuestas para procesos de contratación pública en Colombia exige revisar
> pliegos de condiciones extensos y producir documentos habilitantes, técnicos y económicos en
> plazos cortos; los errores de forma y los requisitos omitidos causan rechazos. El trabajo propone
> diseñar y evaluar un arnés de agentes de inteligencia artificial que asista en el análisis de
> pliegos publicados en SECOP II, la verificación de requisitos habilitantes y la redacción de
> documentos profesionales de la propuesta, con trazabilidad de cada afirmación a su fuente y
> supervisión humana obligatoria.

Para el objetivo general y la justificación puede elegir "Redactarlo con el metodólogo".

## 3. Diseño de la investigación

```
/thesis:design
```

El metodólogo propone problema, pregunta, objetivos, justificación y metodología. Para orientarlo
antes de aprobar:

```
/thesis:revise A -- Usar design science research (Hevner; Peffers et al.): 1) caracterizar el proceso de licitación y sus puntos de falla, 2) definir requisitos del arnés (roles de agentes, trazabilidad, control humano), 3) construir un prototipo, 4) evaluarlo con pliegos reales de SECOP II midiendo requisitos detectados, errores y tiempo frente a la preparación manual.
/thesis:revise B -- Incluir limitaciones éticas y de responsabilidad: la IA asiste, no firma ni presenta propuestas; tratamiento de datos personales según la Ley 1581 de 2012.
```

`A` cubre tema, problema, pregunta y objetivos; `B` cubre metodología, ética y alcance.

Objetivos específicos de ejemplo (verbos verificables):

1. **Caracterizar** las etapas y requisitos documentales de los procesos de selección en Colombia.
2. **Diseñar** la arquitectura de un arnés multiagente con trazabilidad y puntos de aprobación humana.
3. **Implementar** un prototipo que analice pliegos y genere borradores de documentos de la propuesta.
4. **Evaluar** su desempeño frente a la preparación manual en un conjunto de procesos reales.

Aprobar:

```
/thesis:approve A
/thesis:approve B
```

## 4. Índice del documento

```
/thesis:outline
/thesis:revise OUTLINE -- Capítulos: marco normativo de la contratación pública colombiana; estado del arte en agentes LLM, RAG y orquestación multiagente; generación de documentos profesionales y verificación de requisitos; metodología DSR; diseño del arnés; implementación; evaluación; discusión (riesgos, sesgos, responsabilidad, Ley 1581); conclusiones.
```

Revise `thesis/outline/outline.md` y apruebe:

```
/thesis:approve OUTLINE
```

## 5. Investigar y redactar por sección

```
/thesis:research next      # investiga la siguiente sección
                           # lea el resumen en thesis/evidence/dossiers/
/thesis:approve SEC-02     # aprueba la investigación de esa sección
/thesis:draft SEC-02       # redacta solo con evidencia aprobada
/thesis:approve SEC-02     # aprueba la sección redactada
/thesis:build approved     # PDF parcial con lo aprobado
```

Para pedir más búsqueda sobre un tema:

```
/thesis:research SEC-03 -- buscar más sobre retrieval-augmented generation para cumplimiento normativo
```

### Normas para el marco normativo

Agréguelas como fuentes propias para que se clasifiquen como fuente primaria. Deben provenir de un
dominio oficial (`gov.co`). Formato: `URL; título; año; tipo`.

```
/thesis:research SEC-02 -- add <URL oficial>; Ley 80 de 1993, Estatuto General de Contratación de la Administración Pública; 1993; law
```

Normas a considerar (confirme la vigencia y la URL oficial de cada una):

- Ley 80 de 1993 (Estatuto General de Contratación de la Administración Pública).
- Ley 1150 de 2007.
- Decreto 1082 de 2015.
- Ley 1882 de 2018 (documentos tipo).
- Ley 1581 de 2012 (protección de datos personales).
- Guías y documentos tipo de Colombia Compra Eficiente.
- Documentos CONPES sobre inteligencia artificial.

### Fuentes académicas

El bibliotecario busca en OpenAlex, Crossref y arXiv. Puede orientarlo con términos en español e
inglés, por ejemplo: "LLM agents document generation", "retrieval-augmented generation compliance",
"public procurement artificial intelligence".

### Figuras y tablas

Coloque los datos de evaluación como CSV en `thesis/data/` (por ejemplo `thesis/data/evaluacion.csv`).

```
/thesis:figure SEC-05 -- Diagrama de la arquitectura del arnés: agente analista de pliegos, agente verificador de requisitos habilitantes, agente redactor, revisor humano y fuente SECOP II.
/thesis:figure SEC-07 -- Gráfica de barras que compare requisitos detectados y tiempo por propuesta, manual frente al arnés, a partir de data/evaluacion.csv.
```

Los números de sección (`SEC-05`, `SEC-07`) dependen de su índice; consúltelos con `/thesis:status`.

## 6. Cierre

```
/thesis:check              # comprobaciones deterministas (G0–G10)
/thesis:review all         # revisión independiente tipo jurado
/thesis:revise FND-0001 -- <respuesta o corrección>   # por cada hallazgo
/thesis:finalize           # puerta humana C, PDF/A y paquete en build/submission/
```

## Recomendaciones

- **Ética y datos.** Si usa pliegos o propuestas con datos personales, o entrevista a personas,
  responda "sí" en el cuestionario de ética. El plugin pedirá resolver el consentimiento (Ley 1581
  de 2012) y nunca lo dará por innecesario.
- **Uso de IA.** Si su universidad exige declararlo, el plugin no permite finalizar sin la
  declaración. Usted es el autor y debe validar cada sección.
- **Reglas de su universidad.** Si tiene la guía de trabajos de grado, impórtela para que sus reglas
  prevalezcan sobre los valores por defecto:

  ```
  /thesis:norms import -- <texto de la guía, URL o ruta>
  ```

  Si su programa usa un formato de citas propio, genérelo con `/thesis:style new <id> -- <guía>`.
- **Seguimiento.** `/thesis:status` muestra el estado y el siguiente comando; `/thesis:next` ejecuta
  el siguiente paso recomendado.
