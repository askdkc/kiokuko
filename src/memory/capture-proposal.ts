import type { ReplayMemoryProposal } from './replay-review.js';

function excerpt(text: string, limit: number): string {
  const characters = Array.from(text.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim());
  return characters.length > limit ? characters.slice(0, limit - 1).join('') + '…' : characters.join('');
}

/** Store the same excerpts the user can review, with their evidence references. */
export function compactCaptureProposal(proposal: ReplayMemoryProposal): ReplayMemoryProposal {
  const request = { ...proposal.request, text: excerpt(proposal.request.text, 200) };
  const findings = proposal.findings.slice(0, 2).map(finding => ({ ...finding, text: excerpt(finding.text, 180) }));
  return {
    ...proposal,
    request,
    findings,
    attempts: [],
    languages: [],
    tags: ['agenticreplay'],
    keywords: [...new Set([request.text, ...findings.map(finding => finding.text)].join(' ').toLowerCase()
      .match(/[\p{L}\p{N}_.-]{2,64}/gu) ?? [])].slice(0, 64),
  };
}

export function pendingCaptureReviewMessage(proposal: ReplayMemoryProposal): string {
  return [
    '前のターンの内容を、このプロジェクトの記憶に保存しますか？',
    ...(proposal.request.text ? ['', '依頼', proposal.request.text] : []),
    ...(proposal.findings.length ? ['', '記録から抽出した要点', ...proposal.findings.map(finding => finding.text)] : []),
  ].join('\n');
}
