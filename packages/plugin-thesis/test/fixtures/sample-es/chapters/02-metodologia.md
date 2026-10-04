---
section: SEC-02
---

# Metodología {#sec-metodologia}

El valor medio de errores por documento se calcula como

$$
\bar{x} = \frac{1}{n} \sum_{i=1}^{n} x_i
$$ {#eq-media}

donde $x_i$ es el número de errores del documento $i$. El flujo de trabajo se muestra en @fig-flujo
y los resultados de la comparación en @tbl-resultados.

![Flujo de verificación y generación. Fuente: elaboración propia.](figures/diagrams/flujo.mmd){#fig-flujo width=70%}

| Tipo de fuente | Documentos | Errores (%) |
|:---------------|-----------:|------------:|
| Artículo       |         42 |         3.1 |
| Libro          |         17 |         5.8 |
| Norma          |          9 |         0.0 |

Table: Errores de citación por tipo de fuente. Fuente: elaboración propia. {#tbl-resultados}

La comparación entre el método manual y el automático se resume en @fig-errores.

![Errores de citación por tipo de fuente y método. Fuente: elaboración propia.](figures/charts/errores.vl.json){#fig-errores}

## Criterios de selección {#sec-criterios}

- Fuentes verificadas contra Crossref o un dominio oficial.
- Registros sin retractación.

1. Buscar.
2. Verificar.
3. Redactar.
