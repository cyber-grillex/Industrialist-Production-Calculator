/**
 * Simple-mode chain engine.
 *
 * Given a target product and a desired rate, it walks the recipe graph backwards
 * and answers: how many runs per second of each recipe, how many machines,
 * how much raw input has to be supplied, and what is left over as by-products.
 *
 * Pure TypeScript with type-only imports, so it can be unit-checked in plain Node
 * (see tools/simple-chain-check.ts) and has no dependency on React or the stores.
 *
 * Model
 * - Every product that has to be produced uses exactly ONE recipe (the "choice").
 * - A product with no choice, or one listed in `external`, is raw: supplied from outside.
 * - Recipes can be recursive (e.g. sulfuric acid consumes sulfuric acid); the rates are
 *   solved by fixed-point iteration, which converges whenever the recipe is net-positive.
 * - Side outputs that nothing asks for are reported as by-products (surplus) and are
 *   NOT credited back against demand. This is a deliberate simplification.
 */
import type { Machine, Product, Recipe } from '../types/data';

export interface ChainInput {
  recipes: Recipe[];
  products: Product[];
  machines: Machine[];
  target: { productId: string; rate: number };
  /** productId -> recipeId. Missing entries fall back to defaultChoice(). */
  choices?: Record<string, string>;
  /** Products to treat as supplied from outside (mined, bought, already available). */
  external?: Iterable<string>;
}

export interface FlowRate {
  productId: string;
  name: string;
  /** units per second */
  rate: number;
}

export interface ChainRow {
  recipeId: string;
  recipeName: string;
  machineId: string;
  machineName: string;
  /** products this recipe was chosen for */
  producesFor: string[];
  /** recipe cycles per second */
  runsPerSec: number;
  /** machines needed, fractional */
  machinesExact: number;
  /** machines needed, rounded up */
  machinesWhole: number;
  inputs: FlowRate[];
  outputs: FlowRate[];
  /** MF/s at the exact (fractional) machine count */
  power: number;
  /** %/hr at the exact (fractional) machine count */
  pollution: number;
  /** distance from the target, for display ordering */
  depth: number;
}

export interface ChainResult {
  rows: ChainRow[];
  raw: FlowRate[];
  byproducts: FlowRate[];
  totals: { machinesWhole: number; power: number; pollution: number };
  warnings: string[];
  converged: boolean;
}

const MAX_ITERATIONS = 2000;
const EPSILON = 1e-12;
const DIVERGENCE_LIMIT = 1e12;

function hasVariableIo(recipe: Recipe): boolean {
  return (
    recipe.inputs.some((i) => i.variable || i.flowDependencies) ||
    recipe.outputs.some((o) => o.variable)
  );
}

export function recipesProducing(recipes: Recipe[], productId: string): Recipe[] {
  return recipes.filter((r) => r.outputs.some((o) => o.product_id === productId));
}

/**
 * Sensible default recipe for a product, or undefined when nothing produces it.
 * Preference order: non-recursive, fixed I/O, highest output per machine-second
 * (fewest machines for the same rate), fewest inputs, then id for a stable result.
 * Research/unlock state is not considered here; the UI lets the user override any pick.
 */
export function defaultChoice(
  recipes: Recipe[],
  _machines: Machine[],
  productId: string,
): Recipe | undefined {
  const options = recipesProducing(recipes, productId);
  if (options.length === 0) return undefined;
  const throughput = (r: Recipe): number => {
    const out = r.outputs
      .filter((o) => o.product_id === productId)
      .reduce((sum, o) => sum + o.quantity, 0);
    return r.cycle_time > 0 ? out / r.cycle_time : 0;
  };
  const score = (r: Recipe): [number, number, number, number] => [
    r.inputs.some((i) => i.product_id === productId) ? 1 : 0,
    hasVariableIo(r) ? 1 : 0,
    -throughput(r),
    r.inputs.length,
  ];
  return [...options].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i];
    }
    return a.id.localeCompare(b.id);
  })[0];
}

export function computeChain(input: ChainInput): ChainResult {
  const { recipes, products, machines, target } = input;
  const productName = new Map(products.map((p) => [p.id, p.name]));
  const machineName = new Map(machines.map((m) => [m.id, m.name]));
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  const external = new Set(input.external ?? []);
  const warnings: string[] = [];
  const nameOf = (id: string) => productName.get(id) ?? id;

  // Resolve one recipe per product by walking the graph from the target.
  const chosen = new Map<string, Recipe>();
  const rawIds = new Set<string>();
  const stack = [target.productId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const pid = stack.pop() as string;
    if (visited.has(pid)) continue;
    visited.add(pid);
    if (external.has(pid) && pid !== target.productId) {
      rawIds.add(pid);
      continue;
    }
    let recipe: Recipe | undefined;
    const wanted = input.choices?.[pid];
    if (wanted) {
      recipe = recipeById.get(wanted);
      if (!recipe || !recipe.outputs.some((o) => o.product_id === pid)) {
        warnings.push(
          `Рецепт «${wanted}» не производит «${nameOf(pid)}», взят рецепт по умолчанию.`,
        );
        recipe = undefined;
      }
    }
    recipe = recipe ?? defaultChoice(recipes, machines, pid);
    if (!recipe) {
      rawIds.add(pid);
      continue;
    }
    if (hasVariableIo(recipe)) {
      warnings.push(
        `Рецепт «${recipe.name}» (${nameOf(pid)}) с переменными входами/выходами: цифры приблизительные.`,
      );
    }
    chosen.set(pid, recipe);
    for (const i of recipe.inputs) stack.push(i.product_id);
  }

  // Which products each chosen recipe is responsible for.
  const responsibility = new Map<string, string[]>();
  for (const [pid, r] of chosen) {
    const list = responsibility.get(r.id) ?? [];
    list.push(pid);
    responsibility.set(r.id, list);
  }
  const usedRecipes = [...new Map([...chosen.values()].map((r) => [r.id, r])).values()];

  // Fixed-point iteration on recipe run rates.
  const runs = new Map<string, number>(usedRecipes.map((r) => [r.id, 0]));
  const demandOf = (pid: string): number => {
    let d = pid === target.productId ? target.rate : 0;
    for (const r of usedRecipes) {
      const run = runs.get(r.id) ?? 0;
      if (run === 0) continue;
      for (const i of r.inputs) if (i.product_id === pid) d += run * i.quantity;
    }
    return d;
  };

  let converged = false;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let maxDelta = 0;
    const next = new Map<string, number>();
    for (const r of usedRecipes) {
      let need = 0;
      for (const pid of responsibility.get(r.id) ?? []) {
        const out = r.outputs
          .filter((o) => o.product_id === pid)
          .reduce((sum, o) => sum + o.quantity, 0);
        if (out <= 0) continue;
        need = Math.max(need, demandOf(pid) / out);
      }
      next.set(r.id, need);
      maxDelta = Math.max(maxDelta, Math.abs(need - (runs.get(r.id) ?? 0)));
    }
    for (const [id, v] of next) runs.set(id, v);
    const peak = Math.max(...next.values(), 0);
    if (peak > DIVERGENCE_LIMIT) {
      warnings.push(
        'Цепочка зациклена и не окупается: рецепт потребляет больше, чем производит. ' +
          'Задай один из продуктов цикла как внешний.',
      );
      break;
    }
    if (maxDelta <= EPSILON * Math.max(1, peak)) {
      converged = true;
      break;
    }
  }
  if (!converged && warnings.length === 0) {
    warnings.push('Расчёт не сошёлся за отведённое число итераций, цифры могут быть неточными.');
  }

  // Depth for ordering: longest distance from the target, ignoring back-edges.
  const depth = new Map<string, number>();
  const walk = (pid: string, d: number, path: Set<string>) => {
    const r = chosen.get(pid);
    if (!r || path.has(pid)) return;
    if ((depth.get(r.id) ?? -1) >= d) return;
    depth.set(r.id, d);
    const nextPath = new Set(path).add(pid);
    for (const i of r.inputs) walk(i.product_id, d + 1, nextPath);
  };
  walk(target.productId, 0, new Set());

  const rows: ChainRow[] = usedRecipes.map((r) => {
    const run = runs.get(r.id) ?? 0;
    const machinesExact = run * r.cycle_time;
    return {
      recipeId: r.id,
      recipeName: r.name,
      machineId: r.machine_id,
      machineName: machineName.get(r.machine_id) ?? r.machine_id,
      producesFor: responsibility.get(r.id) ?? [],
      runsPerSec: run,
      machinesExact,
      machinesWhole: machinesExact > EPSILON ? Math.ceil(machinesExact - 1e-9) : 0,
      inputs: r.inputs.map((i) => ({
        productId: i.product_id,
        name: nameOf(i.product_id),
        rate: run * i.quantity,
      })),
      outputs: r.outputs.map((o) => ({
        productId: o.product_id,
        name: nameOf(o.product_id),
        rate: run * o.quantity,
      })),
      power: machinesExact * r.power_use,
      pollution: machinesExact * r.pollution,
      depth: depth.get(r.id) ?? 0,
    };
  });
  rows.sort((a, b) => a.depth - b.depth || a.recipeName.localeCompare(b.recipeName));

  // Raw supply: demand for products that nothing in the chain produces.
  const raw: FlowRate[] = [...rawIds]
    .map((pid) => ({ productId: pid, name: nameOf(pid), rate: demandOf(pid) }))
    .filter((f) => f.rate > EPSILON)
    .sort((a, b) => b.rate - a.rate);

  // By-products: production above demand.
  const produced = new Map<string, number>();
  for (const row of rows) {
    for (const o of row.outputs) {
      produced.set(o.productId, (produced.get(o.productId) ?? 0) + o.rate);
    }
  }
  const byproducts: FlowRate[] = [];
  for (const [pid, made] of produced) {
    const surplus = made - demandOf(pid);
    if (surplus > 1e-9 * Math.max(1, made)) {
      byproducts.push({ productId: pid, name: nameOf(pid), rate: surplus });
    }
  }
  byproducts.sort((a, b) => b.rate - a.rate);

  return {
    rows,
    raw,
    byproducts,
    totals: {
      machinesWhole: rows.reduce((s, r) => s + r.machinesWhole, 0),
      power: rows.reduce((s, r) => s + r.power, 0),
      pollution: rows.reduce((s, r) => s + r.pollution, 0),
    },
    warnings,
    converged,
  };
}
