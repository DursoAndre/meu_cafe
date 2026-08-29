const METHODS = ["v60", "french_press"];
const DOSES = [10, 15, 30];
const ROASTS = [
  "light",
  "medium-light",
  "medium",
  "medium-dark",
  "dark",
  "unknown",
];
const GRINDS = ["fine", "medium-fine", "medium", "medium-coarse", "coarse"];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, keys, path, errors) {
  if (!object(value)) {
    errors.push(`${path} deve ser um objeto.`);
    return false;
  }
  keys.forEach((key) => {
    if (!(key in value)) errors.push(`${path}.${key} é obrigatório.`);
  });
  Object.keys(value).forEach((key) => {
    if (!keys.includes(key)) errors.push(`${path}.${key} não é permitido.`);
  });
  return true;
}

function text(value, path, errors, max, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} deve ser texto não vazio${nullable ? " ou null" : ""}.`);
  } else if (value.length > max) {
    errors.push(`${path} excede ${max} caracteres.`);
  }
}

function textList(value, path, errors, maxItems = 20) {
  if (!Array.isArray(value)) {
    errors.push(`${path} deve ser uma lista.`);
    return;
  }
  if (value.length > maxItems) errors.push(`${path} aceita no máximo ${maxItems} itens.`);
  value
    .slice(0, maxItems + 1)
    .forEach((item, index) => text(item, `${path}[${index}]`, errors, 300));
}

function integer(value, path, errors, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${path} deve ser inteiro entre ${min} e ${max}.`);
  }
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validateCoffee(coffee, errors) {
  const keys = [
    "name",
    "roaster",
    "producer",
    "farm",
    "country",
    "region",
    "variety",
    "altitude_m",
    "process",
    "roast_profile",
    "roast_date",
    "official_sensory_notes",
    "roaster_brew_instructions",
  ];
  if (!exact(coffee, keys, "coffee", errors)) return;
  text(coffee.name, "coffee.name", errors, 160);
  ["roaster", "producer", "farm", "country", "region", "variety", "process"].forEach(
    (key) => text(coffee[key], `coffee.${key}`, errors, 160, true),
  );
  if (
    coffee.altitude_m !== null &&
    (typeof coffee.altitude_m !== "number" ||
      coffee.altitude_m < 0 ||
      coffee.altitude_m > 5000)
  ) {
    errors.push("coffee.altitude_m deve ser número entre 0 e 5000 ou null.");
  }
  if (coffee.roast_profile !== null && !ROASTS.includes(coffee.roast_profile)) {
    errors.push("coffee.roast_profile é inválido.");
  }
  if (
    coffee.roast_date !== null &&
    (typeof coffee.roast_date !== "string" || !validDate(coffee.roast_date))
  ) {
    errors.push("coffee.roast_date deve usar uma data real em YYYY-MM-DD ou null.");
  }
  textList(coffee.official_sensory_notes, "coffee.official_sensory_notes", errors);
  text(
    coffee.roaster_brew_instructions,
    "coffee.roaster_brew_instructions",
    errors,
    3000,
    true,
  );
}

function validateAnalysis(analysis, errors) {
  const keys = ["summary", "expected_cup_profile", "confidence", "uncertainties"];
  if (!exact(analysis, keys, "analysis", errors)) return;
  text(analysis.summary, "analysis.summary", errors, 1500);
  text(analysis.expected_cup_profile, "analysis.expected_cup_profile", errors, 1500);
  if (!["high", "medium", "low"].includes(analysis.confidence)) {
    errors.push("analysis.confidence deve ser high, medium ou low.");
  }
  textList(analysis.uncertainties, "analysis.uncertainties", errors);
}

function validateEquipment(equipment, errors) {
  const keys = ["v60_size", "french_press_capacity_ml"];
  if (!exact(equipment, keys, "equipment_assumptions", errors)) return;
  if (equipment.v60_size !== "02") {
    errors.push('equipment_assumptions.v60_size deve ser "02".');
  }
  integer(
    equipment.french_press_capacity_ml,
    "equipment_assumptions.french_press_capacity_ml",
    errors,
    550,
    650,
  );
}

function validateRecommendation(recommendation, errors) {
  const keys = ["method", "dose_g", "reason", "caveats"];
  if (!exact(recommendation, keys, "recommendation", errors)) return;
  if (!METHODS.includes(recommendation.method)) {
    errors.push("recommendation.method é inválido.");
  }
  if (![10, 15].includes(recommendation.dose_g)) {
    errors.push("recommendation.dose_g deve ser 10 ou 15.");
  }
  text(recommendation.reason, "recommendation.reason", errors, 1500);
  textList(recommendation.caveats, "recommendation.caveats", errors, 10);
}

function validateRecipe(recipe, index, errors) {
  const path = `recipes[${index}]`;
  const keys = [
    "method",
    "dose_g",
    "water_g",
    "ratio",
    "temperature_c",
    "grind",
    "total_time_seconds",
    "steps",
    "rationale",
    "capacity_warning",
  ];
  if (!exact(recipe, keys, path, errors)) return;
  if (!METHODS.includes(recipe.method)) errors.push(`${path}.method é inválido.`);
  if (!DOSES.includes(recipe.dose_g)) errors.push(`${path}.dose_g é inválido.`);
  integer(recipe.water_g, `${path}.water_g`, errors, 120, 540);
  if (typeof recipe.ratio !== "number" || recipe.ratio < 12 || recipe.ratio > 18) {
    errors.push(`${path}.ratio deve estar entre 12 e 18.`);
  } else if (
    Number.isInteger(recipe.water_g) &&
    DOSES.includes(recipe.dose_g) &&
    Math.abs(recipe.water_g / recipe.dose_g - recipe.ratio) > 0.15
  ) {
    errors.push(`${path}.ratio não corresponde a água ÷ dose.`);
  }
  integer(recipe.temperature_c, `${path}.temperature_c`, errors, 80, 100);
  integer(recipe.total_time_seconds, `${path}.total_time_seconds`, errors, 60, 900);
  text(recipe.rationale, `${path}.rationale`, errors, 1200);
  if (typeof recipe.capacity_warning !== "boolean") {
    errors.push(`${path}.capacity_warning deve ser booleano.`);
  }
  if (
    recipe.method === "v60" &&
    recipe.dose_g === 30 &&
    recipe.water_g >= 450 &&
    recipe.capacity_warning !== true
  ) {
    errors.push(`${path} deve alertar a capacidade do V60 02.`);
  }
  if (
    recipe.method === "french_press" &&
    recipe.water_g >= 500 &&
    recipe.capacity_warning !== true
  ) {
    errors.push(`${path} deve alertar a capacidade da prensa.`);
  }

  if (
    exact(
      recipe.grind,
      ["relative", "grinder_setting"],
      `${path}.grind`,
      errors,
    )
  ) {
    if (!GRINDS.includes(recipe.grind.relative)) {
      errors.push(`${path}.grind.relative é inválido.`);
    }
    text(
      recipe.grind.grinder_setting,
      `${path}.grind.grinder_setting`,
      errors,
      160,
      true,
    );
  }

  if (!Array.isArray(recipe.steps) || recipe.steps.length < 2 || recipe.steps.length > 12) {
    errors.push(`${path}.steps deve conter entre 2 e 12 passos.`);
    return;
  }
  let previousTime = -1;
  let previousWater = -1;
  let reachesTotal = false;
  recipe.steps.forEach((step, stepIndex) => {
    const stepPath = `${path}.steps[${stepIndex}]`;
    if (!exact(step, ["at_seconds", "action", "target_total_water_g"], stepPath, errors)) {
      return;
    }
    integer(step.at_seconds, `${stepPath}.at_seconds`, errors, 0, 900);
    if (Number.isInteger(step.at_seconds) && step.at_seconds < previousTime) {
      errors.push(`${stepPath}.at_seconds deve ser crescente.`);
    }
    if (Number.isInteger(step.at_seconds)) previousTime = step.at_seconds;
    text(step.action, `${stepPath}.action`, errors, 300);
    if (step.target_total_water_g !== null) {
      integer(step.target_total_water_g, `${stepPath}.target_total_water_g`, errors, 0, 540);
      if (step.target_total_water_g < previousWater) {
        errors.push(`${stepPath}.target_total_water_g deve ser cumulativo.`);
      }
      if (step.target_total_water_g > recipe.water_g) {
        errors.push(`${stepPath}.target_total_water_g excede water_g.`);
      }
      if (step.target_total_water_g === recipe.water_g) reachesTotal = true;
      if (Number.isInteger(step.target_total_water_g)) {
        previousWater = step.target_total_water_g;
      }
    }
  });
  if (!reachesTotal) errors.push(`${path}.steps deve atingir water_g.`);
  if (previousTime > recipe.total_time_seconds) {
    errors.push(`${path}.total_time_seconds deve ocorrer após o último passo.`);
  }
}

export function validateCoffeeImport(value) {
  const errors = [];
  const rootKeys = [
    "schema_version",
    "coffee",
    "analysis",
    "equipment_assumptions",
    "recommendation",
    "recipes",
  ];
  if (!exact(value, rootKeys, "root", errors)) return { valid: false, errors };
  if (value.schema_version !== "1.0.0") {
    errors.push('schema_version deve ser "1.0.0".');
  }
  validateCoffee(value.coffee, errors);
  validateAnalysis(value.analysis, errors);
  validateEquipment(value.equipment_assumptions, errors);
  validateRecommendation(value.recommendation, errors);

  if (!Array.isArray(value.recipes) || value.recipes.length !== 6) {
    errors.push("recipes deve conter exatamente seis receitas.");
  } else {
    value.recipes.forEach((recipe, index) => validateRecipe(recipe, index, errors));
    const found = value.recipes.map((recipe) =>
      object(recipe) ? `${recipe.method}:${recipe.dose_g}` : "invalid",
    );
    const expected = METHODS.flatMap((method) => DOSES.map((dose) => `${method}:${dose}`));
    if (new Set(found).size !== 6 || expected.some((pair) => !found.includes(pair))) {
      errors.push("recipes deve conter cada combinação de método e dose uma única vez.");
    }
  }
  if (
    object(value.recommendation) &&
    Array.isArray(value.recipes) &&
    !value.recipes.some(
      (recipe) =>
        object(recipe) &&
        recipe.method === value.recommendation.method &&
        recipe.dose_g === value.recommendation.dose_g,
    )
  ) {
    errors.push("recommendation deve apontar para uma receita existente.");
  }
  return { valid: errors.length === 0, errors };
}

