import { useEffect, useState } from "react";
import type { KeySource, ProviderKind, ProviderPreset, ProviderTestResult, ProviderView, SeatView } from "../../../src/shared/providers.ts";
import type { Role } from "../../../src/shared/types.ts";
import { confirmDialog, Icon, Modal } from "./ui.tsx";
import { api, type CouncilInfo, type ProvidersInfo } from "../api.ts";

const KINDS: { id: ProviderKind; label: string }[] = [
  { id: "openai", label: "OpenAI-compatible" },
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Google Gemini" },
];
const ROLES: Role[] = ["strategist", "skeptic", "engineer", "security", "reviewer", "researcher", "speaker"];

interface ProviderDraft {
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  keySource: KeySource;
  apiKeyEnv: string;
  apiKey: string;
}

interface SeatDraft {
  id?: string;
  name: string;
  provider: string;
  model: string;
  roles: Role[];
  persona: string;
  committees: string[];
  temperature: string;
}

const fromPreset = (p: ProviderPreset): ProviderDraft => ({
  name: p.name,
  kind: p.kind,
  baseUrl: p.baseUrl,
  keySource: p.apiKeyEnv ? "env" : "none",
  apiKeyEnv: p.apiKeyEnv ?? "",
  apiKey: "",
});

function KeyBadge({ p }: { p: ProviderView }) {
  if (p.keySource === "env")
    return (
      <span className={`key-badge ${p.envPresent ? "ok" : "bad"}`} title={p.envPresent ? "Set in the server's environment" : "Not set where Cortex runs"}>
        env {p.apiKeyEnv} {p.envPresent ? "✓" : "✗ not set"}
      </span>
    );
  if (p.keySource === "stored") return <span className="key-badge ok">key stored locally 🔒</span>;
  return <span className="key-badge">no key</span>;
}

function TestResult({ r }: { r: ProviderTestResult | null }) {
  if (!r) return null;
  return (
    <div className={`test-result ${r.ok ? "ok" : "bad"}`} role="status">
      {r.ok ? "✓" : "✗"} {r.detail}
      {r.latencyMs > 0 && <span className="muted"> · {r.latencyMs} ms</span>}
    </div>
  );
}

/** Add, edit, test and remove API providers, and seat their models in the council. */
export function ProvidersModal({ council, onClose, onChanged }: { council: CouncilInfo; onClose: () => void; onChanged: () => void }) {
  const [info, setInfo] = useState<ProvidersInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [seat, setSeat] = useState<SeatDraft | null>(null);
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const [rowTest, setRowTest] = useState<Record<string, ProviderTestResult>>({});
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .providers()
      .then(setInfo)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const run = async (fn: () => Promise<unknown>, changed = true) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (changed) {
        await load();
        onChanged();
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const providerBody = (d: ProviderDraft) => ({
    name: d.name,
    kind: d.kind,
    baseUrl: d.baseUrl,
    keySource: d.keySource,
    ...(d.keySource === "env" ? { apiKeyEnv: d.apiKeyEnv } : {}),
    ...(d.keySource === "stored" && d.apiKey ? { apiKey: d.apiKey } : {}),
  });

  const testDraft = (d: ProviderDraft) =>
    run(async () => {
      const r = await api.testProvider({ id: d.id, ...providerBody(d) });
      setTest(r);
      if (r.ok && d.id) setModels((m) => ({ ...m, [d.id!]: r.models }));
    }, false);

  const testSaved = (p: ProviderView) =>
    run(async () => {
      const r = await api.testProvider({ id: p.id });
      setRowTest((t) => ({ ...t, [p.id]: r }));
      if (r.ok) setModels((m) => ({ ...m, [p.id]: r.models }));
    }, false);

  const saveDraft = async (d: ProviderDraft) => {
    const body = providerBody(d);
    const ok = await run(async () => {
      const saved = d.id ? await api.updateProvider(d.id, body) : await api.addProvider(body);
      // Fresh provider: go straight to seating one of its models.
      if (!d.id) setSeat(newSeat(saved.id));
    });
    if (ok) {
      setDraft(null);
      setTest(null);
    }
  };

  const newSeat = (provider: string): SeatDraft => ({
    name: "",
    provider,
    model: "",
    roles: ["strategist"],
    persona: "",
    committees: council.committees.some((c) => c.id === "full") ? ["full"] : [],
    temperature: "",
  });

  const editSeat = (s: SeatView): SeatDraft => ({
    id: s.id,
    name: s.name,
    provider: s.provider,
    model: s.model,
    roles: s.roles,
    persona: s.persona ?? "",
    committees: s.committees,
    temperature: s.temperature === undefined ? "" : String(s.temperature),
  });

  const saveSeat = async (s: SeatDraft) => {
    const body = {
      name: s.name || s.model,
      provider: s.provider,
      model: s.model,
      roles: s.roles,
      persona: s.persona || undefined,
      committees: s.committees,
      ...(s.temperature !== "" ? { temperature: Number(s.temperature) } : {}),
    };
    if (await run(() => (s.id ? api.updateSeat(s.id, body) : api.seat(body)))) setSeat(null);
  };

  const providers = info?.providers ?? [];
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

  // Load the model list for the provider picked in the seat form.
  useEffect(() => {
    if (seat?.provider && !models[seat.provider]) {
      api
        .testProvider({ id: seat.provider })
        .then((r) => r.ok && setModels((m) => ({ ...m, [seat.provider]: r.models })))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seat?.provider]);

  return (
    <Modal title="API providers" onClose={onClose} size="lg">
      <div className="modal-body">
        <p className="muted small">
          Connect any OpenAI-compatible, Anthropic or Gemini API, then seat its models in the council. Keys are write-only: Cortex never shows,
          logs or audits them. Referencing an environment variable keeps the key off disk entirely; a pasted key is kept in{" "}
          <code>.cortex/secrets.json</code> (owner-only, git-ignored).
        </p>
        {error && <div className="error">{error}</div>}

        <section className="providers">
          {providers.length === 0 && !draft && <p className="muted">No providers yet. Pick one below to get started.</p>}
          {providers.map((p) => (
            <div key={p.id} className="provider-row">
              <div>
                <b>{p.name}</b> <span className="muted small">{KINDS.find((k) => k.id === p.kind)?.label}</span>
                <div className="mono small muted">{p.baseUrl}</div>
                <div className="row small">
                  <KeyBadge p={p} />
                  <span className="muted">
                    {p.members.length} seat{p.members.length === 1 ? "" : "s"}
                  </span>
                </div>
                <TestResult r={rowTest[p.id] ?? null} />
              </div>
              <div className="provider-actions">
                <button type="button" disabled={busy} onClick={() => testSaved(p)}>
                  Test
                </button>
                <button type="button" disabled={busy} onClick={() => setSeat(newSeat(p.id))}>
                  <Icon name="plus" size={14} /> Add model
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setTest(null);
                    setDraft({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, keySource: p.keySource, apiKeyEnv: p.apiKeyEnv ?? "", apiKey: "" });
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy || p.members.length > 0}
                  title={p.members.length ? "Remove its models from the council first" : undefined}
                  onClick={async () =>
                    (await confirmDialog({ title: `Remove ${p.name}?`, body: "Its stored key is deleted too.", confirmLabel: "Remove provider", danger: true })) &&
                    run(() => api.removeProvider(p.id))
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </section>

        {!draft && (
          <div className="presets" aria-label="Add a provider">
            {(info?.presets ?? []).map((p) => (
              <button
                type="button"
                key={p.id}
                onClick={() => {
                  setTest(null);
                  setDraft(fromPreset(p));
                }}
              >
                <Icon name="plus" size={14} /> {p.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setTest(null);
                setDraft({ name: "", kind: "openai", baseUrl: "", keySource: "stored", apiKeyEnv: "", apiKey: "" });
              }}
            >
              <Icon name="plus" size={14} /> Custom endpoint
            </button>
          </div>
        )}

        {draft && (
          <form
            className="subform"
            onSubmit={(e) => {
              e.preventDefault();
              saveDraft(draft);
            }}
          >
            <h3>{draft.id ? `Edit ${draft.name}` : "Add provider"}</h3>
            <div className="row">
              <label>
                Name
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} required autoFocus />
              </label>
              <label>
                Protocol
                <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ProviderKind })}>
                  {KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Base URL
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                placeholder="https://api.example.com/v1"
                inputMode="url"
              />
            </label>
            <fieldset className="key-source">
              <legend>API key</legend>
              {(
                [
                  ["env", "Environment variable (recommended)"],
                  ["stored", "Paste key"],
                  ["none", "No key (local server)"],
                ] as [KeySource, string][]
              ).map(([v, label]) => (
                <label key={v}>
                  <input type="radio" name="keySource" checked={draft.keySource === v} onChange={() => setDraft({ ...draft, keySource: v })} />
                  {label}
                </label>
              ))}
            </fieldset>
            {draft.keySource === "env" && (
              <label>
                Variable name
                <input
                  value={draft.apiKeyEnv}
                  onChange={(e) => setDraft({ ...draft, apiKeyEnv: e.target.value })}
                  placeholder="GROQ_API_KEY"
                  className="mono"
                  required
                />
                <span className="muted small">Set it in .env or your shell, then restart Cortex.</span>
              </label>
            )}
            {draft.keySource === "stored" && (
              <label>
                Key
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.apiKey}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  placeholder={draft.id ? "Stored · leave blank to keep the current key" : "sk-…"}
                  required={!draft.id || !providers.find((p) => p.id === draft.id && p.keySource === "stored")}
                />
              </label>
            )}
            <TestResult r={test} />
            <footer className="modal-foot">
              <button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setTest(null);
                }}
              >
                Cancel
              </button>
              <button type="button" disabled={busy} onClick={() => testDraft(draft)}>
                Test connection
              </button>
              <button type="submit" className="primary" disabled={busy}>
                Save
              </button>
            </footer>
          </form>
        )}

        {(info?.seats.length ?? 0) > 0 && (
          <section>
            <h3>Models in the council</h3>
            <ul className="seat-list">
              {info!.seats.map((s) => {
                const color = council.members.find((m) => m.id === s.id)?.color;
                return (
                  <li key={s.id} style={{ ["--c" as string]: color }}>
                    <div>
                      <b>{s.name}</b> <span className="mono small muted">{s.model}</span>
                      <div className="small muted">
                        {providers.find((p) => p.id === s.provider)?.name ?? s.provider} · {s.roles.join(", ") || "no roles"}
                      </div>
                    </div>
                    <div className="provider-actions">
                      <button type="button" disabled={busy} onClick={() => setSeat(editSeat(s))}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={async () =>
                          (await confirmDialog({ title: `Remove ${s.name}?`, body: "The model leaves the council; the provider stays configured.", confirmLabel: "Remove", danger: true })) &&
                          run(() => api.unseat(s.id))
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {seat && (
          <form
            className="subform"
            onSubmit={(e) => {
              e.preventDefault();
              saveSeat(seat);
            }}
          >
            <h3>{seat.id ? `Edit ${seat.name}` : "Add a model"}</h3>
            <div className="row">
              <label>
                Provider
                <select value={seat.provider} onChange={(e) => setSeat({ ...seat, provider: e.target.value })}>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Model
                <input
                  value={seat.model}
                  onChange={(e) => setSeat({ ...seat, model: e.target.value })}
                  list="provider-models"
                  className="mono"
                  placeholder={models[seat.provider]?.length ? "Pick or type a model id" : "e.g. llama-3.3-70b-versatile"}
                  required
                />
                <datalist id="provider-models">
                  {(models[seat.provider] ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
            </div>
            <div className="row">
              <label>
                Display name
                <input value={seat.name} onChange={(e) => setSeat({ ...seat, name: e.target.value })} placeholder={seat.model || "e.g. Groq Llama"} maxLength={60} />
              </label>
              <label>
                Temperature
                <input type="number" min={0} max={2} step={0.1} value={seat.temperature} onChange={(e) => setSeat({ ...seat, temperature: e.target.value })} placeholder="default" />
              </label>
            </div>
            <div className="field-label">Roles</div>
            <div className="checks">
              {ROLES.map((r) => (
                <label key={r}>
                  <input type="checkbox" checked={seat.roles.includes(r)} onChange={(e) => setSeat({ ...seat, roles: toggle(seat.roles, r, e.target.checked) })} />
                  {r}
                </label>
              ))}
            </div>
            {council.committees.length > 0 && (
              <>
                <div className="field-label">Committees</div>
                <div className="checks">
                  {council.committees.map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={seat.committees.includes(c.id)}
                        onChange={(e) => setSeat({ ...seat, committees: toggle(seat.committees, c.id, e.target.checked) })}
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              </>
            )}
            <label>
              Persona (optional)
              <textarea value={seat.persona} onChange={(e) => setSeat({ ...seat, persona: e.target.value })} rows={2} maxLength={1000} placeholder="How this member should argue" />
            </label>
            <footer className="modal-foot">
              <button type="button" onClick={() => setSeat(null)}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy || !providers.length}>
                {seat.id ? "Save" : "Add member"}
              </button>
            </footer>
          </form>
        )}
      </div>
    </Modal>
  );
}
