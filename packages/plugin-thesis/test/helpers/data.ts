import type { OutlineNodeDraft } from "../../src/schemas.js";

export const ethicsNo = {
  human_participants: false,
  minors: false,
  identifiable_personal_data: false,
  sensitive_data: false,
  intervention: false,
  risk_above_minimal: false,
  biological_samples: false,
  animals: false,
  communities: false,
  clinical_research: false,
  additional_institutional_rules: false,
};

export function protocolDraft(over: Record<string, unknown> = {}) {
  return {
    problem: "Los estudiantes citan fuentes que no existen o no respaldan sus afirmaciones.",
    researchQuestions: ["¿Cómo verificar automáticamente las referencias de una tesis?"],
    generalObjective:
      "Desarrollar un flujo que verifique automáticamente la evidencia bibliográfica de una tesis.",
    specificObjectives: [
      {
        verb: "diseñar",
        object: "un modelo de evidencia verificable",
        deliverable: "esquema de registro de evidencia",
      },
      {
        verb: "implementar",
        object: "la verificación contra Crossref y OpenAlex",
        deliverable: "módulo de verificación con pruebas",
      },
      {
        verb: "evaluar",
        object: "la precisión de la verificación",
        deliverable: "informe de precisión sobre un corpus de prueba",
      },
    ],
    justification: {
      relevance: "La integridad de las citas es un requisito académico.",
      novelty: "Combina verificación determinista con asistencia de modelos.",
      feasibility: "Usa APIs abiertas y herramientas estándar.",
      beneficiaries: "Estudiantes, asesores y comités.",
    },
    scope: "Tesis de grado en español con citas en APA.",
    limitations: ["Solo fuentes con DOI o dominio oficial."],
    hypotheses: [],
    methodology: {
      design: "Ciencia del diseño con evaluación experimental.",
      population: "Corpus de 200 referencias reales y 50 inventadas.",
      instruments: ["Scripts de verificación"],
      analysisPlan: "Precisión, exhaustividad y errores por tipo.",
      reportingGuideline: null,
    },
    ethics: { ...ethicsNo },
    openQuestions: [],
    ...over,
  };
}

const node = (
  key: string,
  title: string,
  objectives: string[],
  extra: Partial<OutlineNodeDraft> = {},
): OutlineNodeDraft => ({
  key,
  title,
  purpose: `Propósito de ${title}.`,
  objectives,
  researchTopics: [`tema de ${title}`],
  questionsToAnswer: [`¿Qué debe decir ${title}?`],
  evidenceNeeds: ["theoretical"],
  targetWords: 600,
  dependsOn: [],
  children: [],
  ...extra,
});

/** An outline that satisfies the shipped global pack for a Colombian master's thesis. */
export function outlineDraft(): { sections: OutlineNodeDraft[] } {
  return {
    sections: [
      node("resumen", "Resumen", ["OBJ-G"], { requiredKey: "resumen" }),
      node("abstract", "Abstract", ["OBJ-G"], { requiredKey: "abstract" }),
      node("declaracion-ia", "Declaración de uso de IA", [], { requiredKey: "ai_declaration" }),
      node("introduccion", "Introducción", ["OBJ-G"], { requiredKey: "introduccion" }),
      node("problema", "Planteamiento del problema", ["OBJ-G"], {
        requiredKey: "planteamiento_del_problema",
      }),
      node("objetivos", "Objetivos", ["OBJ-G", "OBJ-01", "OBJ-02", "OBJ-03"], {
        requiredKey: "objetivos",
      }),
      node("marco", "Marco teórico", ["OBJ-01"], {
        requiredKey: "marco_teorico",
        researchTopics: ["verificación de referencias", "integridad de citas"],
        children: [node("marco-verificacion", "Verificación de referencias", ["OBJ-01"])],
      }),
      node("metodologia", "Metodología", ["OBJ-02"], {
        requiredKey: "metodologia",
        dependsOn: ["marco"],
      }),
      node("resultados", "Resultados", ["OBJ-03"], {
        requiredKey: "resultados",
        dependsOn: ["metodologia"],
      }),
      node("discusion", "Discusión", ["OBJ-03"], {
        requiredKey: "discusion",
        dependsOn: ["resultados"],
      }),
      node("conclusiones", "Conclusiones", ["OBJ-G"], {
        requiredKey: "conclusiones",
        dependsOn: ["resultados", "discusion"],
      }),
      node("referencias", "Referencias", [], { requiredKey: "referencias" }),
    ],
  };
}

export const json = (value: unknown) => JSON.stringify(value);
export const fenced = (value: unknown) => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
