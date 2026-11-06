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
    fallbackEnabled: false,
    fallbackProvider: "",
    fallbackModel: "",
    reasoningEffort: "",
    reasonLanguage: "",
    debug: false,
    retryEnabled: false,
    retryAttempts: 2,
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

/**
 * The exact reviewer request the official plugin builds.
 *
 * `purpose` mirrors the shipped protocol: DSH 0.2.2 declares `"auto-review"`
 * in `LlmRequestPurposeMap` and sends it with the review call; 0.2.1 and
 * earlier sent the same request with no tag at all. `legacyReviewRequest`
 * below covers that older shape.
 */
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
    purpose: "auto-review",
    signal: new AbortController().signal,
    ...overrides,
  });
}

/** The same reviewer request as DSH 0.2.1 and earlier built it: no purpose tag. */
function legacyReviewRequest(overrides = {}) {
  const { purpose: _purpose, ...rest } = reviewRequest(overrides);
  return Object.freeze(rest);
}

function* validReviewResponse(label) {
  let index = 0;
  if (label !== undefined) {
    yield { type: "reasoning-delta", index, text: label };
    index += 1;
  }
  yield { type: "text-delta", index, text: '{"risk":"low","decision":"allow"}' };
  yield { type: "finish", reason: { kind: "stop" } };
}

/** Minimal Cordis context: records listeners, ignores child scopes. */
function fakeContext({ providers = ["session-provider", "target"], models = {}, efforts = {}, stream: streamOverride } = {}) {
  const listeners = new Map();
  const dispatched = [];
  const logs = [];
  const ctx = {
    logger: { warn: (message) => logs.push(message), info: (message) => logs.push(message), debug: () => {} },
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
        if (streamOverride !== undefined) return streamOverride(options);
        return (async function* () {
          yield* validReviewResponse();
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
  apply(ctx, liveConfig({ provider: "target", model: "target-model", reasonLanguage: "zh" }));
  const listener = listeners.get("llm/stream");
  const cases = {
    "ordinary chat (no fixed policy)": reviewRequest({ system: "You are a helpful assistant." }),
    "compaction (purpose set)": reviewRequest({ purpose: "compaction" }),
    "session title (purpose set)": reviewRequest({ purpose: "session-title" }),
    "unfamiliar auxiliary purpose": reviewRequest({ purpose: "some-future-auxiliary-call" }),
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
  check("review purpose is preserved, not invented", forwarded?.purpose === "auto-review", String(forwarded?.purpose));
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
  check("fallback defaults off", resolved.fallbackEnabled.get() === false, String(resolved.fallbackEnabled.get()));
  check("fallback provider defaults to empty", resolved.fallbackProvider.get() === "", String(resolved.fallbackProvider.get()));
  check("fallback model defaults to empty", resolved.fallbackModel.get() === "", String(resolved.fallbackModel.get()));
  check("reason language defaults to empty", resolved.reasonLanguage.get() === "", String(resolved.reasonLanguage.get()));
  check("debug defaults off", resolved.debug.get() === false, String(resolved.debug.get()));
  check("automatic retry defaults off", resolved.retryEnabled.get() === false, String(resolved.retryEnabled.get()));
  check("additional retry attempts default to two", resolved.retryAttempts.get() === 2, String(resolved.retryAttempts.get()));
  check("marker defaults to REVIEW_POLICY", resolved.marker.get() === "REVIEW_POLICY", String(resolved.marker.get()));
}

console.log("\n9. Reason language is optional and works without a model route");
for (const [language, phrase] of [["zh", "Simplified Chinese"], ["en", "write its value in English"]]) {
  const { ctx, listeners, dispatched } = fakeContext();
  apply(ctx, liveConfig({ reasonLanguage: language }));
  const original = reviewRequest();
  await through(listeners.get("llm/stream"), original);
  const forwarded = dispatched[0];
  check(`${language}: exactly one language-adjusted call`, dispatched.length === 1, `dispatched ${dispatched.length}`);
  check(`${language}: session provider preserved`, forwarded?.provider === original.provider, String(forwarded?.provider));
  check(`${language}: session model preserved`, forwarded?.model === original.model, String(forwarded?.model));
  check(`${language}: original policy stays at the start`, forwarded?.system.startsWith(original.system), forwarded?.system);
  check(`${language}: language instruction is appended`, forwarded?.system.includes(phrase), forwarded?.system);
  check(`${language}: messages remain the same object`, forwarded?.messages === original.messages);
  check(`${language}: temperature and signal are preserved`, forwarded?.temperature === 0 && forwarded?.signal === original.signal);
}

console.log("\n10. An unusable target still falls back while applying the selected reason language");
{
  const { ctx, listeners, dispatched, logs } = fakeContext({ providers: ["session-provider"] });
  apply(ctx, liveConfig({ provider: "missing-provider", model: "missing-model", reasonLanguage: "zh" }));
  const original = reviewRequest();
  await through(listeners.get("llm/stream"), original);
  const forwarded = dispatched[0];
  check("one fallback call is dispatched", dispatched.length === 1, `dispatched ${dispatched.length}`);
  check("fallback retains the session route", forwarded?.provider === original.provider && forwarded?.model === original.model);
  check("language instruction remains active on fallback", forwarded?.system.includes("Simplified Chinese"), forwarded?.system);
  check("unusable route is diagnosed once", logs.length === 1, String(logs.length));
}

console.log("\n11. Saving reasonLanguage persists through the Host settings bridge");
{
  const { ctx } = fakeContext();
  const values = { provider: "", model: "", fallbackEnabled: false, fallbackProvider: "", fallbackModel: "", reasoningEffort: "", reasonLanguage: "", debug: false, retryEnabled: false, retryAttempts: 2, marker: "REVIEW_POLICY" };
  const operations = [];
  const handlers = new Map();
  let revision = 7;
  const settings = {
    describe: () => [{ ns: "auto-review-route", revision, value: { ...values } }],
    mutate: async (ns, ops, expected) => {
      if (ns !== "auto-review-route" || expected !== revision) throw new Error("unexpected settings mutation");
      operations.push(...ops);
      for (const op of ops) if (op.op === "set") values[op.path[0]] = op.value;
      revision += 1;
    },
  };
  const child = {
    get: (key) => key === "connection" ? { requestRejection: () => undefined } : key === "webServer" ? {
      register: ({ path, handler }) => {
        handlers.set(path, handler);
        return () => handlers.delete(path);
      },
    } : undefined,
    effect: (body) => {
      const dispose = typeof body === "function" ? body() : undefined;
      return typeof dispose === "function" ? dispose : () => {};
    },
  };
  ctx.get = (key) => key === "settings" ? settings : undefined;
  ctx.inject = (_services, callback) => {
    callback(child);
    return () => {};
  };
  apply(ctx, liveConfig({}));

  const body = { values: { ...values, fallbackEnabled: true, fallbackProvider: "backup", fallbackModel: "backup-model", reasonLanguage: "zh", debug: true, retryEnabled: true, retryAttempts: 3, ignored: "not writable" }, revision };
  const request = {
    method: "POST",
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
  const response = {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  await handlers.get("/api/dsh-auto-review-route/save")(request, response);
  check("reasonLanguage is included in the settings mutation", operations.some((op) => op.path[0] === "reasonLanguage" && op.value === "zh"));
  check("debug is persisted as a boolean", operations.some((op) => op.path[0] === "debug" && op.value === true));
  check("retry toggle and count are persisted", operations.some((op) => op.path[0] === "retryEnabled" && op.value === true) && operations.some((op) => op.path[0] === "retryAttempts" && op.value === 3));
  check("fallback fields are persisted", operations.some((op) => op.path[0] === "fallbackEnabled" && op.value === true) && operations.some((op) => op.path[0] === "fallbackProvider" && op.value === "backup") && operations.some((op) => op.path[0] === "fallbackModel" && op.value === "backup-model"));
  check("unknown fields stay excluded", !operations.some((op) => op.path[0] === "ignored"));
  check("save response returns persisted settings", response.body?.ok === true && response.body.value.values.reasonLanguage === "zh" && response.body.value.values.debug === true && response.body.value.values.retryEnabled === true && response.body.value.values.retryAttempts === 3 && response.body.value.values.fallbackEnabled === true && response.body.value.values.fallbackProvider === "backup" && response.body.value.values.fallbackModel === "backup-model", JSON.stringify(response.body));

  const invalidBody = { values: { retryAttempts: 6 }, revision };
  const invalidRequest = {
    method: "POST",
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(invalidBody));
    },
  };
  const invalidResponse = {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  const operationCount = operations.length;
  await handlers.get("/api/dsh-auto-review-route/save")(invalidRequest, invalidResponse);
  check("out-of-range retry count is rejected without mutation", invalidResponse.body?.code === "invalid-value" && operations.length === operationCount, JSON.stringify(invalidResponse.body));

  const incompleteRequest = {
    method: "POST",
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ values: { fallbackProvider: "backup" }, revision }));
    },
  };
  const incompleteResponse = {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  await handlers.get("/api/dsh-auto-review-route/save")(incompleteRequest, incompleteResponse);
  check("incomplete fallback route is rejected without mutation", incompleteResponse.body?.code === "invalid-value" && operations.length === operationCount, JSON.stringify(incompleteResponse.body));
}

console.log("\n12. Debug logging captures causes without recording request content");
{
  const root = Object.assign(new Error("socket hang up at https://private.example/path?api_key=SECRET"), { code: "ECONNRESET" });
  const transport = new Error("DeepSeek Messages transport failed", { cause: root });
  const { ctx, listeners, logs } = fakeContext({
    stream: () => (async function* () { throw transport; })(),
  });
  apply(ctx, liveConfig({ provider: "target", model: "flash", debug: true }));
  try {
    await through(listeners.get("llm/stream"), reviewRequest());
  } catch {}
  const records = logs
    .filter((line) => line.startsWith("auto-review-route: debug "))
    .map((line) => JSON.parse(line.slice("auto-review-route: debug ".length)));
  const finished = records.find((entry) => entry.event === "review.finished");
  const rendered = JSON.stringify(records);
  check("a thrown transport error is recorded", finished?.outcome === "threw", JSON.stringify(finished));
  check("nested cause code is retained", rendered.includes("ECONNRESET"), rendered);
  check("effective route is recorded", finished?.effectiveRoute?.provider === "target" && finished?.effectiveRoute?.model === "flash");
  check("credentials and URL are redacted", !rendered.includes("SECRET") && !rendered.includes("private.example"), rendered);
  check("prompt and message text are not recorded", !rendered.includes("REVIEW_POLICY") && !rendered.includes("ENVIRONMENT") && !rendered.includes("PENDING_ACTION"), rendered);
}

console.log("\n13. Structured LLM finish failures are captured without chunk text");
{
  const { ctx, listeners, logs } = fakeContext({
    stream: () => (async function* () {
      yield { type: "text-delta", text: "private streamed content" };
      yield { type: "finish", reason: { kind: "error", failure: { code: "TRANSPORT", status: 502, message: "upstream failed" } } };
    })(),
  });
  apply(ctx, liveConfig({ provider: "target", model: "flash", debug: true }));
  await through(listeners.get("llm/stream"), reviewRequest());
  const records = logs.filter((line) => line.startsWith("auto-review-route: debug "));
  const rendered = records.join("\n");
  check("finish failure code and status are logged", rendered.includes("TRANSPORT") && rendered.includes("502"), rendered);
  check("streamed text is never logged", !rendered.includes("private streamed content"), rendered);
  check("finish error is distinguishable", rendered.includes("finishKind") && rendered.includes("error"), rendered);
}

console.log("\n14. Debug logging identifies streams that end without a finish chunk");
{
  const { ctx, listeners, logs } = fakeContext({
    stream: () => (async function* () { yield { type: "text-delta", text: "partial" }; })(),
  });
  apply(ctx, liveConfig({ provider: "target", model: "flash", debug: true }));
  await through(listeners.get("llm/stream"), reviewRequest());
  const record = logs
    .filter((line) => line.startsWith("auto-review-route: debug "))
    .map((line) => JSON.parse(line.slice("auto-review-route: debug ".length)))
    .find((entry) => entry.event === "review.finished");
  check("missing finish chunk has a distinct outcome", record?.outcome === "ended-without-finish", JSON.stringify(record));
}

console.log("\n15. Authenticated diagnostics bridge exposes a bounded in-memory ring");
{
  const { ctx, listeners } = fakeContext();
  const handlers = new Map();
  let rejection;
  const child = {
    get: (key) => key === "connection" ? { requestRejection: () => rejection } : key === "webServer" ? {
      register: ({ path, handler }) => {
        handlers.set(path, handler);
        return () => handlers.delete(path);
      },
    } : undefined,
    effect: (body) => {
      const dispose = typeof body === "function" ? body() : undefined;
      return typeof dispose === "function" ? dispose : () => {};
    },
  };
  ctx.inject = (_services, callback) => {
    callback(child);
    return () => {};
  };
  apply(ctx, liveConfig({ debug: true }));
  const listener = listeners.get("llm/stream");
  for (let i = 0; i < 51; i += 1) await through(listener, reviewRequest());

  const request = { method: "POST", async *[Symbol.asyncIterator]() {} };
  const response = {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  await handlers.get("/api/dsh-auto-review-route/debug-logs")(request, response);
  const records = response.body?.value?.records ?? [];
  check("diagnostic endpoint returns success", response.status === 200 && response.body?.ok === true);
  check("diagnostic history is bounded to 100 entries", records.length === 100, String(records.length));
  check("ring retains the newest start and finish events", records[0]?.event === "review.started" && records.at(-1)?.event === "review.finished");
  const rendered = JSON.stringify(records);
  check("request prompt and message content are excluded", !rendered.includes("REVIEW_POLICY") && !rendered.includes("PENDING_ACTION"), rendered.slice(0, 160));

  rejection = 403;
  const deniedResponse = {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  await handlers.get("/api/dsh-auto-review-route/debug-logs")(request, deniedResponse);
  check("unauthenticated diagnostic read is denied", deniedResponse.status === 403 && deniedResponse.body?.ok === false);

  rejection = undefined;
  const clearedResponse = {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  await handlers.get("/api/dsh-auto-review-route/debug-logs/clear")(request, clearedResponse);
  check("clear endpoint empties the ring", clearedResponse.body?.ok === true && clearedResponse.body.value.cleared === true);
  const rereadResponse = {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  await handlers.get("/api/dsh-auto-review-route/debug-logs")(request, rereadResponse);
  check("cleared diagnostics read as an empty list", rereadResponse.body?.value?.records?.length === 0);
}

console.log("\n16. Terminal failures stay failed when the consumer stops at finish");
{
  const { ctx, listeners, logs } = fakeContext({
    stream: () => (async function* () {
      yield { type: "finish", reason: { kind: "error", failure: { code: "TRANSPORT", message: "connection failed" } } };
    })(),
  });
  apply(ctx, liveConfig({ provider: "target", model: "flash", debug: true }));
  const downstream = (async function* () {
    yield { type: "finish", reason: { kind: "stop" } };
  })();
  for await (const chunk of listeners.get("llm/stream")(reviewRequest(), () => downstream)) {
    if (chunk.type === "finish") break;
  }
  const finished = logs
    .filter((line) => line.startsWith("auto-review-route: debug "))
    .map((line) => JSON.parse(line.slice("auto-review-route: debug ".length)))
    .find((entry) => entry.event === "review.finished");
  check("terminal error remains failed after early consumer return", finished?.outcome === "failed", JSON.stringify(finished));
  check("finish failure remains identifiable", finished?.finishKind === "error" && finished?.failure?.code === "TRANSPORT");
  check("request abort state is explicit", finished?.signalAborted === false, JSON.stringify(finished));
}

console.log("17. Aborted terminal finishes report an aborted signal");
{
  const controller = new AbortController();
  const { ctx, listeners, logs } = fakeContext({
    stream: () => (async function* () {
      controller.abort();
      yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "request aborted" } } };
    })(),
  });
  apply(ctx, liveConfig({ provider: "target", model: "flash", debug: true }));
  const downstream = (async function* () {
    yield { type: "finish", reason: { kind: "stop" } };
  })();
  for await (const chunk of listeners.get("llm/stream")(reviewRequest({ signal: controller.signal }), () => downstream)) {
    if (chunk.type === "finish") break;
  }
  const finished = logs
    .filter((line) => line.startsWith("auto-review-route: debug "))
    .map((line) => JSON.parse(line.slice("auto-review-route: debug ".length)))
    .find((entry) => entry.event === "review.finished");
  check("aborted finish remains aborted after early consumer return", finished?.outcome === "aborted", JSON.stringify(finished));
  check("an aborted finish reports the cancelled signal", finished?.signalAborted === true, JSON.stringify(finished));
}

console.log("\\n18. Automatic retry hides failed partial output and returns the successful attempt");
{
  let attempt = 0;
  const { ctx, listeners, dispatched, logs } = fakeContext({
    providers: ["session-provider", "target"],
    stream: () => {
      attempt += 1;
      return (async function* () {
        if (attempt === 1) {
          yield { type: "text-delta", text: "discard this failed response" };
          yield { type: "finish", reason: { kind: "error", failure: { code: "TRANSPORT", message: "temporary failure" } } };
          yield { type: "text-delta", text: "must not be consumed after finish" };
          return;
        }
        yield* validReviewResponse("final review response");
      })();
    },
  });
  apply(ctx, liveConfig({ provider: "target", model: "flash", retryEnabled: true, retryAttempts: 1, debug: true }));
  const chunks = await through(listeners.get("llm/stream"), reviewRequest());
  const rendered = JSON.stringify(chunks);
  const records = logs
    .filter((line) => line.startsWith("auto-review-route: debug "))
    .map((line) => JSON.parse(line.slice("auto-review-route: debug ".length)));
  const finished = records.find((entry) => entry.event === "review.finished");
  check("one configured retry means two total dispatches", dispatched.length === 2, String(dispatched.length));
  check("failed partial output and error finish are withheld", !rendered.includes("discard this failed response") && !rendered.includes("TRANSPORT"), rendered);
  check("only successful attempt is forwarded", rendered.includes("final review response") && chunks.at(-1)?.reason?.kind === "stop", rendered);
  check("retry diagnostics and attempt count are recorded", records.some((entry) => entry.event === "review.retry") && finished?.attemptCount === 2 && finished?.retriesUsed === 1, JSON.stringify(finished));
  check("chunks after a terminal finish are not consumed", finished?.chunkCount === 5, JSON.stringify(finished));
}

console.log("\\n19. Retries also recover the session route when no rewrite is configured");
{
  const { ctx, listeners, dispatched } = fakeContext();
  apply(ctx, liveConfig({ retryEnabled: true, retryAttempts: 1 }));
  const original = reviewRequest();
  let nextCalls = 0;
  const failed = (async function* () {
    yield { type: "finish", reason: { kind: "error", failure: { code: "TRANSPORT", message: "temporary failure" } } };
  })();
  const chunks = [];
  for await (const chunk of listeners.get("llm/stream")(original, () => {
    nextCalls += 1;
    return failed;
  })) chunks.push(chunk);
  check("initial request uses the original waterfall next", nextCalls === 1);
  check("retry redispatches the unchanged session request", dispatched.length === 1 && dispatched[0] === original);
  check("failed finish is not returned", chunks.at(-1)?.reason?.kind === "stop", JSON.stringify(chunks));
}

console.log("\\n20. Configured additional attempts cap the total number of calls");
{
  const { ctx, listeners, dispatched } = fakeContext({
    providers: ["session-provider", "target"],
    stream: () => (async function* () {
      yield { type: "finish", reason: { kind: "error", failure: { code: "TRANSPORT", message: "still failing" } } };
    })(),
  });
  apply(ctx, liveConfig({ provider: "target", model: "flash", retryEnabled: true, retryAttempts: 2 }));
  const chunks = await through(listeners.get("llm/stream"), reviewRequest());
  check("two additional retries make exactly three dispatches", dispatched.length === 3, String(dispatched.length));
  check("the last failure reaches the official consumer", chunks.at(-1)?.reason?.kind === "error" && chunks.at(-1)?.reason?.failure?.code === "TRANSPORT", JSON.stringify(chunks));
}

console.log("\\n21. User cancellation is never retried");
{
  const controller = new AbortController();
  const { ctx, listeners, dispatched } = fakeContext({
    stream: () => (async function* () {
      controller.abort();
      yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "cancelled" } } };
    })(),
  });
  apply(ctx, liveConfig({ provider: "target", model: "flash", retryEnabled: true, retryAttempts: 5 }));
  const chunks = await through(listeners.get("llm/stream"), reviewRequest({ signal: controller.signal }));
  check("aborted stream has one dispatch", dispatched.length === 1, String(dispatched.length));
  check("aborted finish is preserved", chunks.at(-1)?.reason?.kind === "aborted", JSON.stringify(chunks));
}

console.log("\\n22. A thrown terminal stream error still propagates after cancellation");
{
  const controller = new AbortController();
  const expected = new Error("cancelled stream transport failure");
  const { ctx, listeners, dispatched } = fakeContext({
    stream: () => (async function* () {
      controller.abort();
      throw expected;
    })(),
  });
  apply(ctx, liveConfig({ provider: "target", model: "flash", retryEnabled: true, retryAttempts: 3 }));
  let caught;
  try {
    await through(listeners.get("llm/stream"), reviewRequest({ signal: controller.signal }));
  } catch (error) {
    caught = error;
  }
  check("cancelled thrown stream is not retried", dispatched.length === 1, String(dispatched.length));
  check("original stream exception propagates", caught === expected, String(caught));
}

console.log("\\n23. Automatic retry recovers a thrown transient stream error");
{
  let attempt = 0;
  const { ctx, listeners, dispatched } = fakeContext({
    stream: () => {
      attempt += 1;
      return (async function* () {
        if (attempt === 1) throw new Error("temporary stream exception");
        yield* validReviewResponse("recovered response");
      })();
    },
  });
  apply(ctx, liveConfig({ provider: "target", model: "flash", retryEnabled: true, retryAttempts: 1 }));
  const chunks = await through(listeners.get("llm/stream"), reviewRequest());
  check("thrown transient failure is redispatched once", dispatched.length === 2, String(dispatched.length));
  check("successful retry response is delivered", chunks.some((chunk) => chunk.text === "recovered response") && chunks.at(-1)?.reason?.kind === "stop", JSON.stringify(chunks));
}

console.log("\\n24. The fallback route gets its own retry budget and hides both failed streams");
{
  let backupAttempts = 0;
  const { ctx, listeners, dispatched, logs } = fakeContext({
    providers: ["session-provider", "primary", "backup"],
    stream: (options) => (async function* () {
      if (options.provider === "primary") {
        yield { type: "text-delta", text: "discard primary partial" };
        yield { type: "finish", reason: { kind: "error", failure: { code: "PRIMARY_DOWN", message: "primary failed" } } };
        return;
      }
      backupAttempts += 1;
      if (backupAttempts === 1) {
        yield { type: "text-delta", text: "discard fallback partial" };
        yield { type: "finish", reason: { kind: "error", failure: { code: "BACKUP_DOWN", message: "backup failed once" } } };
        return;
      }
      yield* validReviewResponse("fallback recovered");
    })(),
  });
  apply(ctx, liveConfig({
    provider: "primary",
    model: "primary-model",
    fallbackEnabled: true,
    fallbackProvider: "backup",
    fallbackModel: "backup-model",
    retryEnabled: true,
    retryAttempts: 1,
    debug: true,
  }));
  const chunks = await through(listeners.get("llm/stream"), reviewRequest());
  const records = logs
    .filter((line) => line.startsWith("auto-review-route: debug "))
    .map((line) => JSON.parse(line.slice("auto-review-route: debug ".length)));
  const finished = records.find((entry) => entry.event === "review.finished");
  check("primary and fallback each receive one retry", dispatched.length === 4, String(dispatched.length));
  check("fallback uses the configured provider and model", dispatched.slice(2).every((options) => options.provider === "backup" && options.model === "backup-model"));
  check("only the final fallback chunks reach Auto-review", JSON.stringify(chunks).includes("fallback recovered") && !JSON.stringify(chunks).includes("discard") && chunks.at(-1)?.reason?.kind === "stop", JSON.stringify(chunks));
  check("diagnostics count route retries separately from calls", finished?.attemptCount === 4 && finished?.retriesUsed === 2 && finished?.fallbackUsed === true && finished?.routeStage === "fallback", JSON.stringify(finished));
}

console.log("\\n25. Empty fallback route returns to the session model and can retry");
{
  let sessionNextCalls = 0;
  const { ctx, listeners, dispatched } = fakeContext({
    providers: ["session-provider", "primary"],
    stream: (options) => (async function* () {
      if (options.provider === "primary") {
        yield { type: "finish", reason: { kind: "error", failure: { code: "PRIMARY_DOWN", message: "primary failed" } } };
        return;
      }
      yield* validReviewResponse("session retry recovered");
    })(),
  });
  apply(ctx, liveConfig({
    provider: "primary",
    model: "primary-model",
    fallbackEnabled: true,
    retryEnabled: true,
    retryAttempts: 1,
  }));
  const original = reviewRequest();
  const chunks = [];
  const failedSession = (async function* () {
    yield { type: "finish", reason: { kind: "error", failure: { code: "SESSION_DOWN", message: "session failed once" } } };
  })();
  for await (const chunk of listeners.get("llm/stream")(original, () => {
    sessionNextCalls += 1;
    return failedSession;
  })) chunks.push(chunk);
  check("session route is reached after primary retries", sessionNextCalls === 1 && dispatched.length === 3 && dispatched[0].provider === "primary" && dispatched[2].provider === "session-provider");
  check("session fallback receives the configured retry", chunks.some((chunk) => chunk.text === "session retry recovered") && chunks.at(-1)?.reason?.kind === "stop", JSON.stringify(chunks));
}

console.log("\\n26. With retries disabled, fallback follows the first retryable failure");
{
  const { ctx, listeners, dispatched } = fakeContext({
    providers: ["session-provider", "primary"],
    stream: () => (async function* () {
      yield { type: "finish", reason: { kind: "error", failure: { code: "PRIMARY_DOWN", message: "primary failed" } } };
    })(),
  });
  apply(ctx, liveConfig({ provider: "primary", model: "primary-model", fallbackEnabled: true }));
  const chunks = [];
  let sessionCalls = 0;
  for await (const chunk of listeners.get("llm/stream")(reviewRequest(), () => {
    sessionCalls += 1;
    return (async function* () { yield* validReviewResponse(); })();
  })) chunks.push(chunk);
  check("one primary request immediately switches to the session route", dispatched.length === 1 && sessionCalls === 1, String(dispatched.length));
  check("the session route response is returned", chunks.at(-1)?.reason?.kind === "stop", JSON.stringify(chunks));
}

console.log("\\n27. User cancellation does not activate a configured fallback");
{
  const controller = new AbortController();
  const { ctx, listeners, dispatched } = fakeContext({
    providers: ["session-provider", "primary", "backup"],
    stream: () => (async function* () {
      controller.abort();
      yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "cancelled" } } };
    })(),
  });
  apply(ctx, liveConfig({
    provider: "primary",
    model: "primary-model",
    fallbackEnabled: true,
    fallbackProvider: "backup",
    fallbackModel: "backup-model",
    retryEnabled: true,
    retryAttempts: 2,
  }));
  const chunks = await through(listeners.get("llm/stream"), reviewRequest({ signal: controller.signal }));
  check("cancelled primary makes one dispatch", dispatched.length === 1, String(dispatched.length));
  check("aborted finish is preserved", chunks.at(-1)?.reason?.kind === "aborted", JSON.stringify(chunks));
}

console.log("\\n28. A normal primary response never activates fallback");
{
  const { ctx, listeners, dispatched } = fakeContext({
    providers: ["session-provider", "primary", "backup"],
    stream: () => (async function* () {
      yield* validReviewResponse("primary response");
    })(),
  });
  apply(ctx, liveConfig({
    provider: "primary",
    model: "primary-model",
    fallbackEnabled: true,
    fallbackProvider: "backup",
    fallbackModel: "backup-model",
    retryEnabled: true,
    retryAttempts: 2,
  }));
  const chunks = await through(listeners.get("llm/stream"), reviewRequest());
  check("normal primary response uses one request", dispatched.length === 1, String(dispatched.length));
  check("normal primary response reaches Auto-review", chunks.some((chunk) => chunk.text === "primary response") && chunks.at(-1)?.reason?.kind === "stop", JSON.stringify(chunks));
}

console.log("\\n29. An invalid primary decision is discarded before fallback output");
{
  const { ctx, listeners, dispatched, logs } = fakeContext({
    providers: ["session-provider", "primary", "backup"],
    stream: (options) => (async function* () {
      if (options.provider === "primary") {
        yield { type: "text-delta", index: 0, text: "not JSON" };
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      yield* validReviewResponse("valid fallback");
    })(),
  });
  apply(ctx, liveConfig({
    provider: "primary",
    model: "primary-model",
    fallbackEnabled: true,
    fallbackProvider: "backup",
    fallbackModel: "backup-model",
    debug: true,
  }));
  const chunks = await through(listeners.get("llm/stream"), reviewRequest());
  const rendered = JSON.stringify(chunks);
  const records = logs
    .filter((line) => line.startsWith("auto-review-route: debug "))
    .map((line) => JSON.parse(line.slice("auto-review-route: debug ".length)));
  const fallback = records.find((entry) => entry.event === "review.fallback");
  const finished = records.find((entry) => entry.event === "review.finished");
  check("invalid primary response activates configured fallback", dispatched.length === 2 && dispatched[1].provider === "backup");
  check("primary body is withheld and valid fallback is delivered", !rendered.includes("not JSON") && rendered.includes("valid fallback") && chunks.at(-1)?.reason?.kind === "stop", rendered);
  check("parse failure is diagnosed without response content", fallback?.reason === "invalid-result" && finished?.fallbackUsed === true && finished?.outcome === "completed" && !JSON.stringify(records).includes("not JSON"), JSON.stringify(records));
}

console.log("\\n30. Invalid primary and fallback decisions consume each route budget");
{
  let primaryAttempts = 0;
  let backupAttempts = 0;
  const { ctx, listeners, dispatched, logs } = fakeContext({
    providers: ["session-provider", "primary", "backup"],
    stream: (options) => (async function* () {
      if (options.provider === "primary") {
        primaryAttempts += 1;
        yield { type: "text-delta", index: 0, text: `bad primary ${primaryAttempts}` };
      } else {
        backupAttempts += 1;
        const text = backupAttempts === 1
          ? '{"risk":"high","decision":"allow"}'
          : '{"risk":"medium","decision":"deny","reason":"reviewed"}';
        yield { type: "text-delta", index: 0, text };
      }
      yield { type: "finish", reason: { kind: "stop" } };
    })(),
  });
  apply(ctx, liveConfig({
    provider: "primary",
    model: "primary-model",
    fallbackEnabled: true,
    fallbackProvider: "backup",
    fallbackModel: "backup-model",
    retryEnabled: true,
    retryAttempts: 1,
    debug: true,
  }));
  const chunks = await through(listeners.get("llm/stream"), reviewRequest());
  const rendered = JSON.stringify(chunks);
  const records = logs
    .filter((line) => line.startsWith("auto-review-route: debug "))
    .map((line) => JSON.parse(line.slice("auto-review-route: debug ".length)));
  const retries = records.filter((entry) => entry.event === "review.retry");
  const finished = records.find((entry) => entry.event === "review.finished");
  check("both routes use two total attempts", dispatched.length === 4 && primaryAttempts === 2 && backupAttempts === 2, String(dispatched.length));
  check("invalid result retries are recorded per route", retries.some((entry) => entry.stage === "primary" && entry.reason === "invalid-result") && retries.some((entry) => entry.stage === "fallback" && entry.reason === "invalid-result"), JSON.stringify(retries));
  check("only the last valid fallback attempt is exposed", !rendered.includes("bad primary") && !rendered.includes("high\\\",\\\"decision\\\":\\\"allow") && rendered.includes("reviewed") && chunks.at(-1)?.reason?.kind === "stop", rendered);
  check("retry accounting includes both routes", finished?.attemptCount === 4 && finished?.retriesUsed === 2 && finished?.routeStage === "fallback", JSON.stringify(finished));
}

console.log("\\n31. A terminal fallback transport error is preserved without another route");
{
  const { ctx, listeners, dispatched, logs } = fakeContext({
    providers: ["session-provider", "primary", "backup"],
    stream: (options) => (async function* () {
      if (options.provider === "primary") {
        yield { type: "text-delta", index: 0, text: "invalid primary JSON" };
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      yield { type: "finish", reason: { kind: "error", failure: { code: "BACKUP_DOWN", message: "fallback unavailable" } } };
    })(),
  });
  apply(ctx, liveConfig({
    provider: "primary",
    model: "primary-model",
    fallbackEnabled: true,
    fallbackProvider: "backup",
    fallbackModel: "backup-model",
    debug: true,
  }));
  const chunks = await through(listeners.get("llm/stream"), reviewRequest());
  const finished = logs
    .filter((line) => line.startsWith("auto-review-route: debug "))
    .map((line) => JSON.parse(line.slice("auto-review-route: debug ".length)))
    .find((entry) => entry.event === "review.finished");
  check("fallback failure does not loop or dispatch a third route", dispatched.length === 2, String(dispatched.length));
  check("official consumer receives the terminal fallback error", chunks.at(-1)?.reason?.kind === "error" && chunks.at(-1)?.reason?.failure?.code === "BACKUP_DOWN", JSON.stringify(chunks));
  check("final diagnostics remain failed at fallback stage", finished?.fallbackUsed === true && finished?.routeStage === "fallback" && finished?.outcome === "failed", JSON.stringify(finished));
}

console.log("\\n32. An invalid session-route fallback remains final and fail-closed");
{
  let sessionCalls = 0;
  const { ctx, listeners, dispatched, logs } = fakeContext({
    providers: ["session-provider", "primary"],
    stream: () => (async function* () {
      yield { type: "text-delta", index: 0, text: "invalid primary JSON" };
      yield { type: "finish", reason: { kind: "stop" } };
    })(),
  });
  apply(ctx, liveConfig({ provider: "primary", model: "primary-model", fallbackEnabled: true, debug: true }));
  const chunks = [];
  for await (const chunk of listeners.get("llm/stream")(reviewRequest(), () => {
    sessionCalls += 1;
    return (async function* () {
      yield { type: "text-delta", index: 0, text: "not JSON from session" };
      yield { type: "finish", reason: { kind: "stop" } };
    })();
  })) chunks.push(chunk);
  const rendered = JSON.stringify(chunks);
  const finished = logs
    .filter((line) => line.startsWith("auto-review-route: debug "))
    .map((line) => JSON.parse(line.slice("auto-review-route: debug ".length)))
    .find((entry) => entry.event === "review.finished");
  check("session fallback is called once and no recursive route is dispatched", sessionCalls === 1 && dispatched.length === 1, `${sessionCalls}/${dispatched.length}`);
  check("invalid primary is hidden and final invalid session output reaches official parser", !rendered.includes("invalid primary JSON") && rendered.includes("not JSON from session"), rendered);
  check("final invalid session response is diagnosed, not accepted", finished?.fallbackUsed === true && finished?.routeStage === "fallback" && finished?.outcome === "invalid-result", JSON.stringify(finished));
  const sessionText = chunks.find((chunk) => chunk.type === "text-delta")?.text;
  let officialParserRejects = false;
  try {
    JSON.parse(sessionText);
  } catch {
    officialParserRejects = true;
  }
  check("the final session payload still fails official JSON parsing", officialParserRejects, String(sessionText));
}

console.log("\\n33. Valid allow and deny decisions never activate fallback");
{
  for (const [label, text] of [
    ["allow", '{"risk":"low","decision":"allow"}'],
    ["deny", '{"risk":"high","decision":"deny","reason":"unsafe"}'],
  ]) {
    const { ctx, listeners, dispatched } = fakeContext({
      providers: ["session-provider", "primary", "backup"],
      stream: () => (async function* () {
        yield { type: "text-delta", index: 0, text };
        yield { type: "finish", reason: { kind: "stop" } };
      })(),
    });
    apply(ctx, liveConfig({
      provider: "primary",
      model: "primary-model",
      fallbackEnabled: true,
      fallbackProvider: "backup",
      fallbackModel: "backup-model",
      retryEnabled: true,
      retryAttempts: 1,
    }));
    await through(listeners.get("llm/stream"), reviewRequest());
    check(`valid ${label} decision has one dispatch`, dispatched.length === 1, String(dispatched.length));
  }
}

console.log("\\n34. Non-decision block shapes and non-stop finishes trigger fallback");
{
  const invalidCases = [
    {
      label: "duplicate root member",
      chunks: [
        { type: "text-delta", index: 0, text: '{"risk":"low","decision":"allow","risk":"low"}' },
        { type: "finish", reason: { kind: "stop" } },
      ],
    },
    {
      label: "text followed by reasoning",
      chunks: [
        { type: "text-delta", index: 0, text: '{"risk":"low","decision":"allow"}' },
        { type: "reasoning-delta", index: 1, text: "late reasoning" },
        { type: "finish", reason: { kind: "stop" } },
      ],
    },
    {
      label: "max-tokens finish",
      chunks: [
        { type: "text-delta", index: 0, text: '{"risk":"low","decision":"allow"}' },
        { type: "finish", reason: { kind: "max-tokens" } },
      ],
    },
  ];
  for (const invalidCase of invalidCases) {
    const { ctx, listeners, dispatched } = fakeContext({
      providers: ["session-provider", "primary", "backup"],
      stream: (options) => (async function* () {
        if (options.provider === "primary") {
          yield* invalidCase.chunks;
          return;
        }
        yield* validReviewResponse("recovered after invalid protocol");
      })(),
    });
    apply(ctx, liveConfig({
      provider: "primary",
      model: "primary-model",
      fallbackEnabled: true,
      fallbackProvider: "backup",
      fallbackModel: "backup-model",
    }));
    const chunks = await through(listeners.get("llm/stream"), reviewRequest());
    check(`${invalidCase.label} falls back once`, dispatched.length === 2 && dispatched[1].provider === "backup" && chunks.at(-1)?.reason?.kind === "stop", JSON.stringify(chunks));
  }
}

console.log("\\n35. Official block framing and usage chunks remain valid");
{
  const { ctx, listeners, dispatched } = fakeContext({
    providers: ["session-provider", "primary", "backup"],
    stream: () => (async function* () {
      yield { type: "block-start", index: 0, blockType: "reasoning" };
      yield { type: "reasoning-delta", index: 0, text: "brief reasoning" };
      yield { type: "block-end", index: 0, block: { type: "reasoning", text: "brief reasoning" } };
      yield { type: "block-start", index: 1, blockType: "text" };
      yield { type: "text-delta", index: 1, text: '{"risk":"medium","decision":"allow"}' };
      yield { type: "usage", usage: { inputTokens: 8, outputTokens: 4 } };
      yield { type: "block-end", index: 1, block: { type: "text", text: '{"risk":"medium","decision":"allow"}' } };
      yield { type: "finish", reason: { kind: "stop" } };
    })(),
  });
  apply(ctx, liveConfig({
    provider: "primary",
    model: "primary-model",
    fallbackEnabled: true,
    fallbackProvider: "backup",
    fallbackModel: "backup-model",
  }));
  const chunks = await through(listeners.get("llm/stream"), reviewRequest());
  check("closed reasoning/text blocks and usage use one primary dispatch", dispatched.length === 1, String(dispatched.length));
  check("usage and protocol-valid framed blocks reach the official consumer", chunks.some((chunk) => chunk.type === "usage") && chunks.at(-1)?.reason?.kind === "stop", JSON.stringify(chunks));
}

console.log("\\n36. Both shipped reviewer protocols are recognised");
{
  // 0.2.2-rc.1 sends `purpose: "auto-review"`; 0.2.1 and earlier sent the
  // same request with no tag. Both must be rerouted, otherwise the plugin
  // silently goes inert on the newer runtime.
  for (const [label, build] of [["tagged (0.2.2+)", reviewRequest], ["untagged (0.2.1 and earlier)", legacyReviewRequest]]) {
    const { ctx, listeners, dispatched } = fakeContext({ providers: ["session-provider", "target"] });
    apply(ctx, liveConfig({ provider: "target", model: "target-model" }));
    const original = build();
    await through(listeners.get("llm/stream"), original);
    check(`${label}: rerouted once`, dispatched.length === 1, `dispatched ${dispatched.length}`);
    check(`${label}: provider rewritten`, dispatched[0]?.provider === "target", String(dispatched[0]?.provider));
    check(`${label}: purpose forwarded unchanged`, dispatched[0]?.purpose === original.purpose, String(dispatched[0]?.purpose));
  }
}

console.log("\\n37. Another producer's purpose tag is never rerouted");
{
  for (const purpose of ["compaction", "session-title", "some-future-auxiliary-call"]) {
    const { ctx, listeners, dispatched } = fakeContext({ providers: ["session-provider", "target"] });
    apply(ctx, liveConfig({ provider: "target", model: "target-model" }));
    await through(listeners.get("llm/stream"), reviewRequest({ purpose }));
    check(`purpose "${purpose}" left alone`, dispatched.length === 0, `dispatched ${dispatched.length}`);
  }
}

console.log(failures === 0 ? "\\nAll checks passed.\\n" : `\\n${failures} check(s) failed.\\n`);
process.exitCode = failures === 0 ? 0 : 1;
