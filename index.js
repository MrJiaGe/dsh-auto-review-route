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
 * purpose includes "routing". This plugin rewrites the provider/model of that
 * one call and re-dispatches it. It never edits, forks, or wraps the official
 * package: the official row is untouched, and every other option of the review
 * request (system prompt `REVIEW_POLICY`, messages, temperature, absence of
 * tools, signal) is forwarded byte-for-byte.
 *
 * Deliberate non-goals:
 * - No provider/model default. An unset route means this plugin does nothing
 *   and the official behaviour (session route) applies.
 * - No policy, prompt, tool, retry, or lifecycle changes.
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

/**
 * Live-editable route policy. Both route fields default to an empty string,
 * meaning "not chosen": with no choice this plugin stays inert and the official
 * reviewer keeps using the session's own provider and model.
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
  reasoningEffort: z
    .string()
    .default("")
    .description(
      "Optional reasoning effort for the reviewer call. Empty inherits the target model's default. "
        + "Dropped automatically when the target model does not declare it.",
    )
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

/**
 * Resolve the configured route into a decision.
 * @param config - the Loader-provided config object.
 * @returns the target route, or `undefined` when the user has not chosen one.
 */
function target(config) {
  const provider = read(config, "provider");
  const model = read(config, "model");
  if (provider.length === 0 || model.length === 0) return undefined;
  const effort = read(config, "reasoningEffort");
  return {
    provider,
    model,
    ...effort.length === 0 ? {} : { reasoningEffort: effort },
  };
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
 * Install the reviewer reroute and the two read-only list endpoints the
 * configuration page needs.
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

  // One-shot diagnostics, so a persistent misconfiguration cannot flood logs.
  const reported = new Set();
  const report = (key, message) => {
    if (reported.has(key)) return;
    reported.add(key);
    warn(message);
  };

  // Preflight result per configured route. The reviewer runs once per tool
  // call, so the adapter lookup is cached and invalidated only when the chosen
  // route changes; a rejected route falls back to official behaviour until then.
  let preflightKey = "";
  let preflightUsable = false;
  /** The effort that survived the last preflight, for the cached key. */
  let preflightEffort;

  /**
   * Verify the configured route once per distinct target.
   *
   * The verdict is cached per configured value, so the effort the adapter
   * actually accepted is cached with it: reading the raw config again on the
   * next call would re-introduce a level this route does not declare.
   *
   * @param route - configured provider/model pair plus the requested effort.
   * @param signal - the review call's cancellation.
   * @returns the effort to send (possibly `undefined`), or `null` when the route
   *   must not be used and the official route applies.
   */
  const preflight = async (route, signal) => {
    const key = `${route.provider}\u0000${route.model}\u0000${route.reasoningEffort ?? ""}`;
    if (key === preflightKey) return preflightUsable ? preflightEffort : null;

    preflightKey = key;
    preflightUsable = false;
    preflightEffort = undefined;

    const llm = ctx.llm;
    let providers;
    try {
      providers = llm.listProviders();
    } catch (error) {
      report("providers", `could not list provider routes (${describe(error)}); the official route is kept`);
      return null;
    }
    if (!providers.some((entry) => entry.id === route.provider)) {
      report(
        `provider:${route.provider}`,
        `provider "${route.provider}" has no registered adapter; the official route is kept`,
      );
      return null;
    }
    let info;
    try {
      info = await llm.resolveModelInfo(route.provider, route.model, signal);
    } catch (error) {
      report(
        `model:${route.provider}/${route.model}`,
        `model "${route.model}" is not usable on "${route.provider}" (${describe(error)}); the official route is kept`,
      );
      return null;
    }
    if (route.reasoningEffort !== undefined) {
      const efforts = info.reasoning?.efforts ?? [];
      if (efforts.some((entry) => entry.id === route.reasoningEffort)) {
        preflightEffort = route.reasoningEffort;
      } else {
        report(
          `effort:${route.provider}/${route.model}/${route.reasoningEffort}`,
          `model "${route.model}" does not declare reasoning effort "${route.reasoningEffort}"; its default is used`,
        );
      }
    }
    preflightUsable = true;
    return preflightEffort;
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

        const route = target(config);
        if (route === undefined) {
          // No user choice: the official reviewer keeps its own route.
          yield* next();
          return;
        }
        if (options.provider === route.provider && options.model === route.model) {
          yield* next();
          return;
        }

        const effort = await preflight(route, options.signal);
        if (effort === null) {
          yield* next();
          return;
        }

        const forwarded = {
          ...options,
          provider: route.provider,
          model: route.model,
          ...effort === undefined ? {} : { reasoningEffort: effort },
        };
        rewritten.add(forwarded);
        try {
          yield* ctx.llm.stream(forwarded);
        } finally {
          rewritten.delete(forwarded);
        }
      }),
    "auto-review-route: reviewer reroute",
  );

  // A route change must re-run the preflight: the user may be pointing the
  // reviewer at a route that did not exist when the previous check ran.
  ctx.effect(
    () =>
      ctx.on("llm/adapters-updated", () => {
        preflightKey = "";
        preflightUsable = false;
      }),
    "auto-review-route: adapter invalidation",
  );

  // No `settings.configure({ auto: false })` call here on purpose. This row is
  // reachable exactly like `dsh-ops` rows are: the default page policy keeps the
  // configure control, and the registered `plugins.row.config` entry above is
  // what renders once it opens. Asking Settings to suppress its auto page would
  // be one more way for this bundle to fail without adding anything.

  mountRoutes(ctx);
}

/** Render one unknown throwable as a log-safe message. */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Largest bridge body accepted, in bytes. Both endpoints only carry a provider
 * id, so a small bound is generous.
 */
const MAX_BODY_BYTES = 8 * 1024;

/** Loopback prefix shared with the browser half of this bundle. */
const BRIDGE_PREFIX = "/api/dsh-auto-review-route";

/**
 * Publish the provider and model catalogs, and the read/write path for this
 * row's own settings, to the configuration page.
 *
 * Writes go through `ctx.settings`, the same service the shipping Settings
 * page uses, so a save persists exactly like any profile patch edit. The page
 * never depends on `ConfigPageForm`: this bundle owns its own form, so it also
 * owns the read that fills it.
 *
 * @param ctx - Cordis context.
 */
function mountRoutes(ctx) {
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
            // Only the four owned keys are writable; a stray field must not be
            // persisted into the profile patch.
            const ops = [];
            for (const key of ["provider", "model", "reasoningEffort", "marker"]) {
              if (!Object.hasOwn(values, key)) continue;
              const raw = values[key];
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
