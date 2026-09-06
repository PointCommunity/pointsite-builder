import { useState } from 'react';
import type { SiteDocument } from '../../site-kit/types';

type Form = SiteDocument['forms'][number];
type FormField = Form['fields'][number];
const optionTypes = new Set<FormField['type']>(['select', 'radio', 'checkbox']);
const fieldTypes: Array<{ value: FormField['type']; label: string }> = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'email', label: 'Email address' },
  { value: 'tel', label: 'Phone number' },
  { value: 'url', label: 'Website link' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'select', label: 'Dropdown menu' },
  { value: 'radio', label: 'Choose one' },
  { value: 'checkbox', label: 'Choose any' },
];

function newField(position: number): FormField {
  return {
    id: crypto.randomUUID(),
    name: `field${position}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
    label: 'New field',
    type: 'text',
    required: false,
    width: 'full',
  };
}

function newForm(): Form {
  return {
    id: crypto.randomUUID(),
    name: 'New form',
    recipientEmail: 'connect@pointaustin.org',
    subject: 'Website form',
    heading: 'How can we help?',
    introduction: 'Complete this short form and our team will follow up.',
    submitLabel: 'Send',
    privacyNote: 'Submitting opens your email app so you can review the message before sending.',
    successMessage: 'Your email app is opening with this request ready to send.',
    layout: 'single',
    density: 'comfortable',
    fields: [newField(1)],
  };
}

export function FormsEditor({
  forms,
  usedFormIds = new Set<string>(),
  onChange,
}: {
  forms: Form[];
  usedFormIds?: ReadonlySet<string>;
  onChange: (forms: Form[]) => void;
}) {
  const [selectedId, setSelectedId] = useState(forms[0]?.id ?? '');
  const selectedIndex = forms.findIndex((form) => form.id === selectedId);
  const selected = forms[selectedIndex];
  const updateForm = (change: (form: Form) => void) => {
    if (selectedIndex < 0) return;
    const next = structuredClone(forms);
    change(next[selectedIndex]);
    onChange(next);
  };
  const updateField = (index: number, change: (field: FormField) => void) =>
    updateForm((form) => change(form.fields[index]));
  const moveField = (index: number, offset: -1 | 1) =>
    updateForm((form) => {
      const destination = index + offset;
      if (destination < 0 || destination >= form.fields.length) return;
      const [field] = form.fields.splice(index, 1);
      form.fields.splice(destination, 0, field);
    });

  return (
    <section className="forms-workspace" aria-labelledby="forms-title">
      <header className="section-heading">
        <div>
          <p className="eyebrow">No-code form builder</p>
          <h2 id="forms-title">Forms</h2>
        </div>
        <p>
          Build short, accessible forms. Visitor entries open a prepared email and are not stored.
        </p>
      </header>
      <div className="forms-layout">
        <aside className="forms-sidebar" aria-label="Website forms">
          <div className="settings-heading">
            <h3>Your forms</h3>
            <button
              type="button"
              className="button button--primary"
              disabled={forms.length >= 30}
              onClick={() => {
                const created = newForm();
                onChange([...forms, created]);
                setSelectedId(created.id);
              }}
            >
              New form
            </button>
          </div>
          {forms.length === 0 ? <p>No forms yet. Create one to get started.</p> : null}
          <div className="form-picker">
            {forms.map((form) => (
              <button
                key={form.id}
                type="button"
                aria-current={selectedId === form.id ? 'true' : undefined}
                onClick={() => setSelectedId(form.id)}
              >
                <strong>{form.name}</strong>
                <span>
                  {form.fields.length} {form.fields.length === 1 ? 'field' : 'fields'}
                </span>
              </button>
            ))}
          </div>
        </aside>
        {selected ? (
          <div className="form-designer">
            <section className="settings-section" aria-labelledby="form-basics-title">
              <div className="settings-heading">
                <div>
                  <h3 id="form-basics-title">Form details</h3>
                  <p>Names and messages shown to visitors.</p>
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="button"
                    disabled={forms.length >= 30}
                    onClick={() => {
                      const copy = structuredClone(selected);
                      copy.id = crypto.randomUUID();
                      copy.name = `${selected.name} copy`;
                      copy.fields = copy.fields.map((field) => ({
                        ...field,
                        id: crypto.randomUUID(),
                      }));
                      onChange([...forms, copy]);
                      setSelectedId(copy.id);
                    }}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="button button--danger"
                    disabled={usedFormIds.has(selected.id)}
                    onClick={() => {
                      if (!window.confirm(`Delete the form “${selected.name}”?`)) return;
                      const remaining = forms.filter((form) => form.id !== selected.id);
                      onChange(remaining);
                      setSelectedId(remaining[0]?.id ?? '');
                    }}
                  >
                    {usedFormIds.has(selected.id) ? 'Used in Layout' : 'Delete form'}
                  </button>
                </div>
              </div>
              <div className="field-grid">
                <label>
                  <span>Form name</span>
                  <input
                    required
                    value={selected.name}
                    onChange={(event) =>
                      updateForm((form) => {
                        form.name = event.target.value;
                      })
                    }
                  />
                </label>
                <label>
                  <span>Heading</span>
                  <input
                    value={selected.heading ?? ''}
                    onChange={(event) =>
                      updateForm((form) => {
                        form.heading = event.target.value || undefined;
                      })
                    }
                  />
                </label>
                <label className="field-wide">
                  <span>Introduction</span>
                  <textarea
                    value={selected.introduction ?? ''}
                    onChange={(event) =>
                      updateForm((form) => {
                        form.introduction = event.target.value || undefined;
                      })
                    }
                  />
                </label>
                <label>
                  <span>Send entries to</span>
                  <input
                    type="email"
                    required
                    value={selected.recipientEmail}
                    onChange={(event) =>
                      updateForm((form) => {
                        form.recipientEmail = event.target.value;
                      })
                    }
                  />
                </label>
                <label>
                  <span>Email subject</span>
                  <input
                    required
                    value={selected.subject}
                    onChange={(event) =>
                      updateForm((form) => {
                        form.subject = event.target.value;
                      })
                    }
                  />
                </label>
                <label>
                  <span>Submit button label</span>
                  <input
                    required
                    value={selected.submitLabel}
                    onChange={(event) =>
                      updateForm((form) => {
                        form.submitLabel = event.target.value;
                      })
                    }
                  />
                </label>
                <label>
                  <span>Layout</span>
                  <select
                    value={selected.layout}
                    onChange={(event) =>
                      updateForm((form) => {
                        form.layout = event.target.value as Form['layout'];
                      })
                    }
                  >
                    <option value="single">One column</option>
                    <option value="two-column">Two columns</option>
                  </select>
                </label>
                <label>
                  <span>Spacing</span>
                  <select
                    value={selected.density}
                    onChange={(event) =>
                      updateForm((form) => {
                        form.density = event.target.value as Form['density'];
                      })
                    }
                  >
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </select>
                </label>
                <label className="field-wide">
                  <span>Privacy guidance</span>
                  <textarea
                    value={selected.privacyNote ?? ''}
                    onChange={(event) =>
                      updateForm((form) => {
                        form.privacyNote = event.target.value || undefined;
                      })
                    }
                  />
                </label>
                <label className="field-wide">
                  <span>After-submit message</span>
                  <textarea
                    value={selected.successMessage ?? ''}
                    onChange={(event) =>
                      updateForm((form) => {
                        form.successMessage = event.target.value || undefined;
                      })
                    }
                  />
                </label>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="fields-title">
              <div className="settings-heading">
                <div>
                  <h3 id="fields-title">Questions and fields</h3>
                  <p>Move buttons make every arrangement keyboard accessible.</p>
                </div>
                <button
                  type="button"
                  className="button button--primary"
                  disabled={selected.fields.length >= 30}
                  onClick={() =>
                    updateForm((form) => {
                      form.fields.push(newField(form.fields.length + 1));
                    })
                  }
                >
                  Add field
                </button>
              </div>
              <div className="form-fields-list">
                {selected.fields.map((field, index) => (
                  <fieldset className="form-field-editor" key={field.id}>
                    <legend>
                      {index + 1}. {field.label}
                    </legend>
                    <div className="field-grid">
                      <label>
                        <span>Question or label</span>
                        <input
                          required
                          value={field.label}
                          onChange={(event) =>
                            updateField(index, (target) => {
                              target.label = event.target.value;
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Answer type</span>
                        <select
                          value={field.type}
                          onChange={(event) =>
                            updateField(index, (target) => {
                              const type = event.target.value as FormField['type'];
                              target.type = type;
                              target.options = optionTypes.has(type)
                                ? (target.options ?? ['Option 1'])
                                : undefined;
                            })
                          }
                        >
                          {fieldTypes.map((type) => (
                            <option key={type.value} value={type.value}>
                              {type.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Placeholder example</span>
                        <input
                          value={field.placeholder ?? ''}
                          onChange={(event) =>
                            updateField(index, (target) => {
                              target.placeholder = event.target.value || undefined;
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>Width</span>
                        <select
                          value={field.width}
                          onChange={(event) =>
                            updateField(index, (target) => {
                              target.width = event.target.value as FormField['width'];
                            })
                          }
                        >
                          <option value="full">Full row</option>
                          <option value="half">Half row</option>
                        </select>
                      </label>
                      <label className="field-wide">
                        <span>Helpful instructions</span>
                        <input
                          value={field.helpText ?? ''}
                          onChange={(event) =>
                            updateField(index, (target) => {
                              target.helpText = event.target.value || undefined;
                            })
                          }
                        />
                      </label>
                      {optionTypes.has(field.type) ? (
                        <label className="field-wide">
                          <span>Choices (one per line)</span>
                          <textarea
                            value={field.options?.join('\n') ?? ''}
                            onChange={(event) =>
                              updateField(index, (target) => {
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
                            updateField(index, (target) => {
                              target.required = event.target.checked;
                            })
                          }
                        />
                        <span>Answer required</span>
                      </label>
                    </div>
                    <div className="button-row">
                      <button
                        className="button"
                        type="button"
                        disabled={index === 0}
                        aria-label={`Move ${field.label} up`}
                        onClick={() => moveField(index, -1)}
                      >
                        ↑ Move up
                      </button>
                      <button
                        className="button"
                        type="button"
                        disabled={index === selected.fields.length - 1}
                        aria-label={`Move ${field.label} down`}
                        onClick={() => moveField(index, 1)}
                      >
                        ↓ Move down
                      </button>
                      <button
                        className="button"
                        type="button"
                        disabled={selected.fields.length >= 30}
                        onClick={() =>
                          updateForm((form) => {
                            form.fields.splice(index + 1, 0, {
                              ...structuredClone(field),
                              id: crypto.randomUUID(),
                              name: `field${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
                            });
                          })
                        }
                      >
                        Duplicate field
                      </button>
                      <button
                        className="button button--danger"
                        type="button"
                        disabled={selected.fields.length === 1}
                        onClick={() =>
                          updateForm((form) => {
                            form.fields.splice(index, 1);
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </fieldset>
                ))}
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </section>
  );
}
