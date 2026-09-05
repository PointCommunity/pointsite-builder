import { Fragment, type ElementType, type ReactNode } from 'react';
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

function ActionLink({ action }: { action: { label: string; href: string; style: string } }) {
  return (
    <a
      className={`point-button point-button--${action.style}`}
      href={action.href}
      {...linkAttributes(action.href)}
    >
      {action.label}
    </a>
  );
}

function mediaSource(document: SiteDocument, id: string): string {
  const media = document.media.find((candidate) => candidate.id === id);
  if (!media) throw new Error(`Missing media ${id}`);
  return media.sourcePath;
}

function FormFields({ form }: { form: SiteDocument['forms'][number] }) {
  return form.fields.map((field) => {
    if (field.type === 'textarea') {
      return (
        <label className="point-field" key={field.id}>
          <span>{field.label}</span>
          <textarea name={field.name} required={field.required} />
        </label>
      );
    }
    if (field.type === 'select') {
      return (
        <label className="point-field" key={field.id}>
          <span>{field.label}</span>
          <select name={field.name} required={field.required} defaultValue="">
            <option value="" disabled>
              Select one
            </option>
            {field.options?.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </label>
      );
    }
    if (field.type === 'radio' || field.type === 'checkbox') {
      return (
        <fieldset className="point-field" key={field.id}>
          <legend>{field.label}</legend>
          {field.options?.map((option) => (
            <label className="point-choice" key={option}>
              <input type={field.type} name={field.name} value={option} required={field.required} />
              <span>{option}</span>
            </label>
          ))}
        </fieldset>
      );
    }
    return (
      <label className="point-field" key={field.id}>
        <span>{field.label}</span>
        <input
          type={field.type}
          name={field.name}
          required={field.required}
          placeholder={field.placeholder}
        />
      </label>
    );
  });
}

export function renderBlock(block: SiteBlock, document: SiteDocument): ReactNode {
  switch (block.type) {
    case 'hero':
      return (
        <section
          className={`point-hero point-surface--${block.surface} point-align--${block.align}`}
        >
          {block.mediaId ? (
            <img src={mediaSource(document, block.mediaId)} alt="" className="point-hero__image" />
          ) : null}
          <div className="point-overlay" aria-hidden="true" />
          <div className="point-shell point-hero__content">
            {block.eyebrow ? <p className="point-eyebrow">{block.eyebrow}</p> : null}
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
    case 'heading': {
      const Heading: ElementType = `h${block.level}`;
      return (
        <section
          className={`point-shell point-heading point-heading--${block.width} point-align--${block.align}`}
        >
          <Heading>{block.text}</Heading>
          {block.supportingText ? <p>{block.supportingText}</p> : null}
        </section>
      );
    }
    case 'richText':
      return (
        <section className="point-shell point-prose">
          {block.content.map((node, index) => {
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
          })}
        </section>
      );
    case 'image':
      return (
        <figure
          className={`point-shell point-image point-aspect--${block.aspect.replace(':', '-')}`}
        >
          <img
            src={mediaSource(document, block.mediaId)}
            alt={block.alt}
            loading="lazy"
            className={`point-fit--${block.fit}`}
          />
          {block.caption ? <figcaption>{block.caption}</figcaption> : null}
        </figure>
      );
    case 'splitFeature':
      return (
        <section
          className={`point-feature point-feature--${block.mediaSide} point-feature--${block.proportion} point-surface--${block.surface}`}
        >
          <div className="point-feature__media">
            <img
              src={mediaSource(document, block.mediaId)}
              alt={block.mediaAlt ?? ''}
              loading="lazy"
            />
          </div>
          <div className="point-feature__content">
            {block.eyebrow ? <p className="point-eyebrow">{block.eyebrow}</p> : null}
            <h2>{block.heading}</h2>
            <p>{block.body}</p>
            {block.action ? <ActionLink action={block.action} /> : null}
          </div>
        </section>
      );
    case 'cta':
      return (
        <section className={`point-shell point-cta point-surface--${block.surface}`}>
          <div>
            <h2>{block.heading}</h2>
            {block.body ? <p>{block.body}</p> : null}
          </div>
          <ActionLink action={block.action} />
        </section>
      );
    case 'cards':
      return (
        <section className="point-shell point-card-section">
          {block.heading ? <h2>{block.heading}</h2> : null}
          <div className={`point-cards point-cards--${block.columns}`}>
            {block.items.map((item) => (
              <article className="point-card" key={item.title}>
                {item.mediaId ? (
                  <img
                    src={mediaSource(document, item.mediaId)}
                    alt={item.mediaAlt ?? ''}
                    loading="lazy"
                  />
                ) : null}
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                {item.href ? (
                  <a href={item.href} {...linkAttributes(item.href)}>
                    Learn more<span className="point-visually-hidden"> about {item.title}</span>
                  </a>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      );
    case 'people':
      return (
        <section className="point-shell point-people">
          {block.heading ? <h2>{block.heading}</h2> : null}
          <div className={`point-people__grid point-people__grid--${block.layout}`}>
            {block.personIds.map((id) => {
              const person = document.collections.people.find((candidate) => candidate.id === id);
              if (!person) throw new Error(`Missing person ${id}`);
              return (
                <article key={id}>
                  {person.mediaId ? (
                    <img
                      src={mediaSource(document, person.mediaId)}
                      alt={person.mediaAlt ?? person.name}
                      loading="lazy"
                    />
                  ) : null}
                  <h3>{person.name}</h3>
                  <p>{person.role}</p>
                  <p>{person.bio}</p>
                </article>
              );
            })}
          </div>
        </section>
      );
    case 'faq':
      return (
        <section className="point-shell point-faq">
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
      const action = `mailto:${form.recipientEmail}?subject=${encodeURIComponent(form.subject)}`;
      return (
        <section className="point-shell point-form-section">
          {block.heading ? <h2>{block.heading}</h2> : null}
          {block.supportingText ? <p>{block.supportingText}</p> : null}
          <form action={action} method="post" encType="text/plain">
            <FormFields form={form} />
            <button className="point-button point-button--primary" type="submit">
              {form.submitLabel}
            </button>
          </form>
        </section>
      );
    }
    case 'map':
      return (
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
        <div className="point-shell">
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
