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
    const { useEffect, useState, useCallback, useMemo } = React;

    const NS = 'dshAutoReviewRoute';
    const ROW_KEY = '@mrjiage/dsh-auto-review-route#auto-review-route';
    const BRIDGE = '/api/dsh-auto-review-route';

    const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

    const en = {
      title: 'Auto-review model route',
      summaryUnset: 'Reviewer uses the session model',
      summaryPrefix: 'Reviewer pinned to',
      intro:
        'Send the Auto-review model request to a provider and model of your choice, so the reviewer does not compete with the working model for the same concurrency quota. The official auto-review plugin is not modified: its risk policy, prompt, tools and lifecycle stay exactly as shipped.',
      unsetNotice:
        'Nothing is selected yet, so the official behaviour applies: the reviewer uses the session\'s own provider and model. Pick both a provider and a model to pin it.',
      provider: 'Provider',
      model: 'Model',
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
      effectiveOfficial: 'Session provider and model (official behaviour)',
      effortNote:
        'Lower reasoning levels are usually faster; higher levels usually take more reasoning time. Unsupported levels fall back to the target model default.',
      noneOption: '— none —',
      readFailed: 'Could not read this row\'s settings',
    };

    const zh = {
      title: '自动审查模型路由',
      summaryUnset: '审查使用会话模型',
      summaryPrefix: '审查已指定为',
      intro:
        '把自动审查的模型请求发往你指定的渠道与模型，避免审查请求和工作模型抢同一个并发额度。官方自动审查插件不会被修改：风险策略、提示词、工具与生命周期全部保持出厂状态。',
      unsetNotice:
        '当前未选择任何渠道与模型，因此沿用官方行为：审查使用会话自身的渠道与模型。选择渠道和模型后才会接管。',
      provider: '渠道',
      model: '模型',
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
      effectiveOfficial: '会话渠道与模型（官方行为）',
      effortNote: '推理档位越低通常响应越快，越高通常需要更多推理时间；具体效果取决于目标模型。不支持的档位会改用目标模型默认值。',
      noneOption: '— 不选 —',
      readFailed: '无法读取此行的设置',
    };

    const CSS = `
.aar { color:var(--dsw-alias-label-primary,inherit); font:inherit; display:grid; gap:18px; max-width:52rem; }
.aar p { margin:0; line-height:1.55; max-width:78ch; overflow-wrap:anywhere; }
.aar .aar-muted { color:var(--dsw-alias-label-secondary,inherit); }
.aar .aar-grid { display:grid; gap:14px; grid-template-columns:repeat(2,minmax(0,1fr)); }
.aar .aar-field { display:grid; gap:7px; min-width:0; }
.aar label { font-weight:600; }
.aar select, .aar input[type=text] {
  box-sizing:border-box; width:100%; max-width:100%; min-height:36px; padding:7px 10px;
  font:inherit; color:inherit; background:transparent;
  border:1px solid var(--dsw-alias-border-l2,#888); border-radius:var(--dsw-radius-sm,8px);
}
.aar .aar-note { color:var(--dsw-alias-label-secondary,inherit); font-size:.9em; }
.aar .aar-err { color:var(--dsw-alias-state-error-primary,inherit); }
.aar .aar-actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.aar button {
  font:inherit; color:inherit; background:transparent; cursor:pointer; min-height:36px; padding:7px 14px;
  border:1px solid var(--dsw-alias-border-l2,#888); border-radius:var(--dsw-radius-md,12px);
}
.aar button:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2,#8882); }
/* Only the declared theme tokens are used here. The theme exposes no
   "on-primary" foreground token, and the plain label token is body text that is
   dark in the light theme, so a filled control carries a literal white label —
   the same choice the shipping primary control makes — while its fill stays a
   token so it still follows the theme. */
.aar button.aar-primary {
  background:var(--dsw-alias-brand-primary,#356be8);
  color:#fff;
  border-color:transparent;
}
.aar button.aar-primary:hover:not(:disabled) { background:var(--dsw-alias-brand-primary,#356be8); color:#fff; }
 .aar :disabled { opacity:.6; cursor:not-allowed; }
/* Keep the label legible even at the reduced disabled opacity: a disabled
   filled control still shows its text instead of a blank surface. */
.aar button.aar-primary:disabled { color:#fff; opacity:.55; }
.aar :is(button,select,input):focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#356be8); outline-offset:2px; }
.aar .aar-card {
  border:1px solid var(--dsw-alias-border-l1,#8883); border-radius:var(--dsw-radius-md,12px);
  padding:14px 16px; display:grid; gap:8px; background:var(--dsw-alias-bg-layer-1,transparent);
}
.aar hr { border:0; border-top:1px solid var(--dsw-alias-border-l1,#8883); margin:2px 0; }
@media (max-width:520px) { .aar .aar-grid { grid-template-columns:1fr; } }
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
        reasoningEffort: text('reasoningEffort'),
        // An empty marker means "use the shipped default"; show it plainly so
        // the field never looks like a missing requirement.
        marker: text('marker') || 'REVIEW_POLICY',
      };
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
      const [models, setModels] = useState(null);
      const [modelsError, setModelsError] = useState('');
      const [manualModel, setManualModel] = useState(false);

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

      // Model catalog follows the chosen provider.
      const provider = draft.provider;
      useEffect(() => {
        setModelsError('');
        if (provider.length === 0) {
          setModels(null);
          return;
        }
        let live = true;
        setModels(null);
        bridge('models', { provider }).then(
          (body) => {
            if (!live) return;
            if (body?.ok === true) setModels(body.value.models ?? []);
            else {
              setModels([]);
              setModelsError(body?.message ?? '');
            }
          },
          (error) => {
            if (!live) return;
            setModels([]);
            setModelsError(error instanceof Error ? error.message : String(error));
          },
        );
        return () => {
          live = false;
        };
      }, [provider]);

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
        setManualModel(false);
      }, [ready, state.values]);

      const save = useCallback(
        async (next) => {
          if (busy) return;
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

      const providerOptions = useMemo(() => providers ?? [], [providers]);
      const modelOptions = useMemo(() => models ?? [], [models]);
      const knownModels = useMemo(() => modelOptions.map((entry) => entry.id), [modelOptions]);
      const useManual =
        manualModel || (modelOptions.length > 0 && draft.model.length > 0 && !knownModels.includes(draft.model));
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
        h('div', { key: 'grid', className: 'aar-grid' }, [
          h('div', { key: 'p', className: 'aar-field' }, [
            h('label', { key: 'l', htmlFor: 'aar-provider' }, t('provider')),
            h(
              'select',
              {
                key: 's',
                id: 'aar-provider',
                value: draft.provider,
                disabled: busy,
                onChange: (event) => {
                  // A model id belongs to one provider: clear it so a saved
                  // route can never name a model the new provider lacks.
                  edit({ provider: event.target.value, model: '' });
                  setManualModel(false);
                },
              },
              [
                h('option', { key: '', value: '' }, t('noneOption')),
                ...providerOptions.map((entry) =>
                  h('option', { key: entry.id, value: entry.id }, `${entry.name ?? entry.id} (${entry.id})`),
                ),
              ],
            ),
            providerError.length > 0
              ? h('span', { key: 'e', className: 'aar-note aar-err' }, `${t('loadFailed')}: ${providerError}`)
              : null,
          ].filter(Boolean)),
          h('div', { key: 'm', className: 'aar-field' }, [
            h('label', { key: 'l', htmlFor: 'aar-model' }, t('model')),
            useManual
              ? h('input', {
                  key: 'i',
                  id: 'aar-model',
                  type: 'text',
                  value: draft.model,
                  disabled: busy,
                  placeholder: 'model id',
                  onChange: (event) => edit({ model: event.target.value }),
                })
              : h(
                  'select',
                  {
                    key: 's',
                    id: 'aar-model',
                    value: draft.model,
                    disabled: busy || draft.provider.length === 0,
                    onChange: (event) => edit({ model: event.target.value }),
                  },
                  [
                    h(
                      'option',
                      { key: '', value: '' },
                      draft.provider.length === 0 ? t('choosePrompt') : models === null ? t('loading') : t('noneOption'),
                    ),
                    ...modelOptions.map((entry) =>
                      h('option', { key: entry.id, value: entry.id }, `${entry.name ?? entry.id} (${entry.id})`),
                    ),
                  ],
                ),
            h(
              'button',
              { key: 'toggle', type: 'button', disabled: busy, onClick: () => setManualModel((current) => !current) },
              useManual ? t('useCatalog') : t('freeText'),
            ),
            modelsError.length > 0
              ? h('span', { key: 'e', className: 'aar-note aar-err' }, `${t('loadFailed')}: ${modelsError}`)
              : null,
          ].filter(Boolean)),
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
              disabled: busy || !dirty,
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
                const cleared = { provider: '', model: '', reasoningEffort: '', marker: draft.marker };
                edit({ provider: '', model: '', reasoningEffort: '' });
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
