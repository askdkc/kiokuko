import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const resultData = result => {
  if (result?.isError === true) return undefined;
  if (result?.structuredContent) return result.structuredContent;
  try { return JSON.parse(result?.content?.filter(x => x.type === 'text').map(x => x.text).join('') ?? ''); } catch { return undefined; }
};
function schemaValid(tool) {
  const schema = tool.inputSchema, props = schema?.properties;
  if (schema?.type !== 'object' || !props) return false;
  if (tool.name === 'task_inspect') return props.cwd?.type === 'string' && props.path?.type === 'string'
    && props.operation?.type === 'string' && ['read','files','status','skill'].every(value => props.operation.enum?.includes(value));
  return props.soulRead?.type === 'boolean' && props.soulRead.const === true && props.capabilities?.type === 'array'
    && (tool.name === 'memory_recall' ? props.query?.type === 'string' : props.task?.type === 'string' && props.requestId?.type === 'string');
}
/** Match requests/responses within one proxy session, with unique call IDs and
 * strictly ordered completions. Registration declarations never prove a read. */
export function observeInstructions({ messages, events, indexes, agentsHash, observations, kind }) {
  const pairs = [], pending = new Map(), seen = new Set(), sessions = new Set();
  let valid = true, previous = 0;
  for (const record of messages) {
    if (!record.sessionId || !Number.isSafeInteger(record.sequence) || record.sequence <= previous) { valid = false; continue; }
    previous = record.sequence; sessions.add(record.sessionId);
    if (!['request','response'].includes(record.direction)) continue;
    const message = record.message; if (message?.id === undefined) continue;
    const id = `${record.sessionId}/${typeof message.id}/${message.id}`;
    if (record.direction === 'request') {
      if (seen.has(id)) valid = false;
      seen.add(id); pending.set(id, record);
    } else {
      const request = pending.get(id); pending.delete(id);
      if (!request || message.error) { valid = false; continue; }
      pairs.push({ request, response:record });
    }
  }
  valid &&= sessions.size === 1 && pending.size === 0;
  const requiredTools = ['task_inspect', kind === 'conversation' ? 'memory_recall' : 'task_prepare'];
  const discovery = pairs.filter(pair => pair.request.message.method === 'tools/list');
  const discovered = valid && discovery.length > 0 && discovery.every(pair => {
    const tools = pair.response.message.result?.tools;
    return Array.isArray(tools) && new Set(tools.map(x => x.name)).size === tools.length
      && requiredTools.every(name => tools.some(tool => tool.name === name && schemaValid(tool)));
  });
  const calls = name => pairs.filter(pair => pair.request.message.method === 'tools/call'
    && pair.request.message.params?.name === name && pair.response.message.result?.isError !== true);
  const registrations = calls(kind === 'conversation' ? 'memory_recall' : 'task_prepare').filter(pair => {
    const data = resultData(pair.response.message.result);
    return kind === 'conversation' ? Array.isArray(data?.items) && data.nextAction === 'proceed'
      : typeof data?.run?.runId === 'string' && ['active','intake'].includes(data.run.status) && data.nextAction !== 'required_capability_unavailable';
  });
  const receipts = [];
  const requiredIndexes = indexes.filter(index => ['kiokuko-codex-soul','kiokuko-codex-memory-reasoning'].includes(index.name));
  const loadedSkills = discovered && requiredIndexes.length === 2 && registrations.length === 1 && registrations.every(registration => {
    const args = registration.request.message.params.arguments;
    return args?.soulRead === true && requiredIndexes.every(index => {
      if (!args.capabilities?.some(x => x.kind === 'skill' && x.name === index.name)) return false;
      const reads = calls('task_inspect').filter(pair => {
        const read = pair.request.message.params.arguments;
        const selector = (read?.path ?? 'kiokuko-soul').replaceAll('\\','/').replace(/^skills\//u,'').replace(/\/SKILL\.md$/u,'');
        return read?.operation === 'skill' && [index.name,index.canonicalName].includes(selector)
          && pair.response.sequence < registration.request.sequence;
      });
      const read = reads.find(pair => {
        const data = resultData(pair.response.message.result);
        return typeof index.bundleText === 'string' && data?.text === index.bundleText
          && data.contentHash === hash(index.bundleText) && data.loadedPackageVersion === index.packageVersion;
      });
      if (!read) return false;
      receipts.push({ sessionId:read.request.sessionId, callId:read.request.message.id, canonicalName:index.canonicalName,
        contentHash:hash(index.bundleText), completed:read.response.sequence, registered:registration.request.sequence });
      return true;
    }) && discovery.every(pair => pair.response.sequence < registration.request.sequence);
  });
  const agentsLoadObserved = events.some(event => event.type === 'instructions.loaded' && event.content_hash === agentsHash);
  return { discovered, loadedSkills, agentsLoadObserved, receipts, protocolValid:valid,
    instructionsVerified:discovered && loadedSkills && agentsLoadObserved
      && (kind === 'conversation' ? calls('task_prepare').length === 0 : observations.some(x => x.event_name === 'UserPromptSubmit' && x.decision === 'handled')) };
}
