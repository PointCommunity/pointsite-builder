import type { SiteDocument } from '../../site-kit/types';

type Form = SiteDocument['forms'][number];
type FormField = Form['fields'][number];
const optionTypes = new Set<FormField['type']>(['select', 'radio', 'checkbox']);

export function FormsEditor({
  forms,
  onChange,
}: {
  forms: Form[];
  onChange: (forms: Form[]) => void;
}) {
  const updateForm = (index: number, change: (form: Form) => void) => {
    const next = structuredClone(forms);
    const form = next[index];
    if (form) change(form);
    onChange(next);
  };
  const updateField = (formIndex: number, fieldIndex: number, change: (field: FormField) => void) =>
    updateForm(formIndex, (form) => {
      const field = form.fields[fieldIndex];
      if (field) change(field);
    });
  const addForm = () =>
    onChange([
      ...forms,
      {
        id: crypto.randomUUID(),
        name: 'New form',
        recipientEmail: 'hello@pointatx.org',
        subject: 'Website form',
        submitLabel: 'Send',
        fields: [
          { id: crypto.randomUUID(), name: 'name', label: 'Name', type: 'text', required: true },
        ],
      },
    ]);
  return (
    <section className="settings-section" aria-labelledby="forms-title">
      <div className="settings-heading">
        <div>
          <h3 id="forms-title">Forms</h3>
          <p>
            Form submissions open a prepared email; no visitor data is stored on the public site.
          </p>
        </div>
      </div>
      <div className="settings-list">
        {forms.map((form, formIndex) => (
          <fieldset className="settings-list__item settings-list__item--stacked" key={form.id}>
            <legend>{form.name}</legend>
            <div className="field-grid">
              <label>
                <span>Internal form name</span>
                <input
                  required
                  value={form.name}
                  onChange={(event) =>
                    updateForm(formIndex, (target) => {
                      target.name = event.target.value;
                    })
                  }
                />
              </label>
              <label>
                <span>Recipient email</span>
                <input
                  required
                  type="email"
                  value={form.recipientEmail}
                  onChange={(event) =>
                    updateForm(formIndex, (target) => {
                      target.recipientEmail = event.target.value;
                    })
                  }
                />
              </label>
              <label>
                <span>Email subject</span>
                <input
                  required
                  value={form.subject}
                  onChange={(event) =>
                    updateForm(formIndex, (target) => {
                      target.subject = event.target.value;
                    })
                  }
                />
              </label>
              <label>
                <span>Submit button</span>
                <input
                  required
                  value={form.submitLabel}
                  onChange={(event) =>
                    updateForm(formIndex, (target) => {
                      target.submitLabel = event.target.value;
                    })
                  }
                />
              </label>
            </div>
            <fieldset className="settings-fieldset">
              <legend>Fields</legend>
              {form.fields.map((field, fieldIndex) => (
                <div className="form-field-editor" key={field.id}>
                  <div className="field-grid">
                    <label>
                      <span>Label</span>
                      <input
                        required
                        value={field.label}
                        onChange={(event) =>
                          updateField(formIndex, fieldIndex, (target) => {
                            target.label = event.target.value;
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Field key</span>
                      <input
                        required
                        pattern="[a-z][A-Za-z0-9_]*"
                        value={field.name}
                        onChange={(event) =>
                          updateField(formIndex, fieldIndex, (target) => {
                            target.name = event.target.value;
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Type</span>
                      <select
                        value={field.type}
                        onChange={(event) =>
                          updateField(formIndex, fieldIndex, (target) => {
                            const type = event.target.value as FormField['type'];
                            target.type = type;
                            target.options = optionTypes.has(type)
                              ? (target.options ?? ['Option 1'])
                              : undefined;
                          })
                        }
                      >
                        <option value="text">Short text</option>
                        <option value="email">Email</option>
                        <option value="tel">Phone</option>
                        <option value="textarea">Long text</option>
                        <option value="select">Select menu</option>
                        <option value="radio">Single choice</option>
                        <option value="checkbox">Checkboxes</option>
                      </select>
                    </label>
                    <label>
                      <span>Placeholder</span>
                      <input
                        value={field.placeholder ?? ''}
                        onChange={(event) =>
                          updateField(formIndex, fieldIndex, (target) => {
                            target.placeholder = event.target.value || undefined;
                          })
                        }
                      />
                    </label>
                    {optionTypes.has(field.type) ? (
                      <label className="field-wide">
                        <span>Options (one per line)</span>
                        <textarea
                          value={field.options?.join('\n') ?? ''}
                          onChange={(event) =>
                            updateField(formIndex, fieldIndex, (target) => {
                              target.options = event.target.value
                                .split('\n')
                                .map((item) => item.trim())
                                .filter(Boolean);
                            })
                          }
                        />
                      </label>
                    ) : null}
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={field.required}
                        onChange={(event) =>
                          updateField(formIndex, fieldIndex, (target) => {
                            target.required = event.target.checked;
                          })
                        }
                      />
                      <span>Required</span>
                    </label>
                  </div>
                  <button
                    type="button"
                    className="button button--danger"
                    disabled={form.fields.length === 1}
                    onClick={() =>
                      updateForm(formIndex, (target) => {
                        target.fields.splice(fieldIndex, 1);
                      })
                    }
                  >
                    Remove field
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button"
                disabled={form.fields.length >= 30}
                onClick={() =>
                  updateForm(formIndex, (target) => {
                    target.fields.push({
                      id: crypto.randomUUID(),
                      name: `field${target.fields.length + 1}`,
                      label: 'New field',
                      type: 'text',
                      required: false,
                    });
                  })
                }
              >
                Add field
              </button>
            </fieldset>
            <button
              type="button"
              className="button button--danger"
              onClick={() => onChange(forms.filter((_, index) => index !== formIndex))}
            >
              Remove form
            </button>
          </fieldset>
        ))}
      </div>
      <button type="button" className="button" disabled={forms.length >= 30} onClick={addForm}>
        Add form
      </button>
    </section>
  );
}
