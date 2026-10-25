/**
 * Behavioural checks for the Host half. Run with plain node:
 *   node verify.mjs
 *
 * They exercise the real `apply()` against a minimal fake Cordis context, so
 * the guarantees this plugin claims are asserted rather than assumed:
 *   1. With no configured route nothing is rerouted (official behaviour).
 *   2. Non-review calls are forwarded untouched, whatever the config says.
 *   3. A review call is rerouted while every other field is preserved exactly.
 *   4. An unusable configured route falls back to the official route.
 *   5. An unsupported reasoning level is dropped, not forced.
 */
import { apply, Config } from "./index.js";

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
};

/** Build a live config object shaped like the Loader's volatile references. */
function liveConfig(values) {
  const defaults = {
    provider: "",
    model: "",
    reasoningEffort: "",
    marker: "REVIEW_POLICY",
  };
  const merged = { ...defaults, ...values };
  const config = {};
  for (const [key, value] of Object.entries(merged)) {
    const get = () => value;
    config[key] = { get };
  }
  return config;
}

/** The exact reviewer request the official plugin builds (lib/index.js:400-413). */
function reviewRequest(overrides = {}) {
  return Object.freeze({
    provider: "session-provider",
    model: "session-model",
    system: "REVIEW_POLICY\nYou are the final authorization reviewer for exactly one pending tool call.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "ENVIRONMENT\n\n{}\n\nPENDING_ACTION\n\n{}" }],
      },
    ],
    temperature: 0,
    signal: new AbortController().signal,
    ...overrides,
  });
}

/** Minimal Cordis context: records listeners, ignores child scopes. */
function fakeContext({ providers = ["session-provider", "target"], models = {}, efforts = {} } = {}) {
  const listeners = new Map();
  const dispatched = [];
  const logs = [];
  const ctx = {
    logger: { warn: (message) => logs.push(message), info: () => {}, debug: () => {} },
    effect: (body) => {
      const dispose = typeof body === "function" ? body() : undefined;
      return typeof dispose === "function" ? dispose : () => {};
    },
    on: (event, listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    inject: () => () => {},
    llm: {
      listProviders: () => providers.map((id) => ({ id, name: id })),
      listModels: async () => [],
      resolveModelInfo: async (provider, model) => {
        const declared = efforts[`${provider}/${model}`] ?? [];
        return {
          provider,
          id: model,
          name: model,
          ...(efforts[`${provider}/${model}`] === undefined
            ? {}
            : { reasoning: { efforts: declared.map((id) => ({ id, name: id })) } }),
        };
      },
      stream: (options) => {
        dispatched.push(options);
        return (async function* () {
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      },
    },
  };
  return { ctx, listeners, dispatched, logs };
}

/** Run one request through the plugin's llm/stream listener. */
async function through(listener, options) {
  const chunks = [];
  const downstream = (async function* () {
    yield { type: "finish", reason: { kind: "stop" }, downstream: true };
  })();
  for await (const chunk of listener(options, () => downstream)) chunks.push(chunk);
  return chunks;
}

console.log("\n1. No route configured leaves the official behaviour intact");
{
  const { ctx, listeners, dispatched } = fakeContext();
  apply(ctx, liveConfig({}));
  const listener = listeners.get("llm/stream");
  const options = reviewRequest();
  const chunks = await through(listener, options);
  check("review call not rerouted", dispatched.length === 0, `dispatched ${dispatched.length}`);
  check("downstream produced the finish", chunks.at(-1)?.downstream === true);
}

console.log("\n2. Non-review calls are never touched, even with a route configured");
{
  const { ctx, listeners, dispatched } = fakeContext();
  apply(ctx, liveConfig({ provider: "target", model: "target-model" }));
  const listener = listeners.get("llm/stream");
  const cases = {
    "ordinary chat (no fixed policy)": reviewRequest({ system: "You are a helpful assistant." }),
    "compaction (purpose set)": reviewRequest({ purpose: "compaction" }),
    "session title (purpose set)": reviewRequest({ purpose: "session-title" }),
    "review-shaped but with tools": reviewRequest({ tools: [{ name: "read", description: "", parameters: {} }] }),
    "review-shaped but temperature 0.2": reviewRequest({ temperature: 0.2 }),
    "no system prompt at all": reviewRequest({ system: undefined }),
  };
  for (const [label, options] of Object.entries(cases)) {
    await through(listener, options);
    check(label, dispatched.length === 0, `dispatched ${dispatched.length}`);
  }
}

console.log("\n3. A review call is rerouted with everything else preserved");
{
  const { ctx, listeners, dispatched } = fakeContext({
    providers: ["session-provider", "cheap"],
    efforts: { "cheap/flash": ["low", "high"] },
  });
  apply(ctx, liveConfig({ provider: "cheap", model: "flash", reasoningEffort: "off" }));
  const listener = listeners.get("llm/stream");
  const original = reviewRequest();
  await through(listener, original);

  check("exactly one rerouted dispatch", dispatched.length === 1, `dispatched ${dispatched.length}`);
  const forwarded = dispatched[0];
  check("provider rewritten", forwarded?.provider === "cheap", String(forwarded?.provider));
  check("model rewritten", forwarded?.model === "flash", String(forwarded?.model));
  check("system prompt byte-identical", forwarded?.system === original.system);
  check("messages byte-identical", forwarded?.messages === original.messages);
  check("temperature preserved", forwarded?.temperature === 0);
  check("signal preserved", forwarded?.signal === original.signal);
  check("no tools invented", forwarded?.tools === undefined);
  check("no purpose invented", forwarded?.purpose === undefined);
  check(
    "unsupported effort dropped (off is not declared)",
    forwarded?.reasoningEffort === undefined,
    String(forwarded?.reasoningEffort),
  );
}

console.log("\n4. A declared reasoning level is forwarded");
{
  const { ctx, listeners, dispatched } = fakeContext({
    providers: ["session-provider", "cheap"],
    efforts: { "cheap/flash": ["low", "high"] },
  });
  apply(ctx, liveConfig({ provider: "cheap", model: "flash", reasoningEffort: "high" }));
  const listener = listeners.get("llm/stream");
  await through(listener, reviewRequest());
  check("effort forwarded", dispatched[0]?.reasoningEffort === "high", String(dispatched[0]?.reasoningEffort));
}

console.log("\n5. An unusable route falls back to the official route");
{
  const { ctx, listeners, dispatched, logs } = fakeContext({ providers: ["session-provider"] });
  apply(ctx, liveConfig({ provider: "missing-provider", model: "whatever" }));
  const listener = listeners.get("llm/stream");
  await through(listener, reviewRequest());
  check("nothing rerouted", dispatched.length === 0, `dispatched ${dispatched.length}`);
  check("one diagnostic logged", logs.length === 1, `logs: ${logs.length}`);
  check("diagnostic names the provider", (logs[0] ?? "").includes("missing-provider"), logs[0]);
}

console.log("\n6. A route identical to the session route is not re-dispatched");
{
  const { ctx, listeners, dispatched } = fakeContext({ providers: ["session-provider"] });
  apply(ctx, liveConfig({ provider: "session-provider", model: "session-model" }));
  const listener = listeners.get("llm/stream");
  await through(listener, reviewRequest());
  check("no redundant dispatch", dispatched.length === 0, `dispatched ${dispatched.length}`);
}

console.log("\n7. Repeated calls keep dropping the unsupported level (cached verdict)");
{
  const { ctx, listeners, dispatched } = fakeContext({
    providers: ["session-provider", "cheap"],
    efforts: { "cheap/flash": ["low", "high"] },
  });
  apply(ctx, liveConfig({ provider: "cheap", model: "flash", reasoningEffort: "off" }));
  const listener = listeners.get("llm/stream");
  await through(listener, reviewRequest());
  await through(listener, reviewRequest());
  await through(listener, reviewRequest());
  check("three reroutes happened", dispatched.length === 3, `dispatched ${dispatched.length}`);
  check(
    "no call carried the undeclared level",
    dispatched.every((options) => options.reasoningEffort === undefined),
    JSON.stringify(dispatched.map((options) => options.reasoningEffort)),
  );
}

console.log("\n8. The schema keeps both route fields optional and default-empty");
{
  const resolved = new Config({});
  check("provider defaults to empty", resolved.provider.get() === "", String(resolved.provider.get()));
  check("model defaults to empty", resolved.model.get() === "", String(resolved.model.get()));
  check("marker defaults to REVIEW_POLICY", resolved.marker.get() === "REVIEW_POLICY", String(resolved.marker.get()));
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
