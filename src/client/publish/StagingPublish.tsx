import { useEffect, useState } from 'react';
import {
  api,
  type CandidateTuple,
  type PublishJobResponse,
  type StagingPublishResult,
} from '../api';
import { useEditor } from '../editor/EditorProvider';

export function StagingPublish() {
  const { draft, saveState } = useEditor();
  const [baseSha, setBaseSha] = useState('');
  const [result, setResult] = useState<StagingPublishResult | null>(null);
  const [job, setJob] = useState<PublishJobResponse | null>(null);
  const [productionBaseSha, setProductionBaseSha] = useState('');
  const [approvalId, setApprovalId] = useState('');
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
              setJob(null);
              setProductionBaseSha('');
              setApprovalId('');
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
        <div className="publish-result">
          <p>
            <a href={result.url} target="_blank" rel="noreferrer">
              View staging commit {result.commitSha.slice(0, 8)}
            </a>
            <br />
            Candidate {result.candidateChecksum}
          </p>
          <button
            className="button"
            disabled={!result.jobId}
            onClick={() => {
              if (!result.jobId) return;
              setStatus('Checking exact-commit quality and deployment evidence…');
              void Promise.all([api.refreshStagingVerification(result.jobId), api.productionBase()])
                .then(([verified, production]) => {
                  setJob(verified);
                  setProductionBaseSha(production.sha);
                  setStatus(
                    verified.evidence.verificationStatus === 'passed'
                      ? 'All mandatory staging evidence passed. Review and accept this exact candidate.'
                      : verified.evidence.verificationStatus === 'failed'
                        ? 'Staging verification failed. Acceptance remains locked.'
                        : 'Staging verification is still running. Check again shortly.',
                  );
                })
                .catch(() =>
                  setStatus('Verification evidence is unavailable. Acceptance remains locked.'),
                );
            }}
          >
            Check staging verification
          </button>
          {job?.evidence.verificationStatus === 'passed' ? (
            <div className="acceptance-panel">
              <h3>Exact acceptance candidate</h3>
              <dl>
                <div>
                  <dt>Renderer</dt>
                  <dd>{result.rendererVersion}</dd>
                </div>
                <div>
                  <dt>Production base observed</dt>
                  <dd>{productionBaseSha}</dd>
                </div>
              </dl>
              <p>
                Build, schema, renderer, routes, assets, accessibility, responsive, security,
                primary flow, and live checks passed.
              </p>
              {job.evidence.workflowUrl ? (
                <a href={job.evidence.workflowUrl} target="_blank" rel="noreferrer">
                  Quality evidence
                </a>
              ) : null}{' '}
              {job.evidence.deploymentUrl ? (
                <a href={job.evidence.deploymentUrl} target="_blank" rel="noreferrer">
                  Deployment evidence
                </a>
              ) : null}
              <button
                className="button button--primary"
                disabled={Boolean(approvalId)}
                onClick={() => {
                  if (!result.jobId || !productionBaseSha) return;
                  const tuple: CandidateTuple = {
                    siteId: result.siteId,
                    revisionId: result.revisionId,
                    revisionChecksum: result.revisionChecksum,
                    schemaVersion: result.schemaVersion,
                    rendererVersion: result.rendererVersion,
                    candidateChecksum: result.candidateChecksum,
                    stagingBaseSha: result.stagingBaseSha,
                    stagingCommitSha: result.commitSha,
                    productionBaseSha,
                  };
                  setStatus('Recording immutable staging acceptance…');
                  void api
                    .acceptStaging(result.jobId, tuple)
                    .then((approval) => {
                      setApprovalId(approval.id);
                      setStatus(
                        'Staging accepted for this exact candidate. Production remains locked.',
                      );
                    })
                    .catch(() =>
                      setStatus('Acceptance stopped: the candidate or evidence changed.'),
                    );
                }}
              >
                {approvalId ? 'Staging accepted' : 'Accept exact staging candidate'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <aside className="production-lock">
        <strong>Production is locked</strong>
        <p>This screen cannot publish or open a production pull request.</p>
      </aside>
    </section>
  );
}
