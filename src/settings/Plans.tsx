import { forgetPlace, usePlansUi } from "../floor/planLinks";

/** The Plans board's hidden places ("Don't ask"), to bring back. */
export function Plans() {
  const ui = usePlansUi();
  const hidden = Object.entries(ui.links).flatMap(([key, l]) => ("hidden" in l ? [{ key, label: l.label }] : []));
  return (
    <section className="settings-pane" aria-label="Plans">
      <h1 className="display-lg">Plans</h1>
      <p className="muted">The Floor shows one card per account you use, Claude or ChatGPT, and every place it's used.</p>
      <section className="prov-section" aria-label="Hidden">
        <h2 className="field-label">Hidden</h2>
        <p className="faint small">Places you said not to ask about. Shown again, one waits under “Not matched” for you to say which account it is.</p>
        {hidden.length === 0 ? (
          <p className="faint small">None.</p>
        ) : (
          <div className="hub-list">
            {hidden.map((h) => (
              <div key={h.key} className="hub-row">
                <span className="hub-name">
                  <b>{h.label}</b>
                </span>
                <button type="button" className="btn" onClick={() => forgetPlace(h.key)}>
                  Show again
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
