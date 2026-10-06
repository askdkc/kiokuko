// Approval history is fetched by the trusted finalizer and again independently
// by G4. Execution-AI JSON cannot mint this authenticated GitHub identity.
export function approvedReviewers(history, allowed) {
  if(!Array.isArray(history)) return [];
  return [...new Set(history.filter(x=>x.state==='approved' && x.user?.type==='User'
    && allowed.includes(x.user.login) && x.environments?.some(e=>e.name==='normal-workflow-answer-review')).map(x=>x.user.login))];
}
