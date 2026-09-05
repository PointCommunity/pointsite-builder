import { useEditor } from '../editor/EditorProvider';

export function SiteSettings() {
  const { document, updateDocument } = useEditor();
  const updateSite = (key: 'name' | 'shortName' | 'mission' | 'email', value: string) =>
    updateDocument((next) => ({ ...next, site: { ...next.site, [key]: value } }));
  return (
    <section className="settings-panel" aria-labelledby="settings-title">
      <h2 id="settings-title">Site settings</h2>
      <div className="field-grid">
        <label>
          <span>Church name</span>
          <input
            value={document.site.name}
            maxLength={120}
            onChange={(e) => updateSite('name', e.target.value)}
          />
        </label>
        <label>
          <span>Short name</span>
          <input
            value={document.site.shortName}
            maxLength={40}
            onChange={(e) => updateSite('shortName', e.target.value)}
          />
        </label>
        <label className="field-wide">
          <span>Mission</span>
          <textarea
            value={document.site.mission}
            maxLength={300}
            onChange={(e) => updateSite('mission', e.target.value)}
          />
        </label>
        <label>
          <span>Contact email</span>
          <input
            type="email"
            value={document.site.email}
            onChange={(e) => updateSite('email', e.target.value)}
          />
        </label>
        <label>
          <span>Primary color</span>
          <input
            type="color"
            value={document.theme.colors.primary}
            onChange={(e) =>
              updateDocument((next) => ({
                ...next,
                theme: { ...next.theme, colors: { ...next.theme.colors, primary: e.target.value } },
              }))
            }
          />
        </label>
        <label>
          <span>Spacing</span>
          <select
            value={document.theme.spacingDensity}
            onChange={(e) =>
              updateDocument((next) => ({
                ...next,
                theme: {
                  ...next.theme,
                  spacingDensity: e.target.value as typeof next.theme.spacingDensity,
                },
              }))
            }
          >
            <option>compact</option>
            <option>comfortable</option>
            <option>spacious</option>
          </select>
        </label>
        <label>
          <span>Corner style</span>
          <select
            value={document.theme.radius}
            onChange={(e) =>
              updateDocument((next) => ({
                ...next,
                theme: { ...next.theme, radius: e.target.value as typeof next.theme.radius },
              }))
            }
          >
            <option>square</option>
            <option>soft</option>
            <option>rounded</option>
          </select>
        </label>
      </div>
    </section>
  );
}
