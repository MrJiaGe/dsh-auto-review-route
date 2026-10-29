/**
 * Auto-review model route.
 *
 * A standalone bundle that lets the user pin the *reviewer* route used by
 * `@deepseek-ai/dsh-experimental-auto-review` to a specific provider/model.
 *
 * The official plugin hard-codes the reviewer to the session's own route:
 *
 *   // dsh-experimental-auto-review/lib/index.js:216-220, 400-414
 *   const header = session.requestHeader()
 *   provider: header.config.provider,
 *   model: header.config.model,
 *   ...
 *   return readDecision(ctx.llm.stream(options))
 *
 * That call goes through the public `llm/stream` waterfall, whose documented
 * purpose includes "routing". This plugin can reroute that one call. By default
 * every request option is forwarded unchanged; when the user explicitly picks a
 * reason language, it appends a narrow instruction affecting only the optional
 * denial-reason wording. The official package and its risk protocol are untouched.
 *
 * Deliberate non-goals:
 * - No provider/model default. An unset route keeps the session's route; the
 *   optional reason-language instruction can be selected independently.
 * - No risk-policy, decision-schema, tool, or lifecycle changes. An opt-in
 *   retry wrapper only repeats failed reviewer model calls.
 * - A unusable configured route fails open to the official route instead of
 *   failing the review, so a typo can never block tool calls.
 *
 * @module @mrjiage/dsh-auto-review-route
 */
import z from "@deepseek-ai/schemastery";

/** Cordis plugin name used by loader diagnostics. */
export const name = "auto-review-route";

/**
 * Services this plugin needs.
 *
 * `settings` and `configEditor` are listed here, not read lazily: the Settings
 * projection only describes an entry whose Fiber reached its active state, and
 * a Fiber reaches it once its declared dependencies are satisfied. Reading an
 * undeclared service later through `ctx.get()` does not participate in that
 * wait, so the row would stay half-activated and never appear in any form.
 *
 * `connection` and `webServer` stay out of this list: a profile without a
 * browser has no bridge to serve, and `ctx.inject([...])` below already waits
 * for them only where they exist.
 */
export const inject = ["llm", "settings", "configEditor"];

/**
 * First line of the official reviewer policy. The official plugin sends it as
 * the complete `system` message (`REVIEW_POLICY` in its lib/index.js:20), so it
 * identifies exactly one kind of request in this process.
 */
const DEFAULT_MARKER = "REVIEW_POLICY";
const DEFAULT_RETRY_ATTEMPTS = 2;
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_INITIAL_DELAY_MS = 300;
const RETRY_MAX_DELAY_MS = 3000;

const REASON_LANGUAGE_INSTRUCTIONS = Object.freeze({
  zh: "When a deny response includes the optional reason field, write its value in Simplified Chinese. This affects wording only: do not change risk classification, decision, JSON keys, allowed object shapes, or any other policy. Return exactly one JSON object and no other text.",
  en: "When a deny response includes the optional reason field, write its value in English. This affects wording only: do not change risk classification, decision, JSON keys, allowed object shapes, or any other policy. Return exactly one JSON object and no other text.",
});

/**
 * Live-editable reviewer controls. Empty route fields keep the session route;
 * an empty reason language leaves the shipped review prompt unchanged.
 */
export const Config = z.object({
  provider: z
    .string()
    .default("")
    .description("Provider route the reviewer should use. Empty keeps the session route.")
    .volatile(),
  model: z
    .string()
    .default("")
    .description("Model id the reviewer should use on that provider. Empty keeps the session route.")
    .volatile(),
  fallbackEnabled: z
    .boolean()
    .default(false)
    .description("Switch to the configured fallback route after the primary route exhausts its attempts.")
    .volatile(),
  fallbackProvider: z
    .string()
    .default("")
    .description("Fallback provider. Leave both fallback route fields empty to use the session route.")
    .volatile(),
  fallbackModel: z
    .string()
    .default("")
    .description("Fallback model id. Leave both fallback route fields empty to use the session route.")
    .volatile(),
  reasoningEffort: z
    .string()
    .default("")
    .description(
      "Optional reasoning effort for the reviewer call. Empty inherits the target model's default. "
        + "Dropped automatically when the target model does not declare it.",
    )
    .volatile(),
  reasonLanguage: z
    .string()
    .default("")
    .description("Optional language for denial reasons. Empty keeps the official prompt unchanged.")
    .volatile(),
  debug: z
    .boolean()
    .default(false)
    .description("Keep redacted Auto-review diagnostics in Host memory and expose them through the authenticated settings page.")
    .volatile(),
  retryEnabled: z
    .boolean()
    .default(false)
    .description("Retry failed Auto-review model calls. User cancellation and normal model responses are never retried.")
    .volatile(),
  retryAttempts: z
    .natural()
    .default(2)
    .min(1)
    .max(5)
    .step(1)
    .description("Additional retry attempts after the initial Auto-review request, from 1 to 5.")
    .volatile(),
  marker: z
    .string()
    .default(DEFAULT_MARKER)
    .description("Reviewer prompt prefix that identifies an auto-review request. Change only if upstream renames it.")
    .volatile(),
});

/** Request objects already rewritten here, so a re-dispatch cannot loop. */
const rewritten = new WeakSet();

/**
 * Read one live config field defensively.
 * @param config - the Loader-provided config object.
 * @param key - field name.
 * @returns the current plain value, or `""` when unreadable.
 */
function read(config, key) {
  const field = config?.[key];
  if (field === undefined || field === null) return "";
  const value = typeof field.get === "function" ? field.get() : field;
  return typeof value === "string" ? value.trim() : "";
}

/** Read one live boolean config field defensively. */
function readBoolean(config, key) {
  const field = config?.[key];
  if (field === undefined || field === null) return false;
  const value = typeof field.get === "function" ? field.get() : field;
  return value === true;
}

function readRetryAttempts(config) {
  const field = config?.retryAttempts;
  const value = typeof field?.get === "function" ? field.get() : field;
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_RETRY_ATTEMPTS
    ? value
    : DEFAULT_RETRY_ATTEMPTS;
}

function retryDelayMs(retryNumber) {
  return Math.min(RETRY_INITIAL_DELAY_MS * 2 ** Math.max(0, retryNumber - 1), RETRY_MAX_DELAY_MS);
}

function waitForRetry(signal, delayMs) {
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (continueRetry) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(continueRetry);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(true), delayMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted === true) finish(false);
  });
}

/** Mirror the official decision grammar before any attempt output is released. */
function topLevelMemberCount(text) {
  const withoutStrings = text.replace(/"(?:\\.|[^"\\])*"/gs, "");
  let depth = 0;
  let count = 0;
  for (const character of withoutStrings) {
    if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
    else if (character === ":" && depth === 1) count += 1;
  }
  return count;
}

function decisionParseFailure(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return "invalid-json";
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "invalid-decision-object";

  const keys = Object.keys(value);
  if (topLevelMemberCount(text) !== keys.length) return "duplicate-decision-member";
  const has = (key) => Object.prototype.hasOwnProperty.call(value, key);
  const risk = value.risk;
  const decision = value.decision;

  if (
    keys.length === 2
    && has("risk")
    && has("decision")
    && ((risk === "low" || risk === "medium") && decision === "allow"
      || (risk === "medium" || risk === "high") && decision === "deny")
  ) return undefined;

  if (
    keys.length === 3
    && has("risk")
    && has("decision")
    && has("reason")
    && (risk === "medium" || risk === "high")
    && decision === "deny"
    && typeof value.reason === "string"
  ) return undefined;

  return "invalid-decision-shape";
}

function assembleDecisionBlocks(chunks) {
  const partials = new Map();
  const order = [];
  const ensure = (index, type) => {
    if (!partials.has(index)) {
      partials.set(index, { type, text: "", block: undefined, closed: false });
      order.push(index);
    }
    const partial = partials.get(index);
    if (partial.type === undefined && type !== undefined) partial.type = type;
    return partial;
  };

  for (const chunk of chunks) {
    switch (chunk?.type) {
      case "block-start":
        ensure(chunk.index, chunk.blockType);
        break;
      case "block-end": {
        if (chunk.block === null || typeof chunk.block !== "object") return undefined;
        const partial = ensure(chunk.index, chunk.block.type);
        if (!partial.closed) {
          partial.block = chunk.block;
          partial.closed = true;
        }
        break;
      }
      case "text-delta":
      case "reasoning-delta": {
        if (typeof chunk.text !== "string") return undefined;
        const type = chunk.type === "text-delta" ? "text" : "reasoning";
        const partial = ensure(chunk.index, type);
        if (!partial.closed) partial.text += chunk.text;
        break;
      }
      case "tool-call-delta": {
        const partial = ensure(chunk.index, "tool-call");
        if (!partial.closed && partial.type === undefined) partial.type = "tool-call";
        break;
      }
      case "usage":
      case "finish":
        break;
      default:
        return undefined;
    }
  }

  return order.map((index) => {
    const partial = partials.get(index);
    return partial.block ?? { type: partial.type, text: partial.text };
  });
}

function reviewResultFailure(chunks) {
  const finish = chunks.at(-1);
  if (finish?.type !== "finish" || finish.reason?.kind !== "stop") return "invalid-finish";

  let blocks;
  try {
    blocks = assembleDecisionBlocks(chunks);
  } catch {
    return "invalid-blocks";
  }
  if (!Array.isArray(blocks) || blocks.length === 0) return "invalid-blocks";
  const decisionBlock = blocks.at(-1);
  if (decisionBlock?.type !== "text" || blocks.slice(0, -1).some((block) => block?.type !== "reasoning")) {
    return "invalid-blocks";
  }
  return decisionParseFailure(decisionBlock.text);
}

/** Collect one route's attempts, exposing only its final attempt to the caller. */
async function runRouteAttempts({ stage, options, maxRetries, dispatch, onChunk, onAttempt, onRetry }) {
  let retriesUsed = 0;

  for (let retryIndex = 0; retryIndex <= maxRetries; retryIndex += 1) {
    const chunks = [];
    let finishKind;
    let failure;
    let error;
    let threw = false;
    onAttempt({ stage, routeAttempt: retryIndex + 1, maxAttempts: maxRetries + 1 });

    try {
      for await (const chunk of dispatch(options)) {
        onChunk(chunk);
        chunks.push(chunk);
        if (chunk?.type === "finish") {
          finishKind = typeof chunk.reason?.kind === "string" ? chunk.reason.kind : "unknown";
          failure = summarizeFailure(chunk.reason?.failure);
          break;
        }
      }
    } catch (attemptError) {
      threw = true;
      error = attemptError;
      failure = summarizeError(attemptError);
    }

    const validationFailure = !threw && finishKind !== undefined && finishKind !== "error" && finishKind !== "aborted"
      ? reviewResultFailure(chunks)
      : undefined;
    if (validationFailure !== undefined) {
      failure = { code: "INVALID_REVIEW_RESULT", message: validationFailure };
    }

    const retryReason = threw
      ? "threw"
      : finishKind === "error"
        ? "finish-error"
        : finishKind === undefined
          ? "missing-finish"
          : validationFailure !== undefined
            ? "invalid-result"
            : undefined;
    const cancelled = options.signal?.aborted === true || finishKind === "aborted";
    if (retryReason !== undefined && retryIndex < maxRetries && !cancelled) {
      const delayMs = retryDelayMs(retryIndex + 1);
      onRetry({ stage, routeAttempt: retryIndex + 1, maxAttempts: maxRetries + 1, reason: retryReason, finishKind, failure, delayMs });
      if (await waitForRetry(options.signal, delayMs)) {
        retriesUsed += 1;
        continue;
      }
    }

    const outcome = options.signal?.aborted === true
      ? "aborted"
      : threw
        ? "threw"
        : finishKind === "error"
          ? "failed"
          : finishKind === "aborted"
            ? "aborted"
            : validationFailure !== undefined
              ? "invalid-result"
              : finishKind === undefined
                ? "ended-without-finish"
                : "completed";
    return {
      chunks,
      error,
      threw,
      finishKind,
      failure,
      outcome,
      retryReason: cancelled ? undefined : retryReason,
      attempts: retryIndex + 1,
      retriesUsed,
    };
  }
}

/** Bound and redact untrusted diagnostic strings before they reach the logger. */
function safeDiagnosticText(value, limit = 400) {
  let text;
  try {
    text = typeof value === "string" ? value : String(value);
  } catch {
    return "[unreadable]";
  }
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(bearer|basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|cookie)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .slice(0, limit);
}

function safeProperty(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

/** Keep only a short, allowlisted cause chain; never serialize stacks or objects. */
function summarizeError(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 6; depth += 1) {
    if ((typeof current !== "object" && typeof current !== "function") || seen.has(current)) break;
    seen.add(current);
    const name = safeProperty(current, "name");
    const code = safeProperty(current, "code");
    const status = safeProperty(current, "status");
    const message = safeProperty(current, "message");
    const entry = {};
    if (typeof name === "string") entry.name = safeDiagnosticText(name, 80);
    if (typeof code === "string" || typeof code === "number") entry.code = safeDiagnosticText(code, 100);
    if (typeof status === "number" && Number.isFinite(status)) entry.status = status;
    if (typeof message === "string") entry.message = safeDiagnosticText(message);
    chain.push(entry);
    current = safeProperty(current, "cause");
  }
  if (chain.length === 0 && error !== undefined) chain.push({ message: safeDiagnosticText(error) });
  return chain;
}

/** Summarize the structured failure attached to an LLM finish chunk. */
function summarizeFailure(failure) {
  if (failure === null || typeof failure !== "object") return undefined;
  const result = {};
  for (const key of ["code", "message", "requestId"]) {
    const value = safeProperty(failure, key);
    if (typeof value === "string" || typeof value === "number") {
      result[key] = safeDiagnosticText(value, key === "message" ? 400 : 120);
    }
  }
  for (const key of ["status", "providerRetryAfterMs"]) {
    const value = safeProperty(failure, key);
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  return result;
}

/**
 * Resolve the configured route into a decision.
 * @param config - the Loader-provided config object.
 * @returns the target route, or `undefined` when the user has not chosen one.
 */
function routeFromConfig(config, providerKey, modelKey, effortKey) {
  const provider = read(config, providerKey);
  const model = read(config, modelKey);
  if (provider.length === 0 || model.length === 0) return undefined;
  const effort = effortKey === undefined ? "" : read(config, effortKey);
  return {
    provider,
    model,
    ...effort.length === 0 ? {} : { reasoningEffort: effort },
  };
}

function target(config) {
  return routeFromConfig(config, "provider", "model", "reasoningEffort");
}

function fallbackTarget(config) {
  return routeFromConfig(config, "fallbackProvider", "fallbackModel");
}

function routeOptions(options, route, effort) {
  if (route === undefined) return options;
  const sameModel = options.provider === route.provider && options.model === route.model;
  if (sameModel && route.reasoningEffort === undefined) return options;

  const forwarded = { ...options, provider: route.provider, model: route.model };
  if (effort === undefined) delete forwarded.reasoningEffort;
  else forwarded.reasoningEffort = effort;
  return forwarded;
}

function sameRoute(left, right) {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort;
}

/**
 * Whether one streaming call is the official auto-review request.
 *
 * All four conditions are properties of the shipped reviewer call and of no
 * other LLM call in this runtime: the fixed `REVIEW_POLICY` system prompt, a
 * zero temperature, no tool schemas, and no `purpose` tag (compaction and
 * session-title calls always carry one).
 *
 * @param options - the waterfall's request options.
 * @param marker - expected reviewer system-prompt prefix.
 * @returns true only for the reviewer call.
 */
function isReviewCall(options, marker) {
  if (options === null || typeof options !== "object") return false;
  if (typeof options.system !== "string" || !options.system.startsWith(marker)) return false;
  if (options.temperature !== 0) return false;
  if (options.tools !== undefined) return false;
  if (options.purpose !== undefined) return false;
  return true;
}

/**
 * Install the reviewer reroute and the read-only list endpoints the
 * configuration page needs, plus its settings and diagnostic-log bridge.
 * @param ctx - Cordis context with the `llm` service.
 * @param config - the Loader-provided live config.
 */
export function apply(ctx, config) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`auto-review-route: ${message}`);
    } catch {
      // A missing logger must never affect review dispatch.
    }
  };

  const debugRecords = [];
  const debugLog = (event, fields = {}) => {
    if (!readBoolean(config, "debug")) return;
    try {
      const record = {
        timestamp: new Date().toISOString(),
        event,
        ...fields,
      };
      const serialized = JSON.stringify(record);
      debugRecords.push(record);
      if (debugRecords.length > DEBUG_RECORD_LIMIT) debugRecords.splice(0, debugRecords.length - DEBUG_RECORD_LIMIT);
      const logger = ctx.logger;
      if (typeof logger?.info === "function") {
        logger.info.call(logger, `auto-review-route: debug ${serialized}`);
      }
    } catch {
      // Diagnostics must never affect review dispatch.
    }
  };

  // One-shot diagnostics, so a persistent misconfiguration cannot flood logs.
  const reported = new Set();
  const report = (key, message) => {
    if (reported.has(key)) return;
    reported.add(key);
    warn(message);
  };

  // Keep a small LRU because both the primary and fallback routes are checked,
  // and users can edit either route while the plugin remains mounted.
  const preflightCache = new Map();
  const rememberPreflight = (key, result) => {
    preflightCache.delete(key);
    preflightCache.set(key, result);
    if (preflightCache.size > 8) preflightCache.delete(preflightCache.keys().next().value);
    return result;
  };

  /** Verify each configured route once, retaining the accepted effort. */
  const preflight = async (route, signal) => {
    const key = JSON.stringify([route.provider, route.model, route.reasoningEffort ?? ""]);
    if (preflightCache.has(key)) {
      const cached = preflightCache.get(key);
      preflightCache.delete(key);
      preflightCache.set(key, cached);
      return cached;
    }

    const llm = ctx.llm;
    let providers;
    try {
      providers = llm.listProviders();
    } catch (error) {
      debugLog("preflight.failed", {
        stage: "providers",
        provider: safeDiagnosticText(route.provider, 120),
        model: safeDiagnosticText(route.model, 160),
        error: summarizeError(error),
      });
      report(`providers:${route.provider}`, `could not list provider routes (${describe(error)}); configured route is unavailable`);
      return rememberPreflight(key, null);
    }
    if (!providers.some((entry) => entry.id === route.provider)) {
      debugLog("preflight.failed", {
        stage: "provider-lookup",
        provider: safeDiagnosticText(route.provider, 120),
      });
      report(
        `provider:${route.provider}`,
        `provider "${route.provider}" has no registered adapter; configured route is unavailable`,
      );
      return rememberPreflight(key, null);
    }

    let info;
    try {
      info = await llm.resolveModelInfo(route.provider, route.model, signal);
    } catch (error) {
      debugLog("preflight.failed", {
        stage: "model-resolution",
        provider: safeDiagnosticText(route.provider, 120),
        model: safeDiagnosticText(route.model, 160),
        error: summarizeError(error),
      });
      report(
        `model:${route.provider}/${route.model}`,
        `model "${route.model}" is not usable on "${route.provider}" (${describe(error)}); configured route is unavailable`,
      );
      return rememberPreflight(key, null);
    }

    let effort;
    if (route.reasoningEffort !== undefined) {
      const efforts = info.reasoning?.efforts ?? [];
      if (efforts.some((entry) => entry.id === route.reasoningEffort)) {
        effort = route.reasoningEffort;
      } else {
        debugLog("preflight.effort-unsupported", {
          provider: safeDiagnosticText(route.provider, 120),
          model: safeDiagnosticText(route.model, 160),
          reasoningEffort: safeDiagnosticText(route.reasoningEffort, 80),
        });
        report(
          `effort:${route.provider}/${route.model}/${route.reasoningEffort}`,
          `model "${route.model}" does not declare reasoning effort "${route.reasoningEffort}"; its default is used`,
        );
      }
    }
    return rememberPreflight(key, effort);
  };

  ctx.effect(
    () =>
      ctx.on("llm/stream", async function* reroute(options, next) {
        if (rewritten.has(options)) {
          yield* next();
          return;
        }
        const marker = read(config, "marker") || DEFAULT_MARKER;
        if (!isReviewCall(options, marker)) {
          yield* next();
          return;
        }

        const primaryRoute = target(config);
        const fallbackEnabled = readBoolean(config, "fallbackEnabled");
        const fallbackProvider = read(config, "fallbackProvider");
        const fallbackModel = read(config, "fallbackModel");
        const fallbackRoute = fallbackTarget(config);
        const incompleteFallbackRoute = (fallbackProvider.length === 0) !== (fallbackModel.length === 0);
        if (fallbackEnabled && incompleteFallbackRoute) {
          report("fallback-route:incomplete", "fallback provider and model must both be selected; the session route will be used");
        }

        let baseOptions = options;
        const reasonLanguage = read(config, "reasonLanguage");
        if (Object.hasOwn(REASON_LANGUAGE_INSTRUCTIONS, reasonLanguage)) {
          baseOptions = {
            ...baseOptions,
            system: `${baseOptions.system}\n\n${REASON_LANGUAGE_INSTRUCTIONS[reasonLanguage]}`,
          };
        }

        const resolveRoute = async (route) => {
          if (route === undefined) return { options: baseOptions, usable: true };
          const sameModel = baseOptions.provider === route.provider && baseOptions.model === route.model;
          if (sameModel && route.reasoningEffort === undefined) {
            return { options: baseOptions, usable: true };
          }
          const effort = await preflight(route, baseOptions.signal);
          if (effort === null) return { options: baseOptions, usable: false };
          return { options: routeOptions(baseOptions, route, effort), usable: true };
        };

        const primaryResolution = await resolveRoute(primaryRoute);
        let fallbackResolution;
        const resolveFallback = async () => {
          if (fallbackResolution === undefined) fallbackResolution = await resolveRoute(fallbackRoute);
          return fallbackResolution;
        };
        const retryEnabled = readBoolean(config, "retryEnabled");
        const maxRetriesPerRoute = retryEnabled ? readRetryAttempts(config) : 0;
        const startedAt = Date.now();
        let firstChunkMs;
        let chunkCount = 0;
        const chunkTypes = {};
        let finishKind;
        let failure;
        let outcome = "cancelled";
        let attemptCount = 0;
        let retriesUsed = 0;
        let fallbackUsed = false;
        let finalStage = "primary";
        let finalOptions = primaryResolution.options;
        const rewrittenOptions = new Set();
        let nextCalled = false;
        const observeChunk = (chunk) => {
          chunkCount += 1;
          if (firstChunkMs === undefined) firstChunkMs = Date.now() - startedAt;
          if (typeof chunk?.type === "string") {
            chunkTypes[chunk.type] = (chunkTypes[chunk.type] ?? 0) + 1;
          }
        };
        const dispatch = (requestOptions) => {
          if (!nextCalled && requestOptions === options) {
            nextCalled = true;
            return next();
          }
          rewritten.add(requestOptions);
          rewrittenOptions.add(requestOptions);
          return ctx.llm.stream(requestOptions);
        };
        const routeSummary = (requestOptions) => ({
          provider: safeDiagnosticText(requestOptions.provider, 120),
          model: safeDiagnosticText(requestOptions.model, 160),
          ...(typeof requestOptions.reasoningEffort === "string"
            ? { reasoningEffort: safeDiagnosticText(requestOptions.reasoningEffort, 80) }
            : {}),
        });
        debugLog("review.started", {
          configuredRoute: primaryRoute === undefined ? null : routeSummary(primaryRoute),
          configuredFallbackRoute: !fallbackEnabled
            ? null
            : fallbackRoute === undefined
              ? "session-route"
              : routeSummary(fallbackRoute),
          effectiveRoute: routeSummary(primaryResolution.options),
          reasonLanguage: safeDiagnosticText(reasonLanguage || "official", 40),
          rerouted: primaryResolution.options !== options,
          retryEnabled,
          maxRetriesPerRoute,
          fallbackEnabled,
        });

        const runStage = async (stage, requestOptions) => runRouteAttempts({
          stage,
          options: requestOptions,
          maxRetries: maxRetriesPerRoute,
          dispatch,
          onChunk: observeChunk,
          onAttempt: () => { attemptCount += 1; },
          onRetry: ({ stage: retryStage, routeAttempt, maxAttempts, reason, finishKind: retryFinishKind, failure: retryFailure, delayMs }) => {
            debugLog("review.retry", {
              stage: retryStage,
              route: routeSummary(requestOptions),
              attempt: attemptCount,
              routeAttempt,
              maxAttempts,
              reason,
              finishKind: retryFinishKind ?? null,
              failure: retryFailure ?? null,
              delayMs,
            });
          },
        });

        try {
          if (maxRetriesPerRoute === 0 && !fallbackEnabled) {
            attemptCount = 1;
            for await (const chunk of dispatch(primaryResolution.options)) {
              observeChunk(chunk);
              if (chunk?.type === "finish") {
                finishKind = typeof chunk.reason?.kind === "string" ? chunk.reason.kind : "unknown";
                failure = summarizeFailure(chunk.reason?.failure);
                outcome = finishKind === "error"
                  ? "failed"
                  : finishKind === "aborted"
                    ? "aborted"
                    : "completed";
              }
              yield chunk;
            }
            if (finishKind === undefined) outcome = "ended-without-finish";
          } else {
            let result;
            if (!primaryResolution.usable && fallbackEnabled) {
              fallbackUsed = true;
              finalStage = "fallback";
              fallbackResolution = await resolveFallback();
              finalOptions = fallbackResolution.options;
              debugLog("review.fallback", {
                reason: "primary-preflight-failed",
                from: primaryRoute === undefined ? routeSummary(baseOptions) : routeSummary(primaryRoute),
                to: routeSummary(finalOptions),
                primaryAttempts: 0,
              });
              result = await runStage("fallback", finalOptions);
              retriesUsed += result.retriesUsed;
            } else {
              result = await runStage("primary", primaryResolution.options);
              retriesUsed += result.retriesUsed;
              if (fallbackEnabled && result.retryReason !== undefined && options.signal?.aborted !== true) {
                fallbackResolution = await resolveFallback();
                if (!sameRoute(primaryResolution.options, fallbackResolution.options)) {
                  fallbackUsed = true;
                  finalStage = "fallback";
                  finalOptions = fallbackResolution.options;
                  debugLog("review.fallback", {
                    reason: result.retryReason,
                    from: routeSummary(primaryResolution.options),
                    to: routeSummary(finalOptions),
                    primaryAttempts: result.attempts,
                    maxRetriesPerRoute,
                  });
                  result = await runStage("fallback", finalOptions);
                  retriesUsed += result.retriesUsed;
                }
              }
            }

            finishKind = result.finishKind;
            failure = result.failure;
            outcome = result.outcome;
            for (const chunk of result.chunks) yield chunk;
            if (result.threw) throw result.error;
          }
        } catch (error) {
          outcome = options.signal?.aborted === true ? "aborted" : "threw";
          failure = summarizeError(error);
          throw error;
        } finally {
          for (const requestOptions of rewrittenOptions) rewritten.delete(requestOptions);
          debugLog("review.finished", {
            effectiveRoute: routeSummary(finalOptions),
            routeStage: finalStage,
            fallbackUsed,
            outcome,
            signalAborted: options.signal?.aborted === true,
            elapsedMs: Date.now() - startedAt,
            firstChunkMs: firstChunkMs ?? null,
            chunkCount,
            chunkTypes,
            finishKind: finishKind ?? null,
            failure: failure ?? null,
            attemptCount,
            retriesUsed,
          });
        }
      }),
    "auto-review-route: reviewer reroute",
  );

  // A route change must re-run the preflight: the user may be pointing the
  // reviewer at a route that did not exist when the previous check ran.
  ctx.effect(
    () =>
      ctx.on("llm/adapters-updated", () => {
        preflightCache.clear();
      }),
    "auto-review-route: adapter invalidation",
  );

  // No `settings.configure({ auto: false })` call here on purpose. This row is
  // reachable exactly like `dsh-ops` rows are: the default page policy keeps the
  // configure control, and the registered `plugins.row.config` entry above is
  // what renders once it opens. Asking Settings to suppress its auto page would
  // be one more way for this bundle to fail without adding anything.

  mountRoutes(ctx, debugRecords);
}

/** Render one unknown throwable as a log-safe message. */
function describe(error) {
  return safeDiagnosticText(error instanceof Error ? error.message : error);
}

/**
 * Largest JSON bridge request body accepted, in bytes. The settings and model
 * catalog endpoints carry only a small owned-field patch or provider id.
 */
const MAX_BODY_BYTES = 8 * 1024;
const DEBUG_RECORD_LIMIT = 100;

/** Loopback prefix shared with the browser half of this bundle. */
const BRIDGE_PREFIX = "/api/dsh-auto-review-route";

/**
 * Publish provider/model catalogs, this row's settings read/write path, and a
 * bounded debug-history read/clear path to the configuration page.
 *
 * Writes go through `ctx.settings`, the same service the shipping Settings
 * page uses, so a save persists exactly like any profile patch edit. The page
 * never depends on `ConfigPageForm`: this bundle owns its own form, so it also
 * owns the read that fills it.
 *
 * @param ctx - Cordis context.
 */
function mountRoutes(ctx, debugRecords) {
  ctx.inject(["connection", "webServer"], (child) => {
    const connection = child.get("connection");
    const webServer = child.get("webServer");
    if (connection === undefined || webServer === undefined) return;

    const admit = (request, response) => {
      const rejection = connection.requestRejection(request);
      if (rejection !== undefined) {
        writeJson(response, rejection, { ok: false, code: "denied", message: "request not admitted" });
        return false;
      }
      if (request.method !== "POST") {
        writeJson(response, 405, { ok: false, code: "method", message: "POST required" });
        return false;
      }
      return true;
    };

    /**
     * The profile entry id this row is addressed by. `describe()` keys its
     * forms by the entry's own id, which for this bundle is the patch id.
     */
    const ENTRY_ID = "auto-review-route";

    /**
     * Resolve the descriptor this row owns, if the composition exposes it.
     * @param settings - the mounted settings service.
     * @returns the descriptor, or undefined while this row has no form yet.
     */
    const descriptorOf = (settings) =>
      settings.describe().find((entry) => String(entry.ns) === ENTRY_ID);

    /**
     * Read this row's editable values and the revision a write must match.
     * @returns the form state the page binds, or a diagnostic naming what is
     *   missing — the page shows that text instead of a generic refusal.
     */
    const stateOf = () => {
      const settings = ctx.get("settings");
      if (settings === undefined) {
        return { ok: false, code: "settings-unavailable", message: "the settings service is not mounted in this profile" };
      }
      let descriptor;
      try {
        descriptor = descriptorOf(settings);
      } catch (error) {
        return { ok: false, code: "describe-failed", message: describe(error) };
      }
      if (descriptor === undefined) {
        // The Fiber settles asynchronously right after a bundle is enabled, so
        // an absent form right now may simply mean "not yet". Say that rather
        // than reporting a capability this profile does have.
        return {
          ok: false,
          code: "row-pending",
          message:
            `this row has no settings form yet (entry "${ENTRY_ID}"). `
            + "Reload the page; if it persists, this row failed to activate.",
        };
      }
      return {
        ok: true,
        value: {
          ns: String(descriptor.ns),
          revision: descriptor.revision,
          writable: true,
          values: descriptor.value ?? {},
        },
      };
    };

    child.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: `${BRIDGE_PREFIX}/debug-logs`,
          handler: async (request, response) => {
            if (!admit(request, response)) return;
            writeJson(response, 200, {
              ok: true,
              value: {
                records: JSON.parse(JSON.stringify(debugRecords)),
                limit: DEBUG_RECORD_LIMIT,
              },
            });
          },
        }),
      "auto-review-route: diagnostic log read",
    );

    child.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: `${BRIDGE_PREFIX}/debug-logs/clear`,
          handler: async (request, response) => {
            if (!admit(request, response)) return;
            debugRecords.length = 0;
            writeJson(response, 200, { ok: true, value: { cleared: true } });
          },
        }),
      "auto-review-route: diagnostic log clear",
    );

    child.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: `${BRIDGE_PREFIX}/state`,
          handler: async (request, response) => {
            if (!admit(request, response)) return;
            try {
              writeJson(response, 200, stateOf());
            } catch (error) {
              writeJson(response, 200, { ok: false, code: "state-failed", message: describe(error) });
            }
          },
        }),
      "auto-review-route: settings read",
    );

    child.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: `${BRIDGE_PREFIX}/save`,
          handler: async (request, response) => {
            if (!admit(request, response)) return;
            const settings = ctx.get("settings");
            if (settings === undefined) {
              writeJson(response, 200, { ok: false, code: "settings-unavailable", message: "the settings service is not mounted" });
              return;
            }
            const body = await readJsonBody(request);
            const values = body?.values;
            if (values === null || typeof values !== "object" || Array.isArray(values)) {
              writeJson(response, 200, { ok: false, code: "values-required", message: "values object is required" });
              return;
            }
            const hasFallbackProvider = Object.hasOwn(values, "fallbackProvider");
            const hasFallbackModel = Object.hasOwn(values, "fallbackModel");
            if (hasFallbackProvider !== hasFallbackModel) {
              writeJson(response, 200, { ok: false, code: "invalid-value", message: "fallback provider and model must be saved together" });
              return;
            }
            if (hasFallbackProvider) {
              const provider = values.fallbackProvider;
              const model = values.fallbackModel;
              if (typeof provider !== "string" || typeof model !== "string") {
                writeJson(response, 200, { ok: false, code: "invalid-value", message: "fallback provider and model must be strings" });
                return;
              }
              if ((provider.trim().length === 0) !== (model.trim().length === 0)) {
                writeJson(response, 200, { ok: false, code: "invalid-value", message: "fallback provider and model must both be selected, or both be empty" });
                return;
              }
            }
            // Only the owned keys are writable; a stray field must not be
            // persisted into the profile patch.
            const ops = [];
            for (const key of ["provider", "model", "fallbackEnabled", "fallbackProvider", "fallbackModel", "reasoningEffort", "reasonLanguage", "debug", "retryEnabled", "retryAttempts", "marker"]) {
              if (!Object.hasOwn(values, key)) continue;
              const raw = values[key];
              if (key === "debug" || key === "retryEnabled" || key === "fallbackEnabled") {
                if (typeof raw !== "boolean") {
                  writeJson(response, 200, { ok: false, code: "invalid-value", message: `"${key}" must be a boolean` });
                  return;
                }
                ops.push({ op: "set", path: [key], value: raw });
                continue;
              }
              if (key === "retryAttempts") {
                if (!Number.isSafeInteger(raw) || raw < 1 || raw > MAX_RETRY_ATTEMPTS) {
                  writeJson(response, 200, { ok: false, code: "invalid-value", message: `"${key}" must be an integer from 1 to ${MAX_RETRY_ATTEMPTS}` });
                  return;
                }
                ops.push({ op: "set", path: [key], value: raw });
                continue;
              }
              if (typeof raw !== "string") {
                writeJson(response, 200, { ok: false, code: "invalid-value", message: `"${key}" must be a string` });
                return;
              }
              ops.push({ op: "set", path: [key], value: raw.trim() });
            }
            if (ops.length === 0) {
              writeJson(response, 200, { ok: false, code: "no-values", message: "no owned field was supplied" });
              return;
            }
            const expected = typeof body?.revision === "number" ? body.revision : undefined;
            try {
              await settings.mutate(ENTRY_ID, ops, expected);
            } catch (error) {
              writeJson(response, 200, { ok: false, code: "save-failed", message: describe(error) });
              return;
            }
            try {
              writeJson(response, 200, stateOf());
            } catch (error) {
              writeJson(response, 200, { ok: false, code: "state-failed", message: describe(error) });
            }
          },
        }),
      "auto-review-route: settings write",
    );

    child.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: `${BRIDGE_PREFIX}/providers`,
          handler: async (request, response) => {
            if (!admit(request, response)) return;
            try {
              const providers = ctx.llm.listProviders().map((entry) => ({ id: entry.id, name: entry.name }));
              writeJson(response, 200, { ok: true, value: { providers } });
            } catch (error) {
              writeJson(response, 200, { ok: false, code: "providers-failed", message: describe(error) });
            }
          },
        }),
      "auto-review-route: provider catalog",
    );

    child.effect(
      () =>
        webServer.register({
          kind: "exact",
          path: `${BRIDGE_PREFIX}/models`,
          handler: async (request, response) => {
            if (!admit(request, response)) return;
            const body = await readJsonBody(request);
            const provider = body?.provider;
            if (typeof provider !== "string" || provider.trim().length === 0) {
              writeJson(response, 200, { ok: false, code: "provider-required", message: "provider is required" });
              return;
            }
            try {
              const listed = await ctx.llm.listModels(provider.trim());
              const models = listed.map((entry) => ({ id: entry.id, name: entry.name }));
              writeJson(response, 200, { ok: true, value: { models } });
            } catch (error) {
              // Some adapters only answer their endpoint online; the page keeps a
              // free-text field, so a failed catalog is reported, never fatal.
              writeJson(response, 200, { ok: false, code: "models-failed", message: describe(error) });
            }
          },
        }),
      "auto-review-route: model catalog",
    );
  });
}

/**
 * Write one JSON response.
 * @param response - node response.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 */
function writeJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end(JSON.stringify(body));
}

/**
 * Read one bounded JSON request body.
 * @param request - node request.
 * @returns the parsed body, or `undefined` when empty, oversized, or not JSON.
 */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}
