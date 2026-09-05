import { useEffect, useState } from 'react';
import { api } from '../api';
import { useEditor } from '../editor/EditorProvider';

interface Result {
  commitSha: string;
  candidateChecksum: string;
  url: string;
}

export function StagingPublish() {
  const { draft, saveState } = useEditor();
  const [baseSha, setBaseSha] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState('Loading exact staging base…');
  useEffect(() => {
    void api
      .stagingBase()
      .then(({ sha }) => {
        setBaseSha(sha);
        setStatus('Ready to publish this exact revision to staging.');
      })
      .catch(() => setStatus('Staging publishing is not configured yet.'));
  }, []);
  return (
    <section className="publish-panel" aria-labelledby="publish-title">
      <p className="eyebrow">Staging only</p>
      <h2 id="publish-title">Publish preview</h2>
      <dl>
        <div>
          <dt>Revision</dt>
          <dd>{draft.revision.id}</dd>
        </div>
        <div>
          <dt>Content checksum</dt>
          <dd>{draft.revision.checksum}</dd>
        </div>
        <div>
          <dt>Staging base</dt>
          <dd>{baseSha || 'Unavailable'}</dd>
        </div>
      </dl>
      <p role="status" aria-live="polite">
        {status}
      </p>
      <button
        className="button button--primary"
        disabled={!baseSha || saveState !== 'saved'}
        onClick={() => {
          setStatus('Publishing exact candidate…');
          void api
            .publishStaging(draft.id, baseSha)
            .then((published) => {
              setResult(published);
              setStatus('Published to staging. CI verification is now running.');
            })
            .catch(() =>
              setStatus('Publish stopped safely. Refresh the staging base and try again.'),
            );
        }}
      >
        Publish to staging
      </button>
      {result ? (
        <p>
          <a href={result.url} target="_blank" rel="noreferrer">
            View staging commit {result.commitSha.slice(0, 8)}
          </a>
          <br />
          Candidate {result.candidateChecksum}
        </p>
      ) : null}
      <aside className="production-lock">
        <strong>Production is locked</strong>
        <p>This screen cannot publish or open a production pull request.</p>
      </aside>
    </section>
  );
}
