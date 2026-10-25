/**
 * Render check for the configuration page.
 *
 * React lives in the browser module table, not in this profile, so this script
 * provides a minimal hooks runtime instead: it renders, flushes effects, awaits
 * the microtask queue, and re-renders until the tree settles. The assertions
 * are about this plugin's component code, not about React internals.
 *
 * Run with plain node: node render-check.mjs
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
};

/** One element as the component tree asked React to build it. */
const created = [];

/**
 * Minimally faithful hooks: state and effects that survive a re-render, which
 * is what the page needs to move from its loading branch to its form.
 */
const hooks = {
  slots: [],
  cursor: 0,
  effects: [],
};
function resetHooks() {
  hooks.cursor = 0;
  hooks.effects = [];
}
function useState(initial) {
  const index = hooks.cursor;
  hooks.cursor += 1;
  if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
  const set = (next) => {
    const current = hooks.slots[index];
    hooks.slots[index] = typeof next === "function" ? next(current) : next;
    scheduleRender();
  };
  return [hooks.slots[index], set];
}
function useEffect(effect) {
  const index = hooks.cursor;
  hooks.cursor += 1;
  hooks.effects.push({ index, effect });
}
function useCallback(fn) {
  hooks.cursor += 1;
  return fn;
}
function useMemo(fn) {
  hooks.cursor += 1;
  return fn();
}

const React = {
  createElement(type, props, ...children) {
    const node = { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
    created.push(node);
    return node;
  },
  useState,
  useEffect,
  useCallback,
  useMemo,
};

/** The browser module loader the bundle registers itself with. */
let registered;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      registered = definition;
    },
  },
};

/** The Host's answer for each bridge endpoint, as the page will receive it. */
const bridgeAnswers = {
  state: { ok: true, value: { revision: 3, writable: true, values: {} } },
  providers: { ok: true, value: { providers: [{ id: "wdtn", name: "中转站" }] } },
  models: { ok: true, value: { models: [{ id: "gpt-6.1-sol", name: "gpt-6.1-sol" }] } },
  save: { ok: true, value: { revision: 4, values: {} } },
};

globalThis.fetch = async (url) => {
  const endpoint = String(url).split("/").pop();
  const body = bridgeAnswers[endpoint] ?? { ok: false, message: "no such endpoint" };
  return { ok: true, status: 200, json: async () => body };
};

const dictionaries = {};
const slotRegistrations = [];
const slotInjections = [];
const ctx = {
  effect: (body) => {
    const dispose = typeof body === "function" ? body() : undefined;
    return typeof dispose === "function" ? dispose : () => {};
  },
  locale: {
    register(ns, dicts) {
      dictionaries[ns] = dicts;
      return () => {};
    },
  },
  slots: {
    inject(key, callback) {
      slotInjections.push(key);
      const result = callback();
      return typeof result === "function" ? result : () => {};
    },
    register(options, component) {
      slotRegistrations.push({ options, component });
      return () => {};
    },
  },
};

/** Run the bundle exactly as the page would load it. */
function load() {
  const source = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  const require = (name) => {
    if (name === "react") return React;
    throw new Error(`unexpected module request: ${name}`);
  };
  new Function("window", "require", source)(globalThis.window, require);
  if (registered === undefined) throw new Error("the bundle never registered a module");
  const module = registered.factory(require);
  module.apply(ctx);
  return module;
}

/** Let queued promises and effects settle, then render once more. */
let renderRequested = false;
function scheduleRender() {
  renderRequested = true;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Render a component until it stops changing.
 * @param component - the registered slot component.
 * @param props - the props the Host would pass.
 * @returns the settled element tree.
 */
async function settle(component, props) {
  let tree;
  for (let pass = 0; pass < 8; pass += 1) {
    created.length = 0;
    renderRequested = false;
    resetHooks();
    tree = component(props);
    // Run effects after the render they belong to, as React does.
    const effects = hooks.effects;
    for (const { effect } of effects) effect();
    await flush();
    if (!renderRequested) return tree;
  }
  return tree;
}

/** Flatten a recorded element tree into its text nodes. */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  for (const child of node.children ?? []) texts(child, out);
  return out;
}

const module = load();

console.log("\n1. The bundle registers its own row page");
check("registered a module", registered !== undefined);
check("module id is the package name", registered.id === "@local/dsh-auto-review-route", registered.id);
check("it injects the slots service", (module.inject ?? []).includes("slots"));
check("it registered the plugins.row.config slot", slotInjections.includes("plugins.row.config"));
check(
  "the row key matches this bundle's patch row",
  slotRegistrations[0]?.options?.key === "@local/dsh-auto-review-route#auto-review-route",
  String(slotRegistrations[0]?.options?.key),
);

const dictionary = dictionaries.dshAutoReviewRoute;

console.log("\n2. Both locales carry every label the page asks for");
check("locale namespace registered", dictionary !== undefined);
for (const localeId of ["en", "zh"]) {
  const dict = dictionary?.[localeId];
  const missing = ["save", "reset", "clear", "retry", "saving", "saved", "rejected", "provider", "model", "effort", "marker", "overview"].filter(
    (key) => typeof dict?.[key] !== "string" || dict[key].length === 0,
  );
  check(`${localeId}: all control labels are non-empty strings`, missing.length === 0, missing.join(", "));
}

console.log("\n3. The settled page renders visible control labels");
for (const localeId of ["en", "zh"]) {
  const dict = dictionary[localeId];
  const t = (key) => dict[key] ?? key;
  hooks.slots = [];
  const page = await settle(slotRegistrations[0].component, { view: "page", t });
  const label = texts(page);
  const joined = label.join(" | ");
  const css = label.filter((entry) => entry.startsWith(".aar"));
  check(`${localeId}: left the loading branch`, !label.includes(dict.loading), (css[0] ?? "").slice(0, 80));
  check(`${localeId}: the save label appears`, label.includes(dict.save), joined.slice(0, 200));
  check(`${localeId}: the reset label appears`, label.includes(dict.reset), joined.slice(0, 200));
  check(`${localeId}: the clear label appears`, label.includes(dict.clear), joined.slice(0, 200));
  check(`${localeId}: the overview heading appears`, label.includes(dict.overview), joined.slice(0, 200));
  check(`${localeId}: the provider label appears`, label.includes(dict.provider), joined.slice(0, 200));
}

console.log("\n4. The save control carries the label as its only child");
{
  const dict = dictionary.zh;
  const t = (key) => dict[key] ?? key;
  hooks.slots = [];
  await settle(slotRegistrations[0].component, { view: "page", t });
  const primary = created.find((node) => node.props?.className === "aar-primary");
  check("a primary button element exists", primary !== undefined, String(created.length));
  const children = (primary?.children ?? []).flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
  check("the primary button has exactly one text child", children.length === 1, JSON.stringify(children));
  check("that child is the save label", children[0] === dict.save, JSON.stringify(children[0]));
}

console.log("\n5. A read failure is reported instead of an empty page");
{
  const dict = dictionary.zh;
  const t = (key) => dict[key] ?? key;
  const original = bridgeAnswers.state;
  bridgeAnswers.state = { ok: false, code: "row-pending", message: "this row has no settings form yet" };
  hooks.slots = [];
  const page = await settle(slotRegistrations[0].component, { view: "page", t });
  const label = texts(page).join(" | ");
  check("the diagnostic text is shown", label.includes("this row has no settings form yet"), label.slice(0, 200));
  check("a retry control is offered", texts(page).includes(dict.retry), label.slice(0, 200));
  bridgeAnswers.state = original;
}

console.log("\n6. The summary view stays a one-liner");
{
  const dict = dictionary.zh;
  const t = (key) => dict[key] ?? key;
  const summaryUnset = slotRegistrations[0].component({ view: "summary", t });
  check("unset summary is the short text", typeof summaryUnset === "string" && summaryUnset === dict.summaryUnset, String(summaryUnset));
}

console.log("\n7. The primary control does not rely on an undeclared theme token");
{
  const source = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  const css = source.slice(source.indexOf("const CSS = `"), source.indexOf("`;\n\n    /** POST one bridge endpoint"));
  // Token names the running theme actually declares (cordis_inspect_query Theme).
  const declared = new Set([
    "--dsw-alias-bg-base",
    "--dsw-alias-bg-layer-1",
    "--dsw-alias-bg-layer-2",
    "--dsw-alias-bg-overlay",
    "--dsw-alias-border-l1",
    "--dsw-alias-border-l2",
    "--dsw-alias-brand-primary",
    "--dsw-alias-label-primary",
    "--dsw-alias-label-secondary",
    "--dsw-alias-state-error-primary",
    "--dsw-alias-state-idle-primary",
    "--dsw-alias-state-success-primary",
    "--dsw-alias-state-warn-primary",
    "--dsw-specific-sidebar-fill",
  ]);
  const referenced = [...css.matchAll(/var\((--dsw-alias-[a-z0-9-]+)/g)].map((match) => match[1]);
  const undeclared = [...new Set(referenced)].filter((token) => !declared.has(token));
  check("every referenced colour token is declared by the theme", undeclared.length === 0, undeclared.join(", "));
  // A filled primary control must not take its text colour from a body token.
  const primaryBlock = css.slice(css.indexOf(".aar button.aar-primary {"));
  const primaryColor = primaryBlock.slice(0, primaryBlock.indexOf("}"));
  check(
    "the filled primary control sets a literal foreground",
    /color:\s*#fff/.test(primaryColor),
    primaryColor.replace(/\s+/g, " ").slice(0, 120),
  );
  check(
    "it does not use the body label token as its foreground",
    !/color:\s*var\(--dsw-alias-label-primary\)/.test(primaryColor),
    primaryColor.replace(/\s+/g, " ").slice(0, 120),
  );
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
