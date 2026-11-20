/**
 * Browser half of the auto-review model route bundle.
 *
 * Contributes one configuration page to the Plugins section for this bundle's
 * own row: a provider picker, a model picker, an optional reasoning level, and
 * the reviewer-prompt marker.
 *
 * The page owns its read and write path through this bundle's loopback bridge
 * rather than the shared `ConfigPageForm`, because the form is this plugin's
 * own and a missing or refused shared form must not turn a working plugin into
 * an unusable page. Writes still land in the profile's cordis patch through
 * `ctx.settings`, so a save behaves exactly like any other profile edit.
 */
window.__ModuleLoader__.load({
  id: '@mrjiage/dsh-auto-review-route',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useCallback } = React;

    const NS = 'dshAutoReviewRoute';
    const ROW_KEY = '@mrjiage/dsh-auto-review-route#auto-review-route';
    const BRIDGE = '/api/dsh-auto-review-route';

    const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const DEFAULT_RETRY_ATTEMPTS = 2;
    const MAX_RETRY_ATTEMPTS = 5;

    const en = {
      title: 'Auto-review model route',
      summaryUnset: 'Reviewer uses the session model',
      summaryPrefix: 'Reviewer pinned to',
      intro:
        'Send the Auto-review model request to a provider and model of your choice, so the reviewer does not compete with the working model for the same concurrency quota. The official auto-review plugin is not modified: its fixed risk policy, tools and lifecycle stay intact. Only when you select a reason language does this plugin append a narrow instruction for the optional reason text. With unofficial direct API providers, severe upstream prompt injection, prompt rewriting or other interference may affect review results or cause requests to fail; this upstream behaviour is outside this plugin\'s control.',
      unsetNotice:
        'Nothing is selected yet, so the reviewer keeps the session route. Pick both a provider and a model to pin it; a reason language can be selected independently.',
      provider: 'Primary provider',
      model: 'Primary model',
      fallbackProvider: 'Fallback provider',
      fallbackModel: 'Fallback model',
      sessionRoute: 'Use the session model',
      sessionModelPrompt: 'Uses the session model',
      fallbackEnabled: 'Enable fallback after primary failures',
      fallbackNote: 'Runs after the primary route exhausts its retry budget, including invalid review results, or after its first retryable failure when retries are off. The fallback gets the same retry budget. Leave both fields empty to use the session model.',
      fallbackPairInvalid: 'Choose both a fallback provider and model, or leave both empty.',
      effort: 'Reasoning effort',
      effortInherit: 'Inherit the target model default',
      marker: 'Reviewer prompt marker',
      markerHelp:
        'Prefix of the fixed reviewer prompt. It is how this plugin recognises the review request. Change it only if a Harness upgrade renames the marker; a wrong value makes the plugin inert instead of breaking reviews.',
      choosePrompt: 'Select a provider first',
      loading: 'Loading…',
      loadFailed: 'Could not load the catalog',
      freeText: 'Type an id manually',
      useCatalog: 'Pick from the catalog',
      save: 'Save',
      reset: 'Reset',
      saving: 'Saving…',
      saved: 'Saved. The reviewer route changed.',
      rejected: 'The change was not accepted',
      retry: 'Retry',
      clear: 'Use the session model',
      overview: 'Effective route',
      effectiveOfficial: 'Session provider and model (official route)',
      effortNote:
        'Lower reasoning levels are usually faster; higher levels usually take more reasoning time. Unsupported levels fall back to the target model default.',
      reasonLanguage: 'Review reason language',
      reasonLanguageOfficial: 'Keep the official prompt',
      reasonLanguageZh: '简体中文 Simplified Chinese',
      reasonLanguageEn: 'English',
      reasonLanguageNote:
        'Keep this blank to leave the official review prompt unchanged. A selected language only guides the optional denial reason; it does not change the risk decision or JSON format, and the model/provider may not follow it.',
      debug: 'Debug Auto-review requests',
      debugNote: 'Collects route, timing, stream outcome, and redacted error details in Host memory. Prompt text, messages, and chunk content are not logged.',
      retryEnabled: 'Automatically retry failed Auto-review requests',
      retryNote: 'Retries transport failures, interrupted streams, non-stop finishes, and invalid review JSON/blocks. Cancellation and valid decisions are not retried.',
      retryAttempts: 'Additional retry attempts',
      retryAttemptsNote: '1–5 retries after the initial request. Each retry may incur provider usage.',
      retryAttemptsInvalid: 'Retry attempts must be a whole number from 1 to 5.',
      debugHistory: 'Recent diagnostics',
      debugHistoryNote: 'The last 100 redacted records stay in Host memory only and are cleared when the Host restarts or the plugin reloads.',
      debugRefresh: 'Refresh',
      debugCopy: 'Copy',
      debugClear: 'Clear',
      debugLoading: 'Loading diagnostics…',
      debugEmpty: 'No diagnostics recorded yet.',
      debugFailed: 'Could not load diagnostics',
      debugCopied: 'Diagnostics copied',
      debugCopyFailed: 'Could not copy diagnostics',
      debugCleared: 'Diagnostics cleared',
      noneOption: '— none —',
      readFailed: 'Could not read this row\'s settings',
    };

    const zh = {
      title: '自动审查模型路由',
      summaryUnset: '审查使用会话模型',
      summaryPrefix: '审查已指定为',
      intro:
        '把自动审查的模型请求发往你指定的渠道与模型，避免审查请求和工作模型抢同一个并发额度。官方自动审查插件代码、固定风险策略、工具与生命周期保持不变；仅在你选择理由语言时，本插件才会追加一条只针对可选理由文字语言的指令。使用非官方直连 API 时，若上游对请求进行严重的提示词注入、改写或其他干扰，可能影响审查结果甚至导致调用失败；此类上游行为不受本插件控制。',
      unsetNotice:
        '当前未选择渠道与模型，因此审查仍使用会话路由。选择理由语言可以单独生效；选择渠道和模型后才会接管模型路由。',
      provider: '主渠道',
      model: '主模型',
      fallbackProvider: '回退渠道',
      fallbackModel: '回退模型',
      sessionRoute: '使用会话模型',
      sessionModelPrompt: '将使用会话模型',
      fallbackEnabled: '主模型失败后启用回退',
      fallbackNote: '主路线耗尽重试后切换，包括审查结果无效；若关闭自动重试，则首次可重试失败后切换。回退路线使用相同重试次数。渠道和模型都不选时使用会话模型。',
      fallbackPairInvalid: '请同时选择回退渠道和模型，或将两项都留空。',
      effort: '推理档位',
      effortInherit: '跟随目标模型默认',
      marker: '审查提示词标识',
      markerHelp:
        '固定审查提示词的前缀，本插件靠它识别审查请求。只有在 Harness 升级改动了该标识时才需要修改；填错只会让插件失效，不会破坏审查。',
      choosePrompt: '请先选择渠道',
      loading: '加载中…',
      loadFailed: '无法获取列表',
      freeText: '手动输入 ID',
      useCatalog: '从列表选择',
      save: '保存',
      reset: '重置',
      saving: '保存中…',
      saved: '已保存，审查路由已切换。',
      rejected: '改动未被接受',
      retry: '重试',
      clear: '改用会话模型',
      overview: '当前生效路由',
      effectiveOfficial: '会话渠道与模型（官方路由）',
      effortNote: '推理档位越低通常响应越快，越高通常需要更多推理时间；具体效果取决于目标模型。不支持的档位会改用目标模型默认值。',
      reasonLanguage: '审查理由语言',
      reasonLanguageOfficial: '保持官方提示词',
      reasonLanguageZh: '简体中文 Simplified Chinese',
      reasonLanguageEn: 'English',
      reasonLanguageNote: '保持官方提示词时不追加语言指令。选择语言仅指导可选拒绝理由的文字语言，不改变风险判断或 JSON 格式；模型或渠道可能不遵从。',
      debug: '自动审查调试日志',
      debugNote: '开启后会在 Host 内存中收集路由、耗时、流结果和脱敏错误信息；不会记录提示词、消息正文或流内容。',
      retryEnabled: '自动重试失败的审查请求',
      retryNote: '重试传输失败、中断流、非 stop 结束和无效的审查 JSON/内容块；用户取消和有效结果不会重试。',
      retryAttempts: '重试次数（不含首次请求）',
      retryAttemptsNote: '可设 1–5 次。重试可能产生额外模型用量。',
      retryAttemptsInvalid: '重试次数必须是 1 到 5 之间的整数。',
      debugHistory: '最近诊断记录',
      debugHistoryNote: 'Host 内存中最多保留最近 100 条脱敏记录；Host 重启或插件重载后会清空。',
      debugRefresh: '刷新',
      debugCopy: '复制',
      debugClear: '清空',
      debugLoading: '正在读取诊断记录…',
      debugEmpty: '尚无诊断记录。',
      debugFailed: '无法读取诊断记录',
      debugCopied: '诊断记录已复制',
      debugCopyFailed: '无法复制诊断记录',
      debugCleared: '诊断记录已清空',
      noneOption: '— 不选 —',
      readFailed: '无法读取此行的设置',
    };

    const CSS = `
.aar { color:var(--dsw-alias-label-primary,inherit); font:inherit; display:grid; gap:18px; max-width:56rem; }
.aar p { margin:0; line-height:1.55; max-width:78ch; overflow-wrap:anywhere; }
.aar .aar-muted { color:var(--dsw-alias-label-secondary,inherit); }
.aar .aar-grid, .aar .aar-route-grid { display:grid; gap:14px; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:start; }
.aar .aar-route-grid { column-gap:18px; row-gap:16px; }
.aar .aar-field { display:grid; gap:7px; min-width:0; align-content:start; }
.aar .aar-field > label { font-weight:600; line-height:1.35; min-height:1.35em; }
.aar label { font-weight:600; }
.aar .aar-toggle { display:flex; align-items:center; gap:9px; }
.aar .aar-toggle input[type=checkbox] { width:16px; height:16px; flex:0 0 16px; accent-color:var(--dsw-alias-brand-primary,#356be8); }
.aar select, .aar input[type=text], .aar input[type=number] {
  box-sizing:border-box; width:100%; max-width:100%; min-height:38px; padding:7px 10px;
  font:inherit; color:inherit; background:transparent;
  border:1px solid var(--dsw-alias-border-l2,#888); border-radius:var(--dsw-radius-sm,8px);
}
.aar .aar-note { color:var(--dsw-alias-label-secondary,inherit); font-size:.9em; line-height:1.45; }
.aar .aar-err { color:var(--dsw-alias-state-error-primary,inherit); }
.aar .aar-actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.aar button {
  font:inherit; color:inherit; background:transparent; cursor:pointer; min-height:36px; padding:7px 14px;
  border:1px solid var(--dsw-alias-border-l2,#888); border-radius:var(--dsw-radius-sm,8px);
}
.aar button:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2,#8882); }
.aar .aar-fallback-toggle { grid-column:1/-1; display:grid; gap:7px; padding:12px 0; border-block:1px solid var(--dsw-alias-border-l1,#8883); }
.aar .aar-model-action { justify-self:start; min-height:28px; padding:3px 0; border:0; border-radius:0; color:var(--dsw-alias-brand-primary,#356be8); text-align:left; }
/* The brand fill reverses between light and dark themes; use the base
   surface colour for its contrasting label in both palettes. */
.aar button.aar-primary,
.aar button.aar-primary:hover:not(:disabled) {
  background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-bg-base);
  border-color:transparent;
}
.aar :disabled { opacity:.6; cursor:not-allowed; }
.aar button.aar-primary:disabled {
  background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);
  border-color:var(--dsw-alias-border-l2);
  opacity:1;
}
.aar :is(button,select,input):focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#356be8); outline-offset:2px; }
.aar .aar-card {
  border:1px solid var(--dsw-alias-border-l1,#8883); border-radius:var(--dsw-radius-sm,8px);
  padding:14px 16px; display:grid; gap:8px; background:var(--dsw-alias-bg-layer-1,transparent);
}
.aar .aar-debug-log { display:grid; gap:10px; min-width:0; }
.aar .aar-log-output {
  box-sizing:border-box; max-height:20rem; overflow:auto; margin:0; padding:10px;
  border:1px solid var(--dsw-alias-border-l1,#8883); border-radius:4px;
  background:var(--dsw-alias-bg-layer-1,transparent); font:0.82em/1.45 monospace;
  white-space:pre-wrap; overflow-wrap:anywhere;
}
.aar hr { border:0; border-top:1px solid var(--dsw-alias-border-l1,#8883); margin:2px 0; }
@media (max-width:600px) {
  .aar .aar-grid, .aar .aar-route-grid { grid-template-columns:1fr; }
  .aar .aar-fallback-toggle { grid-column:auto; }
}
`;

    /** POST one bridge endpoint and return its envelope untouched. */
    async function bridge(endpoint, payload) {
      let response;
      try {
        response = await fetch(`${BRIDGE}/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        });
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    /** Shape the Host's raw values into the page's draft. */
    function draftOf(values) {
      const text = (key) => (typeof values?.[key] === 'string' ? values[key] : '');
      return {
        provider: text('provider'),
        model: text('model'),
        fallbackEnabled: values?.fallbackEnabled === true,
        fallbackProvider: text('fallbackProvider'),
        fallbackModel: text('fallbackModel'),
        reasoningEffort: text('reasoningEffort'),
        reasonLanguage: text('reasonLanguage'),
        debug: values?.debug === true,
        retryEnabled: values?.retryEnabled === true,
        retryAttempts: Number.isSafeInteger(values?.retryAttempts)
          && values.retryAttempts >= 1
          && values.retryAttempts <= MAX_RETRY_ATTEMPTS
          ? values.retryAttempts
          : DEFAULT_RETRY_ATTEMPTS,
        // An empty marker means "use the shipped default"; show it plainly so
        // the field never looks like a missing requirement.
        marker: text('marker') || 'REVIEW_POLICY',
      };
    }

    function validFallbackRoute(provider, model) {
      if (typeof provider !== 'string' || typeof model !== 'string') return false;
      return (provider.trim().length === 0) === (model.trim().length === 0);
    }

    function validRetryAttempts(value) {
      return Number.isSafeInteger(value) && value >= 1 && value <= MAX_RETRY_ATTEMPTS;
    }

    /**
     * Read this row's settings from the Host.
     * @returns reader state plus a `reload` action.
     */
    function useRemoteState() {
      const [state, setState] = useState({ status: 'loading', revision: undefined, values: {} });
      const [attempt, setAttempt] = useState(0);
      useEffect(() => {
        let live = true;
        setState((current) => ({ ...current, status: 'loading' }));
        bridge('state').then(
          (body) => {
            if (!live) return;
            if (body?.ok === true) {
              setState({
                status: 'ready',
                values: body.value.values ?? {},
                revision: body.value.revision,
              });
            } else {
              setState({
                status: 'error',
                values: {},
                revision: undefined,
                message: body?.message ?? 'the Host refused the read',
              });
            }
          },
          (error) => {
            if (!live) return;
            setState({
              status: 'error',
              values: {},
              revision: undefined,
              message: error instanceof Error ? error.message : String(error),
            });
          },
        );
        return () => {
          live = false;
        };
      }, [attempt]);
      return { ...state, reload: () => setAttempt((current) => current + 1) };
    }

    function useModelCatalog(provider) {
      const [catalog, setCatalog] = useState(() => ({ provider, models: null, error: '' }));

      useEffect(() => {
        let live = true;
        setCatalog({ provider, models: null, error: '' });
        if (provider.length === 0) return () => { live = false; };

        bridge('models', { provider }).then(
          (body) => {
            if (!live) return;
            if (body?.ok === true) setCatalog({ provider, models: body.value.models ?? [], error: '' });
            else setCatalog({ provider, models: [], error: body?.message ?? '' });
          },
          (error) => {
            if (!live) return;
            setCatalog({
              provider,
              models: [],
              error: error instanceof Error ? error.message : String(error),
            });
          },
        );
        return () => { live = false; };
      }, [provider]);

      return catalog.provider === provider ? catalog : { provider, models: null, error: '' };
    }

    function Summary(props) {
      const { t } = props;
      const state = useRemoteState();
      if (state.status !== 'ready') return t('summaryUnset');
      const draft = draftOf(state.values);
      if (draft.provider.length === 0 || draft.model.length === 0) return t('summaryUnset');
      return `${t('summaryPrefix')} ${draft.provider} / ${draft.model}`;
    }

    function Page(props) {
      const { t } = props;
      const state = useRemoteState();
      const [draft, setDraft] = useState(() => draftOf({}));
      const [dirty, setDirty] = useState(false);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const [messageKind, setMessageKind] = useState('info');
      const [providers, setProviders] = useState(null);
      const [providerError, setProviderError] = useState('');
      const [manualModels, setManualModels] = useState({ primary: false, fallback: false });
      const [debugRecords, setDebugRecords] = useState([]);
      const [debugBusy, setDebugBusy] = useState(false);
      const [debugStatus, setDebugStatus] = useState('');

      // Adopt the Host values until the user starts editing.
      const ready = state.status === 'ready';
      const revision = state.revision;
      useEffect(() => {
        if (!ready || dirty) return;
        setDraft(draftOf(state.values));
      }, [ready, revision, dirty]);

      // Provider catalog.
      useEffect(() => {
        let live = true;
        bridge('providers').then(
          (body) => {
            if (!live) return;
            if (body?.ok === true) setProviders(body.value.providers ?? []);
            else {
              setProviders([]);
              setProviderError(body?.message ?? '');
            }
          },
          (error) => {
            if (!live) return;
            setProviders([]);
            setProviderError(error instanceof Error ? error.message : String(error));
          },
        );
        return () => {
          live = false;
        };
      }, []);

      const primaryModelCatalog = useModelCatalog(draft.provider);
      const fallbackModelCatalog = useModelCatalog(draft.fallbackProvider);

      const edit = useCallback((patch) => {
        setDraft((current) => ({ ...current, ...patch }));
        setDirty(true);
        setMessage('');
        setMessageKind('info');
      }, []);

      const reset = useCallback(() => {
        setDraft(draftOf(ready ? state.values : {}));
        setDirty(false);
        setMessage('');
        setManualModels({ primary: false, fallback: false });
      }, [ready, state.values]);

      const save = useCallback(
        async (next) => {
          if (busy) return;
          if (!validRetryAttempts(next.retryAttempts)) {
            setMessage(t('retryAttemptsInvalid'));
            setMessageKind('err');
            return;
          }
          if (!validFallbackRoute(next.fallbackProvider, next.fallbackModel)) {
            setMessage(t('fallbackPairInvalid'));
            setMessageKind('err');
            return;
          }
          setBusy(true);
          setMessage('');
          const body = { values: { ...next, marker: next.marker || 'REVIEW_POLICY' } };
          if (typeof revision === 'number') body.revision = revision;
          try {
            const result = await bridge('save', body);
            if (result?.ok === true) {
              setMessage(t('saved'));
              setMessageKind('info');
              setDirty(false);
              // Re-read so the adopted values and revision match the Host.
              state.reload();
            } else {
              setMessage(`${t('rejected')}: ${result?.message ?? ''}`);
              setMessageKind('err');
            }
          } catch (error) {
            setMessage(`${t('rejected')}: ${error instanceof Error ? error.message : String(error)}`);
            setMessageKind('err');
          } finally {
            setBusy(false);
          }
        },
        [busy, revision, state, t],
      );

      const refreshDebug = useCallback(
        async () => {
          if (debugBusy) return;
          setDebugBusy(true);
          setDebugStatus('');
          try {
            const result = await bridge('debug-logs');
            if (result?.ok === true && Array.isArray(result.value?.records)) {
              setDebugRecords(result.value.records);
            } else {
              setDebugStatus(`${t('debugFailed')}: ${result?.message ?? ''}`);
            }
          } catch (error) {
            setDebugStatus(`${t('debugFailed')}: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            setDebugBusy(false);
          }
        },
        [debugBusy, t],
      );

      const copyDebug = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(debugRecords, null, 2));
          setDebugStatus(t('debugCopied'));
        } catch {
          setDebugStatus(t('debugCopyFailed'));
        }
      }, [debugRecords, t]);

      const clearDebug = useCallback(
        async () => {
          if (debugBusy) return;
          setDebugBusy(true);
          setDebugStatus('');
          try {
            const result = await bridge('debug-logs/clear');
            if (result?.ok === true) {
              setDebugRecords([]);
              setDebugStatus(t('debugCleared'));
            } else {
              setDebugStatus(`${t('debugFailed')}: ${result?.message ?? ''}`);
            }
          } catch (error) {
            setDebugStatus(`${t('debugFailed')}: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            setDebugBusy(false);
          }
        },
        [debugBusy, t],
      );

      const providerOptions = providers ?? [];
      const renderProviderField = (route, providerKey, modelKey, labelKey, disabled) => {
        const id = `aar-${route}-provider`;
        return h('div', { key: id, className: 'aar-field' }, [
          h('label', { key: 'label', htmlFor: id }, t(labelKey)),
          h('select', {
            key: 'select',
            id,
            value: draft[providerKey],
            disabled: busy || disabled,
            onChange: (event) => {
              edit({ [providerKey]: event.target.value, [modelKey]: '' });
              setManualModels((current) => ({ ...current, [route]: false }));
            },
          }, [
            h('option', { key: '', value: '' }, t('sessionRoute')),
            ...providerOptions.map((entry) =>
              h('option', { key: entry.id, value: entry.id }, `${entry.name ?? entry.id} (${entry.id})`),
            ),
          ]),
          route === 'primary' && providerError.length > 0
            ? h('span', { key: 'error', className: 'aar-note aar-err' }, `${t('loadFailed')}: ${providerError}`)
            : null,
        ].filter(Boolean));
      };
      const renderModelField = (route, providerKey, modelKey, labelKey, catalog, disabled) => {
        const id = `aar-${route}-model`;
        const modelOptions = catalog.models ?? [];
        const knownModels = modelOptions.map((entry) => entry.id);
        const modelId = draft[modelKey];
        const useManual = manualModels[route]
          || (modelOptions.length > 0 && modelId.length > 0 && !knownModels.includes(modelId));
        const fieldDisabled = busy || disabled || draft[providerKey].length === 0;
        return h('div', { key: id, className: 'aar-field' }, [
          h('label', { key: 'label', htmlFor: id }, t(labelKey)),
          useManual
            ? h('input', {
                key: 'input',
                id,
                type: 'text',
                value: modelId,
                disabled: fieldDisabled,
                placeholder: 'model id',
                onChange: (event) => edit({ [modelKey]: event.target.value }),
              })
            : h('select', {
                key: 'select',
                id,
                value: modelId,
                disabled: fieldDisabled,
                onChange: (event) => edit({ [modelKey]: event.target.value }),
              }, [
                h('option', { key: '', value: '' }, draft[providerKey].length === 0
                  ? (route === 'fallback' ? t('sessionModelPrompt') : t('choosePrompt'))
                  : catalog.models === null ? t('loading') : t('noneOption')),
                ...modelOptions.map((entry) =>
                  h('option', { key: entry.id, value: entry.id }, `${entry.name ?? entry.id} (${entry.id})`),
                ),
              ]),
          h('button', {
            key: 'mode',
            type: 'button',
            className: 'aar-model-action',
            disabled: fieldDisabled,
            onClick: () => setManualModels((current) => ({ ...current, [route]: !current[route] })),
          }, useManual ? t('useCatalog') : t('freeText')),
          catalog.error.length > 0
            ? h('span', { key: 'error', className: 'aar-note aar-err' }, `${t('loadFailed')}: ${catalog.error}`)
            : route === 'fallback' && !validFallbackRoute(draft.fallbackProvider, draft.fallbackModel)
              ? h('span', { key: 'error', className: 'aar-note aar-err' }, t('fallbackPairInvalid'))
              : null,
        ].filter(Boolean));
      };
      const pinned = draft.provider.length > 0 && draft.model.length > 0;


      // A Host-side read failure is reported verbatim: it names what is
      // missing, which a generic "unavailable" would hide.
      if (state.status === 'loading') {
        return h('div', { className: 'aar' }, [
          h('style', { key: 'css' }, CSS),
          h('p', { key: 'l', className: 'aar-muted', role: 'status' }, t('loading')),
        ]);
      }
      if (state.status === 'error') {
        return h('div', { className: 'aar' }, [
          h('style', { key: 'css' }, CSS),
          h('p', { key: 'h', className: 'aar-err role-alert', role: 'alert' }, `${t('readFailed')}: ${state.message}`),
          h(
            'div',
            { key: 'a', className: 'aar-actions' },
            h('button', { type: 'button', onClick: state.reload }, t('retry')),
          ),
        ]);
      }

      return h('div', { className: 'aar' }, [
        h('style', { key: 'css' }, CSS),
        h('p', { key: 'intro', className: 'aar-muted' }, t('intro')),
        h('div', { key: 'overview', className: 'aar-card' }, [
          h('strong', { key: 'h' }, t('overview')),
          h(
            'p',
            { key: 'v', className: pinned ? undefined : 'aar-muted' },
            pinned ? `${draft.provider} / ${draft.model}` : t('effectiveOfficial'),
          ),
          pinned ? null : h('p', { key: 'n', className: 'aar-note' }, t('unsetNotice')),
        ].filter(Boolean)),
        h('hr', { key: 'hr1' }),
        h('div', { key: 'routes', className: 'aar-route-grid' }, [
          renderProviderField('primary', 'provider', 'model', 'provider', false),
          renderModelField('primary', 'provider', 'model', 'model', primaryModelCatalog, false),
          h('div', { key: 'fallback-toggle', className: 'aar-field aar-fallback-toggle' }, [
            h('label', { key: 'label', className: 'aar-toggle', htmlFor: 'aar-fallback-enabled' }, [
              h('input', {
                key: 'input',
                id: 'aar-fallback-enabled',
                type: 'checkbox',
                checked: draft.fallbackEnabled,
                disabled: busy,
                onChange: (event) => edit({ fallbackEnabled: event.target.checked }),
              }),
              h('span', { key: 'text' }, t('fallbackEnabled')),
            ]),
            h('span', { key: 'note', className: 'aar-note' }, t('fallbackNote')),
          ]),
          renderProviderField('fallback', 'fallbackProvider', 'fallbackModel', 'fallbackProvider', !draft.fallbackEnabled),
          renderModelField(
            'fallback',
            'fallbackProvider',
            'fallbackModel',
            'fallbackModel',
            fallbackModelCatalog,
            !draft.fallbackEnabled,
          ),
        ]),
        h('hr', { key: 'route-divider' }),
        h('div', { key: 'grid', className: 'aar-grid' }, [
          h('div', { key: 'e', className: 'aar-field' }, [
            h('label', { key: 'l', htmlFor: 'aar-effort' }, t('effort')),
            h(
              'select',
              {
                key: 's',
                id: 'aar-effort',
                value: draft.reasoningEffort,
                disabled: busy,
                onChange: (event) => edit({ reasoningEffort: event.target.value }),
              },
              [
                h('option', { key: '', value: '' }, t('effortInherit')),
                ...LEVELS.map((level) => h('option', { key: level, value: level }, level)),
              ],
            ),
            h('span', { key: 'n', className: 'aar-note' }, t('effortNote')),
          ]),
          h('div', { key: 'reason-language', className: 'aar-field' }, [
            h('label', { key: 'l', htmlFor: 'aar-reason-language' }, t('reasonLanguage')),
            h(
              'select',
              {
                key: 's',
                id: 'aar-reason-language',
                value: draft.reasonLanguage,
                disabled: busy,
                onChange: (event) => edit({ reasonLanguage: event.target.value }),
              },
              [
                h('option', { key: '', value: '' }, t('reasonLanguageOfficial')),
                h('option', { key: 'zh', value: 'zh' }, t('reasonLanguageZh')),
                h('option', { key: 'en', value: 'en' }, t('reasonLanguageEn')),
              ],
            ),
            h('span', { key: 'n', className: 'aar-note' }, t('reasonLanguageNote')),
          ]),
          h('div', { key: 'retry-enabled', className: 'aar-field aar-retry-field' }, [
            h('label', { key: 'l', className: 'aar-toggle', htmlFor: 'aar-retry-enabled' }, [
              h('input', {
                key: 'i',
                id: 'aar-retry-enabled',
                type: 'checkbox',
                checked: draft.retryEnabled,
                disabled: busy,
                onChange: (event) => edit({ retryEnabled: event.target.checked }),
              }),
              h('span', { key: 'text' }, t('retryEnabled')),
            ]),
            h('span', { key: 'n', className: 'aar-note' }, t('retryNote')),
          ]),
          h('div', { key: 'retry-attempts', className: 'aar-field' }, [
            h('label', { key: 'l', htmlFor: 'aar-retry-attempts' }, t('retryAttempts')),
            h('input', {
              key: 'i',
              id: 'aar-retry-attempts',
              type: 'number',
              min: 1,
              max: MAX_RETRY_ATTEMPTS,
              step: 1,
              value: draft.retryAttempts,
              disabled: busy || !draft.retryEnabled,
              'aria-invalid': !validRetryAttempts(draft.retryAttempts),
              onChange: (event) => {
                const value = event.target.value;
                edit({ retryAttempts: value === '' ? '' : Number(value) });
              },
            }),
            h('span', {
              key: 'n',
              className: validRetryAttempts(draft.retryAttempts) ? 'aar-note' : 'aar-err',
            }, validRetryAttempts(draft.retryAttempts) ? t('retryAttemptsNote') : t('retryAttemptsInvalid')),
          ]),
          h('div', { key: 'debug', className: 'aar-field aar-debug-field' }, [
            h('label', { key: 'l', className: 'aar-toggle', htmlFor: 'aar-debug' }, [
              h('input', {
                key: 'i',
                id: 'aar-debug',
                type: 'checkbox',
                checked: draft.debug,
                disabled: busy,
                onChange: (event) => edit({ debug: event.target.checked }),
              }),
              h('span', { key: 'text' }, t('debug')),
            ]),
            h('span', { key: 'n', className: 'aar-note' }, t('debugNote')),
          ]),
        ]),
        h('hr', { key: 'hr2' }),
        h('div', { key: 'marker', className: 'aar-field' }, [
          h('label', { key: 'l', htmlFor: 'aar-marker' }, t('marker')),
          h('input', {
            key: 'i',
            id: 'aar-marker',
            type: 'text',
            value: draft.marker,
            disabled: busy,
            placeholder: 'REVIEW_POLICY',
            onChange: (event) => edit({ marker: event.target.value }),
          }),
          h('span', { key: 'n', className: 'aar-note' }, t('markerHelp')),
        ]),
        h('div', { key: 'actions', className: 'aar-actions' }, [
          h(
            'button',
            {
              key: 'save',
              type: 'button',
              className: 'aar-primary',
              disabled: busy || !dirty || !validRetryAttempts(draft.retryAttempts) || !validFallbackRoute(draft.fallbackProvider, draft.fallbackModel),
              onClick: () => void save(draft),
            },
            t(busy ? 'saving' : 'save'),
          ),
          h('button', { key: 'reset', type: 'button', disabled: busy, onClick: reset }, t('reset')),
          h(
            'button',
            {
              key: 'clear',
              type: 'button',
              disabled: busy,
              onClick: () => {
                const cleared = {
                  provider: '',
                  model: '',
                  fallbackEnabled: draft.fallbackEnabled,
                  fallbackProvider: draft.fallbackProvider,
                  fallbackModel: draft.fallbackModel,
                  reasoningEffort: '',
                  reasonLanguage: draft.reasonLanguage,
                  debug: draft.debug,
                  retryEnabled: draft.retryEnabled,
                  retryAttempts: validRetryAttempts(draft.retryAttempts)
                    ? draft.retryAttempts
                    : DEFAULT_RETRY_ATTEMPTS,
                  marker: draft.marker,
                };
                edit({ provider: '', model: '', reasoningEffort: '' });
                setManualModels((current) => ({ ...current, primary: false }));
                void save(cleared);
              },
            },
            t('clear'),
          ),
          message.length > 0
            ? h(
                'span',
                { key: 'msg', className: messageKind === 'err' ? 'aar-err' : 'aar-muted', role: 'status' },
                message,
              )
            : null,
        ].filter(Boolean)),
        h('hr', { key: 'debug-log-separator' }),
        h('section', { key: 'debug-log', className: 'aar-debug-log', 'aria-labelledby': 'aar-debug-log-title' }, [
          h('strong', { key: 'title', id: 'aar-debug-log-title' }, t('debugHistory')),
          h('p', { key: 'note', className: 'aar-note' }, t('debugHistoryNote')),
          h('div', { key: 'actions', className: 'aar-actions' }, [
            h('button', {
              key: 'refresh',
              id: 'aar-debug-refresh',
              type: 'button',
              disabled: debugBusy,
              onClick: refreshDebug,
            }, t(debugBusy ? 'debugLoading' : 'debugRefresh')),
            h('button', {
              key: 'copy',
              id: 'aar-debug-copy',
              type: 'button',
              disabled: debugBusy || debugRecords.length === 0,
              onClick: copyDebug,
            }, t('debugCopy')),
            h('button', {
              key: 'clear',
              id: 'aar-debug-clear',
              type: 'button',
              disabled: debugBusy || debugRecords.length === 0,
              onClick: clearDebug,
            }, t('debugClear')),
          ]),
          debugStatus.length > 0
            ? h('span', { key: 'status', className: 'aar-note', role: 'status' }, debugStatus)
            : null,
          debugRecords.length > 0
            ? h('pre', { key: 'output', className: 'aar-log-output', 'aria-label': t('debugHistory') }, JSON.stringify(debugRecords, null, 2))
            : h('p', { key: 'empty', className: 'aar-note', role: 'status' }, t('debugEmpty')),
        ]),
      ]);
    }

    return {
      name: 'dsh-auto-review-route-client',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'auto-review-route: dictionaries');
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: ROW_KEY, locale: NS },
            (props) => (props && props.view === 'summary' ? Summary(props) : Page(props)),
          ),
        );
      },
    };
  },
});
