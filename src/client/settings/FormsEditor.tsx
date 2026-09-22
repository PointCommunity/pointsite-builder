import { useLayoutEffect, useRef, useState } from 'react';
import type { SiteDocument } from '../../site-kit/types';
import {
  areasOverlap,
  clampGridArea,
  updateGridArea,
  type GridArea,
  type GridBreakpoint,
} from '../../site-kit/grid-layout';

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

function placeFields(fields: FormField[]): void {
  let row = 1;
  let column = 1;
  fields.forEach((field, index) => {
    const span = field.width === 'half' ? 6 : 12;
    if (column + span > 13) {
      row += 1;
      column = 1;
    }
    field.grid = {
      desktop: { column, row, columnSpan: span, rowSpan: 1 },
      tablet: { column: 1, row: index + 1, columnSpan: 12, rowSpan: 1 },
      mobile: { column: 1, row: index + 1, columnSpan: 12, rowSpan: 1 },
    };
    column += span;
  });
}

function appendField(form: Form, field: FormField): void {
  if (form.layout === 'grid') {
    field.grid = Object.fromEntries(
      (['desktop', 'tablet', 'mobile'] as const).map((breakpoint) => [
        breakpoint,
        {
          column: 1,
          row: Math.max(
            1,
            ...form.fields.map(
              (item) => item.grid![breakpoint].row + item.grid![breakpoint].rowSpan,
            ),
          ),
          columnSpan: 12,
          rowSpan: 1,
        },
      ]),
    ) as NonNullable<FormField['grid']>;
  }
  form.fields.push(field);
}

function validFieldArea(
  fields: FormField[],
  index: number,
  breakpoint: GridBreakpoint,
  next: GridArea,
): boolean {
  const before = fields[index - 1]?.grid?.[breakpoint];
  const after = fields[index + 1]?.grid?.[breakpoint];
  const ordered = (a: GridArea, b: GridArea) =>
    a.row < b.row || (a.row === b.row && a.column <= b.column);
  return (
    (!before || ordered(before, next)) &&
    (!after || ordered(next, after)) &&
    !fields.some(
      (field, position) =>
        position !== index && field.grid && areasOverlap(next, field.grid[breakpoint]),
    )
  );
}

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

function newForm(recipientEmail: string): Form {
  return {
    id: crypto.randomUUID(),
    name: 'New form',
    recipientEmail,
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
  schemaVersion = 11,
  siteEmail,
  usedFormIds = new Set<string>(),
  onChange,
}: {
  forms: Form[];
  schemaVersion?: number;
  siteEmail?: string;
  usedFormIds?: ReadonlySet<string>;
  onChange: (forms: Form[]) => void;
}) {
  const [selectedId, setSelectedId] = useState(forms[0]?.id ?? '');
  const [group, setGroup] = useState<'questions' | 'details'>('questions');
  const [fieldId, setFieldId] = useState('');
  const [breakpoint, setBreakpoint] = useState<GridBreakpoint>('desktop');
  const [gridError, setGridError] = useState('');
  const root = useRef<HTMLElement>(null);
  const focusField = useRef(false);
  const selectedIndex = forms.findIndex((form) => form.id === selectedId);
  const selected = forms[selectedIndex];
  const selectedFieldId = selected?.fields.some((field) => field.id === fieldId)
    ? fieldId
    : selected?.fields[0]?.id;
  useLayoutEffect(() => {
    if (!focusField.current) return;
    root.current
      ?.querySelector<HTMLInputElement>('.form-field-editor:not([hidden]) input')
      ?.focus();
    focusField.current = false;
  }, [selectedFieldId]);
  const navigate = (action: () => void) => {
    const invalid = Array.from(
      root.current?.querySelectorAll<HTMLInputElement>(':invalid') ?? [],
    ).find((field) => !field.closest('[hidden]'));
    if (invalid) {
      invalid.reportValidity();
      invalid.focus();
      return;
    }
    action();
  };
  const updateForm = (change: (form: Form) => void) => {
    if (selectedIndex < 0) return;
    const next = structuredClone(forms);
    change(next[selectedIndex]);
    onChange(next);
  };
  const updateField = (index: number, change: (field: FormField) => void) =>
    updateForm((form) => change(form.fields[index]));
  const moveField = (index: number, destination: number) =>
    updateForm((form) => {
      if (destination < 0 || destination >= form.fields.length) return;
      const slots = form.fields.map((field) => field.grid);
      const [field] = form.fields.splice(index, 1);
      form.fields.splice(destination, 0, field);
      if (form.layout === 'grid')
        form.fields.forEach((item, position) => {
          item.grid = slots[position];
        });
    });
  const updateArea = (index: number, change: Partial<GridArea>) => {
    const fields = selected?.fields;
    if (!fields?.[index]?.grid) return;
    const next = clampGridArea({ ...fields[index].grid[breakpoint], ...change });
    if (!validFieldArea(fields, index, breakpoint, next)) {
      setGridError('Fields cannot overlap or appear before an earlier question.');
      return;
    }
    setGridError('');
    updateField(index, (field) => {
      field.grid = updateGridArea(field.grid!, breakpoint, change);
    });
  };

  return (
    <section
      className="forms-workspace"
      aria-labelledby="forms-title"
      ref={root}
      onInvalidCapture={(event) => {
        const target = event.target as HTMLElement;
        setGroup(target.closest('[data-form-group="details"]') ? 'details' : 'questions');
        const field = target.closest<HTMLElement>('[data-form-field]');
        if (field) setFieldId(field.dataset.formField!);
      }}
    >
      <header className="section-heading">
        <div>
          <p className="eyebrow">Website forms</p>
          <h2 id="forms-title">Form Designer</h2>
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
                const created = newForm(
                  siteEmail ?? forms[0]?.recipientEmail ?? 'contact@example.com',
                );
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
                onClick={() => navigate(() => setSelectedId(form.id))}
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
            <nav className="category-navigation" aria-label="Form sections">
              <button
                type="button"
                className="button"
                aria-pressed={group === 'questions'}
                onClick={() => navigate(() => setGroup('questions'))}
              >
                Questions
              </button>
              <button
                type="button"
                className="button"
                aria-pressed={group === 'details'}
                onClick={() => navigate(() => setGroup('details'))}
              >
                Form details
              </button>
            </nav>
            <section
              data-form-group="details"
              hidden={group !== 'details'}
              className="settings-section"
              aria-labelledby="form-basics-title"
            >
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
                        if (form.layout === 'grid') placeFields(form.fields);
                        else
                          form.fields.forEach((field) => {
                            field.grid = undefined;
                          });
                      })
                    }
                  >
                    <option value="single">One column</option>
                    <option value="two-column">Two columns</option>
                    {schemaVersion >= 12 ? <option value="grid">Grid (12 columns)</option> : null}
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
            <section
              data-form-group="questions"
              hidden={group !== 'questions'}
              className="settings-section"
              aria-labelledby="fields-title"
            >
              <div className="settings-heading">
                <div>
                  <h3 id="fields-title">Questions and fields</h3>
                  <p>Move buttons make every arrangement keyboard accessible.</p>
                </div>
                <button
                  type="button"
                  className="button button--primary"
                  disabled={selected.fields.length >= 30}
                  onClick={() => {
                    const field = newField(selected.fields.length + 1);
                    updateForm((form) => {
                      appendField(form, field);
                    });
                    setFieldId(field.id);
                    focusField.current = true;
                  }}
                >
                  Add field
                </button>
              </div>
              {selected.layout === 'grid' ? (
                <div className="form-grid-preview-scroll">
                  <p>
                    Drag a field to a free grid cell, or use its row and column controls. Tab order
                    follows the question list.
                  </p>
                  <div
                    className="form-grid-preview"
                    aria-label={`${breakpoint} form grid`}
                    style={{
                      gridTemplateRows: `repeat(${Math.min(1000, Math.max(2, ...selected.fields.map((field) => field.grid![breakpoint].row + field.grid![breakpoint].rowSpan)))}, 56px)`,
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const index = selected.fields.findIndex(
                        (field) =>
                          field.id === event.dataTransfer.getData('application/x-point-form-field'),
                      );
                      if (index < 0) return;
                      const rect = event.currentTarget.getBoundingClientRect();
                      updateArea(index, {
                        column: Math.floor(((event.clientX - rect.left) / rect.width) * 12) + 1,
                        row: Math.floor((event.clientY - rect.top) / 62) + 1,
                      });
                    }}
                  >
                    {selected.fields.map((field) =>
                      field.grid ? (
                        <button
                          key={field.id}
                          type="button"
                          draggable
                          className="form-grid-preview__field"
                          aria-pressed={selectedFieldId === field.id}
                          style={{
                            gridColumn: `${field.grid[breakpoint].column} / span ${field.grid[breakpoint].columnSpan}`,
                            gridRow: `${field.grid[breakpoint].row} / span ${field.grid[breakpoint].rowSpan}`,
                          }}
                          onClick={() => setFieldId(field.id)}
                          onDragStart={(event) =>
                            event.dataTransfer.setData('application/x-point-form-field', field.id)
                          }
                        >
                          {field.label || 'Untitled question'}
                        </button>
                      ) : null,
                    )}
                  </div>
                </div>
              ) : null}
              <div className="question-workspace">
                <div className="form-fields-list" aria-label="Question list">
                  {selected.fields.map((field, index) => (
                    <button
                      type="button"
                      className="question-summary"
                      key={field.id}
                      draggable={selected.layout === 'grid'}
                      onDragStart={(event) => event.dataTransfer.setData('text/plain', field.id)}
                      onDragOver={(event) => {
                        if (selected.layout === 'grid') event.preventDefault();
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const source = selected.fields.findIndex(
                          (candidate) => candidate.id === event.dataTransfer.getData('text/plain'),
                        );
                        if (source >= 0 && source !== index) moveField(source, index);
                      }}
                      aria-pressed={selectedFieldId === field.id}
                      onClick={() => navigate(() => setFieldId(field.id))}
                    >
                      <strong>
                        {index + 1}. {field.label || 'Untitled question'}
                      </strong>
                      <span>
                        {fieldTypes.find((type) => type.value === field.type)?.label}
                        {field.required ? ' · Required' : ' · Optional'}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="form-field-properties">
                  {selected.fields.map((field, index) => (
                    <fieldset
                      data-form-field={field.id}
                      hidden={selectedFieldId !== field.id}
                      className="form-field-editor"
                      key={field.id}
                    >
                      <legend>
                        {index + 1}. {field.label}
                      </legend>
                      {selected.layout === 'grid' && field.grid ? (
                        <>
                          <label>
                            <span>Grid breakpoint</span>
                            <select
                              value={breakpoint}
                              onChange={(event) =>
                                setBreakpoint(event.target.value as GridBreakpoint)
                              }
                            >
                              <option value="desktop">Desktop</option>
                              <option value="tablet">Tablet</option>
                              <option value="mobile">Mobile</option>
                            </select>
                          </label>
                          <div className="field-grid">
                            {(
                              [
                                ['Column', 'column', 12],
                                ['Row', 'row', 1000],
                                ['Width (columns)', 'columnSpan', 12],
                                ['Height (rows)', 'rowSpan', 100],
                              ] as const
                            ).map(([label, key, max]) => (
                              <label key={key}>
                                <span>{label}</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={max}
                                  value={field.grid![breakpoint][key]}
                                  onChange={(event) =>
                                    updateArea(index, { [key]: Number(event.target.value) })
                                  }
                                />
                              </label>
                            ))}
                          </div>
                          {gridError ? <p role="alert">{gridError}</p> : null}
                        </>
                      ) : null}
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
                        {selected.layout !== 'grid' ? (
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
                        ) : null}
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
                          onClick={() => moveField(index, index - 1)}
                        >
                          ↑ Move up
                        </button>
                        <button
                          className="button"
                          type="button"
                          disabled={index === selected.fields.length - 1}
                          aria-label={`Move ${field.label} down`}
                          onClick={() => moveField(index, index + 1)}
                        >
                          ↓ Move down
                        </button>
                        <button
                          className="button"
                          type="button"
                          disabled={selected.fields.length >= 30}
                          onClick={() => {
                            const id = crypto.randomUUID();
                            updateForm((form) => {
                              const copy = {
                                ...structuredClone(field),
                                id,
                                name: `field${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
                              };
                              if (form.layout === 'grid') appendField(form, copy);
                              else form.fields.splice(index + 1, 0, copy);
                            });
                            setFieldId(id);
                            focusField.current = true;
                          }}
                        >
                          Duplicate field
                        </button>
                        <button
                          className="button button--danger"
                          type="button"
                          disabled={selected.fields.length === 1}
                          onClick={() => {
                            focusField.current = true;
                            setFieldId(
                              selected.fields[index + 1]?.id ??
                                selected.fields[index - 1]?.id ??
                                '',
                            );
                            updateForm((form) => {
                              form.fields.splice(index, 1);
                            });
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </fieldset>
                  ))}
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </section>
  );
}
