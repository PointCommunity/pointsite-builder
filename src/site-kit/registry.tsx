import { Fragment, useState, type ElementType, type FormEvent, type ReactNode } from 'react';
import type { SiteBlock, SiteDocument } from './types';

export const blockDefinitions: Record<
  SiteBlock['type'],
  { label: string; supportsMoveButtons: true }
> = {
  hero: { label: 'Hero', supportsMoveButtons: true },
  heading: { label: 'Heading', supportsMoveButtons: true },
  richText: { label: 'Rich text', supportsMoveButtons: true },
  image: { label: 'Image', supportsMoveButtons: true },
  splitFeature: { label: 'Split feature', supportsMoveButtons: true },
  cta: { label: 'Call to action', supportsMoveButtons: true },
  cards: { label: 'Cards', supportsMoveButtons: true },
  people: { label: 'People', supportsMoveButtons: true },
  faq: { label: 'Frequently asked questions', supportsMoveButtons: true },
  form: { label: 'Form', supportsMoveButtons: true },
  map: { label: 'Map', supportsMoveButtons: true },
  divider: { label: 'Divider', supportsMoveButtons: true },
  spacer: { label: 'Spacer', supportsMoveButtons: true },
};

function linkAttributes(href: string) {
  return href.startsWith('/') || href.startsWith('mailto:')
    ? {}
    : { target: '_blank', rel: 'noreferrer' };
}

function ActionLink({
  action,
  className = '',
}: {
  action: { label: string; href: string; style: string };
  className?: string;
}) {
  return (
    <a
      className={`button point-button point-button--${action.style} ${className}`.trim()}
      href={action.href}
      {...linkAttributes(action.href)}
    >
      {action.label}
    </a>
  );
}

function mediaRecord(document: SiteDocument, id: string) {
  const media = document.media.find((candidate) => candidate.id === id);
  if (!media) throw new Error(`Missing media ${id}`);
  return media;
}

function TextLines({ text }: { text: string }) {
  return text.split(/\n{2,}/).map((line, index) => (
    <p key={`${line.slice(0, 24)}-${index}`}>
      {line.split('\n').map((part, partIndex) => (
        <Fragment key={`${part}-${partIndex}`}>
          {partIndex ? <br /> : null}
          {part}
        </Fragment>
      ))}
    </p>
  ));
}

function FormFields({ form }: { form: SiteDocument['forms'][number] }) {
  return form.fields.map((field) => {
    const label = (
      <>
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </>
    );
    if (field.type === 'textarea') {
      return (
        <div className="field field--textarea" key={field.id}>
          <label htmlFor={field.id}>{label}</label>
          <textarea id={field.id} name={field.name} required={field.required} rows={5} />
        </div>
      );
    }
    if (field.type === 'select') {
      return (
        <div className="field" key={field.id}>
          <label htmlFor={field.id}>{label}</label>
          <select id={field.id} name={field.name} required={field.required} defaultValue="">
            <option value="" disabled>
              Select one
            </option>
            {field.options?.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </div>
      );
    }
    if (field.type === 'radio' || field.type === 'checkbox') {
      return (
        <div className={`field field--${field.type}`} key={field.id}>
          <label>{label}</label>
          <div className="choice-list">
            {field.options?.map((option) => (
              <label className="choice" key={option}>
                <input
                  type={field.type}
                  name={field.name}
                  value={option}
                  required={field.required && field.type === 'radio'}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        </div>
      );
    }
    return (
      <div className="field" key={field.id}>
        <label htmlFor={field.id}>{label}</label>
        <input
          id={field.id}
          type={field.type}
          name={field.name}
          required={field.required}
          placeholder={field.placeholder}
        />
      </div>
    );
  });
}

function FormPanel({
  form,
  heading,
  supportingText,
}: {
  form: SiteDocument['forms'][number];
  heading?: string;
  supportingText?: string;
}) {
  const action = `mailto:${form.recipientEmail}?subject=${encodeURIComponent(form.subject)}`;
  const [status, setStatus] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const lines = form.fields.flatMap((field) => {
      const values = data
        .getAll(field.name)
        .map((value) => (typeof value === 'string' ? value : value.name))
        .filter(Boolean)
        .join(', ');
      return values ? [`${field.label}: ${values}`] : [];
    });
    setStatus('Your email app is opening with this request ready to send.');
    const emailLink = globalThis.document.createElement('a');
    emailLink.href = `${action}&body=${encodeURIComponent(lines.join('\n'))}`;
    emailLink.hidden = true;
    globalThis.document.body.appendChild(emailLink);
    emailLink.click();
    emailLink.remove();
  };
  return (
    <section className="form-panel">
      <div className="form-heading">
        <p className="eyebrow">Get connected</p>
        <h2>{heading ?? form.name}</h2>
        {supportingText ? <p>{supportingText}</p> : null}
      </div>
      <form
        className="managed-form"
        action={action}
        method="post"
        encType="text/plain"
        onSubmit={submit}
      >
        <FormFields form={form} />
        <button className="button button--dark" type="submit">
          {form.submitLabel}
        </button>
        <p className="form-note">
          Submitting opens your email app so you can review the message before sending it directly
          to Point ATX.
        </p>
        <p className="form-status" role="status" aria-live="polite">
          {status}
        </p>
      </form>
    </section>
  );
}

function renderRichContent(block: Extract<SiteBlock, { type: 'richText' }>) {
  return block.content.map((node, index) => {
    const key = `${node.type}-${index}`;
    if (node.type === 'paragraph')
      return (
        <p key={key}>
          {node.children.map((child, childIndex) => (
            <Fragment key={`${child.text}-${childIndex}`}>
              {child.bold ? (
                <strong>{child.italic ? <em>{child.text}</em> : child.text}</strong>
              ) : child.italic ? (
                <em>{child.text}</em>
              ) : (
                child.text
              )}
            </Fragment>
          ))}
        </p>
      );
    if (node.type === 'bulletedList')
      return (
        <ul key={key}>
          {node.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    if (node.type === 'numberedList')
      return (
        <ol key={key}>
          {node.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      );
    if (node.type === 'quote')
      return (
        <blockquote key={key}>
          {node.text}
          {node.attribution ? <footer>— {node.attribution}</footer> : null}
        </blockquote>
      );
    return (
      <p key={key}>
        <a href={node.href} {...linkAttributes(node.href)}>
          {node.text}
        </a>
      </p>
    );
  });
}

export function renderBlock(block: SiteBlock, document: SiteDocument): ReactNode {
  switch (block.type) {
    case 'hero': {
      const media = block.mediaId ? mediaRecord(document, block.mediaId) : undefined;
      if (block.variant === 'homeHero')
        return (
          <section className="home-hero">
            {media ? <img src={media.sourcePath} alt={media.alt} /> : null}
            <div className="hero-shade" />
            <div className="home-hero-copy shell">
              <h1>{block.heading}</h1>
            </div>
          </section>
        );
      return (
        <section
          className={`point-hero point-surface--${block.surface} point-align--${block.align}`}
        >
          {media ? (
            <img src={media.sourcePath} alt={media.alt} className="point-hero__image" />
          ) : null}
          <div className="point-overlay" aria-hidden="true" />
          <div className="shell point-hero__content">
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            <h1>{block.heading}</h1>
            {block.body ? <p>{block.body}</p> : null}
            <div className="point-actions">
              {block.actions.map((action) => (
                <ActionLink action={action} key={`${action.href}-${action.label}`} />
              ))}
            </div>
          </div>
        </section>
      );
    }
    case 'heading': {
      const Heading: ElementType = `h${block.level}`;
      if (block.variant === 'homeIntro')
        return (
          <section className="home-intro shell">
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            <Heading>
              {block.text.split('\n').map((line, index) => (
                <Fragment key={line}>
                  {index ? ' ' : null}
                  <span>{line}</span>
                </Fragment>
              ))}
            </Heading>
            {block.supportingText ? <p>{block.supportingText}</p> : null}
            <div className="button-row">
              {block.actions?.map((action) => (
                <ActionLink action={action} key={`${action.href}-${action.label}`} />
              ))}
            </div>
          </section>
        );
      return (
        <section
          className={`content-section point-heading point-heading--${block.width} point-align--${block.align}`}
        >
          {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
          <Heading>{block.text}</Heading>
          {block.supportingText ? <p>{block.supportingText}</p> : null}
        </section>
      );
    }
    case 'richText':
      return (
        <section
          className={`content-section ${block.variant === 'prose' ? 'prose' : 'point-prose'}`}
        >
          {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
          {block.heading ? <h2>{block.heading}</h2> : null}
          {renderRichContent(block)}
        </section>
      );
    case 'image': {
      const media = mediaRecord(document, block.mediaId);
      return block.variant === 'wide' ? (
        <section className="content-section wide-photo">
          <img src={media.sourcePath} alt={block.alt} width="1000" height="668" loading="lazy" />
          {block.caption ? <p>{block.caption}</p> : null}
        </section>
      ) : (
        <figure className={`point-image point-aspect--${block.aspect.replace(':', '-')}`}>
          <img
            src={media.sourcePath}
            alt={block.alt}
            loading="lazy"
            className={`point-fit--${block.fit}`}
          />
          {block.caption ? <figcaption>{block.caption}</figcaption> : null}
        </figure>
      );
    }
    case 'splitFeature': {
      const media = mediaRecord(document, block.mediaId);
      if (block.variant === 'photoBanner')
        return (
          <section className="home-feature home-feature--photo">
            <img src={media.sourcePath} alt={block.mediaAlt ?? media.alt} loading="lazy" />
            <div className="feature-shade" />
            <div className="feature-copy shell">
              {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
              <h2>{block.heading}</h2>
              <p>{block.body}</p>
              {block.action ? <ActionLink action={block.action} className="button--light" /> : null}
            </div>
          </section>
        );
      if (block.variant === 'splitFeature')
        return (
          <section className="home-feature home-feature--split shell">
            <div className="feature-image">
              <img src={media.sourcePath} alt={block.mediaAlt ?? media.alt} loading="lazy" />
            </div>
            <div className="feature-copy">
              {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
              <h2>{block.heading}</h2>
              <TextLines text={block.body} />
              {block.action ? <ActionLink action={block.action} /> : null}
            </div>
          </section>
        );
      if (block.variant === 'imageSplit')
        return (
          <section className="content-section split-section image-split">
            <div>
              <img
                src={media.sourcePath}
                alt={block.mediaAlt ?? media.alt}
                width="500"
                height="624"
                loading="lazy"
              />
            </div>
            <div>
              {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
              <h2>
                {block.heading.split('\n').map((line, index) => (
                  <Fragment key={line}>
                    {index ? <br /> : null}
                    {line}
                  </Fragment>
                ))}
              </h2>
              <TextLines text={block.body} />
              {block.note ? (
                <p>
                  <small>{block.note}</small>
                </p>
              ) : null}
              {block.calloutLabel || block.calloutValue ? (
                <div className="service-callout">
                  {block.calloutLabel ? <strong>{block.calloutLabel}</strong> : null}
                  {block.calloutValue ? <span>{block.calloutValue}</span> : null}
                </div>
              ) : null}
            </div>
          </section>
        );
      return (
        <section
          className={`point-feature point-feature--${block.mediaSide} point-feature--${block.proportion} point-surface--${block.surface}`}
        >
          <div className="point-feature__media">
            <img src={media.sourcePath} alt={block.mediaAlt ?? media.alt} loading="lazy" />
          </div>
          <div className="point-feature__content">
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            <h2>{block.heading}</h2>
            <TextLines text={block.body} />
            {block.action ? <ActionLink action={block.action} /> : null}
          </div>
        </section>
      );
    }
    case 'cta':
      return (
        <section
          className={
            block.variant === 'rental'
              ? 'content-section rental-link'
              : `point-cta point-surface--${block.surface}`
          }
        >
          <div>
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            <h2>{block.heading}</h2>
            {block.body ? <p>{block.body}</p> : null}
          </div>
          <ActionLink action={block.action} />
        </section>
      );
    case 'cards': {
      if (block.variant === 'splitEditorial' || block.variant === 'splitEditorialTone')
        return (
          <section
            className={`content-section split-section${block.variant === 'splitEditorialTone' ? ' tone-section' : ''}`}
          >
            {block.items.map((item) => (
              <div key={item.title}>
                {item.eyebrow ? <p className="eyebrow">{item.eyebrow}</p> : null}
                <h2>{item.title}</h2>
                <TextLines text={item.body} />
              </div>
            ))}
          </section>
        );
      if (block.variant === 'identity')
        return (
          <section className="content-section tone-section">
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            <h2>{block.heading}</h2>
            <div className="three-column">
              {block.items.map((item) => (
                <p key={item.title}>
                  <strong>{item.title}</strong>
                  <br />
                  {item.body}
                  {item.supportingText ? (
                    <>
                      {' '}
                      <em>{item.supportingText}</em>
                    </>
                  ) : null}
                </p>
              ))}
            </div>
          </section>
        );
      if (block.variant === 'beliefs')
        return (
          <section className="content-section">
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            <div className="belief-list">
              {block.items.map((item, index) => (
                <article key={item.title}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <h2>{item.title}</h2>
                    <p>{item.body}</p>
                    {item.supportingText ? <small>{item.supportingText}</small> : null}
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      if (block.variant === 'groups')
        return (
          <section className="content-section group-grid">
            {block.items.map((item) => {
              const [schedule = '', location = '', leaders = ''] = item.body.split('\n');
              return (
                <article key={item.title}>
                  <h2>{item.title}</h2>
                  <p className="group-time">{schedule}</p>
                  <p>{location}</p>
                  <p>
                    <strong>Leaders:</strong> {leaders.replace(/^Leaders:\s*/, '')}
                  </p>
                </article>
              );
            })}
          </section>
        );
      if (block.variant === 'giving')
        return (
          <section className="content-section giving-options">
            {block.items.map((item, index) => (
              <article key={item.title}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <h2>{item.title}</h2>
                <p>{item.body}</p>
                {item.href ? (
                  <a
                    className="button button--dark"
                    href={item.href}
                    {...linkAttributes(item.href)}
                  >
                    Open secure giving
                  </a>
                ) : null}
              </article>
            ))}
          </section>
        );
      return (
        <section className="content-section point-card-section">
          {block.heading ? <h2>{block.heading}</h2> : null}
          <div className={`point-cards point-cards--${block.columns}`}>
            {block.items.map((item) => (
              <article className="point-card" key={item.title}>
                {item.mediaId ? (
                  <img
                    src={mediaRecord(document, item.mediaId).sourcePath}
                    alt={item.mediaAlt ?? ''}
                    loading="lazy"
                  />
                ) : null}
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                {item.href ? (
                  <a href={item.href} {...linkAttributes(item.href)}>
                    Learn more<span className="sr-only"> about {item.title}</span>
                  </a>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      );
    }
    case 'people':
      return (
        <section
          className={`content-section ${block.variant === 'leadership' ? '' : 'point-people'}`}
        >
          {block.heading ? <h2>{block.heading}</h2> : null}
          <div
            className={
              block.variant === 'leadership'
                ? 'people-grid'
                : `point-people__grid point-people__grid--${block.layout}`
            }
          >
            {block.personIds.map((id) => {
              const person = document.collections.people.find((candidate) => candidate.id === id);
              if (!person) throw new Error(`Missing person ${id}`);
              return (
                <article className={block.variant === 'leadership' ? 'person-card' : ''} key={id}>
                  {person.mediaId ? (
                    <img
                      src={mediaRecord(document, person.mediaId).sourcePath}
                      alt={person.mediaAlt ?? person.name}
                      width={block.variant === 'leadership' ? 500 : undefined}
                      height={block.variant === 'leadership' ? 625 : undefined}
                      loading="lazy"
                    />
                  ) : (
                    <div className="person-placeholder" aria-hidden="true">
                      P
                    </div>
                  )}
                  <h2>{person.name}</h2>
                  <p>{person.role}</p>
                  {block.variant === 'leadership' ? null : <p>{person.bio}</p>}
                </article>
              );
            })}
          </div>
        </section>
      );
    case 'faq':
      return (
        <section
          className={`content-section ${block.variant === 'groups' ? 'faq-section' : 'point-faq'}`}
        >
          {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
          {block.heading ? <h2>{block.heading}</h2> : null}
          {block.items.map((item) => (
            <details key={item.question} open={item.initiallyOpen}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </section>
      );
    case 'form': {
      const form = document.forms.find((candidate) => candidate.id === block.formId);
      if (!form) throw new Error(`Missing form ${block.formId}`);
      if (block.variant === 'contact')
        return (
          <section className="content-section contact-grid">
            <div>
              {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
              <h2>
                {block.heading?.split('\n').map((line, index) => (
                  <Fragment key={line}>
                    {index ? <br /> : null}
                    {line}
                  </Fragment>
                ))}
              </h2>
              {block.body
                ? block.body
                    .split('\n')
                    .map((line, index) => (
                      <p key={`${line}-${index}`}>
                        {index === 0 && line.includes('@') ? (
                          <a href={`mailto:${line}`}>{line}</a>
                        ) : (
                          line
                        )}
                      </p>
                    ))
                : null}
              {block.linkHref && block.linkLabel ? (
                <a className="text-link" href={block.linkHref} {...linkAttributes(block.linkHref)}>
                  {block.linkLabel}
                </a>
              ) : null}
            </div>
            <FormPanel form={form} heading={form.name} supportingText={block.supportingText} />
          </section>
        );
      const panel = (
        <FormPanel form={form} heading={block.heading} supportingText={block.supportingText} />
      );
      return block.variant === 'standalone' ? (
        <section className="content-section standalone-form">{panel}</section>
      ) : (
        panel
      );
    }
    case 'map':
      return block.variant === 'gathering' ? (
        <section className="gathering-section">
          <div className="shell">
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            {block.heading ? <h2>{block.heading}</h2> : null}
            {block.body ? <TextLines text={block.body} /> : null}
            <iframe
              title={block.title}
              src={`https://www.google.com/maps?q=${encodeURIComponent(block.query)}&output=embed`}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </section>
      ) : (
        <section className="point-map">
          <iframe
            title={block.title}
            src={`https://www.google.com/maps?q=${encodeURIComponent(block.query)}&output=embed`}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </section>
      );
    case 'divider':
      return block.style === 'line' ? (
        <div>
          <hr />
        </div>
      ) : (
        <div className="point-divider-space" aria-hidden="true" />
      );
    case 'spacer':
      return <div className={`point-spacer point-spacer--${block.size}`} aria-hidden="true" />;
    default:
      throw new Error(`Unsupported block type: ${(block as { type: string }).type}`);
  }
}
