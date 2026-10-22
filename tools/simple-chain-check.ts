/**
 * Plain-Node sanity check for the simple-mode chain engine (no npm install needed).
 *   node tools/simple-chain-check.ts
 * Expected numbers are worked out by hand in the comments.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeChain, defaultChoice } from '../src/simple/chainEngine.ts';
import { alloyer_purple_gold } from '../src/data/special_recipes/alloyer.ts';
import {
  buildShareUrl,
  decodeState,
  encodeState,
  readStateFromHash,
  type SimpleState,
} from '../src/simple/shareLink.ts';

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../src/data/${name}`, import.meta.url), 'utf8'));

const baseRecipes = load('recipes.json');
const products = load('products.json');
const machines = load('machines.json');

// Special recipes are computed from their default settings (steam 300 °C -> alloyer cycle 10 s).
const alloyer = alloyer_purple_gold.compute({ steam_temp: 300 });
assert.equal(alloyer.cycle_time, 10);
const recipes = [...baseRecipes, alloyer];

const near = (a: number, b: number, msg: string) =>
  assert.ok(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${msg}: ${a} != ${b}`);

// 1) Purple gold ingot 1/s with gold, aluminium and steam supplied from outside.
//    Molder: 2 ingots / 4 molten / 4 s  -> 0.5 runs/s, 2.0 machines, needs 2 molten/s.
//    Alloyer: 2 molten / run / 10 s     -> 1 run/s, 10 machines; eats 1 gold, 2 Al, 200 steam per s.
{
  const res = computeChain({
    recipes,
    products,
    machines,
    target: { productId: 'p_purple_gold_ingot', rate: 1 },
    external: ['p_gold_ingot', 'p_aluminium_ingot', 'p_steam'],
  });
  const byRecipe = Object.fromEntries(res.rows.map((r) => [r.recipeId, r]));
  near(byRecipe['r_ingot_molder_06'].machinesExact, 2, 'molder machines');
  near(byRecipe['r_alloyer_02'].runsPerSec, 1, 'alloyer runs/s');
  near(byRecipe['r_alloyer_02'].machinesExact, 10, 'alloyer machines');
  const raw = Object.fromEntries(res.raw.map((f) => [f.productId, f.rate]));
  near(raw['p_gold_ingot'], 1, 'gold/s');
  near(raw['p_aluminium_ingot'], 2, 'aluminium/s');
  near(raw['p_steam'], 200, 'steam/s');
  assert.equal(res.byproducts.length, 0);
  assert.ok(res.converged);
  console.log('ok  purple gold, supplied inputs');
}

// 2) Full chain down to raw materials must converge, and every input of a used recipe
//    must be either produced by another used recipe or listed as raw.
{
  const res = computeChain({
    recipes,
    products,
    machines,
    target: { productId: 'p_purple_gold_ingot', rate: 1 },
  });
  assert.ok(res.converged, 'full chain converges');
  const made = new Set(res.rows.flatMap((r) => r.outputs.map((o) => o.productId)));
  const raw = new Set(res.raw.map((f) => f.productId));
  for (const row of res.rows) {
    for (const i of row.inputs) {
      if (i.rate <= 1e-12) continue;
      assert.ok(made.has(i.productId) || raw.has(i.productId), `${i.name} is neither made nor raw`);
    }
  }
  // Mass balance: everything consumed is produced or raw (plus the target itself).
  for (const row of res.rows) {
    for (const i of row.inputs) {
      const supply =
        res.rows.flatMap((r) => r.outputs).filter((o) => o.productId === i.productId).reduce((s, o) => s + o.rate, 0) +
        (res.raw.find((f) => f.productId === i.productId)?.rate ?? 0);
      const demand = res.rows.flatMap((r) => r.inputs).filter((x) => x.productId === i.productId).reduce((s, x) => s + x.rate, 0);
      assert.ok(supply + 1e-6 >= demand, `balance for ${i.name}: supply ${supply} < demand ${demand}`);
    }
  }
  console.log(`ok  full chain: ${res.rows.length} recipes, ${res.raw.length} raw inputs, ${res.totals.machinesWhole} machines`);
  for (const f of res.raw) console.log(`    raw  ${f.name}: ${f.rate.toFixed(3)}/s`);
  for (const w of res.warnings) console.log(`    warn ${w}`);
}

// 3) Recursive recipe: sulfuric acid (r_chemical_reactor_03: 20 SO3 + 20 water + 2 acid -> 15 acid per 3 s).
//    Net 13 acid per run, so 13 acid/s needs 1 run/s of the recipe and 2 acid/s recycled.
{
  const res = computeChain({
    recipes,
    products,
    machines,
    target: { productId: 'p_sulfuric_acid', rate: 13 },
    choices: { p_sulfuric_acid: 'r_chemical_reactor_03' },
    external: ['p_sulfur_trioxide', 'p_water'],
  });
  const row = res.rows.find((r) => r.recipeId === 'r_chemical_reactor_03');
  assert.ok(row, 'row exists');
  // runs * 15 = 13 + runs * 2  =>  runs = 1
  near(row.runsPerSec, 1, 'recursive runs/s');
  assert.ok(res.converged);
  console.log('ok  recursive sulfuric acid');
}

// 4) Default choice avoids self-referential recipes when a clean one exists.
{
  const d = defaultChoice(recipes, machines, 'p_sulfuric_acid');
  assert.ok(d && !d.inputs.some((i) => i.product_id === 'p_sulfuric_acid'), 'default is non-recursive');
  console.log(`ok  default sulfuric acid recipe: ${d?.id}`);
}

// 5) Divergent loop is reported instead of hanging.
{
  const loop = {
    id: 'r_test_loop', name: 'Loop', machine_id: 'm_x', cycle_time: 1, power_use: 0, power_type: 'MV', pollution: 0,
    inputs: [{ product_id: 'p_a', quantity: 2 }], outputs: [{ product_id: 'p_a', quantity: 1, temperature: 18 }],
  };
  const res = computeChain({
    recipes: [loop as never], products, machines, target: { productId: 'p_a', rate: 1 }, choices: { p_a: 'r_test_loop' },
  });
  assert.ok(res.warnings.length > 0 && !res.converged, 'divergence flagged');
  console.log('ok  divergent loop flagged');
}

// 6) Share link round-trips and rejects garbage.
{
  const state: SimpleState = {
    productId: 'p_purple_gold_ingot',
    rate: 2.5,
    unit: 'm',
    choices: { p_gold_ingot: 'r_grinder_10' },
    external: ['p_steam', 'p_water'],
    settings: { r_alloyer_02: { steam_temp: 450 } },
  };
  const url = buildShareUrl(state, 'https://example.com/app/?x=1#old');
  assert.ok(url.startsWith('https://example.com/app/?x=1#s='), 'hash replaced, query kept');
  const back = readStateFromHash(url.slice(url.indexOf('#')));
  assert.deepEqual(back, state);
  assert.equal(readStateFromHash('#s=not-base64!!'), null);
  assert.equal(readStateFromHash('#other=1'), null);
  assert.equal(decodeState(encodeState({ ...state, rate: -1 })), null, 'negative rate rejected');
  console.log('ok  share link round-trip');
}

console.log('all checks passed');
