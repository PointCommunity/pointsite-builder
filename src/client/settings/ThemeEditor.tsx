import { themePresets } from '../../site-kit/presets';
import type { ThemeDocument } from '../../site-kit/types';

export function ThemeEditor({
  theme,
  onChange,
}: {
  theme: ThemeDocument;
  onChange: (theme: ThemeDocument) => void;
}) {
  const update = <K extends keyof ThemeDocument>(key: K, value: ThemeDocument[K]) =>
    onChange({ ...theme, preset: 'custom', [key]: value });
  const colorLabels: Record<keyof ThemeDocument['colors'], string> = {
    canvas: 'Page background',
    surface: 'Section background',
    text: 'Main text',
    mutedText: 'Secondary text',
    primary: 'Primary accent',
    onPrimary: 'Text on accent',
    border: 'Borders',
  };
  return (
    <section className="settings-section" aria-labelledby="theme-title">
      <div className="settings-heading">
        <div>
          <h3 id="theme-title">Design</h3>
          <p>Start with a preset, then adjust any detail.</p>
        </div>
      </div>
      <div className="preset-grid">
        {themePresets.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className="preset-card"
            aria-pressed={theme.preset === preset.id}
            onClick={() => onChange(structuredClone(preset.theme))}
          >
            <span className="preset-swatches" aria-hidden="true">
              <i style={{ background: preset.theme.colors.canvas }} />
              <i style={{ background: preset.theme.colors.primary }} />
              <i style={{ background: preset.theme.colors.surface }} />
            </span>
            <strong>{preset.name}</strong>
            <small>{preset.description}</small>
          </button>
        ))}
      </div>
      <fieldset className="settings-fieldset">
        <legend>Colors</legend>
        <div className="color-grid">
          {Object.entries(theme.colors).map(([key, value]) => (
            <label key={key}>
              <span>{colorLabels[key as keyof ThemeDocument['colors']]}</span>
              <span className="color-control">
                <input
                  type="color"
                  value={value}
                  onChange={(event) =>
                    update('colors', { ...theme.colors, [key]: event.target.value })
                  }
                />
                <output>{value}</output>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field-grid">
        <label>
          <span>Heading typeface</span>
          <select
            value={theme.headingFont}
            onChange={(event) =>
              update('headingFont', event.target.value as ThemeDocument['headingFont'])
            }
          >
            <option value="serif">Classic serif</option>
            <option value="sans">Clean sans</option>
            <option value="display">Bold display</option>
          </select>
        </label>
        <label>
          <span>Body typeface</span>
          <select
            value={theme.bodyFont}
            onChange={(event) =>
              update('bodyFont', event.target.value as ThemeDocument['bodyFont'])
            }
          >
            <option value="sans">Sans</option>
            <option value="humanist">Humanist</option>
          </select>
        </label>
        <label>
          <span>Spacing</span>
          <select
            value={theme.spacingDensity}
            onChange={(event) =>
              update('spacingDensity', event.target.value as ThemeDocument['spacingDensity'])
            }
          >
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
            <option value="spacious">Spacious</option>
          </select>
        </label>
        <label>
          <span>Corners</span>
          <select
            value={theme.radius}
            onChange={(event) => update('radius', event.target.value as ThemeDocument['radius'])}
          >
            <option value="square">Square</option>
            <option value="soft">Soft</option>
            <option value="rounded">Rounded</option>
          </select>
        </label>
        <label>
          <span>Buttons</span>
          <select
            value={theme.buttonStyle}
            onChange={(event) =>
              update('buttonStyle', event.target.value as ThemeDocument['buttonStyle'])
            }
          >
            <option value="solid">Solid</option>
            <option value="outline">Outline</option>
            <option value="pill">Pill</option>
          </select>
        </label>
        <label>
          <span>Section style</span>
          <select
            value={theme.surfaceStyle}
            onChange={(event) =>
              update('surfaceStyle', event.target.value as ThemeDocument['surfaceStyle'])
            }
          >
            <option value="warm">Warm</option>
            <option value="clean">Clean</option>
            <option value="bold">Bold</option>
          </select>
        </label>
      </div>
    </section>
  );
}
