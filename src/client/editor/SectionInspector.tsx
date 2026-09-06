import type { SectionBlock, SiteDocument } from '../../site-kit/types';

export type SectionSettings = Omit<SectionBlock, 'id' | 'type' | 'items'>;

function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { label: string; value: T }[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="inspector-field">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => {
          const option = options.find(
            (candidate) => String(candidate.value) === event.target.value,
          );
          if (option) onChange(option.value);
        }}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SectionInspector({
  settings,
  document,
  onChange,
}: {
  settings: SectionSettings;
  document?: SiteDocument;
  onChange: (settings: SectionSettings) => void;
}) {
  if (settings.layout === 'compatibility')
    return (
      <div className="block-inspector">
        <p className="inspector-help">
          Production-compatible section. Convert it to Flow or Grid to customize its container.
        </p>
        <Select
          label="Section layout"
          value={settings.layout}
          options={[
            { label: 'Production compatible', value: 'compatibility' },
            { label: 'Flow', value: 'flow' },
            { label: 'Grid', value: 'grid' },
          ]}
          onChange={(layout) =>
            onChange({ ...settings, layout, ...(layout === 'grid' ? { columns: 12 } : {}) })
          }
        />
      </div>
    );
  const spacingOptions = ['none', 'small', 'medium', 'large'].map((value) => ({
    label: value[0].toUpperCase() + value.slice(1),
    value,
  })) as Array<{ label: string; value: SectionSettings['padding'] }>;
  return (
    <div className="block-inspector inspector-grid">
      <label className="inspector-field">
        <span>Section name</span>
        <input
          value={settings.name}
          onChange={(event) =>
            onChange({ ...settings, name: event.target.value || 'Untitled section' })
          }
        />
      </label>
      <Select
        label="Section layout"
        value={settings.layout}
        options={[
          { label: 'Flow', value: 'flow' },
          { label: 'Grid', value: 'grid' },
        ]}
        onChange={(layout) =>
          onChange({ ...settings, layout, ...(layout === 'grid' ? { columns: 12 } : {}) })
        }
      />
      {settings.layout === 'grid' ? (
        <p className="inspector-help">Standard responsive grid: 12 columns</p>
      ) : null}
      <Select
        label="Content width"
        value={settings.width}
        options={[
          { label: 'Full width', value: 'full' },
          { label: 'Site width', value: 'shell' },
          { label: 'Narrow', value: 'narrow' },
        ]}
        onChange={(width) => onChange({ ...settings, width })}
      />
      <Select
        label="Background"
        value={settings.surface}
        options={[
          { label: 'Transparent', value: 'transparent' },
          { label: 'Canvas', value: 'canvas' },
          { label: 'Surface', value: 'surface' },
          { label: 'Primary', value: 'primary' },
        ]}
        onChange={(surface) => onChange({ ...settings, surface })}
      />
      <Select
        label="Spacing"
        value={settings.padding}
        options={spacingOptions}
        onChange={(padding) => onChange({ ...settings, padding })}
      />
      <Select
        label="Element gap"
        value={settings.gap}
        options={spacingOptions}
        onChange={(gap) => onChange({ ...settings, gap })}
      />
      {settings.layout === 'grid' ? (
        <label className="inspector-field">
          <span>Minimum section height (grid rows)</span>
          <input
            type="number"
            min="1"
            max="100"
            value={settings.minRows}
            onChange={(event) =>
              onChange({
                ...settings,
                minRows: Math.max(1, Math.min(100, Number(event.target.value) || 1)),
              })
            }
          />
        </label>
      ) : null}
      <label className="inspector-field">
        <span>Background image</span>
        <select
          value={settings.backgroundMediaId ?? ''}
          onChange={(event) =>
            onChange({ ...settings, backgroundMediaId: event.target.value || undefined })
          }
        >
          <option value="">No image</option>
          {(document?.media ?? []).map((item) => (
            <option value={item.id} key={item.id}>
              {item.alt || item.sourcePath.split('/').at(-1)}
            </option>
          ))}
        </select>
      </label>
      {settings.backgroundMediaId ? (
        <>
          <Select
            label="Background position"
            value={settings.backgroundPosition}
            options={[
              { label: 'Top', value: 'top' },
              { label: 'Center', value: 'center' },
              { label: 'Bottom', value: 'bottom' },
            ]}
            onChange={(backgroundPosition) => onChange({ ...settings, backgroundPosition })}
          />
          <Select
            label="Image overlay"
            value={settings.overlay}
            options={[
              { label: 'None', value: 'none' },
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
            ]}
            onChange={(overlay) => onChange({ ...settings, overlay })}
          />
        </>
      ) : null}
    </div>
  );
}
