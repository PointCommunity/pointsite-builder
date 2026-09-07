import { Fragment, useState, type ElementType, type FormEvent, type ReactNode } from 'react';
import type { CSSProperties } from 'react';
import type { SectionBlock, SiteDocument, SiteElement } from './types';
import { youtubeEmbedUrl } from './linked-media';

export const blockDefinitions: Record<
  SiteElement['type'],
  { label: string; supportsMoveButtons: true }
> = {
  hero: { label: 'Hero', supportsMoveButtons: true },
  heading: { label: 'Heading', supportsMoveButtons: true },
  richText: { label: 'Rich text', supportsMoveButtons: true },
  image: { label: 'Image', supportsMoveButtons: true },
  mediaEmbed: { label: 'Linked media', supportsMoveButtons: true },
  splitFeature: { label: 'Split feature', supportsMoveButtons: true },
  cta: { label: 'Call to action', supportsMoveButtons: true },
  cards: { label: 'Cards', supportsMoveButtons: true },
  people: { label: 'People', supportsMoveButtons: true },
  faq: { label: 'Frequently asked questions', supportsMoveButtons: true },
  form: { label: 'Form', supportsMoveButtons: true },
  map: { label: 'Map', supportsMoveButtons: true },
  divider: { label: 'Divider', supportsMoveButtons: true },
  spacer: { label: 'Spacer', supportsMoveButtons: true },
  text: { label: 'Text', supportsMoveButtons: true },
  button: { label: 'Button', supportsMoveButtons: true },
  navigation: { label: 'Navigation', supportsMoveButtons: true },
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

function NavigationBlock({
  block,
  document,
  onNavigate,
}: {
  block: Extract<SiteElement, { type: 'navigation' }>;
  document: SiteDocument;
  onNavigate?: (route: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const navigationId = `point-navigation-${block.id}`;
  return (
    <div
      className={`point-navigation point-navigation--${block.orientation} point-navigation--${block.align} point-navigation--${block.surface}`}
    >
      {block.orientation === 'responsive' ? (
        <button
          className="point-navigation__toggle"
          type="button"
          aria-expanded={open}
          aria-controls={navigationId}
          onClick={() => setOpen((value) => !value)}
        >
          Menu
        </button>
      ) : null}
      <nav
        id={navigationId}
        className={
          open ? 'point-navigation__menu point-navigation__menu--open' : 'point-navigation__menu'
        }
        aria-label={block.label}
        onClick={() => setOpen(false)}
      >
        {document.navigation.map((item) => (
          <div className="point-navigation__item" key={item.id}>
            <a
              href={item.href}
              {...linkAttributes(item.href)}
              onClick={(event) => {
                if (!onNavigate || !item.href.startsWith('/')) return;
                event.preventDefault();
                onNavigate(item.href);
              }}
            >
              {item.label}
              {item.children.length ? <span aria-hidden="true">⌄</span> : null}
            </a>
            {item.children.length ? (
              <div className="point-navigation__dropdown">
                {item.children.map((child) => (
                  <a
                    href={child.href}
                    key={child.id}
                    {...linkAttributes(child.href)}
                    onClick={(event) => {
                      if (!onNavigate || !child.href.startsWith('/')) return;
                      event.preventDefault();
                      onNavigate(child.href);
                    }}
                  >
                    {child.label}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </nav>
    </div>
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

type CardItem = Extract<SiteElement, { type: 'cards' }>['items'][number];

function CardMedia({ item, document }: { item: CardItem; document: SiteDocument }) {
  return item.mediaId ? (
    <img
      src={mediaRecord(document, item.mediaId).sourcePath}
      alt={item.mediaAlt ?? ''}
      loading="lazy"
    />
  ) : null;
}

function CardLink({ item }: { item: CardItem }) {
  return item.href ? (
    <a href={item.href} {...linkAttributes(item.href)}>
      Learn more<span className="sr-only"> about {item.title}</span>
    </a>
  ) : null;
}

function FormFields({ form }: { form: SiteDocument['forms'][number] }) {
  return form.fields.map((field) => {
    const describedBy = field.helpText ? `${field.id}-help` : undefined;
    const label = (
      <>
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </>
    );
    if (field.type === 'textarea') {
      return (
        <div className={`field field--textarea field--${field.width}`} key={field.id}>
          <label htmlFor={field.id}>{label}</label>
          {field.helpText ? <small id={describedBy}>{field.helpText}</small> : null}
          <textarea
            id={field.id}
            name={field.name}
            required={field.required}
            placeholder={field.placeholder}
            aria-describedby={describedBy}
            rows={5}
          />
        </div>
      );
    }
    if (field.type === 'select') {
      return (
        <div className={`field field--${field.width}`} key={field.id}>
          <label htmlFor={field.id}>{label}</label>
          {field.helpText ? <small id={describedBy}>{field.helpText}</small> : null}
          <select
            id={field.id}
            name={field.name}
            required={field.required}
            aria-describedby={describedBy}
            defaultValue=""
          >
            <option value="" disabled>
              Select one
            </option>
            {field.options?.map((option, index) => (
              <option key={index}>{option}</option>
            ))}
          </select>
        </div>
      );
    }
    if (field.type === 'radio' || field.type === 'checkbox') {
      return (
        <fieldset className={`field field--${field.type} field--${field.width}`} key={field.id}>
          <legend>{label}</legend>
          {field.helpText ? <small id={describedBy}>{field.helpText}</small> : null}
          <div className="choice-list">
            {field.options?.map((option, index) => (
              <label className="choice" key={index}>
                <input
                  type={field.type}
                  name={field.name}
                  value={option}
                  required={field.required && field.type === 'radio'}
                  aria-describedby={describedBy}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    return (
      <div className={`field field--${field.width}`} key={field.id}>
        <label htmlFor={field.id}>{label}</label>
        {field.helpText ? <small id={describedBy}>{field.helpText}</small> : null}
        <input
          id={field.id}
          type={field.type}
          name={field.name}
          required={field.required}
          placeholder={field.placeholder}
          aria-describedby={describedBy}
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
    setStatus(form.successMessage ?? 'Your email app is opening with this request ready to send.');
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
        <h2>{heading ?? form.heading ?? form.name}</h2>
        {supportingText || form.introduction ? <p>{supportingText ?? form.introduction}</p> : null}
      </div>
      <form
        className={`managed-form managed-form--${form.layout} managed-form--${form.density}`}
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
          {form.privacyNote ??
            'Submitting opens your email app so you can review the message before sending it directly to Point ATX.'}
        </p>
        <p className="form-status" role="status" aria-live="polite">
          {status}
        </p>
      </form>
    </section>
  );
}

function renderRichContent(block: Extract<SiteElement, { type: 'richText' }>) {
  return block.content.map((node, index) => {
    const key = `${node.type}-${index}`;
    if (node.type === 'paragraph')
      return (
        <p key={key}>
          {node.children.map((child, childIndex) => (
            <Fragment key={childIndex}>
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
          {node.items.map((item, itemIndex) => (
            <li key={itemIndex}>{item}</li>
          ))}
        </ul>
      );
    if (node.type === 'numberedList')
      return (
        <ol key={key}>
          {node.items.map((item, itemIndex) => (
            <li key={itemIndex}>{item}</li>
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

export function renderBlock(
  block: SiteElement,
  document: SiteDocument,
  onNavigate?: (route: string) => void,
): ReactNode {
  switch (block.type) {
    case 'hero': {
      const media = block.mediaId ? mediaRecord(document, block.mediaId) : undefined;
      if (block.variant === 'homeHero')
        return (
          <section className={`home-hero home-hero--${block.align} home-hero--${block.surface}`}>
            {media && block.surface === 'image' ? (
              <img src={media.sourcePath} alt={media.alt} />
            ) : null}
            {block.surface === 'image' ? <div className="hero-shade" /> : null}
            <div className="home-hero-copy shell">
              {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
              <h1>{block.heading}</h1>
              {block.body ? <p className="home-hero-body">{block.body}</p> : null}
              {block.actions.length ? (
                <div className="point-actions">
                  {block.actions.map((action, index) => (
                    <ActionLink action={action} key={index} />
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        );
      return (
        <section
          className={`point-hero point-surface--${block.surface} point-align--${block.align}`}
        >
          {media && block.surface === 'image' ? (
            <img src={media.sourcePath} alt={media.alt} className="point-hero__image" />
          ) : null}
          {block.surface === 'image' ? <div className="point-overlay" aria-hidden="true" /> : null}
          <div className="shell point-hero__content">
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            <h1>{block.heading}</h1>
            {block.body ? <p>{block.body}</p> : null}
            <div className="point-actions">
              {block.actions.map((action, index) => (
                <ActionLink action={action} key={index} />
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
          <section
            className={`home-intro home-intro--${block.width} point-align--${block.align} shell`}
          >
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            <Heading>
              {block.text.split('\n').map((line, index) => (
                <Fragment key={index}>
                  {index ? ' ' : null}
                  <span>{line}</span>
                </Fragment>
              ))}
            </Heading>
            {block.supportingText ? <p>{block.supportingText}</p> : null}
            <div className="button-row">
              {block.actions?.map((action, index) => (
                <ActionLink action={action} key={index} />
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
          {block.actions?.length ? (
            <div className="point-actions">
              {block.actions.map((action, index) => (
                <ActionLink action={action} key={index} />
              ))}
            </div>
          ) : null}
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
        <section
          className={`content-section wide-photo point-aspect--${block.aspect.replace(':', '-')}`}
        >
          <img
            src={media.sourcePath}
            alt={block.alt}
            width="1000"
            height="668"
            loading="lazy"
            className={`point-fit--${block.fit}`}
          />
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
    case 'mediaEmbed': {
      const media = document.linkedMedia.find((candidate) => candidate.id === block.linkedMediaId);
      if (!media) throw new Error(`Missing linked media ${block.linkedMediaId}`);
      const className = `point-linked-media point-aspect--${block.aspect.replace(':', '-')} point-fit--${block.fit}`;
      const content =
        media.type === 'image' ? (
          <img src={media.url} alt={media.alternativeText ?? ''} loading="lazy" />
        ) : media.type === 'video' ? (
          <video src={media.url} controls preload="metadata" aria-label={media.displayName} />
        ) : (
          <iframe
            src={youtubeEmbedUrl(media.url) ?? undefined}
            title={media.displayName}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        );
      return (
        <figure className={className}>
          {content}
          {block.caption || media.caption ? (
            <figcaption>{block.caption ?? media.caption}</figcaption>
          ) : null}
        </figure>
      );
    }
    case 'splitFeature': {
      const media = mediaRecord(document, block.mediaId);
      if (block.variant === 'photoBanner')
        return (
          <section
            className={`home-feature home-feature--photo point-feature--${block.mediaSide} point-feature--${block.proportion} point-align-vertical--${block.align} point-surface--${block.surface}`}
          >
            <img src={media.sourcePath} alt={block.mediaAlt ?? media.alt} loading="lazy" />
            <div className="feature-shade" />
            <div className="feature-copy shell">
              {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
              <h2>{block.heading}</h2>
              <p>{block.body}</p>
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
              {block.action ? <ActionLink action={block.action} className="button--light" /> : null}
            </div>
          </section>
        );
      if (block.variant === 'splitFeature')
        return (
          <section
            className={`home-feature home-feature--split point-feature--${block.mediaSide} point-feature--${block.proportion} point-align-vertical--${block.align} point-surface--${block.surface} shell`}
          >
            <div className="feature-image">
              <img src={media.sourcePath} alt={block.mediaAlt ?? media.alt} loading="lazy" />
            </div>
            <div className="feature-copy">
              {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
              <h2>{block.heading}</h2>
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
              {block.action ? <ActionLink action={block.action} /> : null}
            </div>
          </section>
        );
      if (block.variant === 'imageSplit')
        return (
          <section
            className={`content-section split-section image-split point-feature--${block.mediaSide} point-feature--${block.proportion} point-align-vertical--${block.align} point-surface--${block.surface}`}
          >
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
              {block.action ? <ActionLink action={block.action} /> : null}
            </div>
          </section>
        );
      return (
        <section
          className={`point-feature point-feature--${block.mediaSide} point-feature--${block.proportion} point-align-vertical--${block.align} point-surface--${block.surface}`}
        >
          <div className="point-feature__media">
            <img src={media.sourcePath} alt={block.mediaAlt ?? media.alt} loading="lazy" />
          </div>
          <div className="point-feature__content">
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            <h2>{block.heading}</h2>
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
              ? `content-section rental-link point-surface--${block.surface}`
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
            className={`content-section split-section point-cards--${block.columns}${block.variant === 'splitEditorialTone' ? ' tone-section' : ''}`}
          >
            {block.items.map((item, index) => (
              <div key={index}>
                {item.eyebrow ? <p className="eyebrow">{item.eyebrow}</p> : null}
                <CardMedia item={item} document={document} />
                <h2>{item.title}</h2>
                <TextLines text={item.body} />
                {item.supportingText ? <small>{item.supportingText}</small> : null}
                <CardLink item={item} />
              </div>
            ))}
          </section>
        );
      if (block.variant === 'identity')
        return (
          <section className={`content-section tone-section point-cards--${block.columns}`}>
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            <h2>{block.heading}</h2>
            <div className={`three-column point-cards--${block.columns}`}>
              {block.items.map((item, index) => (
                <p key={index}>
                  {item.eyebrow ? <span className="eyebrow">{item.eyebrow}</span> : null}
                  <CardMedia item={item} document={document} />
                  <strong>{item.title}</strong>
                  <br />
                  {item.body}
                  {item.supportingText ? (
                    <>
                      {' '}
                      <em>{item.supportingText}</em>
                    </>
                  ) : null}
                  {item.href ? (
                    <>
                      {' '}
                      <CardLink item={item} />
                    </>
                  ) : null}
                </p>
              ))}
            </div>
          </section>
        );
      if (block.variant === 'beliefs')
        return (
          <section className={`content-section point-cards--${block.columns}`}>
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            {block.heading ? <h2>{block.heading}</h2> : null}
            <div className="belief-list">
              {block.items.map((item, index) => (
                <article key={index}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    {item.eyebrow ? <p className="eyebrow">{item.eyebrow}</p> : null}
                    <CardMedia item={item} document={document} />
                    <h2>{item.title}</h2>
                    <p>{item.body}</p>
                    {item.supportingText ? <small>{item.supportingText}</small> : null}
                    <CardLink item={item} />
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      if (block.variant === 'groups')
        return (
          <section
            className="content-section group-grid"
            style={{ '--point-card-columns': block.columns } as CSSProperties}
          >
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            {block.heading ? <h2>{block.heading}</h2> : null}
            {block.items.map((item, index) => {
              const [schedule = '', location = '', leaders = ''] = item.body.split('\n');
              return (
                <article key={index}>
                  {item.eyebrow ? <p className="eyebrow">{item.eyebrow}</p> : null}
                  <CardMedia item={item} document={document} />
                  <h2>{item.title}</h2>
                  <p className="group-time">{schedule}</p>
                  <p>{location}</p>
                  <p>
                    <strong>Leaders:</strong> {leaders.replace(/^Leaders:\s*/, '')}
                  </p>
                  {item.supportingText ? <small>{item.supportingText}</small> : null}
                  <CardLink item={item} />
                </article>
              );
            })}
          </section>
        );
      if (block.variant === 'giving')
        return (
          <section
            className="content-section giving-options"
            style={{ '--point-card-columns': block.columns } as CSSProperties}
          >
            {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
            {block.heading ? <h2>{block.heading}</h2> : null}
            {block.items.map((item, index) => (
              <article key={index}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                {item.eyebrow ? <p className="eyebrow">{item.eyebrow}</p> : null}
                <CardMedia item={item} document={document} />
                <h2>{item.title}</h2>
                <p>{item.body}</p>
                {item.supportingText ? <small>{item.supportingText}</small> : null}
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
          {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
          {block.heading ? <h2>{block.heading}</h2> : null}
          <div className={`point-cards point-cards--${block.columns}`}>
            {block.items.map((item, index) => (
              <article className="point-card" key={index}>
                {item.eyebrow ? <p className="eyebrow">{item.eyebrow}</p> : null}
                {item.mediaId ? (
                  <img
                    src={mediaRecord(document, item.mediaId).sourcePath}
                    alt={item.mediaAlt ?? ''}
                    loading="lazy"
                  />
                ) : null}
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                {item.supportingText ? <small>{item.supportingText}</small> : null}
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
                ? `people-grid people-grid--${block.layout}`
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
          {block.items.map((item, index) => (
            <details key={index} open={item.initiallyOpen}>
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
                  <Fragment key={index}>
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
      return (
        <section
          className={`point-form-wrapper point-form-wrapper--${block.variant ?? 'standard'} ${block.variant === 'standalone' ? 'content-section standalone-form' : ''}`}
        >
          {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
          {block.body ? <TextLines text={block.body} /> : null}
          {block.linkHref && block.linkLabel ? (
            <a className="text-link" href={block.linkHref} {...linkAttributes(block.linkHref)}>
              {block.linkLabel}
            </a>
          ) : null}
          {panel}
        </section>
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
          {block.eyebrow ? <p className="eyebrow">{block.eyebrow}</p> : null}
          {block.heading ? <h2>{block.heading}</h2> : null}
          {block.body ? <TextLines text={block.body} /> : null}
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
    case 'text':
      return (
        <p className={`point-text point-text--${block.style} point-align--${block.align}`}>
          {block.text}
        </p>
      );
    case 'button':
      return (
        <div
          className={`point-button-box point-button-box--${block.align} point-button-box--${block.width}`}
        >
          <ActionLink action={block} />
        </div>
      );
    case 'navigation':
      return <NavigationBlock block={block} document={document} onNavigate={onNavigate} />;
    default:
      throw new Error(`Unsupported block type: ${(block as { type: string }).type}`);
  }
}

const sectionGap = { none: '0px', small: '0.75rem', medium: '1.5rem', large: '3rem' } as const;
const sectionTotalGap = {
  none: '0px',
  small: '8.25rem',
  medium: '16.5rem',
  large: '33rem',
} as const;

export function renderSection(
  section: SectionBlock,
  document: SiteDocument,
  onNavigate?: (route: string) => void,
): ReactNode {
  if (section.layout === 'compatibility') {
    const placement = section.items[0];
    return placement ? renderBlock(placement.element, document, onNavigate) : null;
  }

  const style = {
    '--point-section-columns': section.layout === 'flow' ? 1 : 12,
    '--point-section-gap': sectionGap[section.gap],
    '--point-section-total-gap': sectionTotalGap[section.gap],
    '--point-section-min-rows': section.minRows,
  } as CSSProperties;
  const sectionColumns = section.layout === 'flow' ? 1 : section.columns;

  return (
    <section
      className={`point-layout-section point-layout-section--${section.layout} point-layout-section--position-${section.position} point-layout-section--${section.width} point-layout-section--${section.surface} point-layout-section--pad-${section.padding} point-layout-section--overlay-${section.overlay}`}
      aria-label={section.name}
    >
      {section.backgroundMediaId ? (
        <img
          className={`point-layout-section__background point-layout-section__background--${section.backgroundPosition}`}
          src={mediaRecord(document, section.backgroundMediaId).sourcePath}
          alt=""
        />
      ) : null}
      {section.overlay !== 'none' ? (
        <div className="point-layout-section__overlay" aria-hidden="true" />
      ) : null}
      <div className="point-layout-section__grid" style={style}>
        {section.items.map((placement) => {
          const desktop = placement.grid.desktop;
          const tablet = placement.grid.tablet ?? desktop;
          const mobile = placement.grid.mobile ?? desktop;
          const placementStyle =
            section.layout === 'grid'
              ? ({
                  '--point-grid-desktop-column': desktop.column,
                  '--point-grid-desktop-row': desktop.row,
                  '--point-grid-desktop-column-span': desktop.columnSpan,
                  '--point-grid-desktop-row-span': desktop.rowSpan,
                  '--point-grid-tablet-column': tablet.column,
                  '--point-grid-tablet-row': tablet.row,
                  '--point-grid-tablet-column-span': tablet.columnSpan,
                  '--point-grid-tablet-row-span': tablet.rowSpan,
                  '--point-grid-mobile-column': mobile.column,
                  '--point-grid-mobile-row': mobile.row,
                  '--point-grid-mobile-column-span': mobile.columnSpan,
                  '--point-grid-mobile-row-span': mobile.rowSpan,
                } as CSSProperties)
              : undefined;
          return (
            <div
              className={`point-layout-item point-layout-item--${section.layout} point-layout-item--${placement.align} point-layout-item--span-${Math.min(placement.span, sectionColumns)}`}
              key={placement.id}
              style={placementStyle}
            >
              {renderBlock(placement.element, document, onNavigate)}
            </div>
          );
        })}
      </div>
    </section>
  );
}
