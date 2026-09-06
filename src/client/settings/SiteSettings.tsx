import type { SiteDocument } from '../../site-kit/types';
import { useEditor } from '../editor/EditorProvider';
import { ThemeEditor } from './ThemeEditor';
import { NavigationEditor } from './NavigationEditor';
import { CollectionsEditor } from './CollectionsEditor';

export function SiteSettings() {
  const { document, updateDocument } = useEditor();
  const updateSite = (change: (site: SiteDocument['site']) => void) =>
    updateDocument((next) => {
      change(next.site);
      return next;
    });
  return (
    <div className="settings-panel">
      <header className="section-heading">
        <div>
          <p className="eyebrow">Whole website</p>
          <h2>Site settings</h2>
        </div>
        <p>Changes remain in this draft until staging publish.</p>
      </header>
      <section className="settings-section" aria-labelledby="identity-title">
        <h3 id="identity-title">Identity and contact</h3>
        <div className="field-grid">
          <label>
            <span>Church name</span>
            <input
              required
              maxLength={120}
              value={document.site.name}
              onChange={(event) =>
                updateSite((site) => {
                  site.name = event.target.value;
                })
              }
            />
          </label>
          <label>
            <span>Short name</span>
            <input
              required
              maxLength={40}
              value={document.site.shortName}
              onChange={(event) =>
                updateSite((site) => {
                  site.shortName = event.target.value;
                })
              }
            />
          </label>
          <label className="field-wide">
            <span>Mission</span>
            <textarea
              required
              maxLength={300}
              value={document.site.mission}
              onChange={(event) =>
                updateSite((site) => {
                  site.mission = event.target.value;
                })
              }
            />
          </label>
          <label>
            <span>Contact email</span>
            <input
              required
              type="email"
              value={document.site.email}
              onChange={(event) =>
                updateSite((site) => {
                  site.email = event.target.value;
                })
              }
            />
          </label>
          <label>
            <span>Phone</span>
            <input
              type="tel"
              value={document.site.phone ?? ''}
              onChange={(event) =>
                updateSite((site) => {
                  site.phone = event.target.value || undefined;
                })
              }
            />
          </label>
          <label>
            <span>Street address</span>
            <input
              required
              value={document.site.address.street}
              onChange={(event) =>
                updateSite((site) => {
                  site.address.street = event.target.value;
                })
              }
            />
          </label>
          <label>
            <span>City</span>
            <input
              required
              value={document.site.address.city}
              onChange={(event) =>
                updateSite((site) => {
                  site.address.city = event.target.value;
                })
              }
            />
          </label>
          <label>
            <span>State or region</span>
            <input
              required
              value={document.site.address.region}
              onChange={(event) =>
                updateSite((site) => {
                  site.address.region = event.target.value;
                })
              }
            />
          </label>
          <label>
            <span>Postal code</span>
            <input
              required
              value={document.site.address.postalCode}
              onChange={(event) =>
                updateSite((site) => {
                  site.address.postalCode = event.target.value;
                })
              }
            />
          </label>
        </div>
      </section>
      <section
        className="settings-section"
        id="footer-settings"
        tabIndex={-1}
        aria-labelledby="services-title"
      >
        <h3 id="services-title">Footer content and giving</h3>
        <div className="field-grid">
          <label>
            <span>Service label</span>
            <input
              required
              value={document.site.service.label}
              onChange={(event) =>
                updateSite((site) => {
                  site.service.label = event.target.value;
                })
              }
            />
          </label>
          <label>
            <span>Service schedule</span>
            <input
              required
              value={document.site.service.schedule}
              onChange={(event) =>
                updateSite((site) => {
                  site.service.schedule = event.target.value;
                })
              }
            />
          </label>
          <label className="field-wide">
            <span>Giving link</span>
            <input
              required
              type="url"
              value={document.site.givingUrl}
              onChange={(event) =>
                updateSite((site) => {
                  site.givingUrl = event.target.value;
                })
              }
            />
          </label>
        </div>
      </section>
      <section className="settings-section" aria-labelledby="social-title">
        <h3 id="social-title">Social links</h3>
        <div className="settings-list">
          {document.site.socialLinks.map((link, index) => (
            <div className="settings-list__item" key={index}>
              <label>
                <span>Network</span>
                <select
                  value={link.platform}
                  onChange={(event) =>
                    updateSite((site) => {
                      site.socialLinks[index].platform = event.target.value as typeof link.platform;
                    })
                  }
                >
                  <option value="facebook">Facebook</option>
                  <option value="instagram">Instagram</option>
                  <option value="youtube">YouTube</option>
                  <option value="x">X</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>
                <span>Accessible label</span>
                <input
                  required
                  value={link.label}
                  onChange={(event) =>
                    updateSite((site) => {
                      site.socialLinks[index].label = event.target.value;
                    })
                  }
                />
              </label>
              <label>
                <span>Link</span>
                <input
                  required
                  type="url"
                  value={link.url}
                  onChange={(event) =>
                    updateSite((site) => {
                      site.socialLinks[index].url = event.target.value;
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="button button--danger"
                onClick={() =>
                  updateSite((site) => {
                    site.socialLinks.splice(index, 1);
                  })
                }
              >
                Remove link
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="button"
          disabled={document.site.socialLinks.length >= 12}
          onClick={() =>
            updateSite((site) => {
              site.socialLinks.push({
                platform: 'other',
                label: 'New social link',
                url: 'https://example.com',
              });
            })
          }
        >
          Add social link
        </button>
      </section>
      <NavigationEditor
        navigation={document.navigation}
        onChange={(navigation) => updateDocument((next) => ({ ...next, navigation }))}
      />
      <CollectionsEditor
        document={document}
        onChange={(collections) => updateDocument((next) => ({ ...next, collections }))}
      />
      <ThemeEditor
        theme={document.theme}
        onChange={(theme) => updateDocument((next) => ({ ...next, theme }))}
      />
    </div>
  );
}
