// Interpret official Node leaf-completion events. Totals are checked claims,
// never an authority that can override a failed or unfinished lifecycle.
export function validSuite(result, manifest, noSkips = false) {
  if(result?.schema !== 'repository-node-lifecycle-v1' || result.complete !== true || result.streamEnded !== true
    || result.summaryCount !== 1 || !Array.isArray(result.ids) || !result.ids.length || !Array.isArray(manifest)
    || new Set(manifest.map(x=>x.id)).size !== manifest.length) return false;
  const counts={tests:0,passed:0,failed:0,cancelled:0,skipped:0,todo:0}, seen=new Set();
  for(const event of result.ids) {
    if(!event || typeof event.id !== 'string' || !event.id || seen.has(event.id)
      || !['test:pass','test:fail'].includes(event.type) || typeof event.skipped !== 'boolean'
      || typeof event.todo !== 'boolean' || event.suite !== false) return false;
    if(event.type === 'test:pass' && event.failureType != null) return false;
    seen.add(event.id);counts.tests++;
    const expected=manifest.find(x=>x.id === event.id);
    if(!expected || (event.skipped && (noSkips || !expected.optionalSkip || event.type !== 'test:pass' || event.todo))) return false;
    if(event.todo) counts.todo++;
    else if(event.skipped) counts.skipped++;
    else if(event.type === 'test:pass') {if(event.failureType != null) return false;counts.passed++;}
    else if(['cancelledByParent','testTimeoutFailure','testAborted'].includes(event.failureType)) counts.cancelled++;
    else counts.failed++;
  }
  return seen.size === manifest.length && manifest.every(x=>seen.has(x.id))
    && Object.keys(counts).every(key=>Number.isSafeInteger(result.counts?.[key]) && result.counts[key] === counts[key])
    && counts.failed === 0 && counts.todo === 0 && counts.cancelled === 0
    && Array.isArray(result.suites) && result.suites.every(event => {
      if (!event || typeof event.id !== 'string' || !event.id || seen.has(event.id) || event.suite !== true
        || event.type !== 'test:pass' || event.todo !== false || event.skipped !== false || event.failureType != null) return false;
      seen.add(event.id); return true;
    });
}
