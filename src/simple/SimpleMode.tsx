import { useEffect, useMemo, useState } from 'react';
import { getAllMachines, getAllProducts, getAllRecipes, resolveActiveRecipe } from '../data/lookup';
import { getSpecialRecipe } from '../data/registry';
import { formatPollution, formatPower } from '../utils/unitFormatting';
import { computeChain, defaultChoice, recipesProducing } from './chainEngine';
import type { ChainRow, FlowRate } from './chainEngine';
import { DEFAULT_STATE, buildShareUrl, readStateFromHash } from './shareLink';
import type { SimpleState } from './shareLink';
import './simple.css';

const DONE_STORAGE_KEY = 'industrialist-simple-done';

const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const fmt = (value: number): string => numberFormat.format(value);

const NO_HELPERS = {
  resolveProduct: () => '',
  hasConnection: () => false,
};

function convertRate(rate: number, from: 's' | 'm', to: 's' | 'm'): number {
  if (from === to) return rate;
  const converted = to === 'm' ? rate * 60 : rate / 60;
  return Number(converted.toPrecision(10));
}

function loadDone(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(DONE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

function saveDone(done: Record<string, boolean>): void {
  try {
    localStorage.setItem(DONE_STORAGE_KEY, JSON.stringify(done));
  } catch {
    // Storage can be blocked or full; the checklist then just lives in memory.
  }
}

interface NumberFieldProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}

/** Text input that keeps what the user is typing ("1." or "") and commits only valid numbers. */
function NumberField({ label, value, onCommit }: NumberFieldProps) {
  const [text, setText] = useState(String(value));
  return (
    <label className="simple-field">
      <span className="simple-field-label">{label}</span>
      <input
        className="simple-input"
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const parsed = Number(next.replace(',', '.'));
          if (next.trim() !== '' && Number.isFinite(parsed)) onCommit(parsed);
        }}
      />
    </label>
  );
}

function FlowList({ flows }: { flows: FlowRate[] }) {
  return (
    <ul className="simple-flows">
      {flows.map((flow) => (
        <li key={flow.productId}>
          {flow.name} <span className="simple-dim">{fmt(flow.rate)}/с</span>
        </li>
      ))}
    </ul>
  );
}

export function SimpleMode({ onOpenGraph }: { onOpenGraph: () => void }) {
  const [state, setState] = useState<SimpleState>(
    () => readStateFromHash(window.location.hash) ?? DEFAULT_STATE,
  );
  const [filter, setFilter] = useState('');
  const [done, setDone] = useState<Record<string, boolean>>(loadDone);
  const [copied, setCopied] = useState(false);

  const baseRecipes = useMemo(() => getAllRecipes(), []);
  const products = useMemo(() => getAllProducts(), []);
  const machines = useMemo(() => getAllMachines(), []);

  // Special recipes depend on user settings (e.g. steam temperature); the rest are used as-is.
  const recipes = useMemo(
    () =>
      baseRecipes.map((recipe) => {
        const settings = state.settings[recipe.id];
        if (!settings) return recipe;
        return resolveActiveRecipe(recipe.id, settings, undefined, NO_HELPERS) ?? recipe;
      }),
    [baseRecipes, state.settings],
  );

  const productName = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
  const nameOf = (id: string) => productName.get(id) ?? id;

  const targetOptions = useMemo(() => {
    const producible = new Set(recipes.flatMap((r) => r.outputs.map((o) => o.product_id)));
    const needle = filter.trim().toLowerCase();
    return products
      .filter(
        (p) =>
          p.id === state.productId ||
          (producible.has(p.id) && (needle === '' || p.name.toLowerCase().includes(needle))),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products, recipes, filter, state.productId]);

  const ratePerSecond = state.unit === 'm' ? state.rate / 60 : state.rate;
  const rateValid = Number.isFinite(ratePerSecond) && ratePerSecond > 0;

  const result = useMemo(
    () =>
      rateValid
        ? computeChain({
            recipes,
            products,
            machines,
            target: { productId: state.productId, rate: ratePerSecond },
            choices: state.choices,
            external: state.external,
          })
        : null,
    [recipes, products, machines, state, ratePerSecond, rateValid],
  );

  // Keep the address bar equal to a shareable link, so copying the URL always works.
  useEffect(() => {
    const url = buildShareUrl(state, window.location.href);
    window.history.replaceState(null, '', url);
  }, [state]);

  const update = (patch: Partial<SimpleState>) => {
    setCopied(false);
    setState((prev) => ({ ...prev, ...patch }));
  };

  const setChoice = (productId: string, recipeId: string) => {
    update({ choices: { ...state.choices, [productId]: recipeId } });
  };

  const setExternal = (productId: string, isExternal: boolean) => {
    const rest = state.external.filter((id) => id !== productId);
    update({ external: isExternal ? [...rest, productId] : rest });
  };

  const setRecipeSetting = (recipeId: string, key: string, value: number) => {
    update({
      settings: {
        ...state.settings,
        [recipeId]: { ...state.settings[recipeId], [key]: value },
      },
    });
  };

  const toggleDone = (recipeId: string, value: boolean) => {
    const next = { ...done, [recipeId]: value };
    setDone(next);
    saveDone(next);
  };

  const resetDone = () => {
    setDone({});
    saveDone({});
  };

  const shareUrl = buildShareUrl(state, window.location.href);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const renderRecipeCell = (row: ChainRow) => {
    const special = getSpecialRecipe(row.recipeId);
    const numberSettings = special
      ? Object.entries(special.settings).flatMap(([key, def]) =>
          def.type === 'number' ? [{ key, def }] : [],
        )
      : [];
    return (
      <>
        <div className="simple-recipe-name">{row.recipeName}</div>
        {row.producesFor.map((pid) => {
          const options = recipesProducing(recipes, pid);
          const current =
            state.choices[pid] ?? defaultChoice(recipes, machines, pid)?.id ?? row.recipeId;
          return (
            <div className="simple-choice" key={pid}>
              {options.length > 1 && (
                <label className="simple-field">
                  <span className="simple-field-label">Как делать «{nameOf(pid)}»</span>
                  <select
                    className="simple-input"
                    value={current}
                    onChange={(event) => setChoice(pid, event.target.value)}
                  >
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {pid !== state.productId && (
                <button
                  className="simple-button simple-button-small"
                  type="button"
                  onClick={() => setExternal(pid, true)}
                >
                  Не делать, брать «{nameOf(pid)}» извне
                </button>
              )}
            </div>
          );
        })}
        {numberSettings.map(({ key, def }) => (
          <NumberField
            key={key}
            label={def.label}
            value={state.settings[row.recipeId]?.[key] ?? def.default}
            onCommit={(value) => setRecipeSetting(row.recipeId, key, value)}
          />
        ))}
      </>
    );
  };

  return (
    <div className="simple-root">
      <header className="simple-header">
        <h1 className="simple-title">Индустриалист: калькулятор цепочек</h1>
        <button className="simple-button" type="button" onClick={onOpenGraph}>
          Режим графа →
        </button>
      </header>

      <section className="simple-panel">
        <div className="simple-controls">
          <label className="simple-field simple-field-wide">
            <span className="simple-field-label">Что хочу получать</span>
            <input
              className="simple-input"
              type="search"
              placeholder="Поиск по названию…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <select
              className="simple-input"
              value={state.productId}
              onChange={(event) =>
                update({ productId: event.target.value, choices: {}, external: [] })
              }
            >
              {targetOptions.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>
          <NumberField
            key={state.unit}
            label="Сколько"
            value={state.rate}
            onCommit={(rate) => update({ rate })}
          />
          <label className="simple-field">
            <span className="simple-field-label">В</span>
            <select
              className="simple-input"
              value={state.unit}
              onChange={(event) => {
                const unit = event.target.value === 'm' ? 'm' : 's';
                update({ unit, rate: convertRate(state.rate, state.unit, unit) });
              }}
            >
              <option value="s">секунду</option>
              <option value="m">минуту</option>
            </select>
          </label>
        </div>
        <div className="simple-share">
          <input className="simple-input" readOnly value={shareUrl} aria-label="Ссылка на расчёт" />
          <button className="simple-button" type="button" onClick={copyLink}>
            {copied ? 'Скопировано' : 'Скопировать ссылку'}
          </button>
        </div>
      </section>

      {!rateValid && <p className="simple-error">Введи темп больше нуля.</p>}

      {result && (
        <>
          <section className="simple-summary">
            <div>
              <div className="simple-dim">Машин всего</div>
              <div className="simple-stat">{result.totals.machinesWhole}</div>
            </div>
            <div>
              <div className="simple-dim">Энергия</div>
              <div className="simple-stat">{formatPower(result.totals.power)}</div>
            </div>
            <div>
              <div className="simple-dim">Загрязнение</div>
              <div className="simple-stat">{formatPollution(result.totals.pollution)}</div>
            </div>
          </section>

          {result.warnings.map((warning) => (
            <p className="simple-error" key={warning}>
              {warning}
            </p>
          ))}

          <section className="simple-panel">
            <div className="simple-section-head">
              <h2 className="simple-subtitle">Что построить</h2>
              <button className="simple-button" type="button" onClick={resetDone}>
                Сбросить галочки
              </button>
            </div>
            <div className="simple-table-wrap">
              <table className="simple-table">
                <thead>
                  <tr>
                    <th>✓</th>
                    <th>Машина</th>
                    <th>Рецепт</th>
                    <th className="simple-num">Штук</th>
                    <th>Берёт</th>
                    <th>Выдаёт</th>
                    <th className="simple-num">Энергия</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={row.recipeId} className={done[row.recipeId] ? 'simple-row-done' : ''}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Построено: ${row.machineName}`}
                          checked={done[row.recipeId] === true}
                          onChange={(event) => toggleDone(row.recipeId, event.target.checked)}
                        />
                      </td>
                      <td>{row.machineName}</td>
                      <td>{renderRecipeCell(row)}</td>
                      <td className="simple-num">
                        <strong>{row.machinesWhole}</strong>
                        <div className="simple-dim">точно {fmt(row.machinesExact)}</div>
                      </td>
                      <td>
                        <FlowList flows={row.inputs} />
                      </td>
                      <td>
                        <FlowList flows={row.outputs} />
                      </td>
                      <td className="simple-num">{formatPower(row.power)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="simple-panel">
            <h2 className="simple-subtitle">Сырьё, которое нужно подвозить</h2>
            {result.raw.length === 0 ? (
              <p className="simple-dim">Ничего: вся цепочка замкнута.</p>
            ) : (
              <ul className="simple-raw">
                {result.raw.map((flow) => (
                  <li key={flow.productId}>
                    <span>{flow.name}</span>
                    <span className="simple-num">
                      {fmt(flow.rate)}/с{' '}
                      <span className="simple-dim">({fmt(flow.rate * 60)}/мин)</span>
                    </span>
                    {state.external.includes(flow.productId) &&
                      recipesProducing(recipes, flow.productId).length > 0 && (
                        <button
                          className="simple-button"
                          type="button"
                          onClick={() => setExternal(flow.productId, false)}
                        >
                          Производить самому
                        </button>
                      )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {result.byproducts.length > 0 && (
            <section className="simple-panel">
              <h2 className="simple-subtitle">Побочные продукты (излишки)</h2>
              <p className="simple-dim">
                Их нужно куда-то девать или продавать. В расчёт они не засчитываются.
              </p>
              <FlowList flows={result.byproducts} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
