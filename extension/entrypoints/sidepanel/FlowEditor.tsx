import { useEffect, useState } from 'react';
import { sendRuntimeMessage, type ContentStateView } from '@/lib/messaging';
import {
  describePage,
  describePages,
  describeFlow,
  describeSteps,
  parseOrigin,
  shortFlowId,
  type InputDefinition,
  type Flow,
} from '@/lib/flow-schema';
import type { InputIssue, InputValue } from '@/lib/flow-inputs';
import type { FlowSchedule } from '@/lib/flow-schedules';
import { t, type MessageKey } from '@/lib/i18n';
import { formatTime } from '@/lib/ui-labels';
import { redactText } from '@/lib/redact';
import FlowHistorySection from './FlowHistorySection';

interface Props {
  flow: Flow;
  contentState: ContentStateView | null;
  failureText: string | null;
  onBack: () => void;
  onSaved: () => void;
}

type SaveErrors = string[];

export default function FlowEditor({ flow: initial, contentState, failureText, onBack, onSaved }: Props) {
  const [flow, setFlow] = useState<Flow>(initial);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<SaveErrors>([]);
  const [statusBusy, setStatusBusy] = useState(false);

  // Input form state (form-support): unsaved draft + per-item issues recomputed by the background on
  // every read/save against the CURRENT definitions. A checkbox control cannot distinguish "not
  // filled" from false, so checkbox booleans are always submitted (absent stays a storage-level
  // concept). Stale records from an older definition are never seeded back into the controls.
  const [inputDraft, setInputDraft] = useState<Record<string, InputValue>>({});
  const [inputIssues, setInputIssues] = useState<InputIssue[]>([]);
  const [inputBusy, setInputBusy] = useState(false);
  const [inputSaved, setInputSaved] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [inputsHydrated, setInputsHydrated] = useState((initial.inputs?.length ?? 0) === 0);
  // A failed hydration must not fall through to an editable empty form: under the whole-form replace
  // contract an unaware save would wipe every stored value. The form stays closed until a retry
  // succeeds; inputsRetry re-runs the effect.
  const [inputLoadError, setInputLoadError] = useState<string | null>(null);
  const [inputsRetry, setInputsRetry] = useState(0);

  // Timed-trigger schedules (device-local, never part of the flow definition). The card pulls the
  // plan list on mount and after each mutation; the next-trigger display always reads the record's
  // nextDueAt — the background is the only place it is computed, so there is no second calculation
  // to drift. The form is component-local state; nothing persists beyond the records themselves.
  const [schedules, setSchedules] = useState<FlowSchedule[] | null>(null);
  const [schedulesRetry, setSchedulesRetry] = useState(0);
  const [schedulesLoadError, setSchedulesLoadError] = useState<string | null>(null);
  const [scheduleFormOpen, setScheduleFormOpen] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [scheduleKind, setScheduleKind] = useState<'daily' | 'weekly' | 'interval'>('daily');
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [scheduleWeekday, setScheduleWeekday] = useState('1');
  const [scheduleMinutes, setScheduleMinutes] = useState('30');
  const [scheduleEntryUrl, setScheduleEntryUrl] = useState('');
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setSchedulesLoadError(null);
      try {
        const res = await sendRuntimeMessage({ type: 'sp:getSchedules', flowId: initial.id });
        if (cancelled) return;
        if (res?.ok) {
          setSchedules(res.schedules ?? []);
        } else {
          setSchedulesLoadError(t('editor.schedules.loadFail', { reason: res?.reason ?? t('common.unknownReason') }));
        }
      } catch {
        if (!cancelled) setSchedulesLoadError(t('editor.schedules.loadTimeout'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initial.id, schedulesRetry]);

  useEffect(() => {
    if ((initial.inputs?.length ?? 0) === 0) return;
    let cancelled = false;
    void (async () => {
      setInputLoadError(null);
      try {
        const res = await sendRuntimeMessage({ type: 'sp:getFlowInputs', flowId: initial.id });
        if (cancelled) return;
        if (res?.ok) {
          setInputDraft(res.values ?? {});
          setInputIssues(res.inputIssues ?? []);
          setInputsHydrated(true);
        } else {
          setInputLoadError(t('editor.inputs.loadFail', { reason: res?.reason ?? t('common.unknownReason') }));
        }
      } catch {
        if (!cancelled) setInputLoadError(t('editor.inputs.loadTimeout'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initial.id, inputsRetry]);

  const updateInputDraft = (key: string, value: InputValue) => {
    setInputSaved(false);
    setInputDraft((prev) => ({ ...prev, [key]: value }));
  };

  const issueTextOf = (def: InputDefinition): string | null => {
    const issue = inputIssues.find((i) => i.key === def.key);
    if (issue === undefined) return null;
    return t(`editor.inputs.issue.${issue.reason}` as MessageKey);
  };

  const saveInputs = async (): Promise<void> => {
    // Whole-form replace semantics make an unhydrated save a wipe — the button only renders on a
    // hydrated form, this guard keeps that invariant true even if a future caller forgets it
    if (!inputsHydrated) return;
    setInputBusy(true);
    setInputSaved(false);
    setInputError(null);
    try {
      const res = await sendRuntimeMessage({ type: 'sp:saveFlowInputs', flowId: flow.id, values: inputDraft });
      if (res?.ok) {
        setInputIssues(res.inputIssues ?? []);
        setInputSaved(true);
      } else if (res?.ok === false && res.reason === 'invalid-input') {
        setInputIssues(res.inputIssues ?? []);
        setInputError(t('editor.inputs.invalidNotSaved'));
      } else {
        setInputError(t('editor.inputs.saveFail', { reason: res?.reason ?? t('common.unknownReason') }));
      }
    } catch {
      setInputError(t('editor.inputs.saveTimeout'));
    } finally {
      setInputBusy(false);
    }
  };

  const updateFlow = (patch: Partial<Flow>) =>
    setFlow((prev) => ({ ...prev, ...patch }) as Flow);

  // updatedAt is compare-and-swap: the editor sends the stamp it opened with, so a flow revised
  // meanwhile (AI optimize, sync pull) refuses the save instead of being rolled back. A successful
  // save returns the fresh stamp for the editor's next save from the same session.
  const save = async (): Promise<boolean> => {
    setSaving(true);
    setErrors([]);
    try {
      const res = await sendRuntimeMessage({
        type: 'sp:saveFlow',
        flow,
        expectedUpdatedAt: flow.provenance.updatedAt,
      });
      if (!res?.ok) {
        if (res?.ok === false && res.reason === 'changed') {
          setErrors([t('editor.saveConflict')]);
          return false;
        }
        setErrors([t('editor.saveFail', { reason: res?.reason ?? t('common.unknownReason') })]);
        return false;
      }
      if (res.updatedAt !== undefined) {
        setFlow((prev) => ({ ...prev, provenance: { ...prev.provenance, updatedAt: res.updatedAt! } }));
      }
      return true;
    } catch {
      setErrors([t('editor.saveTimeout')]);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const enableFlow = async () => {
    setStatusBusy(true);
    const saved = await save();
    if (!saved) {
      setStatusBusy(false);
      return;
    }
    const res = await sendRuntimeMessage({ type: 'sp:setFlowStatus', id: flow.id, status: 'enabled' });
    setStatusBusy(false);
    if (!res?.ok) {
      setErrors([t('editor.enableFail', { reason: res?.reason ?? t('common.unknownReason') })]);
      return;
    }
    onSaved();
  };

  // "Improve with AI": pause the flow (if enabled), then grant the native channel a
  // 15-minute single-flow read — the AI reads the full definition over flow.read, re-verifies on the
  // target page and replaces it under the original id after your in-conversation confirmation. The
  // editor stays open so the grant state is visible; the import page is not involved.
  const [grant, setGrant] = useState<{ expiresInMs: number } | null>(null);
  const optimizeFlow = async () => {
    setStatusBusy(true);
    setErrors([]);
    setGrant(null);
    try {
      if (flow.status === 'enabled') {
        const paused = await sendRuntimeMessage({ type: 'sp:setFlowStatus', id: flow.id, status: 'paused' });
        if (!paused?.ok) {
          setErrors([t('editor.optimizeFail', { reason: paused?.reason ?? t('common.unknownReason') })]);
          return;
        }
      }
      const res = await sendRuntimeMessage({ type: 'sp:grantNativeRead', flowId: flow.id });
      if (!res?.ok) {
        setErrors([t('editor.optimizeFail', { reason: res?.reason ?? t('common.unknownReason') })]);
        return;
      }
      setGrant({ expiresInMs: res.expiresInMs ?? 0 });
    } catch {
      setErrors([t('editor.optimizeFail', { reason: t('common.timeoutWord') })]);
    } finally {
      setStatusBusy(false);
    }
  };

  const describeSchedulePeriod = (schedule: FlowSchedule): string => {
    if (schedule.period.kind === 'daily') return t('editor.schedules.desc.daily', { time: schedule.period.time });
    if (schedule.period.kind === 'weekly') {
      return t('editor.schedules.desc.weekly', {
        weekday: t(`editor.schedules.weekday.${schedule.period.weekday}` as MessageKey),
        time: schedule.period.time,
      });
    }
    return t('editor.schedules.desc.interval', { minutes: schedule.period.minutes });
  };

  const scheduleReasonText = (reason: string | undefined): string => {
    // The guard rejects a malformed period before the writer can answer 'invalid-schedule' — the
    // only payload this form builds — so the same wording is shown instead of the unknown fallback
    const known = ['schedule-limit', 'flow-not-found', 'flow-not-enabled', 'invalid-schedule', 'invalid-entry-url'];
    const key = reason === 'bad-payload' ? 'invalid-schedule' : reason;
    return key !== undefined && known.includes(key)
      ? t(`editor.schedules.reason.${key}` as MessageKey)
      : t('common.unknownReason');
  };

  const closeScheduleForm = (): void => {
    setScheduleFormOpen(false);
    setEditingScheduleId(null);
    setScheduleError(null);
  };

  const openScheduleCreate = (): void => {
    setScheduleKind('daily');
    setScheduleTime('09:00');
    setScheduleWeekday('1');
    setScheduleMinutes('30');
    // Prefill from the active tab when it already sits on this flow's site
    setScheduleEntryUrl(contentState !== null && parseOrigin(contentState.url) === flow.site ? contentState.url : '');
    setScheduleError(null);
    setScheduleFormOpen(true);
    setEditingScheduleId(null);
  };

  const openScheduleEdit = (schedule: FlowSchedule): void => {
    setScheduleKind(schedule.period.kind);
    if (schedule.period.kind === 'daily' || schedule.period.kind === 'weekly') setScheduleTime(schedule.period.time);
    if (schedule.period.kind === 'weekly') setScheduleWeekday(String(schedule.period.weekday));
    if (schedule.period.kind === 'interval') setScheduleMinutes(String(schedule.period.minutes));
    setScheduleEntryUrl(schedule.entryUrl);
    setScheduleError(null);
    setEditingScheduleId(schedule.id);
    setScheduleFormOpen(true);
  };

  const saveSchedule = async (): Promise<void> => {
    setScheduleBusy(true);
    setScheduleError(null);
    const period: unknown =
      scheduleKind === 'daily'
        ? { kind: 'daily', time: scheduleTime }
        : scheduleKind === 'weekly'
          ? { kind: 'weekly', weekday: Number(scheduleWeekday), time: scheduleTime }
          : { kind: 'interval', minutes: Number(scheduleMinutes) };
    try {
      const res = await sendRuntimeMessage({
        type: 'sp:saveSchedule',
        schedule: {
          ...(editingScheduleId !== null ? { id: editingScheduleId } : {}),
          flowId: flow.id,
          entryUrl: scheduleEntryUrl.trim(),
          period,
        },
      });
      if (res?.ok) {
        closeScheduleForm();
        setSchedulesRetry((n) => n + 1);
      } else {
        setScheduleError(t('editor.schedules.saveFail', { reason: scheduleReasonText(res?.ok === false ? res.reason : undefined) }));
      }
    } catch {
      setScheduleError(t('editor.schedules.saveFail', { reason: t('common.timeoutWord') }));
    } finally {
      setScheduleBusy(false);
    }
  };

  // Deleting a schedule is a light record rebuild (unlike deleting a flow, nothing is
  // irreversible) — no confirm dialog
  const removeSchedule = async (id: string): Promise<void> => {
    setScheduleBusy(true);
    setScheduleError(null);
    try {
      const res = await sendRuntimeMessage({ type: 'sp:deleteSchedule', id });
      if (!res?.ok) {
        setScheduleError(t('editor.schedules.deleteFail', { reason: scheduleReasonText(res?.ok === false ? res.reason : undefined) }));
      }
      setSchedulesRetry((n) => n + 1);
    } catch {
      setScheduleError(t('editor.schedules.deleteFail', { reason: t('common.timeoutWord') }));
    } finally {
      setScheduleBusy(false);
    }
  };

  const renderInputControl = (def: InputDefinition, domId: string, issue: string | null) => {
    const issueId = `${domId}-err`;
    const common = {
      id: domId,
      'data-input-key': def.key,
      'aria-describedby': issue !== null ? issueId : undefined,
    };
    const value = inputDraft[def.key];
    switch (def.type) {
      case 'text':
      case 'number':
      case 'date':
      case 'time':
        return (
          <input
            {...common}
            className="sp-input"
            type={def.type === 'number' ? 'text' : def.type}
            inputMode={def.type === 'number' ? 'decimal' : undefined}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => updateInputDraft(def.key, e.target.value)}
          />
        );
      case 'single':
        return (
          <select
            {...common}
            className="sp-select"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => updateInputDraft(def.key, e.target.value)}
          >
            <option value="">—</option>
            {(def.options ?? []).map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        );
      case 'checkbox':
        return <input {...common} type="checkbox" checked={value === true} onChange={(e) => updateInputDraft(def.key, e.target.checked)} />;
      case 'multi': {
        const selected = Array.isArray(value) ? value : [];
        return (
          <div {...common} className="sp-group" role="group" aria-label={def.label}>
            {(def.options ?? []).map((opt) => (
              <label key={opt.value} className="sp-option">
                <input
                  type="checkbox"
                  value={opt.value}
                  checked={selected.includes(opt.value)}
                  onChange={(e) =>
                    updateInputDraft(
                      def.key,
                      e.target.checked ? [...selected, opt.value] : selected.filter((v) => v !== opt.value),
                    )
                  }
                />
                {opt.label}
              </label>
            ))}
          </div>
        );
      }
    }
  };

  return (
    <>
      <button type="button" className="sp-btn sp-back" onClick={onBack}>
        {t('editor.back')}
      </button>

      <section className="sp-card">
        <div className="sp-field">
          <label className="sp-label" htmlFor="flow-name">{t('editor.nameLabel')}</label>
          <input
            id="flow-name"
            className="sp-input"
            value={flow.name}
            onChange={(e) => updateFlow({ name: e.target.value })}
          />
        </div>
        <p className="sp-desc">{redactText(describeFlow(flow))}</p>
        <p className="sp-sub">
          {t('editor.siteLine', { site: flow.site, page: describePages(flow) })}
          {contentState ? t('editor.currentPage', { target: contentState.pageTarget }) : ''}
        </p>
        <p className="sp-sub">
          <span title={t('flows.idTooltip')}>{t('editor.flowIdLine', { id: shortFlowId(flow.id) })}</span>
        </p>
      </section>

      <section className="sp-card" aria-label={t('editor.actions.title')}>
        <h2 className="sp-title">{t('editor.actions.title')}</h2>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {describeSteps(flow.steps).map((s, i) => (
            <li key={i} className="sp-desc">
              {s.submit ? '⚠ ' : ''}
              {redactText(s.text)}
            </li>
          ))}
        </ol>
      </section>

      {(flow.inputs?.length ?? 0) > 0 && (
        <section className="sp-card" aria-label={t('editor.inputs.title')}>
          <h2 className="sp-title">{t('editor.inputs.title')}</h2>
          <p className="sp-sub">{t('editor.inputs.hint')}</p>
          {!inputsHydrated && inputLoadError === null && <p className="sp-sub">{t('common.loading')}</p>}
          {inputLoadError !== null && (
            <>
              <p className="sp-error" role="alert">{inputLoadError}</p>
              <div className="sp-row">
                <button type="button" className="sp-btn" onClick={() => setInputsRetry((n) => n + 1)}>
                  {t('common.retry')}
                </button>
              </div>
            </>
          )}
          {inputsHydrated && (
            <>
              {flow.inputs!.map((def) => {
                const domId = `flow-input-${def.key}`;
                const issue = issueTextOf(def);
                return (
                  <div key={def.key} className="sp-field">
                    <label className="sp-label" htmlFor={domId}>
                      {def.label}
                      {def.required ? t('editor.inputs.required') : t('editor.inputs.optional')}
                    </label>
                    {renderInputControl(def, domId, issue)}
                    {issue !== null && (
                      <p className="sp-error" id={`${domId}-err`} role="alert">{issue}</p>
                    )}
                  </div>
                );
              })}
              <div className="sp-row">
                <button type="button" className="sp-btn" onClick={() => void saveInputs()} disabled={inputBusy}>
                  {inputBusy ? t('common.saving') : t('editor.inputs.save')}
                </button>
              </div>
              {inputSaved && inputIssues.length === 0 && (
                <p className="sp-progress">{t('editor.inputs.savedNextRun')}</p>
              )}
              {inputSaved && inputIssues.length > 0 && (
                <p className="sp-progress fail">
                  {t('editor.inputs.incomplete', {
                    items: inputIssues.map((i) => (i.key === i.label ? i.key : `${i.label} (${i.key})`)).join('; '),
                  })}
                </p>
              )}
              {inputError && <p className="sp-error" role="alert">{inputError}</p>}
            </>
          )}
        </section>
      )}

      <section className="sp-card" aria-label={t('editor.schedules.title')}>
        <h2 className="sp-title">{t('editor.schedules.title')}</h2>
        {schedules === null ? (
          schedulesLoadError !== null ? (
            <>
              <p className="sp-error" role="alert">{schedulesLoadError}</p>
              <div className="sp-row">
                <button type="button" className="sp-btn" onClick={() => setSchedulesRetry((n) => n + 1)}>
                  {t('common.retry')}
                </button>
              </div>
            </>
          ) : (
            <p className="sp-sub">{t('common.loading')}</p>
          )
        ) : (
          <>
            <p className="sp-sub">{t('editor.schedules.count', { n: schedules.length })}</p>
            {schedules.length === 0 && <p className="sp-sub">{t('editor.schedules.empty')}</p>}
            {schedules.map((schedule) => (
              <div key={schedule.id} className="sp-field">
                <p className="sp-desc">
                  {describeSchedulePeriod(schedule)} ·{' '}
                  {t('editor.schedules.nextRun', { time: formatTime(schedule.nextDueAt, { withSeconds: false }) })}
                </p>
                <p className="sp-sub" style={{ overflowWrap: 'anywhere' }}>{redactText(schedule.entryUrl)}</p>
                <div className="sp-row">
                  <button type="button" className="sp-btn" onClick={() => openScheduleEdit(schedule)} disabled={scheduleBusy}>
                    {t('editor.schedules.edit')}
                  </button>
                  <button type="button" className="sp-btn" onClick={() => void removeSchedule(schedule.id)} disabled={scheduleBusy}>
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            ))}
            {flow.status !== 'enabled' ? (
              <p className="sp-sub">{t('editor.schedules.createDisabled')}</p>
            ) : scheduleFormOpen ? (
              <>
                <div className="sp-field">
                  <label className="sp-label" htmlFor="schedule-kind">{t('editor.schedules.kind')}</label>
                  <select
                    id="schedule-kind"
                    className="sp-select"
                    value={scheduleKind}
                    onChange={(e) => setScheduleKind(e.target.value as 'daily' | 'weekly' | 'interval')}
                  >
                    <option value="daily">{t('editor.schedules.kind.daily')}</option>
                    <option value="weekly">{t('editor.schedules.kind.weekly')}</option>
                    <option value="interval">{t('editor.schedules.kind.interval')}</option>
                  </select>
                </div>
                {scheduleKind !== 'interval' && (
                  <div className="sp-field">
                    <label className="sp-label" htmlFor="schedule-time">{t('editor.schedules.time')}</label>
                    <input
                      id="schedule-time"
                      className="sp-input"
                      type="time"
                      value={scheduleTime}
                      onChange={(e) => setScheduleTime(e.target.value)}
                    />
                  </div>
                )}
                {scheduleKind === 'weekly' && (
                  <div className="sp-field">
                    <label className="sp-label" htmlFor="schedule-weekday">{t('editor.schedules.weekday')}</label>
                    <select
                      id="schedule-weekday"
                      className="sp-select"
                      value={scheduleWeekday}
                      onChange={(e) => setScheduleWeekday(e.target.value)}
                    >
                      {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                        <option key={day} value={String(day)}>
                          {t(`editor.schedules.weekday.${day}` as MessageKey)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {scheduleKind === 'interval' && (
                  <div className="sp-field">
                    <label className="sp-label" htmlFor="schedule-minutes">{t('editor.schedules.intervalMinutes')}</label>
                    <input
                      id="schedule-minutes"
                      className="sp-input"
                      type="text"
                      inputMode="numeric"
                      value={scheduleMinutes}
                      onChange={(e) => setScheduleMinutes(e.target.value)}
                    />
                  </div>
                )}
                <div className="sp-field">
                  <label className="sp-label" htmlFor="schedule-entry">{t('editor.schedules.entryUrl')}</label>
                  <input
                    id="schedule-entry"
                    className="sp-input"
                    type="text"
                    value={scheduleEntryUrl}
                    onChange={(e) => setScheduleEntryUrl(e.target.value)}
                  />
                  <p className="sp-sub">{t('editor.schedules.entryUrlHint')}</p>
                </div>
                <div className="sp-row">
                  <button type="button" className="sp-btn" onClick={() => void saveSchedule()} disabled={scheduleBusy}>
                    {scheduleBusy ? t('common.saving') : t('editor.schedules.save')}
                  </button>
                  <button type="button" className="sp-btn" onClick={closeScheduleForm} disabled={scheduleBusy}>
                    {t('common.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <div className="sp-row">
                <button type="button" className="sp-btn" onClick={openScheduleCreate}>
                  {t('editor.schedules.add')}
                </button>
              </div>
            )}
            {scheduleError && <p className="sp-error" role="alert">{scheduleError}</p>}
          </>
        )}
      </section>

      <section className="sp-card" aria-label={t('editor.run.title')}>
        <h2 className="sp-title">{t('editor.run.title')}</h2>
        <div className="sp-row">
          <button
            type="button"
            className="sp-btn primary"
            onClick={() => void enableFlow()}
            disabled={statusBusy}
          >
            {statusBusy ? t('common.busy') : t('common.enable')}
          </button>
          <button type="button" className="sp-btn" onClick={() => void save().then((ok) => ok && onSaved())} disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
        {failureText && <p className="sp-progress fail">{t('flows.lastFailure')}: {failureText}</p>}
      </section>

      <section className="sp-card">
        <button type="button" className="sp-btn" onClick={() => void optimizeFlow()} disabled={statusBusy || saving}>
          {t('editor.optimize')}
        </button>
        <p className="sp-sub">{t('editor.optimizeHint')}</p>
        {grant !== null && (
          <p className="sp-progress" role="status">{t('editor.optimizeGranted', { minutes: Math.max(1, Math.round(grant.expiresInMs / 60_000)) })}</p>
        )}
      </section>

      <FlowHistorySection flowId={flow.id} flowName={flow.name} onRolledBack={onSaved} />

      {errors.length > 0 && (
        <section className="sp-card" role="alert">
          {errors.map((e, i) => (
            <p key={i} className="sp-error">{e}</p>
          ))}
        </section>
      )}
    </>
  );
}
