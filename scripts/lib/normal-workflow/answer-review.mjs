import { createHash } from 'node:crypto';
export const RUBRIC_VERSION = 'shipping-answer-v1';
export const ANSWER_RUBRIC = Object.freeze({
  conversation: ['4999 costs 500', '5000 costs 0', 'No contradictory statement'],
  inquiry: ['Specification: below 5000 costs 500; at or above 5000 costs 0',
    'Actual initial implementation charges 500 at exactly 5000', 'Clearly distinguishes specification from implementation', 'No contradictory statement'],
});
const digest = value => createHash('sha256').update(value).digest('hex');
/** Review comes from an independently approved reviewer, outside the model tree.
 * It binds the original answer/spec/tree; no execution-model grading JSON. */
export function verifyAnswerReview({ answer, kind, initialHash, specHash, review, reviewers = [] }) {
  const valid = review?.schema === RUBRIC_VERSION && review.answerHash === digest(answer)
    && review.initialHash === initialHash && review.specHash === specHash && review.kind === kind
    && reviewers.includes(review.reviewer) && typeof review.reason === 'string' && review.reason.trim().length > 0
    && Array.isArray(review.criteria) && review.criteria.length === ANSWER_RUBRIC[kind]?.length
    && review.criteria.every((item, i) => item.criterion === ANSWER_RUBRIC[kind][i] && ['PASS','FAIL','UNCERTAIN'].includes(item.verdict))
    && ['PASS','FAIL','UNCERTAIN'].includes(review.verdict);
  if (!valid || review.verdict === 'UNCERTAIN' || review.criteria.some(item => item.verdict === 'UNCERTAIN'))
    return { classification:'FAIL_HARNESS', passed:false, reason:'Missing, stale, unapproved or uncertain independent answer review' };
  if (review.verdict === 'PASS' && !review.criteria.every(item => item.verdict === 'PASS'))
    return { classification:'FAIL_HARNESS', passed:false, reason:'Contradictory review verdict' };
  return { classification:review.verdict === 'PASS' ? 'PASS' : 'FAIL_PRODUCT', passed:review.verdict === 'PASS',
    reviewHash:digest(JSON.stringify(review)), reason:review.reason };
}
